import crypto from "crypto";

import { createChildLogger } from "../logger";
import type { Project } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import { writeDelegatedRoundGapLedger } from "./delegated-round-gap-ledger";
import {
  settleDelegatedRound,
  type DelegatedLedgerPhase,
} from "./delegated-round-ledger";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import { syncDelegatedRoundStageAuthority } from "./delegated-round-stage-authority";
import { presentDesignGateDecision } from "./design-gate-decision-presenter";
import {
  recordDelegatedRoundSideThreads,
  usedSubAgentThreadIds,
} from "./delegated-round-side-history";
import { roundOutputPath } from "./delegated-round-workspace";
import { runDelegatedRound } from "./pipeline-delegated-round";
import type { RedFixClaimInput } from "./spec-battle-ledger";
import { recordRubricAssessmentsFromVerdicts } from "./rubric-service";
import { resolveStageRubric } from "./rubric-stage-service";

const log = createChildLogger("pipeline-delegated-phase-round");

/**
 * One delegated round of TechSpec, Plan or TestPlan, from dispatch to settled
 * ledger.
 *
 * ## Why the three phases share this and Spec does not
 *
 * Spec's equivalent (`runDelegatedSpecRound`) is welded to the Spec battle
 * service by design -- see the handoff's §5.0. These three have no such history:
 * they are being given a round for the first time, so they get one runner rather
 * than three copies that would start identical and drift.
 *
 * What differs per phase is exactly two things, and both are parameters:
 * which descriptor the round runs under, and how red's document is persisted.
 * Everything else -- attribution, the gap ledger, the two rubrics, the gate --
 * is phase-independent, and phase-independent is what a shared runner should be
 * made of.
 *
 * ## Order, and why it is this order
 *
 * 1. **Rubrics resolved first.** Their criterion ids travel into the briefs, and
 *    into the ingestion so an invented id refuses the round BEFORE anything is
 *    written. Resolving them after the turn would put the refusal after red and
 *    blue had already been committed -- the half-round §7.3 warns about, which
 *    is exactly how CHG-006 ended up with a failed round and two live gaps.
 * 2. **Sub-agent threads recorded before the ledger writes.** A round that
 *    settles red and then fails must still have burned its threads, or a retry
 *    could re-attribute the very sub-agents whose output it just refused.
 * 3. **Gate last.** It is computed from the gaps, so it has to run after they
 *    land.
 */

