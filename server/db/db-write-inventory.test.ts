import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  computeDbWritePolicyDigest,
  readIndependentDbWritePolicy,
  scanDbWriteInventory,
  type DbWriteInventoryPolicy,
} from "./db-write-inventory";

const policy: DbWriteInventoryPolicy = {
  roots: ["server", "app", "scripts"],
  productionOwners: {},
  allowedTestScripts: [
    "scripts/test-retry-always-available.ts",
    "scripts/test-state-machine-closure.ts",
  ],
};

test("AST inventory distinguishes project DB writes from unrelated method names", () => {
  const result = scanDbWriteInventory(process.cwd(), policy, {
    virtualFiles: {
      "server/services/example.ts": `
        import { db as database } from "../db";
        const ordinary = { run() {}, insert() {} };
        ordinary.run();
        ordinary.insert();
        database.insert({}).values({}).run();
        database.transaction((transaction) => {
          transaction.update({}).set({}).run();
        });
      `,
    },
  });

  assert.deepEqual(
    result.writes.map((write) => [write.receiver, write.operation]),
    [
      ["database", "insert"],
      ["database", "transaction"],
      ["transaction", "update"],
    ],
  );
});

test("repository aliases are classified as lifecycle boundary writes", () => {
  const result = scanDbWriteInventory(process.cwd(), policy, {
    virtualFiles: {
      "server/services/example.ts": `
        import { runLedgerRepository as ledger } from "../repositories/run-ledger-repository";
        ledger.createRun({});
        ledger.endRun("RUN-1", {});
        ledger.patchChange("CHG-1", {});
      `,
    },
  });

  assert.deepEqual(
    result.boundaryCalls.map((call) => call.symbol),
    ["createRun", "endRun", "patchChange"],
  );
  assert.equal(result.writes.length, 0);
});

test("AST inventory follows project DB type aliases, typed parameters, and DB getters", () => {
  const result = scanDbWriteInventory(process.cwd(), policy, {
    virtualFiles: {
      "server/services/example.ts": `
        type ExampleDb = typeof import("../db/index").db;
        function writeWithParameter(storage: ExampleDb) {
          storage.delete({}).run();
        }
        function getExampleDb(): ExampleDb { throw new Error("fixture"); }
        const storage = getExampleDb();
        storage.update({}).set({}).run();
      `,
    },
  });

  assert.deepEqual(
    result.writes.map((write) => [write.receiver, write.operation]),
    [["storage", "delete"], ["storage", "update"]],
  );
});

test("Program type flow follows namespace, property, destructure, assignment, re-export, and getter aliases", () => {
  const result = scanDbWriteInventory(process.cwd(), policy, {
    virtualFiles: {
      "server/services/db-reexport.ts": `export { db as applicationDb } from "../db";`,
      "server/services/example.ts": `
        import * as databaseModule from "../db";
        import { applicationDb } from "./db-reexport";
        import { runLedgerRepository as originalLedger } from "../repositories/run-ledger-repository";
        const holder = { database: databaseModule.db, ledger: originalLedger };
        const { database: destructuredDb, ledger: destructuredLedger } = holder;
        let assignedDb = applicationDb;
        assignedDb = destructuredDb;
        function getDb() { return assignedDb; }
        getDb().insert({}).values({}).run();
        destructuredLedger.patchChange("CHG-1", {});
      `,
    },
  });

  assert.deepEqual(result.writes.map((write) => write.operation), ["insert"]);
  assert.deepEqual(result.boundaryCalls.map((call) => call.symbol), ["patchChange"]);
});

test("full Program inventory captures all three previously missed repositories", () => {
  const result = scanDbWriteInventory(process.cwd());
  for (const file of [
    "server/repositories/action-contract-repository.ts",
    "server/repositories/run-ledger-repository.ts",
    "server/repositories/stage-authority-repository.ts",
  ]) {
    assert.ok(result.files.includes(file), `missing ${file}`);
  }
  assert.equal(
    result.writes.some((write) => write.file === "server/services/plan-report-service.ts"),
    false,
    "crypto.update must not be classified as a DB write",
  );
});

test("full repository inventory has no unowned production DB writes", () => {
  const result = scanDbWriteInventory(process.cwd());
  assert.deepEqual(result.unclassified, []);
  assert.ok(result.writes.length > 0);
  assert.ok(result.files.length > 0);
});

test("fixed production snapshot matches production writes and pins independent policy semantics", () => {
  const result = scanDbWriteInventory(process.cwd());
  const snapshot = JSON.parse(
    fs.readFileSync("server/db/db-write-inventory.snapshot.json", "utf8"),
  ) as { schemaVersion: number; policySha256: string; entries: Array<{ file: string; symbol: string; nodeKind: string; table: string | null }> };
  const independentPolicy = readIndependentDbWritePolicy(process.cwd());
  const key = (entry: { file: string; symbol: string; nodeKind: string; table?: string | null; target?: string | null }) =>
    [entry.file, entry.symbol, entry.nodeKind, entry.table ?? entry.target ?? ""].join("|");
  const actual = [...new Set(result.writes
    .filter((write) => !write.file.endsWith(".test.ts") && !/scripts\/test-[^/]+\.ts$/.test(write.file))
    .map(key))].sort();
  const expected = snapshot.entries.map(key).sort();
  assert.deepEqual(actual, expected);
  assert.deepEqual(independentPolicy.productionEntries.map(key).sort(), expected);
  assert.ok(independentPolicy.productionEntries.every((entry) => entry.owner.trim() && entry.reason.trim()));
  assert.equal(snapshot.policySha256, computeDbWritePolicyDigest(independentPolicy.productionEntries));
});

