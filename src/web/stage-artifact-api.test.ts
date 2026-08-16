import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import type { StageRoundArtifact } from "../domain/stage-artifact";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { StageArtifactStore } from "../store/stage-artifact-store";
import { createRepoOps } from "../work/repo";
import { createStageArtifactApi } from "./stage-artifact-api";

const AT = "2026-08-16T12:00:00.000Z";

interface Fixture {
  database: Database.Database;
  root: string;
  sha1: string;
  sha2: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "stagepass-stage-api-"));
  const git = (...args: string[]): string => execFileSync("git", args, {
    cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "round 1");
  const sha1 = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "b.ts"), 'import { a } from "./a"; export const b = a;\n');
  git("add", "-A");
  git("commit", "-q", "-m", "round 2");
  const sha2 = git("rev-parse", "HEAD").trim();

  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "Project", root);
  new ChangeStore(database).create("CHG-1", { projectId: "PRJ-1" });
  const artifacts = new StageArtifactStore(database);
  const upstream = [{ phase: "Arch" as const, artifactIds: ["arch.md"] }];
  const r1: StageRoundArtifact = {
    changeId: "CHG-1", phase: "Build", round: 1, jobId: "JOB-1",
    artifactIds: [sha1], commit: sha1, source: "recorded", upstream,
    files: [{ path: "a.ts", role: "delivery", change: "added" }], settledAt: AT,
  };
  artifacts.record(r1);
  artifacts.record({
    ...r1,
    round: 2,
    jobId: "JOB-2",
    artifactIds: [sha2],
    commit: sha2,
    files: [
      { path: "a.ts", role: "delivery", change: "modified" },
      { path: "b.ts", role: "delivery", change: "added" },
    ],
    settledAt: "2026-08-16T13:00:00.000Z",
  });
  const gaps = new GapStore(database, () => new Date(AT));
  gaps.settleRound("CHG-1", "Build", {
    round: 2,
    found: [
      {
        id: "G-FILE", severity: "P1", title: "A 文件问题", where: "a.ts",
        why: "exact", owner: null,
      },
      {
        id: "G-STAGE", severity: "P2", title: "阶段问题", where: "a.ts:1",
        why: "not exact", owner: null,
      },
    ],
    verdicts: {},
  });

  return { database, root, sha1, sha2 };
}

async function withApi(
  context: Fixture,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const handler = createStageArtifactApi({ database: context.database, repo: createRepoOps() });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://panel.invalid");
    void handler(url, request, response).then((handled) => {
      if (!handled) response.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function json(base: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

function counts(database: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of [
    "jobs", "turns", "questions", "change_events", "change_evidence",
    "stage_round_artifacts", "gaps",
  ]) {
    result[table] = (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count;
  }
  return result;
}

describe("read-only Stage artifact API", () => {
  it("returns newest scene, round switching, details and exact gap associations", async () => {
    const context = fixture();
    const before = counts(context.database);
    await withApi(context, async (base) => {
      const latest = await json(base, "/api/stage-artifacts?change=CHG-1&phase=Build");
      assert.equal(latest.status, 200);
      assert.equal(latest.body.rounds[0].round, 2);
      assert.deepEqual(latest.body.scene.files.map((file: { path: string }) => file.path),
        ["a.ts", "b.ts"]);
      assert.deepEqual(latest.body.fileFacts["a.ts"].map((gap: { id: string }) => gap.id),
        ["G-FILE"]);
      assert.deepEqual(latest.body.stageFacts.map((gap: { id: string }) => gap.id),
        ["G-STAGE"]);

      const old = await json(base,
        "/api/stage-artifacts?change=CHG-1&phase=Build&round=1");
      assert.equal(old.body.selectedRound, 1);
      assert.deepEqual(old.body.scene.files.map((file: { path: string }) => file.path), ["a.ts"]);

      const file = await json(base,
        "/api/stage-file?change=CHG-1&phase=Build&round=2&path=a.ts");
      assert.equal(file.status, 200);
      assert.match(file.body.content, /a = 2/);
      assert.match(file.body.diff, /^\+export const a = 2/m);
      assert.equal(file.body.dependencies.blast, 1);
      assert.deepEqual(file.body.relatedGaps.map((gap: { id: string }) => gap.id), ["G-FILE"]);
    });
    assert.deepEqual(counts(context.database), before, "GET 改了业务数据");
    context.database.close();
  });

  it("reconstructs proven legacy facts without inserting a ledger row", async () => {
    const context = fixture();
    const changes = new ChangeStore(context.database);
    changes.create("CHG-LEG", { projectId: "PRJ-1" });
    const path = join(context.root, "docs/stagepass/CHG-LEG");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "PRD-r1.md"), "# old\n");
    writeFileSync(join(path, "PRD-r1-opposition.md"), "# old blue\n");
    execFileSync("git", ["add", "-A"], { cwd: context.root });
    execFileSync("git", ["commit", "-q", "-m", "legacy evidence"], { cwd: context.root });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: context.root, encoding: "utf-8",
    }).trim();
    new EvidenceStore(context.database, () => new Date(AT)).put("CHG-LEG", "PRD", {
      artifactIds: [sha], blockers: [], waivedBlockerIds: [],
    });

    await withApi(context, async (base) => {
      const response = await json(base,
        "/api/stage-artifacts?change=CHG-LEG&phase=PRD");
      assert.equal(response.status, 200);
      assert.equal(response.body.rounds[0].source, "reconstructed");
      assert.equal(response.body.incompleteRounds.length, 0);
    });
    assert.equal(new StageArtifactStore(context.database).list("CHG-LEG", "PRD").length, 0);
    context.database.close();
  });

  it("rejects invalid identity, phase, round, method and commit injection", async () => {
    const context = fixture();
    await withApi(context, async (base) => {
      for (const [path, status, error] of [
        ["/api/stage-artifacts?phase=Build", 400, "change-required"],
        ["/api/stage-artifacts?change=CHG-1&phase=Nope", 400, "phase-invalid"],
        ["/api/stage-artifacts?change=missing&phase=Build", 404, "change-unknown"],
        ["/api/stage-artifacts?change=CHG-1&phase=Build&round=0", 400, "round-invalid"],
        ["/api/stage-file?change=CHG-1&phase=Build&round=2", 400, "path-required"],
        ["/api/stage-file?change=CHG-1&phase=Build&round=2&path=no.ts", 404,
          "path-not-in-round"],
        ["/api/stage-file?change=CHG-1&phase=Build&round=2&path=a.ts&commit=0000000",
          400, "commit-not-accepted"],
      ] as const) {
        const response = await json(base, path);
        assert.equal(response.status, status, path);
        assert.equal(response.body.error, error, path);
      }
      const post = await fetch(
        `${base}/api/stage-artifacts?change=CHG-1&phase=Build`, { method: "POST" },
      );
      assert.equal(post.status, 405);
    });
    context.database.close();
  });
});