export interface DelegatedPhaseRoundInput {
  descriptor: DelegatedRoundPhase & { phase: DelegatedLedgerPhase };
  changeId: string;
  changeTitle?: string;
  projectId: string;
  project: Project;
  context: JobExecutionContext;
  provider: Provider;
  runId: string;
  roundId: string;
  roundNo: number;
  /** A judge turn this task already produced, once its questions converged. */
  adoptedResult?: AiRunResult;
  /**
   * Writes the phase's own document from red's payload, and returns the rows
   * the stage gate hashes.
   *
   * A callback rather than a branch on the phase, because each phase's persister
   * already exists and already owns the shape of its own snapshot. Handing it in
   * keeps this runner from ever needing to know what a tech spec is.
   */
  persistRed: (input: {
    changeId: string;
    project: Project;
    runId: string;
    result: AiRunResult;
  }) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function runDelegatedPhaseRound(
  input: DelegatedPhaseRoundInput,
): Promise<AiRunResult> {
  const scope = { projectId: input.projectId, changeId: input.changeId, phase: input.descriptor.phase };
  const pin = { runId: input.runId, roundId: input.roundId };
  const criticRubric = resolveStageRubric({ ...scope, role: "critic" }, pin);
  const verdictRubric = resolveStageRubric({ ...scope, role: "verdict" }, pin);
  const criteriaOf = (rubric: typeof criticRubric) =>
    rubric?.rubric.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })) ?? [];

  const { round, result } = await runDelegatedRound({
    descriptor: input.descriptor,
    changeId: input.changeId,
    changeTitle: input.changeTitle,
    repoPath: input.project.repoPath,
    roundNo: input.roundNo,
    runId: input.runId,
    context: input.context,
    provider: input.provider,
    adoptedResult: input.adoptedResult,
    criticCriteria: criteriaOf(criticRubric),
    verdictCriteria: criteriaOf(verdictRubric),
    // Threads earlier rounds already spent. The judge task stays open across
    // rounds, so without this round 2 could be attributed from round 1's
    // sub-agents without spawning anything.
    usedAgentThreadIds: usedSubAgentThreadIds(input.changeId),
  });

  recordDelegatedRoundSideThreads({
    changeId: input.changeId,
    runId: input.runId,
    phase: input.descriptor.phase,
    roundId: input.roundId,
    roundNo: input.roundNo,
    sideThreads: round.sideThreads,
  });

  // Red's document goes through the phase's own persister, so the round and the
  // single-turn path produce the same snapshot rows from the same payload.
  // `fixClaims` is the round's field, not the document's, so it is stripped
  // before the persister sees a shape its schema would reject.
  const { fixClaims, ...redDocument } = round.red as { fixClaims?: RedFixClaimInput[] };
  const { rows } = await input.persistRed({
    changeId: input.changeId,
    project: input.project,
    runId: input.runId,
    result: { ...result, structuredOutput: redDocument },
  });

  writeDelegatedRoundGapLedger({
    changeId: input.changeId,
    descriptor: input.descriptor,
    roundId: input.roundId,
    red: { fixClaims: fixClaims ?? [] },
    blue: round.blue,
    redHash: crypto.createHash("sha256").update(JSON.stringify(redDocument)).digest("hex"),
  });

  // Both rubrics, from the role that actually answered each. A missing criterion
  // still lands as `not_assessed` and still blocks: buildRubricAssessments
  // iterates criteria, not the model's list, so a short answer cannot shorten
  // the stored batch.
  if (criticRubric && criticRubric.rubric.criteria.length > 0) {
    recordRubricAssessmentsFromVerdicts({
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      rubric: criticRubric.rubric,
      verdicts: round.blue.rubric,
    });
  }
  if (verdictRubric && verdictRubric.rubric.criteria.length > 0) {
    recordRubricAssessmentsFromVerdicts({
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      rubric: verdictRubric.rubric,
      verdicts: round.judge.rubric,
    });
  }

  settleDelegatedRound({
    changeId: input.changeId,
    descriptor: input.descriptor,
    roundId: input.roundId,
    redArtifactPath: roundOutputPath(
      input.changeId, input.descriptor.phase, input.roundNo, "red",
    ),
    redArtifactHash: crypto.createHash("sha256").update(JSON.stringify(redDocument)).digest("hex"),
    blueArtifactPath: roundOutputPath(
      input.changeId, input.descriptor.phase, input.roundNo, "blue",
    ),
    blueArtifactHash: crypto.createHash("sha256").update(JSON.stringify(round.blue)).digest("hex"),
  });

  const gate = syncDelegatedRoundStageAuthority({
    changeId: input.changeId,
    phase: input.descriptor.phase,
    roundId: input.roundId,
  });

  // The round is settled and its gate is written, so the human's decision is now
  // the only thing missing. The web does not route approvals, so without this the
  // phase would dead-end exactly as Spec did -- see design-gate-decision-presenter.
  presentDesignGateDecision({
    changeId: input.changeId,
    phase: input.descriptor.phase,
    roundNo: input.roundNo,
    reportHash: `${input.roundId}:${input.runId}`,
  });

  log.info(
    {
      changeId: input.changeId,
      phase: input.descriptor.phase,
      roundId: input.roundId,
      roundNo: input.roundNo,
      gate: gate.applied ? gate.gate.status : `unchanged:${gate.applied === false ? gate.reason : ""}`,
      snapshotRows: rows.length,
    },
    "Delegated phase round settled",
  );
  return result;
}
