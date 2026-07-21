import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { projects, rubricCriteria, rubrics } from "../db/schema.ts";
import { factoryCriteria } from "./rubric-defaults.ts";
import {
  parseRubricFile,
  rubricFilePath,
  serializeRubricFile,
  syncRubricFileForScope,
  writeRubricFileForScope,
  type RubricFileLine,
} from "./rubric-file-service.ts";
import {
  ensureFactoryRubrics,
  getCurrentRubric,
  listRubricVersions,
  saveRubricVersion,
} from "./rubric-service.ts";
import { resolveStageRubric } from "./rubric-stage-service.ts";

const PROJECT_ID = "PRJ-RUBRIC-FILE-001";
const CHANGE_ID = "CHG-RUBRIC-FILE-001";
const PHASE = "Build" as const;
const ROLE = "producer" as const;

const PROJECT_SCOPE = {
  projectId: PROJECT_ID,
  changeId: null,
  phase: PHASE,
  role: ROLE,
};

let repoPath = "";

function cleanupRows() {
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-FILE-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-FILE-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-FILE-%")).run();
}

function seed() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric File Service",
      repoPath,
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function syncInput() {
  return { projectId: PROJECT_ID, repoPath, phase: PHASE, role: ROLE };
}

function filePath() {
  return rubricFilePath(repoPath, PHASE, ROLE);
}

function versionCount(): number {
  return listRubricVersions(PROJECT_SCOPE).length;
}

function currentKeys(): string[] {
  return getCurrentRubric(PROJECT_SCOPE)!.criteria.map((criterion) => criterion.criterionKey);
}

beforeEach(() => {
  cleanupRows();
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-file-service-"));
  seed();
});

