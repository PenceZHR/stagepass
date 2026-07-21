import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { projects } from "../db/schema";
import { createChildLogger } from "../logger";
import type { RubricPhase, RubricRole } from "./rubric-assessment";
import {
  getCurrentRubric,
  saveRubricVersion,
  type RubricVersionRecord,
} from "./rubric-service";
import { TIER1_CRITERION_KEYS, tier1CriteriaForScope } from "./rubric-tiers";

const log = createChildLogger("rubric-file-service");

/**
 * `.ship/rubrics/<phase>-<role>.md` <-> DB synchronisation (design §2.3,
 * approach C): the FILE owns the text, the DB owns the state.
 *
 * Only PROJECT-level rubrics (`changeId = null`) have a file. Change-level
 * overrides stay DB/UI-only: a file has no place to say which change it means,
 * and giving it one would turn a repo checkout into an override editor.
 *
 * ## File format
 *
 * One criterion per line, everything about it visible and editable in-line:
 *
 *     - [!] 正文 <!-- key: RBK-… -->     ← blocking
 *     - [ ] 正文 <!-- key: RBK-… -->     ← advisory (仅记录)
 *     - [!] 新写的一条标准               ← a NEW criterion: no key yet
 *
 * The trailing key comment is the criterion's identity across versions (§5.1).
 * A line without one is a new criterion; its key is minted by
 * saveRubricVersion's resolveCriterionKeys (unchanged wording re-attaches to
 * its old key, genuinely new wording gets a fresh `RBK-<uuid>`). THIS MODULE
 * NEVER MINTS KEYS -- it only round-trips what the DB decided.
 *
 * Tier-1 lines sit in their own section at the top, labelled read-only.
 * Deleting or editing them does not stick: the file's criteria are pushed
 * through saveRubricVersion, whose mergeTier1Criteria pins the canonical rows
 * back in, and the canonical rewrite puts the lines back. Deleting any OTHER
 * line withdraws that criterion -- the existing retirement chain
 * (blockingCriterionKeysInForce) takes it from there.
 *
 * ## Sync semantics (design §2.3, do not drift)
 *
 *  1. `syncRubricFileForScope` runs at stage-resolve time, BEFORE the stage
 *     reads its effective rubric, so a file edit is judged by the very run
 *     that picked it up.
 *  2. Comparison is between CANONICAL serialisations -- serialize(parse(file))
 *     vs serialize(current DB version) -- never raw bytes, so whitespace or
 *     comment noise cannot trigger an endless mint loop. Different canon =>
 *     MINT A NEW VERSION via saveRubricVersion (old versions are never
 *     edited), then rewrite the file in canonical form.
 *  3. Missing file => bootstrap: write the canonical form of the current DB
 *     version. No mint -- nothing changed, the file just did not exist yet.
 *  4. Unparseable file => NO mint, NO rewrite. Rewriting would destroy a
 *     manuscript the user was mid-way through; minting from a failed parse
 *     would judge the stage against text nobody wrote. We log a warning and
 *     the stage proceeds on the DB version, which is exactly the pre-file
 *     behaviour.
 *  5. Two processes (web + worker) may sync concurrently. Version integrity is
 *     saveRubricVersion's transaction + unique indexes; our only job is to not
 *     kill the stage when we lose that race: catch, re-read the winner's
 *     version, project it back into the file.
 *  6. Writes are atomic (tmp + rename), so a reader never sees a half file.
 *
 * `syncRubricFileForScope` NEVER THROWS: a rubric file problem must degrade to
 * "DB is authoritative", not fail the stage that was passing through.
 *
 * `writeRubricFileForScope` is the projection direction only: after a UI save,
 * the file must be rewritten so the next sync does not read the pre-edit file
 * as a user edit and revert the save. It MAY throw on real fs failures so the
 * caller can surface them -- silently skipping would set up exactly that
 * revert.
 */

export interface RubricFileLine {
  /** null = a new hand-written line that has no identity yet. */
  criterionKey: string | null;
  text: string;
  blocking: boolean;
}

export type RubricFileParseResult =
  | { ok: true; lines: RubricFileLine[] }
  | { ok: false; message: string };

const TIER1_SECTION_HEADER = "## 一级标准（只读：删除或修改会在下次同步时被自动还原）";
const EDITABLE_SECTION_HEADER = "## 项目标准（可编辑）";
const INSTRUCTIONS = [
  "<!-- 本文件由 StagePass 维护，是该项目此阶段评分标准的正文（项目级）。 -->",
  "<!-- 每行一条标准：`- [!] 正文` 为阻断项，`- [ ] 正文` 为仅记录。 -->",
  "<!-- 删除一行即撤下该标准；新增一行可以不写 key，保存时会自动分配。 -->",
  "<!-- 行尾的 key 注释是该标准的跨版本身份，请勿手工修改或复制。 -->",
];

