import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

describe("database lifecycle", () => {
  it("does not open or migrate the configured database when the module is only imported", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-db-import-"));
    const dbPath = path.join(tempDir, "import-only.db");
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "server/db/index.ts")).href;
    try {
      const child = spawnSync(process.execPath, [
        "--import", "tsx",
        "--input-type=module",
        "--eval", `const module = await import(${JSON.stringify(moduleUrl)}); Object.keys(module.db); void ("select" in module.db); Object.getPrototypeOf(module.db);`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, STAGEPASS_DB_PATH: dbPath },
        encoding: "utf-8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.existsSync(dbPath), false, "import created the database");
      assert.equal(fs.existsSync(`${dbPath}-wal`), false, "import created the WAL");
      assert.equal(fs.existsSync(`${dbPath}-shm`), false, "import created shared memory");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("can import the pipeline worker without starting it or touching SQLite", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-worker-import-"));
    const dbPath = path.join(tempDir, "worker-import.db");
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts/pipeline-worker.ts")).href;
    try {
      const child = spawnSync(process.execPath, [
        "--import", "tsx",
        "--input-type=module",
        "--eval", `await import(${JSON.stringify(moduleUrl)});`,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STAGEPASS_DB_PATH: dbPath,
          PIPELINE_WORKER_ID: "",
          PIPELINE_WORKER_INSTANCE_NONCE: "",
        },
        encoding: "utf-8",
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.existsSync(dbPath), false, "worker import created the database");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
