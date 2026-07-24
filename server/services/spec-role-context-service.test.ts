import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSpecCriticContext } from "./spec-role-context-service";

describe("spec role context service", () => {
  it("rebuilds critic input without writer scratch or transcript", () => {
    const result = buildSpecCriticContext({
      frozenSpecArtifact: "SPEC_V7",
      requirements: "REQS_V3",
      checklist: "CHECKLIST_V2",
      writerScratch: "WRITER_SCRATCH_SECRET",
      writerTranscript: "WRITER_TRANSCRIPT_SECRET",
    } as never);
    assert.match(result.prompt, /fresh adversarial evaluation/i);
    assert.match(result.prompt, /SPEC_V7/);
    assert.match(result.prompt, /REQS_V3/);
    assert.match(result.prompt, /CHECKLIST_V2/);
    assert.doesNotMatch(result.prompt, /WRITER_SCRATCH_SECRET|WRITER_TRANSCRIPT_SECRET/);
    assert.equal(result.outputArtifactKind, "spec_critic_review");
  });
});
