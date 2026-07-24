import fs from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = process.cwd();
const sourceRoot = path.join(root, "spikes", "codex-desktop-mcp");
const outputRoot = path.join(root, ".stagepass", "phase0-mcp");

async function main(): Promise<void> {
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const ui = await build({
    entryPoints: [path.join(sourceRoot, "ui.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    minify: true,
  });
  const uiBundle = ui.outputFiles[0]?.text;
  if (!uiBundle) throw new Error("Phase 0 UI bundle was not emitted");

  await Promise.all([
    build({
      entryPoints: [path.join(sourceRoot, "server.ts")],
      outfile: path.join(outputRoot, "server.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      define: {
        __PHASE0_UI_BUNDLE__: JSON.stringify(uiBundle),
      },
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module';"
          + "const require = __createRequire(import.meta.url);",
      },
    }),
    build({
      entryPoints: [path.join(sourceRoot, "supervisor.ts")],
      outfile: path.join(outputRoot, "supervisor.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
    }),
  ]);

  const [serverStat, supervisorStat] = await Promise.all([
    fs.stat(path.join(outputRoot, "server.mjs")),
    fs.stat(path.join(outputRoot, "supervisor.mjs")),
  ]);
  if (serverStat.size === 0 || supervisorStat.size === 0) {
    throw new Error("Phase 0 MCP build emitted an empty artifact");
  }
  process.stderr.write(
    `Built disposable Phase 0 MCP fixture in ${outputRoot}\n`,
  );
}

void main();
