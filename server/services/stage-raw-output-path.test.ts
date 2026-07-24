import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isStageRawOutputFileName,
  LEGACY_STAGE_RAW_OUTPUT_FILE_NAME,
  stageRawOutputFileName,
  stageRawOutputPath,
} from "./stage-raw-output-path.ts";

const RUN = { repoPath: "/repo", changeId: "CHG-003", runId: "RUN-mrw8zgd3-0356b933" };

describe("stage raw output path", () => {
  it("gives the roles of one run separate files instead of overwriting each other", () => {
    // The reproduction, as measured: a Spec battle run calls the provider for
    // the red author and again for the blue critic under one `runs` row. Both
    // captures used to resolve to runs/<runId>/raw-ai-output.json, so the
    // artifacts table held two rows for one file and only `spec_critic`
    // survived on disk.
    const red = stageRawOutputPath({ ...RUN, phase: "spec" });
    const critic = stageRawOutputPath({ ...RUN, phase: "spec_critic" });

    assert.notEqual(red, critic, "two roles of the same run must not share a capture file");
    assert.match(red, /runs\/RUN-mrw8zgd3-0356b933\/raw-ai-output-spec\.json$/);
    assert.match(critic, /runs\/RUN-mrw8zgd3-0356b933\/raw-ai-output-spec_critic\.json$/);
  });

  it("keeps each run's captures under that run's own directory", () => {
    const a = stageRawOutputPath({ ...RUN, phase: "spec" });
    const b = stageRawOutputPath({ ...RUN, runId: "RUN-999", phase: "spec" });

    assert.notEqual(a, b);
    assert.match(a, /changes\/CHG-003\/runs\//);
  });

  it("recognises captures of any phase, and the legacy name that predates the split", () => {
    assert.equal(isStageRawOutputFileName(stageRawOutputFileName("spec")), true);
    assert.equal(isStageRawOutputFileName(stageRawOutputFileName("spec_critic")), true);
    assert.equal(isStageRawOutputFileName(stageRawOutputFileName("review")), true);
    // Runs captured before the split are still on disk and still referenced by
    // artifacts.path; they must keep classifying as raw captures.
    assert.equal(isStageRawOutputFileName(LEGACY_STAGE_RAW_OUTPUT_FILE_NAME), true);
  });

  it("does not claim unrelated files", () => {
    for (const name of [
      "prd-delta.md",
      "raw-review-output.json",
      "spec-round-01-red.md",
      "raw-ai-output.txt",
      "raw-ai-output-.json",
      "not-raw-ai-output-spec.json",
    ]) {
      assert.equal(isStageRawOutputFileName(name), false, `${name} must not be treated as a capture`);
    }
  });

  it("never lets a phase escape the run directory", () => {
    // Phases are identifiers today, but this name reaches the filesystem, so a
    // separator in it must not be able to redirect the write.
    const evil = stageRawOutputPath({ ...RUN, phase: "../../etc/passwd" });

    assert.match(evil, /runs\/RUN-mrw8zgd3-0356b933\/raw-ai-output-[a-z0-9_-]+\.json$/);
    assert.equal(evil.includes(".."), false);
    assert.equal(stageRawOutputFileName("").includes("unknown"), true);
  });
});