export function rubricFilePath(
  repoPath: string,
  phase: RubricPhase,
  role: RubricRole,
): string {
  return path.join(repoPath, ".ship", "rubrics", `${phase}-${role}.md`);
}

function formatLine(line: RubricFileLine): string {
  const marker = line.blocking ? "!" : " ";
  const keySuffix = line.criterionKey ? ` <!-- key: ${line.criterionKey} -->` : "";
  return `- [${marker}] ${line.text.trim()}${keySuffix}`;
}

/**
 * Canonical serialisation. Byte-deterministic in its inputs, which is what the
 * sync comparison and the "repeat sync mints nothing" guarantee stand on:
 * serialize(parse(serialize(x))) === serialize(x).
 *
 * Tier-1 membership is derived from the KEY, not from which section a line
 * was found in, so a tier-1 line dragged into the editable section normalises
 * back to the top -- section placement is presentation, the key is identity.
 * Tier-1 lines render blocking unconditionally (§2.1 恒阻断): the marker on a
 * tier-1 file line is not consulted, matching saveRubricVersion.
 */
export function serializeRubricFile(
  phase: RubricPhase,
  role: RubricRole,
  lines: readonly RubricFileLine[],
): string {
  const isTier1 = (line: RubricFileLine): boolean =>
    line.criterionKey !== null && TIER1_CRITERION_KEYS.has(line.criterionKey);
  const tier1 = lines.filter(isTier1);
  const rest = lines.filter((line) => !isTier1(line));

  const out: string[] = [`# ${phase} ${role} 评分标准`, "", ...INSTRUCTIONS, ""];
  if (tier1.length > 0) {
    out.push(TIER1_SECTION_HEADER, "");
    for (const line of tier1) out.push(formatLine({ ...line, blocking: true }));
    out.push("");
  }
  out.push(EDITABLE_SECTION_HEADER, "");
  for (const line of rest) out.push(formatLine(line));
  return `${out.join("\n")}\n`;
}

const CRITERION_LINE = /^- \[(!| )\] (.+)$/;
const KEY_SUFFIX = /^(.*?)\s*<!--\s*key:\s*(\S+)\s*-->$/;

/**
 * Strict on purpose. Headings, blank lines and full-line comments are
 * scaffolding and are skipped; a `- ` line must parse as a criterion; and any
 * OTHER non-empty line is a parse FAILURE rather than a skip. Skipping it
 * would mean the next canonical rewrite silently deletes prose the user
 * probably meant as a criterion -- failing the parse keeps their file intact
 * (sync rule 4) and tells them why in the log.
 */
export function parseRubricFile(content: string): RubricFileParseResult {
  const lines: RubricFileLine[] = [];
  const rawLines = content.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!.trimEnd();
    if (line.trim() === "") continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--") && line.endsWith("-->")) continue;

    const matched = CRITERION_LINE.exec(line);
    if (!matched) {
      return {
        ok: false,
        message: `第 ${index + 1} 行无法解析为标准行（应为 \`- [!] 正文\` 或 \`- [ ] 正文\`）: ${line}`,
      };
    }
    const blocking = matched[1] === "!";
    let text = matched[2]!;
    let criterionKey: string | null = null;
    const keyed = KEY_SUFFIX.exec(text);
    if (keyed) {
      text = keyed[1]!;
      criterionKey = keyed[2]!;
    }
    text = text.trim();
    if (text === "") {
      return { ok: false, message: `第 ${index + 1} 行的标准正文为空` };
    }
    lines.push({ criterionKey, text, blocking });
  }
  return { ok: true, lines };
}

function recordToLines(record: RubricVersionRecord): RubricFileLine[] {
  return record.criteria.map((criterion) => ({
    criterionKey: criterion.criterionKey,
    text: criterion.text,
    blocking: criterion.blocking,
  }));
}

/** tmp + rename in the same directory, so a reader never sees a torn file. */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * File -> DB at stage-resolve time. Never throws; see the module comment for
 * the full contract. The scope is always the PROJECT-level rubric.
 */
export function syncRubricFileForScope(input: {
  projectId: string;
  repoPath: string;
  phase: RubricPhase;
  role: RubricRole;
}): void {
  try {
    syncRubricFileForScopeInner(input);
  } catch (err) {
    // A rubric FILE problem must never cost the stage that was merely passing
    // through: the DB version stays authoritative and the run proceeds on it.
    log.warn(
      { err, projectId: input.projectId, phase: input.phase, role: input.role },
      "rubric file sync failed; stage continues on the DB version",
    );
  }
}

