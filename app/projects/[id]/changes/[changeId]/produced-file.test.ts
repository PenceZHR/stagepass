import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Source-string tests, matching the convention of artifact-viewer.test.ts /
// build-sandbox.test.ts (no DOM runner in this project). They pin the load-bearing
// behaviour of the shared clickable-file component.

const source = fs.readFileSync(
  path.join(process.cwd(), "app/projects/[id]/changes/[changeId]/produced-file.tsx"),
  "utf-8",
);

describe("produced-file", () => {
  it("is a client component", () => {
    assert.match(source, /^"use client";/);
  });

  it("exports both ProducedFile and FileViewerModal", () => {
    assert.match(source, /export function ProducedFile\(/);
    assert.match(source, /export function FileViewerModal\(/);
  });

  it("renders a clickable button (not just text)", () => {
    assert.match(source, /<button/);
    assert.match(source, /onClick=\{\(\) => setOpen\(true\)\}/);
  });

  it("resolves content by artifact id when given one", () => {
    assert.match(source, /artifacts\/\$\{encodeURIComponent\(target\.artifactId\)\}\/content/);
  });

  it("resolves content by path via the file-content endpoint, url-encoded", () => {
    assert.match(source, /file-content\?path=\$\{encodeURIComponent\(target\.path \?\? ""\)\}/);
  });

  it("defaults the label to the path basename", () => {
    assert.match(source, /path\.split\("\/"\)\.pop\(\)/);
  });

  it("degrades to plain text only when there is no content, path, or artifact id", () => {
    assert.match(source, /if \(content == null && !path && !artifactId\)/);
    assert.match(source, /return <span/);
  });

  it("skips the network fetch when content is already known", () => {
    // Initial state resolves straight to "ready" from knownContent, and the
    // fetch effect bails out early when it's present — no round-trip either way.
    assert.match(source, /const knownContent = target\.content/);
    assert.match(source, /knownContent != null[\s\S]{0,60}status: "ready", content: knownContent/);
    assert.match(source, /if \(knownContent != null\) return;/);
  });

  it("portals the modal to document.body instead of rendering it inline", () => {
    // Callers place <ProducedFile> inside phrasing-content parents (e.g. <p>);
    // an inline block-level modal would nest invalidly. Portaling escapes that.
    assert.match(source, /import \{ createPortal \} from "react-dom";/);
    assert.match(source, /return createPortal\(/);
    assert.match(source, /document\.body,?\s*\);?\s*\}$/m);
  });
});