afterEach(() => {
  cleanupRows();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("rubric file format", () => {
  it("round-trips byte-identically: serialize(parse(serialize(x))) === serialize(x)", () => {
    const lines: RubricFileLine[] = [
      // Tier-1 row: must normalise into the read-only section, forced blocking.
      { criterionKey: "RBK-factory-Build-producer-01", text: "我改动的每一个文件都在计划的 expectedFiles 范围内。", blocking: true },
      { criterionKey: "RBK-user-1", text: "用户写的阻断标准。", blocking: true },
      { criterionKey: "RBK-user-2", text: "用户写的仅记录标准。", blocking: false },
      // A new hand-written line without a key is legal.
      { criterionKey: null, text: "还没有 key 的新标准。", blocking: true },
    ];
    const once = serializeRubricFile(PHASE, ROLE, lines);
    const parsed = parseRubricFile(once);
    assert.ok(parsed.ok, "canonical form must parse");
    const twice = serializeRubricFile(PHASE, ROLE, parsed.lines);
    assert.equal(twice, once);
  });

  it("rejects a non-criterion prose line instead of silently dropping it", () => {
    const parsed = parseRubricFile("# 标题\n\n这句话不是标准行,但可能是用户想写的标准\n");
    assert.equal(parsed.ok, false);
  });
});

describe("syncRubricFileForScope", () => {
  it("bootstraps a missing file from the DB version without minting", () => {
    ensureFactoryRubrics(PROJECT_ID);
    assert.equal(versionCount(), 1);

    syncRubricFileForScope(syncInput());

    assert.equal(versionCount(), 1, "bootstrap must not mint a version");
    const content = fs.readFileSync(filePath(), "utf8");
    const record = getCurrentRubric(PROJECT_SCOPE)!;
    const expected = serializeRubricFile(
      PHASE,
      ROLE,
      record.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        text: criterion.text,
        blocking: criterion.blocking,
      })),
    );
    assert.equal(content, expected, "bootstrap writes the canonical form");
    assert.ok(content.includes("RBK-factory-Build-producer-01"));
  });

  it("does nothing for a scope that has no DB version (file cannot conjure a rubric)", () => {
    // QA has no factory rubric and nothing was saved: no version, no file.
    syncRubricFileForScope({ projectId: PROJECT_ID, repoPath, phase: "QA", role: "producer" });
    assert.equal(fs.existsSync(rubricFilePath(repoPath, "QA", "producer")), false);
  });

  it("a file edit is minted at stage-resolve time and judged by that very run", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 1);

    const added = "新增:构建产物里不允许出现调试输出。";
    fs.appendFileSync(filePath(), `- [!] ${added}\n`, "utf8");

    // The stage resolve itself must pick the edit up: this is the test that
    // goes RED if the sync call is removed from resolveStageRubric.
    const stageRubric = resolveStageRubric({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: PHASE,
      role: ROLE,
    });
    assert.ok(stageRubric);
    assert.equal(versionCount(), 2, "the edit mints exactly one new version");

    const criterion = stageRubric.rubric.criteria.find((row) => row.text === added);
    assert.ok(criterion, "the stage judges the post-sync version, not the pre-edit one");
    assert.equal(criterion.blocking, true);
    assert.ok(criterion.criterionKey.startsWith("RBK-"), "key minted by saveRubricVersion");
    assert.ok(
      !criterion.criterionKey.startsWith("RBK-factory-"),
      "a new line gets a fresh runtime key, never a factory identity",
    );

    const rewritten = fs.readFileSync(filePath(), "utf8");
    assert.ok(
      rewritten.includes(`${added} <!-- key: ${criterion.criterionKey} -->`),
      "the file is rewritten canonically with the minted key attached",
    );
  });

  it("repeated sync mints nothing, including across whitespace-only noise", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());
    fs.appendFileSync(filePath(), "- [ ] 一条真实的编辑。\n", "utf8");
    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2);

    // Second sync over the canonical rewrite: zero minting.
    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2, "sync twice, the second mints nothing");

    // Whitespace-only noise is not an edit: trailing spaces + extra blank lines.
    const noisy = fs
      .readFileSync(filePath(), "utf8")
      .replace("- [ ] 一条真实的编辑。", "- [ ] 一条真实的编辑。   ")
      .concat("\n\n");
    fs.writeFileSync(filePath(), noisy, "utf8");
    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2, "whitespace differences must not mint");
  });

  it("deleting a non-tier-1 line withdraws that criterion", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());
    assert.ok(currentKeys().includes("RBK-factory-Build-producer-03"));

    const withoutLine = fs
      .readFileSync(filePath(), "utf8")
      .split("\n")
      .filter((line) => !line.includes("RBK-factory-Build-producer-03"))
      .join("\n");
    fs.writeFileSync(filePath(), withoutLine, "utf8");

    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2);
    const keys = currentKeys();
    assert.ok(!keys.includes("RBK-factory-Build-producer-03"), "deleted line = withdrawn criterion");
    assert.equal(keys.length, factoryCriteria(PHASE, ROLE).length - 1);
  });

  it("deleting a tier-1 line does NOT stick: restored on the canonical rewrite", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());

    const withoutTier1 = fs
      .readFileSync(filePath(), "utf8")
      .split("\n")
      .filter((line) => !line.includes("RBK-factory-Build-producer-01"))
      .join("\n");
    fs.writeFileSync(filePath(), withoutTier1, "utf8");

    syncRubricFileForScope(syncInput());
    // The mint DOES happen (the file differed), but saveRubricVersion's tier-1
    // merge pins the row back in -- we verify the existing enforcement rather
    // than reimplementing it.
    assert.equal(versionCount(), 2);
    const record = getCurrentRubric(PROJECT_SCOPE)!;
    const tier1 = record.criteria.find(
      (criterion) => criterion.criterionKey === "RBK-factory-Build-producer-01",
    );
    assert.ok(tier1, "tier-1 criterion survives its deletion from the file");
    assert.equal(tier1.blocking, true);
    assert.ok(
      fs.readFileSync(filePath(), "utf8").includes("RBK-factory-Build-producer-01"),
      "the rewritten file carries the tier-1 line again",
    );
  });

  it("self-heals a pre-tier current version: stale tier-1 flags mint once, then stay quiet", () => {
    // A version seeded before the tier-1 registry existed: canonical texts,
    // tier-1 keys, but blocking=0 -- writable only by direct insert, which is
    // exactly how such a database looks. The canonical serializer renders
    // tier-1 lines `[!]` regardless of the stored flag, so the ordinary
    // hash comparison can never see this staleness; without the explicit
    // self-heal, every future verdict keeps hanging off the advisory version
    // and a tier-1 `no` derives nothing on the Build/Fix finding channel.
    const now = new Date().toISOString();
    const legacyId = "RUB-legacy-pretier";
    db.insert(rubrics)
      .values({
        id: legacyId,
        projectId: PROJECT_ID,
        changeId: null,
        phase: PHASE,
        role: ROLE,
        version: 1,
        isCurrent: 1,
        createdAt: now,
      })
      .run();
    factoryCriteria(PHASE, ROLE).forEach((criterion, ordinal) => {
      db.insert(rubricCriteria)
        .values({
          id: `RBC-legacy-${ordinal}`,
          rubricId: legacyId,
          criterionKey: criterion.criterionKey,
          ordinal,
          text: criterion.text,
          blocking: 0,
          createdAt: now,
        })
        .run();
    });

    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2, "the stale version mints exactly one successor");
    const healed = getCurrentRubric(PROJECT_SCOPE)!;
    for (const row of healed.criteria) {
      assert.equal(
        row.blocking,
        row.criterionKey === "RBK-factory-Build-producer-01"
        || row.criterionKey === "RBK-factory-Build-producer-02",
        `${row.criterionKey} blocking after heal`,
      );
    }

    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2, "a healed version mints nothing further");
  });

  it("an unparseable file mints nothing and is left byte-for-byte untouched", () => {
    ensureFactoryRubrics(PROJECT_ID);
    const manuscript = "# 我的草稿\n\n先记两笔,还没写成标准行的样子\n- [!] 这行是好的\n";
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), manuscript, "utf8");

    syncRubricFileForScope(syncInput());

    assert.equal(versionCount(), 1, "no version is minted from a failed parse");
    assert.equal(
      fs.readFileSync(filePath(), "utf8"),
      manuscript,
      "the user's manuscript must not be overwritten",
    );
  });

  it("rewording keeps identity: carried key wins, and unchanged text re-attaches its key", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());

    const reworded = "改写后的正文:测试必须先红后绿。";
    const content = fs
      .readFileSync(filePath(), "utf8")
      .split("\n")
      .map((line) => {
        // Reword -04 but keep its key comment (rule 1: carried key).
        if (line.includes("RBK-factory-Build-producer-04")) {
          return `- [!] ${reworded} <!-- key: RBK-factory-Build-producer-04 -->`;
        }
        // Strip -05's key comment but keep its text (rule 2: text match).
        if (line.includes("RBK-factory-Build-producer-05")) {
          return line.replace(" <!-- key: RBK-factory-Build-producer-05 -->", "");
        }
        return line;
      })
      .join("\n");
    fs.writeFileSync(filePath(), content, "utf8");

    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), 2);
    const record = getCurrentRubric(PROJECT_SCOPE)!;
    const rewordedRow = record.criteria.find((row) => row.text === reworded);
    assert.ok(rewordedRow);
    assert.equal(rewordedRow.criterionKey, "RBK-factory-Build-producer-04");
    assert.equal(rewordedRow.blocking, true, "the [!] marker in the file sets blocking");
    assert.ok(currentKeys().includes("RBK-factory-Build-producer-05"));
  });
});

describe("writeRubricFileForScope", () => {
  it("projects the current DB version out as the canonical file after a UI save", () => {
    ensureFactoryRubrics(PROJECT_ID);
    syncRubricFileForScope(syncInput());

    saveRubricVersion({
      ...PROJECT_SCOPE,
      criteria: [{ text: "UI 新增的标准。", blocking: false }],
    });
    writeRubricFileForScope(syncInput());

    const record = getCurrentRubric(PROJECT_SCOPE)!;
    const expected = serializeRubricFile(
      PHASE,
      ROLE,
      record.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        text: criterion.text,
        blocking: criterion.blocking,
      })),
    );
    assert.equal(fs.readFileSync(filePath(), "utf8"), expected);
    assert.ok(expected.includes("UI 新增的标准。"));

    // And the next sync reads the projection as canon: zero minting.
    const versions = versionCount();
    syncRubricFileForScope(syncInput());
    assert.equal(versionCount(), versions, "sync after UI projection must not revert the save");
  });
});
