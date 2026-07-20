import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Inline the parseUnifiedDiff function for unit testing
// (same logic as in page.tsx)

interface DiffLine {
  type: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

interface ParsedDiff {
  hunks: Hunk[];
}

function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        newStart: parseInt(hunkMatch[2], 10),
        lines: [],
      };
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", oldNo: null, newNo: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", oldNo: oldLine, newNo: null, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith(" ") || line === "") {
      if (currentHunk.lines.length > 0 || line.startsWith(" ")) {
        currentHunk.lines.push({ type: "ctx", oldNo: oldLine, newNo: newLine, text: line.startsWith(" ") ? line.slice(1) : line });
        oldLine++;
        newLine++;
      }
    }
  }

  return { hunks };
}

describe("parseUnifiedDiff", () => {
  it("parses a standard unified diff with context, additions, and deletions", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,6 @@
 line 1
-old line 2
+new line 2a
+new line 2b
 line 3
 line 4
 line 5`;

    const result = parseUnifiedDiff(diff);
    assert.equal(result.hunks.length, 1);

    const hunk = result.hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.newStart, 1);

    const types = hunk.lines.map((l) => l.type);
    assert.deepEqual(types, ["ctx", "del", "add", "add", "ctx", "ctx", "ctx"]);

    const delLine = hunk.lines.find((l) => l.type === "del")!;
    assert.equal(delLine.text, "old line 2");
    assert.equal(delLine.oldNo, 2);
    assert.equal(delLine.newNo, null);

    const addLines = hunk.lines.filter((l) => l.type === "add");
    assert.equal(addLines[0].text, "new line 2a");
    assert.equal(addLines[0].newNo, 2);
    assert.equal(addLines[1].text, "new line 2b");
    assert.equal(addLines[1].newNo, 3);
  });

  it("parses a new file diff (all additions)", () => {
    const diff = `+++ new-file.ts
+ import { foo } from "bar";
+
+ export function hello() {
+   return "world";
+ }`;

    const result = parseUnifiedDiff(diff);
    // No @@ header means no hunks parsed in unified format
    assert.equal(result.hunks.length, 0);
  });

  it("parses a new file diff with hunk header", () => {
    const diff = `--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,4 @@
+import { foo } from "bar";
+
+export function hello() {
+  return "world";
+}`;

    const result = parseUnifiedDiff(diff);
    assert.equal(result.hunks.length, 1);

    const hunk = result.hunks[0];
    assert.equal(hunk.oldStart, 0);
    assert.equal(hunk.newStart, 1);

    assert.ok(hunk.lines.every((l) => l.type === "add"));
    assert.equal(hunk.lines.length, 5);
    assert.equal(hunk.lines[0].newNo, 1);
  });

  it("returns empty hunks for empty diff string", () => {
    const result = parseUnifiedDiff("");
    assert.equal(result.hunks.length, 0);
  });

  it("parses multiple hunks", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line 1
-old line 2
+new line 2
 line 3
@@ -10,3 +10,4 @@
 line 10
 line 11
+inserted line
 line 12`;

    const result = parseUnifiedDiff(diff);
    assert.equal(result.hunks.length, 2);

    assert.equal(result.hunks[0].oldStart, 1);
    assert.equal(result.hunks[0].newStart, 1);
    assert.equal(result.hunks[0].lines.length, 4);

    assert.equal(result.hunks[1].oldStart, 10);
    assert.equal(result.hunks[1].newStart, 10);
    assert.equal(result.hunks[1].lines.length, 4);
    assert.equal(result.hunks[1].lines[2].type, "add");
    assert.equal(result.hunks[1].lines[2].newNo, 12);
  });

  it("handles deletion-only hunk", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -5,4 +5,2 @@
 keep
-removed 1
-removed 2
 keep`;

    const result = parseUnifiedDiff(diff);
    assert.equal(result.hunks.length, 1);

    const hunk = result.hunks[0];
    const delLines = hunk.lines.filter((l) => l.type === "del");
    assert.equal(delLines.length, 2);
    assert.equal(delLines[0].oldNo, 6);
    assert.equal(delLines[1].oldNo, 7);
  });
});

describe("getColorClass (event type coloring)", () => {
  function getColorClass(type: string, rawJson: string | null): string {
    if (type === "codex_output" && rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (parsed.itemType === "command") return "text-green-400";
        if (parsed.itemType === "file_change") return "text-amber-400";
      } catch { /* ignore */ }
    }
    if (type === "ai_reasoning") return "text-slate-400";
    if (type === "ai_message") return "text-slate-100";
    return "text-slate-300";
  }

  it("ai_reasoning → slate-400 (gray)", () => {
    assert.equal(getColorClass("ai_reasoning", null), "text-slate-400");
  });

  it("ai_message → slate-100 (white/bright)", () => {
    assert.equal(getColorClass("ai_message", null), "text-slate-100");
  });

  it("codex_output + command → green-400", () => {
    const raw = JSON.stringify({ itemType: "command", content: "ls" });
    assert.equal(getColorClass("codex_output", raw), "text-green-400");
  });

  it("codex_output + file_change → amber-400", () => {
    const raw = JSON.stringify({ itemType: "file_change", paths: ["src/a.ts"] });
    assert.equal(getColorClass("codex_output", raw), "text-amber-400");
  });

  it("unknown type → slate-300 (default)", () => {
    assert.equal(getColorClass("something_else", null), "text-slate-300");
  });
});
