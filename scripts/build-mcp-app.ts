import fs from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = process.cwd();
const mcpRoot = path.join(root, "mcp");
const outputRoot = path.join(mcpRoot, "dist");
const uiEntry = path.join(mcpRoot, "ui", "interaction-app.tsx");
const uiCss = path.join(mcpRoot, "ui", "interaction-app.css");
const supervisorEntry = path.join(mcpRoot, "supervisor.ts");

async function requireFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`MCP build entry missing: ${path.basename(filePath)}`);
  }
}

async function main(): Promise<void> {
  await Promise.all([
    requireFile(uiEntry),
    requireFile(uiCss),
    requireFile(supervisorEntry),
  ]);
  await fs.mkdir(outputRoot, { recursive: true });

  await build({
    entryPoints: [uiEntry],
    outfile: path.join(outputRoot, "interaction-app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const uiBundle = await fs.readFile(
    path.join(outputRoot, "interaction-app.js"),
    "utf8",
  );
  const uiStyles = await fs.readFile(uiCss, "utf8");
  if (!uiBundle.trim()) throw new Error("MCP App UI bundle is empty");

  await build({
    entryPoints: [supervisorEntry],
    outfile: path.join(outputRoot, "supervisor.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    define: {
      __STAGEPASS_UI_BUNDLE__: JSON.stringify(
        `const style=document.createElement("style");`
        + `style.textContent=${JSON.stringify(uiStyles)};`
        + `document.head.append(style);${uiBundle}`,
      ),
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';"
        + "const require = __createRequire(import.meta.url);",
    },
  });
  await requireFile(path.join(outputRoot, "supervisor.mjs"));
  process.stdout.write("MCP App bundle ready\n");
}

void main();
