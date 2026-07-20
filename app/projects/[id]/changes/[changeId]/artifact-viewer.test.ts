import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ArtifactsPanel viewer dialog (double-scrollbar fix)", () => {
  const src = readFileSync(resolve(__dirname, "artifacts-panel.tsx"), "utf-8");

  it("pre element inside artifact viewer does not have max-h-96 or overflow-auto", () => {
    // Locate the artifact viewer section by finding the viewingContent dialog
    const dialogStart = src.indexOf("viewingContent.content");
    assert.ok(dialogStart !== -1, "should find viewingContent.content in source");

    // Find the <pre that renders the artifact content (nearest pre before viewingContent.content)
    const regionBefore = src.slice(Math.max(0, dialogStart - 300), dialogStart);
    const preMatch = regionBefore.match(/<pre\s+className="([^"]+)"/);
    assert.ok(preMatch, "should find a <pre> className near viewingContent.content");

    const preClasses = preMatch[1];
    assert.ok(!preClasses.includes("max-h-96"), "pre should not contain max-h-96 (causes nested scroll)");
    assert.ok(!preClasses.includes("overflow-auto"), "pre should not contain overflow-auto (outer div handles scroll)");
  });

  it("outer div wrapping content has overflow-auto for single scroll container", () => {
    // The outer div should be the flex-1 overflow-auto container
    const dialogStart = src.indexOf("viewingContent.content");
    const regionBefore = src.slice(Math.max(0, dialogStart - 500), dialogStart);
    assert.ok(
      regionBefore.includes('className="flex-1 overflow-auto"'),
      "outer wrapper div should have flex-1 overflow-auto"
    );
  });

  it("editing textarea still has fixed h-96 height", () => {
    const textareaMatch = src.match(/<textarea[\s\S]*?className="([^"]+)"[\s\S]*?editContent/);
    assert.ok(textareaMatch, "should find textarea for editing");
    assert.ok(textareaMatch[1].includes("h-96"), "textarea should keep h-96 fixed height");
  });
});
