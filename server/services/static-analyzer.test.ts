import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import {
  runStaticAnalysis,
  formatAnalysisForPrompt,
} from "./static-analyzer.ts";

import {
  parseDocBlock,
  parseFileSelectionJson,
} from "./context-parsers.ts";

describe("static-analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-analyzer-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  describe("analyzeProject", () => {
    it("should extract exports from TypeScript files in server/services", async () => {
      writeFile("server/services/example.ts", `
import { something } from "../db";

export interface IEngine {
  run(input: string): Promise<void>;
}

export function getEngine(): IEngine {
  return {} as IEngine;
}

export class MyEngine implements IEngine {
  async run(input: string): Promise<void> {}
  private helper(): void {}
}

export const VERSION = "1.0.0";

export type EngineType = "codex" | "claude";
`);

      const result = await runStaticAnalysis(tmpDir);
      assert.ok(result.coreFiles.length >= 1, "Should have at least 1 core file");

      const exampleFile = result.coreFiles.find(f => f.filePath === "server/services/example.ts");
      assert.ok(exampleFile, "Should find example.ts in core files");

      const exportNames = exampleFile.exports.map(e => e.name);
      assert.ok(exportNames.includes("IEngine"), "Should export IEngine");
      assert.ok(exportNames.includes("getEngine"), "Should export getEngine");
      assert.ok(exportNames.includes("MyEngine"), "Should export MyEngine");
      assert.ok(exportNames.includes("VERSION"), "Should export VERSION");
      assert.ok(exportNames.includes("EngineType"), "Should export EngineType");

      const getEngineExport = exampleFile.exports.find(e => e.name === "getEngine");
      assert.equal(getEngineExport?.kind, "function");
      assert.ok(getEngineExport?.signature?.includes("getEngine"));

      const classExport = exampleFile.exports.find(e => e.name === "MyEngine");
      assert.equal(classExport?.kind, "class");

      const classInfo = exampleFile.classes.find(c => c.name === "MyEngine");
      assert.ok(classInfo, "Should have class info for MyEngine");
      assert.ok(classInfo.implements?.includes("IEngine"), "Should implement IEngine");
      assert.ok(classInfo.methods.some(m => m.name === "run"), "Should have run method");
    });

    it("should scan peripheral tsx files with regex", async () => {
      writeFile("app/projects/page.tsx", `
"use client";
import { useState } from "react";

export default function ProjectsPage() {
  return <div>Hello</div>;
}
`);

      const result = await runStaticAnalysis(tmpDir);
      const pageFile = result.peripheralFiles.find(f => f.filePath === "app/projects/page.tsx");
      assert.ok(pageFile, "Should find page.tsx in peripheral files");
      assert.ok(
        pageFile.exports.some(e => e.name === "ProjectsPage" || e.name === "default"),
        "Should detect default export"
      );
    });

    it("should build dependency graph from imports", async () => {
      writeFile("server/services/a.ts", `
import { db } from "../db";
import { helper } from "./b";
export function fnA() {}
`);
      writeFile("server/services/b.ts", `
export function helper() {}
`);
      writeFile("server/db/index.ts", `
export const db = {};
`);

      const result = await runStaticAnalysis(tmpDir);
      const deps = result.dependencyGraph.get("server/services/a.ts");
      assert.ok(deps, "Should have deps for a.ts");
      assert.ok(deps.includes("server/services/b.ts") || deps.includes("server/db"), "Should list b.ts or db as dep");
    });

    it("should extract API routes", async () => {
      writeFile("app/api/users/route.ts", `
import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json([]); }
export async function POST() { return NextResponse.json({}); }
`);

      const result = await runStaticAnalysis(tmpDir);
      assert.ok(result.routes.length >= 1, "Should find at least one route");
      const getRoute = result.routes.find(r => r.method === "GET" && r.path.includes("/api/users"));
      assert.ok(getRoute, "Should find GET /api/users route");
    });

    it("should extract pages", async () => {
      writeFile("app/dashboard/page.tsx", `
export default function DashboardPage() { return <div/>; }
`);

      const result = await runStaticAnalysis(tmpDir);
      assert.ok(result.pages.length >= 1, "Should detect at least one page");
      assert.ok(result.pages.some(p => p.path.includes("/dashboard")), "Should find /dashboard page");
    });

    it("should build directory tree", async () => {
      writeFile("server/services/test.ts", "export const x = 1;");
      writeFile("app/page.tsx", "export default function() {}");

      const result = await runStaticAnalysis(tmpDir);
      assert.ok(result.tree.length > 0, "Tree should not be empty");
      assert.ok(result.tree.includes("server"), "Tree should include server dir");
    });

    it("should ignore node_modules and .git", async () => {
      writeFile("node_modules/pkg/index.ts", "export const x = 1;");
      writeFile(".git/config", "content");
      writeFile("server/services/real.ts", "export function real() {}");

      const result = await runStaticAnalysis(tmpDir);
      const allFiles = [...result.coreFiles, ...result.peripheralFiles];
      assert.ok(!allFiles.some(f => f.filePath.includes("node_modules")), "Should not include node_modules");
      assert.ok(!result.tree.includes("node_modules"), "Tree should not include node_modules");
    });
  });

  describe("formatAnalysisForPrompt", () => {
    it("should produce formatted text with all sections", async () => {
      writeFile("server/services/svc.ts", `
export function myFunc(a: string): number { return 0; }
`);

      const result = await runStaticAnalysis(tmpDir);
      const formatted = formatAnalysisForPrompt(result);

      assert.ok(formatted.includes("目录结构"), "Should have directory tree section");
      assert.ok(formatted.includes("核心文件分析"), "Should have core files section");
      assert.ok(formatted.includes("依赖关系图"), "Should have dependency graph section");
    });
  });
});

