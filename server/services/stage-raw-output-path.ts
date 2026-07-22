import path from "node:path";

/**
 * Where a run's raw provider capture lives, and how to recognise one.
 *
 * ## Why the phase is in the file name
 *
 * A single run can call the provider more than once. The Spec battle is the
 * clear case: one `runs` row covers the red author, the blue critic and the
 * report pass. Every one of those captures used to be written to
 * `runs/<runId>/raw-ai-output.json` -- a constant -- so each call silently
 * overwrote the previous one and only the last role survived.
 *
 * Measured on a real run (RUN-mrw8zgd3-0356b933, CHG-003): the `artifacts`
 * table held two `stage_raw_output` rows pointing at that one path, while the
 * file on disk contained `phase: spec_critic`. The red author's raw output --
 * its line protocol, stderr and exit code -- was unrecoverable, and the ledger
 * claimed two captures existed when there was one. Raw capture exists precisely
 * so a suspicious provider call can be re-read afterwards, and it was dropping
 * exactly the multi-role stages where that matters most.
 *
 * ## Why this is its own module
 *
 * Three places independently spelled this rule: the writer in
 * `stage-raw-capture-service`, a second path builder in
 * `pipeline-review-stage-service`, and a file-name classifier in
 * `change-phase-service`. Changing the name in one would have broken the other
 * two. These are pure functions with no database import so all three can share
 * them -- `stage-raw-capture-service` pulls in the run-ledger repository, which
 * makes it unsuitable as the shared home.
 */

/**
 * The name used before captures were split per phase. Still recognised by
 * `isStageRawOutputFileName` because runs recorded under it exist on disk and
 * are referenced by `artifacts.path`; nothing rewrites history.
 */
export const LEGACY_STAGE_RAW_OUTPUT_FILE_NAME = "raw-ai-output.json";

const STAGE_RAW_OUTPUT_PREFIX = "raw-ai-output";

/**
 * Phases are identifiers already (`spec`, `spec_critic`, `review`), so the slug
 * is deliberately narrower than "safe": no dots either. Dots would survive as
 * `..` inside the file name, which is inert once joined -- but there is no
 * phase that needs one, and a name with no dots cannot be misread later.
 */
function phaseSlug(phase: string | undefined): string {
  const slug = (phase ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

/**
 * `phase` is optional on the capture envelope, so a caller that omits it lands
 * on `raw-ai-output-unknown.json`. That is the pre-existing single-file
 * behaviour, kept deliberately: collapsing is only wrong when two captures in
 * one run can be told apart, and with no phase there is nothing to tell them
 * apart by. Every multi-role stage does set it.
 */
export function stageRawOutputFileName(phase: string | undefined): string {
  return `${STAGE_RAW_OUTPUT_PREFIX}-${phaseSlug(phase)}.json`;
}

export function stageRawOutputPath(input: {
  repoPath: string;
  changeId: string;
  runId: string;
  phase: string | undefined;
}): string {
  return path.join(
    input.repoPath,
    ".ship",
    "changes",
    input.changeId,
    "runs",
    input.runId,
    stageRawOutputFileName(input.phase),
  );
}

/**
 * Whether a file name holds a raw provider capture, for any phase.
 *
 * Accepts the legacy constant name as well: `change-phase-service` uses this to
 * decide that a file is review metadata rather than a produced artifact, and a
 * run captured before the split must keep classifying the same way.
 */
export function isStageRawOutputFileName(fileName: string): boolean {
  if (fileName === LEGACY_STAGE_RAW_OUTPUT_FILE_NAME) return true;
  return new RegExp(`^${STAGE_RAW_OUTPUT_PREFIX}-[a-z0-9_-]+\\.json$`).test(fileName);
}