function syncRubricFileForScopeInner(input: {
  projectId: string;
  repoPath: string;
  phase: RubricPhase;
  role: RubricRole;
}): void {
  const scope = {
    projectId: input.projectId,
    changeId: null,
    phase: input.phase,
    role: input.role,
  } as const;

  // No DB version => no sync. The DB owns the state (§2.3): a file cannot
  // conjure a rubric into a scope that has none -- ensureFactoryRubrics has
  // already run by the time we are called, so "none" is a deliberate state
  // (a scope that ships no factory criteria), not a missed seed.
  let current = getCurrentRubric(scope);
  if (!current) return;

  // Self-heal a pre-tier current version. Rows seeded before the tier-1
  // registry existed carry `blocking = 0` on tier-1 keys (or miss a tier-1 row
  // outright), and the canonical serialization CANNOT surface that: it renders
  // tier-1 lines `[!]` unconditionally, so file and DB always compare equal
  // and the ordinary mint below never fires. Left alone, every new verdict on
  // this scope keeps hanging off the stale version, and the Build/Fix finding
  // channel -- which reads the flags as they stood WHEN JUDGED (§4.3.1) --
  // would derive nothing from a tier-1 `no`, making 恒阻断 a dead letter on
  // exactly the projects that existed before tier-1 shipped. Minting here puts
  // every FUTURE judgment on a version whose tier-1 rows block; historical
  // batches stay pinned to the version they were judged by, so this opens no
  // blocker retroactively (§4.3.1: an edit may only ever CLOSE one).
  const tier1Stale =
    tier1CriteriaForScope(input.phase, input.role).some(
      (canon) =>
        !current!.criteria.some(
          (row) => row.criterionKey === canon.criterionKey && row.blocking && row.text === canon.text,
        ),
    );
  if (tier1Stale) {
    current = saveRubricVersion({
      ...scope,
      criteria: current.criteria.map((row) => ({
        text: row.text,
        blocking: row.blocking,
        criterionKey: row.criterionKey,
      })),
    });
  }

  // A repoPath whose directory is gone (repo deleted or moved) gets no
  // `.ship/rubrics/` resurrected at its old address.
  if (!fs.existsSync(input.repoPath) || !fs.statSync(input.repoPath).isDirectory()) return;

  const filePath = rubricFilePath(input.repoPath, input.phase, input.role);
  const canonicalDb = serializeRubricFile(input.phase, input.role, recordToLines(current));

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Bootstrap: project the DB out. Nothing changed, so nothing is minted.
    writeFileAtomic(filePath, canonicalDb);
    return;
  }

  const parsed = parseRubricFile(raw);
  if (!parsed.ok) {
    // Rule 4: neither mint nor rewrite. The user's manuscript survives intact,
    // the stage runs on the DB version, and the warning names the line.
    log.warn(
      { filePath, reason: parsed.message },
      "rubric file did not parse; leaving the file untouched and running on the DB version",
    );
    return;
  }

  // Hash-equivalent comparison on CANONICAL forms (rule 2): a file that
  // differs only in whitespace, comments or section placement is the same
  // rubric and mints nothing.
  const canonicalFile = serializeRubricFile(input.phase, input.role, parsed.lines);
  if (canonicalFile === canonicalDb) return;

  let saved: RubricVersionRecord;
  try {
    saved = saveRubricVersion({
      ...scope,
      criteria: parsed.lines.map((line) => ({
        text: line.text,
        blocking: line.blocking,
        criterionKey: line.criterionKey ?? undefined,
      })),
    });
  } catch (err) {
    // Rule 5: lost a concurrent-mint race (web vs worker). The winner's
    // version is the truth now; re-read it and project it into the file so
    // both processes converge on the same canon.
    log.warn(
      { err, filePath },
      "rubric file mint lost a concurrent save; re-reading the current version",
    );
    const reread = getCurrentRubric(scope);
    if (reread) {
      writeFileAtomic(filePath, serializeRubricFile(input.phase, input.role, recordToLines(reread)));
    }
    return;
  }

  // Rewrite in canonical form. This is also what restores deleted tier-1
  // lines: mergeTier1Criteria pinned them back into `saved`, we just print it.
  writeFileAtomic(filePath, serializeRubricFile(input.phase, input.role, recordToLines(saved)));
}

/**
 * DB -> file projection after a UI save (the PUT route calls this). Writes the
 * current project-level version in canonical form so the next sync sees the
 * post-save state instead of reading the stale file as a user edit.
 */
export function writeRubricFileForScope(input: {
  projectId: string;
  repoPath: string;
  phase: RubricPhase;
  role: RubricRole;
}): void {
  const current = getCurrentRubric({
    projectId: input.projectId,
    changeId: null,
    phase: input.phase,
    role: input.role,
  });
  if (!current) return;
  if (!fs.existsSync(input.repoPath) || !fs.statSync(input.repoPath).isDirectory()) return;
  writeFileAtomic(
    rubricFilePath(input.repoPath, input.phase, input.role),
    serializeRubricFile(input.phase, input.role, recordToLines(current)),
  );
}

/**
 * Resolves the repoPath for a project so stage-side callers can sync without
 * widening their own signatures. Returns null for an unknown project -- the
 * caller treats that as "nothing to sync".
 */
export function repoPathForProject(projectId: string): string | null {
  const row = db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return row?.repoPath ?? null;
}