describe("context-init-service helpers", () => {
  describe("parseDocBlock", () => {
    it("should extract content between tagged code blocks", () => {
      const output = `Some text before

\`\`\`architecture
# Architecture

This is the architecture doc.
\`\`\`

\`\`\`coding-rules
# Coding Rules
\`\`\``;

      const arch = parseDocBlock(output, "architecture");
      assert.ok(arch?.includes("This is the architecture doc."));

      const rules = parseDocBlock(output, "coding-rules");
      assert.ok(rules?.includes("Coding Rules"));
    });

    it("should return null for missing tags", () => {
      const output = "```json\n{}\n```";
      assert.equal(parseDocBlock(output, "architecture"), null);
    });

    it("should handle nested code blocks", () => {
      const output = `\`\`\`architecture
# Arch

Here is some code:

\`\`\`typescript
const x = 1;
\`\`\`

More content.
\`\`\`

\`\`\`coding-rules
Rules here
\`\`\``;

      const arch = parseDocBlock(output, "architecture");
      assert.ok(arch?.includes("const x = 1"), "Should include nested code block content");
      assert.ok(arch?.includes("More content."), "Should keep content after nested code block");
    });

    it("should extract XML-tagged docs containing markdown code fences", () => {
      const output = `<coding-rules>
# Rules

\`\`\`js
const x = 1;
\`\`\`

## More
Keep this section.
</coding-rules>`;

      const rules = parseDocBlock(output, "coding-rules");
      assert.ok(rules?.includes("const x = 1"));
      assert.ok(rules?.includes("Keep this section."));
    });
  });

  describe("parseFileSelectionJson", () => {
    it("should parse a valid JSON array from code block", () => {
      const output = '```json\n["file1.ts", "file2.ts"]\n```';
      const result = parseFileSelectionJson(output);
      assert.deepEqual(result, ["file1.ts", "file2.ts"]);
    });

    it("should parse raw JSON array", () => {
      const output = '["a.ts", "b.ts", "c.ts"]';
      const result = parseFileSelectionJson(output);
      assert.deepEqual(result, ["a.ts", "b.ts", "c.ts"]);
    });

    it("should return empty array for invalid JSON", () => {
      const output = "I think these files are important:\n- file1.ts\n- file2.ts";
      const result = parseFileSelectionJson(output);
      assert.deepEqual(result, []);
    });

    it("should limit to MAX_SELECTED_FILES", () => {
      const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
      const output = JSON.stringify(files);
      const result = parseFileSelectionJson(output);
      assert.equal(result.length, 20);
    });

    it("should handle JSON embedded in other text", () => {
      const output = 'Here are the files:\n\n["server/a.ts", "server/b.ts"]\n\nThat is all.';
      const result = parseFileSelectionJson(output);
      assert.deepEqual(result, ["server/a.ts", "server/b.ts"]);
    });
  });
});
