import type { CodexAppServerShellControl } from "./codex-app-server-shell-control";
import type { CodexTurnSnapshot } from "./codex-desktop-bridge-types";
import type {
  SubAgentThreadRead,
  SubAgentThreadReader,
} from "./codex-subagent-attribution";

/**
 * Reads a sub-agent's own thread: what it finally said, and when it ran.
 *
 * Both answers must come from the sub-agent's thread rather than from the
 * judge's account of them. The judge cannot write into this thread, which is
 * the whole reason attribution is anchored here -- see
 * codex-subagent-attribution.ts for the observed failure where a judge with no
 * sub-agents at all reported both sides' answers as its own.
 */

/**
 * A side may take more than one turn -- the judge can send it follow-up input.
 * "When it ran" therefore spans the first turn's start to the last turn's
 * completion, and "what it said" is the last thing it said. Taking a single
 * turn's window would report a side that answered a follow-up as having started
 * late, which turn-taking would then read as running out of order.
 */
export function readSubAgentFromTurns(turns: readonly CodexTurnSnapshot[]): SubAgentThreadRead {
  const output = turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.kind === "agent_message")
    .map((item) => item.semantic.text)
    .at(-1) ?? null;

  const startedAt = turns
    .map((turn) => turn.metadata.startedAt)
    .find((value): value is string => typeof value === "string");
  const completedAt = [...turns]
    .reverse()
    .map((turn) => turn.metadata.completedAt)
    .find((value): value is string => typeof value === "string");

  return {
    output,
    startedAt: parseInstant(startedAt),
    completedAt: parseInstant(completedAt),
  };
}

/**
 * Snapshots carry ISO strings (the normalizer already resolved the app-server's
 * epoch-seconds-vs-milliseconds ambiguity), so every side in a round is read in
 * the same unit -- which is the only thing turn-taking needs.
 */
function parseInstant(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createSubAgentThreadReader(
  shellControl: Pick<CodexAppServerShellControl, "readThreadWithTurns">,
): SubAgentThreadReader {
  return async (agentThreadId) => {
    // Errors propagate: attributeSubAgentSides turns them into
    // `sub_agent_thread_unreadable`, which is deliberately NOT the same as a
    // side that produced nothing.
    const { turns } = await shellControl.readThreadWithTurns({
      threadId: agentThreadId,
      includeTurns: true,
    });
    return readSubAgentFromTurns(turns);
  };
}
