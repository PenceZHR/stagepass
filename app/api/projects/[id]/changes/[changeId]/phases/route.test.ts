import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Source-string test, matching the convention of ai-engine-adapter.test.ts.
// Pins a real regression: safePhaseReviewDto used to omit `content` and
// `editablePath` from the artifact DTO even though the service layer computes
// them and the client type/UI (editable-phase-artifact.tsx) depends on both —
// content to render in the click-to-view modal, editablePath to gate editing.
// Their absence silently broke both features (produced a 404 via the id-based
// fetch fallback for content, and always-disabled editing) with no server error.

const source = fs.readFileSync(
  path.join(process.cwd(), "app/api/projects/[id]/changes/[changeId]/phases/route.ts"),
  "utf-8",
);

describe("phases route DTO", () => {
  it("passes artifact content and editablePath through to the client", () => {
    const mapStart = source.indexOf("artifacts: review.selected.artifacts.map(");
    assert.notEqual(mapStart, -1, "artifact DTO mapping should exist");
    const mapEnd = source.indexOf("})),", mapStart);
    const artifactMap = source.slice(mapStart, mapEnd);

    assert.match(artifactMap, /content: artifact\.content/);
    assert.match(artifactMap, /editablePath: artifact\.editablePath/);
  });
});