test("real test DB writes are scanned and each file proves its declared DB injection", () => {
  const result = scanDbWriteInventory(process.cwd());
  const policyFile = readIndependentDbWritePolicy(process.cwd());
  const testWrites = result.writes.filter((write) =>
    write.file.endsWith(".test.ts") || /scripts\/test-[^/]+\.ts$/.test(write.file));
  const scannedFiles = new Set(testWrites.map((write) => write.file));

  assert.ok(scannedFiles.has("server/services/pipeline-service.test.ts"));
  assert.ok(scannedFiles.has("server/db/sqlite-lock-retry.test.ts"));
  assert.ok(testWrites.length > 0);
  assert.ok(testWrites.every((write) => write.owner === "test-fixture"));
  for (const file of scannedFiles) {
    assert.ok(policyFile.testFixtures.some((fixture) => fixture.file === file), `missing fixture policy for ${file}`);
  }
});

test("test DB writes require an explicit fixture entry and matching injection proof", () => {
  const fixturePolicy: DbWriteInventoryPolicy = {
    ...policy,
    testFixtures: [{
      file: "server/services/fixture.test.ts",
      mode: "local-memory",
      reason: "fixture owns an in-memory SQLite database",
    }],
  };
  const withoutInjection = scanDbWriteInventory(process.cwd(), fixturePolicy, {
    virtualFiles: {
      "server/services/fixture.test.ts": `
        import { db } from "../db";
        db.insert({}).values({}).run();
      `,
    },
  });
  assert.equal(withoutInjection.unclassified.length, 1);

  const isolated = scanDbWriteInventory(process.cwd(), fixturePolicy, {
    virtualFiles: {
      "server/services/fixture.test.ts": `
        import Database from "better-sqlite3";
        import { drizzle } from "drizzle-orm/better-sqlite3";
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        db.insert({}).values({}).run();
      `,
    },
  });
  assert.equal(isolated.unclassified.length, 0);
  assert.equal(isolated.writes[0]?.owner, "test-fixture");
});

test("allowlist matching rejects a write when any exact write-point field drifts", () => {
  const exactPolicy: DbWriteInventoryPolicy = {
    ...policy,
    allowlist: [{
      file: "server/services/example.ts",
      symbol: "database.insert",
      nodeKind: "CallExpression",
      table: "events",
      owner: "Task 14",
      reason: "fixture exact owner",
    }],
  };
  const result = scanDbWriteInventory(process.cwd(), exactPolicy, {
    virtualFiles: {
      "server/services/example.ts": `
        import { db as database } from "../db";
        import { changes } from "../db/schema";
        database.insert(changes).values({}).run();
      `,
    },
  });
  assert.equal(result.unclassified.length, 1);
});

test("independent policy digest detects exact owner and reason drift", () => {
  const entries = readIndependentDbWritePolicy(process.cwd()).productionEntries;
  assert.ok(entries.length > 0);
  const baseline = computeDbWritePolicyDigest(entries);
  const ownerDrift = entries.map((entry, index) => index === 0 ? { ...entry, owner: `${entry.owner}-drift` } : entry);
  const reasonDrift = entries.map((entry, index) => index === 0 ? { ...entry, reason: `${entry.reason}-drift` } : entry);
  assert.notEqual(computeDbWritePolicyDigest(ownerDrift), baseline);
  assert.notEqual(computeDbWritePolicyDigest(reasonDrift), baseline);
});

test("better-sqlite3 native prepare run, statement aliases, and exec writes are classified", () => {
  const nativePolicy: DbWriteInventoryPolicy = {
    ...policy,
    testFixtures: [{
      file: "server/services/native.test.ts",
      mode: "local-memory",
      reason: "fixture owns an in-memory SQLite database",
    }],
  };
  const result = scanDbWriteInventory(process.cwd(), nativePolicy, {
    virtualFiles: {
      "server/services/native.test.ts": `
        import Database from "better-sqlite3";
        const sqlite = new Database(":memory:");
        sqlite.prepare("INSERT INTO events (id) VALUES (?)").run("EVT-1");
        const statement = sqlite.prepare("UPDATE changes SET status = ? WHERE id = ?");
        statement.run("FAILED", "CHG-1");
        sqlite.exec("CREATE TABLE IF NOT EXISTS fixture_rows (id text)");
        const ordinary = { run() {}, exec() {} };
        ordinary.run();
        ordinary.exec();
      `,
    },
  });

  assert.deepEqual(result.writes.map(({ operation, target }) => [operation, target]), [
    ["run", "events"],
    ["run", "changes"],
    ["exec", "fixture_rows"],
  ]);
  assert.deepEqual(result.unclassified, []);
});

test("provider worker stages do not bypass run-ledger or change write boundaries", () => {
  const result = scanDbWriteInventory(process.cwd());
  const workerFiles = new Set([
    "server/services/pipeline-service.ts",
    "server/services/pipeline-build-stage-service.ts",
    "server/services/pipeline-document-stage-runner-service.ts",
    "server/services/pipeline-plan-stage-service.ts",
    "server/services/pipeline-prd-briefing-stage-service.ts",
    "server/services/pipeline-qa-stage-service.ts",
    "server/services/pipeline-release-retro-stage-service.ts",
    "server/services/pipeline-review-stage-service.ts",
    "server/services/pipeline-spec-stage-service.ts",
  ]);
  const bypasses = result.writes.filter((write) =>
    workerFiles.has(write.file)
    && ["runs", "changes", "events", "artifacts", "findings"].includes(write.target ?? ""),
  );

  assert.deepEqual(bypasses, []);
});
