import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import {
  SqliteWriteBusyError,
  isRetryableSqliteWriteError,
  withSqliteWriteRetry,
} from "./write-boundary";

function sqliteError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function createTempDatabase(): { dbPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-lock-retry-"));
  return { dbPath: path.join(tempDir, "test.db"), tempDir };
}

function captureError(write: () => unknown): unknown {
  try {
    write();
  } catch (error) {
    return error;
  }
  assert.fail("expected write to throw");
}

describe("sqlite write boundary", { concurrency: false }, () => {
  it("retries a real short SQLite write lock and returns the successful result", async () => {
    const { dbPath, tempDir } = createTempDatabase();
    const writer = new Database(dbPath);
    writer.exec("CREATE TABLE items (value TEXT NOT NULL)");
    writer.pragma("busy_timeout = 0");

    const require = createRequire(import.meta.url);
    const lockOwner = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const Database = require(workerData.databaseModulePath);
        const db = new Database(workerData.dbPath);
        db.pragma("busy_timeout = 0");
        db.exec("BEGIN IMMEDIATE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
        }, workerData.holdMs);
      `,
      {
        eval: true,
        workerData: {
          databaseModulePath: require.resolve("better-sqlite3"),
          dbPath,
          holdMs: 100,
        },
      },
    );
    const lockOwnerExited = new Promise<void>((resolve, reject) => {
      lockOwner.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`lock owner exited with ${code}`)),
      );
      lockOwner.once("error", reject);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        lockOwner.once("message", (message) =>
          message === "locked" ? resolve() : reject(new Error(`unexpected message: ${message}`)),
        );
        lockOwner.once("error", reject);
      });

      let attempts = 0;
      const startedAt = Date.now();
      const result = withSqliteWriteRetry(
        "test.real-short-lock",
        () => {
          attempts += 1;
          writer.prepare("INSERT INTO items (value) VALUES (?)").run("written");
          return "ok";
        },
        { delaysMs: [20], maxAttempts: 10 },
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result, "ok");
      assert.ok(attempts > 1);
      assert.ok(elapsedMs >= 40, `expected a real wait, received ${elapsedMs}ms`);
      assert.deepEqual(writer.prepare("SELECT value FROM items").pluck().all(), ["written"]);
      await lockOwnerExited;
    } finally {
      await lockOwner.terminate();
      writer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not retry non-SQLite-lock errors", () => {
    let attempts = 0;
    const original = sqliteError("SQLITE_CONSTRAINT", "constraint failed");

    const thrown = captureError(() =>
      withSqliteWriteRetry(
        "test.non-retryable",
        () => {
          attempts += 1;
          throw original;
        },
        { delaysMs: [0, 0], maxAttempts: 3 },
      ),
    );
    assert.equal(thrown, original);
    assert.equal(attempts, 1);
  });

  it("throws the stable typed error contract when a real long lock exhausts retries", () => {
    const { dbPath, tempDir } = createTempDatabase();
    const lockOwner = new Database(dbPath);
    const writer = new Database(dbPath);
    lockOwner.exec("CREATE TABLE items (value TEXT NOT NULL)");
    lockOwner.pragma("busy_timeout = 0");
    writer.pragma("busy_timeout = 0");
    lockOwner.exec("BEGIN IMMEDIATE");

    try {
      const thrown = captureError(() =>
        withSqliteWriteRetry(
          "test.real-long-lock",
          () => writer.prepare("INSERT INTO items (value) VALUES (?)").run("blocked"),
          { delaysMs: [15], maxAttempts: 2 },
        ),
      );
      assert.ok(thrown instanceof SqliteWriteBusyError);

      assert.deepEqual(
        {
          name: thrown.name,
          code: thrown.code,
          label: thrown.label,
          attempts: thrown.attempts,
          sqliteCode: thrown.sqliteCode,
        },
        {
          name: "SqliteWriteBusyError",
          code: "sqlite_write_busy",
          label: "test.real-long-lock",
          attempts: 2,
          sqliteCode: "SQLITE_BUSY",
        },
      );
      assert.ok(thrown.elapsedMs >= 15, `expected elapsedMs >= 15, received ${thrown.elapsedMs}`);
    } finally {
      lockOwner.exec("ROLLBACK");
      writer.close();
      lockOwner.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recognizes sqlite busy and locked error shapes", () => {
    assert.equal(isRetryableSqliteWriteError(sqliteError("SQLITE_BUSY", "busy")), true);
    assert.equal(isRetryableSqliteWriteError(sqliteError("SQLITE_LOCKED", "locked")), true);
    assert.equal(isRetryableSqliteWriteError(new Error("database is locked")), true);
    assert.equal(isRetryableSqliteWriteError(new Error("no such table")), false);
  });

  it("preserves the extended SQLite result code for diagnostics", () => {
    const thrown = captureError(() =>
      withSqliteWriteRetry(
        "test.busy-snapshot",
        () => { throw sqliteError("SQLITE_BUSY_SNAPSHOT", "database is locked"); },
        { delaysMs: [], maxAttempts: 1 },
      ),
    );
    assert.ok(thrown instanceof SqliteWriteBusyError);
    assert.equal(thrown.sqliteCode, "SQLITE_BUSY");
    assert.equal(thrown.sqliteExtendedCode, "SQLITE_BUSY_SNAPSHOT");
  });

  it("reports UNKNOWN_LOCK for recognized lock text without a SQLite code", () => {
    const thrown = captureError(() =>
      withSqliteWriteRetry(
        "test.message-lock",
        () => {
          throw new Error("database table is locked");
        },
        { delaysMs: [], maxAttempts: 1 },
      ),
    );
    assert.ok(thrown instanceof SqliteWriteBusyError);

    assert.equal(thrown.sqliteCode, "UNKNOWN_LOCK");
  });

  it("logs only sanitized retry metadata", () => {
    const require = createRequire(import.meta.url);
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "server", "db", "write-boundary.ts"),
    ).href;
    const sensitiveValues = [
      "INSERT INTO secrets VALUES (?)",
      "customer-42-token",
      "/private/customer/acme.db",
      "Acme confidential payload",
    ];
    const errorMessage = sensitiveValues.join(" | ");
    const script = `
      import { withSqliteWriteRetry } from ${JSON.stringify(moduleUrl)};
      const source = Object.assign(new Error(${JSON.stringify(errorMessage)}), {
        code: "SQLITE_BUSY",
      });
      try {
        withSqliteWriteRetry("test.sanitized-log", () => { throw source; }, {
          delaysMs: [0],
          maxAttempts: 2,
        });
      } catch (error) {
        console.log("ERROR_SNAPSHOT " + JSON.stringify({
          code: error.code,
          label: error.label,
          attempts: error.attempts,
          elapsedMs: error.elapsedMs,
          sqliteCode: error.sqliteCode,
        }));
      }
    `;
    const output = execFileSync(process.execPath, [require.resolve("tsx/cli"), "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "warn" },
    });
    const logLine = output
      .split("\n")
      .find((line) => line.startsWith("{") && line.includes("SQLite write locked; retrying"));

    assert.ok(logLine, `expected structured retry log in output: ${output}`);
    const entry = JSON.parse(logLine) as Record<string, unknown>;
    assert.deepEqual(
      {
        label: entry.label,
        attempt: entry.attempt,
        sqliteCode: entry.sqliteCode,
      },
      {
        label: "test.sanitized-log",
        attempt: 1,
        sqliteCode: "SQLITE_BUSY",
      },
    );
    assert.equal(typeof entry.elapsedMs, "number");
    assert.ok(Number.isFinite(entry.elapsedMs) && (entry.elapsedMs as number) >= 0);
    for (const sensitive of sensitiveValues) {
      assert.doesNotMatch(output, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("keeps stage authority combined writes behind retry transactions", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "stage-authority-service.ts"),
      "utf8",
    );

    assert.match(source, /export function completeStageRun[\s\S]*withStageAuthorityTransaction/);
    assert.match(source, /export function recomputeStageGate[\s\S]*withStageAuthorityTransaction/);
    assert.match(source, /export function getStageAuthority[\s\S]*withStageAuthorityTransaction/);
    assert.doesNotMatch(source, /stageAuthorityRepository\.completeStageRun/);
    assert.doesNotMatch(source, /stageAuthorityRepository\.insertStageReport/);
    assert.doesNotMatch(source, /stageAuthorityRepository\.insertStageGate/);
  });
});
