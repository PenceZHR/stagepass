import { blockersFrom, type Gap } from "../domain/gap";
import type { Blocker } from "../domain/gate";
import type { Phase } from "../domain/phase";
import { BLUE, judgePrompt, RED, readRound } from "../domain/round";
import type { CodexTransport } from "../codex/transport";
import type { GapStore } from "../store/gap-store";

/**
 * One adversarial round, from prompt to settled gaps.
 *
 * The four things this joins were each proved separately -- the judge's prompt,
 * finding a sub-agent's own rollout, reading three transcripts into an outcome,
 * and writing that outcome to the gap store. What was missing was the wire
 * between them, and a wire is exactly the kind of thing the tree this replaces
 * had a hundred of: built, plausible, and never once run end to end.
 *
 * ## Red and blue are read before anything is written
 *
 * If blue's transcript cannot be found, this throws and the gap store is
 * untouched. That ordering is the whole safety property: a round that half
 * happened must leave the gate reading the state from before it, not a state in
 * which red's artifacts were recorded and blue's objections were lost. "Blue
 * could not be read" and "blue found nothing" are the two things that must never
 * arrive at the gate as the same thing, and here they differ by an exception.
 *
 * ## Everything unproven is injected
 *
 * The transport and the rollout reader are parameters, so the whole of this runs
 * offline against `ScriptedCodexTransport` and a stub reader. What is left that
 * needs a real Codex is one thing only: whether a judge actually spawns two
 * sub-agents at the paths it was told to use.
 */

export interface RoundRequest {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /** What red is asked to produce. */
  readonly task: string;
  /** The judge's thread, or null to start one. */
  readonly judgeThreadId: string | null;
}

export interface RoundDependencies {
  readonly transport: CodexTransport;
  readonly gaps: GapStore;
  /** What one role said in its own words, read from its own rollout. */
  readonly readRole: (parentThreadId: string, agentPath: string) => string;
}

export interface RoundSettled {
  /** The thread the judge ran on. Later rounds resume it. */
  readonly judgeThreadId: string;
  readonly artifactIds: readonly string[];
  readonly gaps: readonly Gap[];
  /** What the gate will see. Empty means this phase is not blocked. */
  readonly blockers: readonly Blocker[];
}

export async function runRound(
  request: RoundRequest,
  dependencies: RoundDependencies,
): Promise<RoundSettled> {
  // Only open gaps are put to the judge. A closed one is not a question, and
  // listing it would invite a verdict that reopens something already settled.
  const openGaps = dependencies.gaps
    .all(request.changeId, request.phase)
    .filter((gap) => gap.status === "open");

  const delivery = await dependencies.transport.runTurn({
    threadId: request.judgeThreadId,
    prompt: judgePrompt({
      phase: request.phase,
      round: request.round,
      task: request.task,
      openGaps,
    }),
  });

  // Read both roles first. See the note above on why this cannot be reordered.
  const red = dependencies.readRole(delivery.threadId, RED);
  const blue = dependencies.readRole(delivery.threadId, BLUE);

  const reading = readRound({
    round: request.round,
    red,
    blue,
    judge: delivery.text,
  });

  const gaps = dependencies.gaps.settleRound(
    request.changeId, request.phase, reading.outcome,
  );

  return {
    judgeThreadId: delivery.threadId,
    artifactIds: reading.artifactIds,
    gaps,
    blockers: blockersFrom(gaps),
  };
}
