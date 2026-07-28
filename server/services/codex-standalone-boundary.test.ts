import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const SOURCE_ROOTS = ["app", "server", "mcp"] as const;
const HISTORICAL_AUDIT_FILES = new Set([
  "server/db/migrate.ts",
  "server/db/schema.ts",
  "server/types/enums.ts",
  "server/services/codex-phase0-verifier-contract.ts",
]);
/**
 * The one module allowed to start turns over app-server.
 *
 * The rule this list narrows is not "turns are dangerous to start" but "there
 * must be exactly one place that starts them", so recovery has a single thing
 * to reason about. Adding a second entry here is an architecture change, not a
 * convenience -- prefer routing through the gateway.
 */
const TURN_STARTING_FILES = new Set([
  "server/services/codex-session-gateway.ts",
]);

function productionSources(): Array<{ file: string; source: string }> {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["__fixtures__", "fixtures", "generated"].includes(entry.name)) {
          visit(absolute);
        }
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name)
        && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ) {
        files.push(absolute);
      }
    }
  };
  for (const root of SOURCE_ROOTS) visit(path.join(ROOT, root));
  return files.map((file) => ({
    file: path.relative(ROOT, file).replaceAll(path.sep, "/"),
    source: fs.readFileSync(file, "utf8"),
  }));
}

describe("Codex standalone production boundary", () => {
  it("has no rollback engine import or managed app-server turn writer", () => {
    for (const fixture of productionSources()) {
      assert.doesNotMatch(
        fixture.source,
        /(?:from\s+|require\()["'].*codex-app-server-engine/,
        fixture.file,
      );
      if (
        !HISTORICAL_AUDIT_FILES.has(fixture.file)
        && !TURN_STARTING_FILES.has(fixture.file)
      ) {
        assert.doesNotMatch(fixture.source, /["']turn\/start["']/, fixture.file);
      }
    }
  });

  it("cannot construct a new legacy Web migration command", () => {
    for (const file of [
      "server/services/pipeline-command-types.ts",
      "server/services/pipeline-command-gateway.ts",
      "app/api/projects/[id]/changes/[changeId]/commands/route.ts",
    ]) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        /legacy_web_migration/,
        file,
      );
    }
  });

  it("keeps only the persistent shell/read/model app-server boundary", () => {
    const client = fs.readFileSync(
      path.join(ROOT, "server/services/codex-app-server-client.ts"),
      "utf8",
    );
    for (const allowed of [
      "thread/start",
      "thread/name/set",
      "thread/list",
      "thread/read",
      "model/list",
    ]) {
      assert.match(client, new RegExp(allowed.replace("/", "\\/")));
    }
    const adapter = fs.readFileSync(
      path.join(ROOT, "server/services/ai-engine-adapter.ts"),
      "utf8",
    );
    assert.match(adapter, /LazyCodexDesktopEngine/);
    assert.doesNotMatch(adapter, /desktopBridge|rollback|AppServerEngine/);
  });

  it("forces Desktop execution through the Server-owned logical turn", () => {
    const engine = fs.readFileSync(
      path.join(ROOT, "server/services/codex-desktop-engine.ts"),
      "utf8",
    );
    assert.match(engine, /ALLOWED_INPUT_KEYS = new Set\(\["logicalTurnId"\]\)/);
    assert.match(engine, /caller_identity_override/);
    assert.match(engine, /readLogicalTurnForStart\(logicalTurnId\)/);
    assert.doesNotMatch(engine, /probeFollower|openAndWaitForFollower|thread\/events/);
  });
});
