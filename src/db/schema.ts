import { PHASES } from "../domain/phase";
import { CHANGE_ACTIONS, PHASE_STATUSES } from "../domain/change-state";
import { ANSWER_ACTIONS, QUESTION_KINDS } from "../domain/question";
import { GAP_STATUSES } from "../domain/gap";
import { BLOCKER_KINDS } from "../domain/gate";
import { RUBRIC_ROLES, RUBRIC_VERDICTS } from "../domain/rubric";
import { ROUND_NOTE_SOURCES } from "../domain/round";

/**
 * The L0 schema, with the ledger invariant enforced by the database itself.
 *
 * ## Why the enum lists are generated
 *
 * A `CHECK (phase IN (...))` written by hand is a second copy of the phase
 * list, and a second copy is a place for the two to disagree. They are built
 * from the domain constants instead, so adding a phase cannot leave the
 * database refusing it.
 *
 * ## Why a trigger and not a convention
 *
 * "Every state change is recorded" is only true if it cannot be skipped. A rule
 * that lives in one function is a rule that holds until the second caller
 * appears. `ck_changes_ledger` makes SQLite refuse any update to `changes`
 * that does not have a matching ledger row -- so a bypass is not a missing
 * audit entry discovered later, it is an immediate abort at the moment of the
 * write, with a stack trace pointing at the code that tried.
 *
 * ## No backticks inside the SQL
 *
 * It is one template literal, so a backtick in a comment ends it and the file
 * stops parsing several lines later with a message about an unrelated word.
 * Cost me three round trips; write plain words instead.
 */

const quoted = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(",");

export const SCHEMA_SQL = `
-- What a Change belongs to. One row per body of work a person thinks of as a
-- thing: it carries a name, and nothing else. No status, no phase, no gate --
-- a project cannot be approved or blocked, so it holds none of that.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- 这个项目的代码在哪。**Codex 就跑在这个目录里。**
  --
  -- 2026-07-30 用户发现的洞：在这之前 projects 只有 id 和 name，而 pty 的 cwd 是
  -- 服务启动时定死的一个值（scripts/panel.ts 里的 process.cwd()）。于是你新建一个
  -- 项目、在它下面建 Change、按「跑这个阶段」—— Codex 跑在 stagepass 这个仓库里，
  -- 用的还是 workspace-write。**它会读写本仓库，同时声称在给你那个项目干活。**
  --
  -- 可空是为了不弄坏已有的库；但没有它不许跑（panel-server 在排队之前就拒），
  -- 和 change_briefs 同一个 fail-closed 形状。空字符串不算路径，所以有 CHECK。
  path        TEXT     NULL CHECK (path IS NULL OR length(trim(path)) > 0),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  id            TEXT PRIMARY KEY,
  -- Both nullable, and deliberately so: a Change is complete without either.
  -- Every gate, every transition and every fence works on a Change that belongs
  -- to no project and has no title, which is what the whole state machine was
  -- proved against. These two carry what a PERSON needs to recognise it, and
  -- nothing reads them to make a decision.
  project_id    TEXT     NULL REFERENCES projects(id),
  title         TEXT     NULL,
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  status        TEXT NOT NULL CHECK (status IN (${quoted(PHASE_STATUSES)})),
  return_phase  TEXT     NULL CHECK (return_phase IS NULL OR return_phase IN (${quoted(PHASES)})),
  seq           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- The same two invariants the domain enforces, restated where the data lives.
  -- A row that could not have come from transition() must not be storable.
  CHECK ((phase = 'Fix') = (return_phase IS NOT NULL)),
  CHECK (status <> 'closed' OR phase = 'Done')
);

CREATE INDEX IF NOT EXISTS ix_changes_project ON changes (project_id, created_at);

-- 人到底要什么，用他自己答出来的话记下来。
--
-- ## 为什么是独立的一张表，不是 changes 上的一列
--
-- 实测撞出来的：changes 上的两条触发器要求**每一次 UPDATE 都是一次状态转移**
-- （ck_changes_seq_advances 要 NEW.seq = OLD.seq + 1）。而录入需求不是转移 ——
-- 没有 action 可记，seq 不该动。把它做成一列，就得放宽那条触发器，而它守的正是
-- 「账本的完整性可以用算术检查」这条。
--
-- 换一张表，两条触发器一个字都不用动，「对 changes 的每一次 UPDATE 都是转移」
-- 这句话仍然逐字成立。
--
-- 和 changes.title 的关键区别：**模型读这个。** 它是 PRD 阶段红方的任务书，下游
-- 每个阶段都靠它知道这次改动到底是为了什么。之前这里是空的，于是红方收到的是一句
-- 写死的通用指令，「this change」是哪个 change 从来没被告知，那份 PRD 只能是编的。
-- 见 domain/brief.ts。
CREATE TABLE IF NOT EXISTS change_briefs (
  change_id   TEXT PRIMARY KEY REFERENCES changes(id),
  brief       TEXT NOT NULL CHECK (length(trim(brief)) > 0),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_events (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  seq         INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)},'create')),
  from_phase  TEXT     NULL,
  from_status TEXT     NULL,
  to_phase    TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (change_id, seq)
);

-- The ledger is not optional. An update to a Change that is not accompanied by
-- its ledger row aborts the transaction that attempted it.
CREATE TRIGGER IF NOT EXISTS ck_changes_ledger
AFTER UPDATE ON changes
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM change_events
  WHERE change_id = NEW.id AND seq = NEW.seq
)
BEGIN
  SELECT RAISE(ABORT, 'change_updated_without_ledger_entry');
END;

-- Sequence numbers are dense and monotonic, so "the ledger is complete" is
-- checkable by arithmetic rather than by reading every row.
CREATE TRIGGER IF NOT EXISTS ck_changes_seq_advances
AFTER UPDATE ON changes
FOR EACH ROW
WHEN NEW.seq <> OLD.seq + 1
BEGIN
  SELECT RAISE(ABORT, 'change_seq_must_advance_by_one');
END;

-- ---------------------------------------------------------------------------
-- L1
-- ---------------------------------------------------------------------------

-- What a phase produced, and what is still wrong with it. The gate reads only
-- this; it never reads a model's opinion of how the phase went.
CREATE TABLE IF NOT EXISTS change_evidence (
  change_id     TEXT NOT NULL REFERENCES changes(id),
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  artifact_ids  TEXT NOT NULL,
  blockers      TEXT NOT NULL,
  waived_ids    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (change_id, phase)
);

-- Applied commands, keyed by the caller's idempotency key.
--
-- Only COMPLETED commands are stored. A refusal is not a durable outcome: the
-- gate that refused it may open, and a caller that retries then must not be
-- handed back the old "no".
CREATE TABLE IF NOT EXISTS commands (
  idempotency_key   TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL REFERENCES changes(id),
  action            TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)})),
  request_hash      TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  result_seq        INTEGER NOT NULL,
  result_phase      TEXT NOT NULL CHECK (result_phase IN (${quoted(PHASES)})),
  result_status     TEXT NOT NULL CHECK (result_status IN (${quoted(PHASE_STATUSES)})),
  at                TEXT NOT NULL
);

-- Long-running work and who owns it.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL REFERENCES changes(id),
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempt       INTEGER NOT NULL,
  max_attempts  INTEGER NOT NULL,
  owner         TEXT NULL,
  token         TEXT NULL,
  expires_at    INTEGER NULL,
  deadline_at   INTEGER NOT NULL,
  error         TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- A running job has an owner; a job that is not running has none. Without
  -- this, "running with nobody on it" is a representable row -- which is the
  -- exact state where work looks alive forever and nothing tells anyone.
  CHECK ((status = 'running') = (owner IS NOT NULL AND token IS NOT NULL AND expires_at IS NOT NULL)),
  -- A terminal job states why. A failed job with no reason is the shape that
  -- let the old tree report failures as though they were nothing at all.
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_jobs_claimable ON jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- L2
-- ---------------------------------------------------------------------------

-- Which Codex thread a phase's work happens in: one thread per (Change, phase).
--
-- Keyed by the pair rather than by the Change, because with one thread per
-- Change part of a phase's decision rests on what the model remembers from
-- EARLIER phases -- and that memory lives in Codex's conversation history,
-- inside no StagePass snapshot. The fence cannot reach it. Per-phase threads
-- force cross-phase information through documents, which can be snapshotted,
-- hashed and fenced. See the rebuild PRD section 6.5.
--
-- The price, paid deliberately: each phase opens on a conversation that knows
-- nothing about the earlier ones, so every phase's opening prompt has to carry
-- its upstream documents itself.
--
-- Re-entering a phase reuses its thread rather than starting another. Fix can
-- be entered many times, so the pair is not unique in TIME; what a third round
-- of Fix most needs is what the first two changed and why it still failed, and
-- that is in this same thread.
CREATE TABLE IF NOT EXISTS change_bindings (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  phase       TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  thread_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('bound','detached')),
  bound_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (change_id, phase)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_bindings_thread
  ON change_bindings (thread_id) WHERE status = 'bound';

-- Every turn StagePass asks for, written down BEFORE it is dispatched.
--
-- Recording it first is what makes a lost response survivable: on restart the
-- turn is there, in the dispatched state, and can be reconciled. A turn written
-- dispatch is a turn that, if the process dies in between, never existed --
-- and the work silently happened twice.
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL REFERENCES changes(id),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  request_hash  TEXT NOT NULL,
  prompt        TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending','dispatched','completed','failed')),
  thread_id     TEXT NULL,
  response      TEXT NULL,
  error         TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- A completed turn has what came back; a failed one says why. Neither may be
  -- silent about its own outcome.
  CHECK (status <> 'completed' OR response IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_turns_job ON turns (job_id, created_at);

-- ---------------------------------------------------------------------------
-- L4
-- ---------------------------------------------------------------------------

-- Problems that outlive the round that found them.
--
-- The gate reads open rows here rather than a blockers list on the round, so a
-- later round cannot resolve a problem by not mentioning it. Closing one
-- requires saying so; the resolution column is where that is said.
CREATE TABLE IF NOT EXISTS gaps (
  id            TEXT NOT NULL,
  change_id     TEXT NOT NULL REFERENCES changes(id),
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  -- Two kinds, and they are not the same thing.
  --
  --   finding   a problem someone found. Carries a severity: the question was
  --             "how bad is this".
  --   standard  a rubric criterion that was not met. Carries NO severity: the
  --             question was "is it met", which is binary. Inventing a P0/P1/P2
  --             for it would be inventing a dimension that does not exist.
  --
  -- The paired CHECK below makes the mismatched row unstorable rather than
  -- leaving it to callers -- same shape as the Fix/return_phase invariant above.
  kind          TEXT NOT NULL CHECK (kind IN (${quoted(BLOCKER_KINDS)})),
  severity      TEXT     NULL CHECK (severity IS NULL OR severity IN ('P0','P1','P2')),
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status        TEXT NOT NULL CHECK (status IN (${quoted(GAP_STATUSES)})),
  opened_round  INTEGER NOT NULL,
  resolution    TEXT NULL,
  -- 人对这一条说的话，会跟着它进下一轮。
  --
  -- 和 resolution 分开是因为它们答的是两个问题：resolution 说「它为什么不再挡着」，
  -- note 说「它还挡着，而这是我要红方注意的」。合成一列，「我驳回了它」和「我要求
  -- 照我说的改」就成了同一行。
  note          TEXT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (change_id, phase, id),
  -- A gap that has left the open state says why. Without this, "closed" and "forgotten"
  -- are the same row, which is the distinction this table exists to keep.
  CHECK (status = 'open' OR (resolution IS NOT NULL AND length(trim(resolution)) > 0)),
  -- A finding has a severity; a standard has none. Neither half is optional.
  CHECK ((kind = 'finding') = (severity IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_gaps_open
  ON gaps (change_id, phase) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- L3
-- ---------------------------------------------------------------------------

-- What StagePass is asking a human, and the ground it was asked against.
--
-- expected_snapshot is the fence, stored at the moment of asking. A person
-- takes as long as they take, and applying their answer to evidence they never
-- saw is exactly what the fence exists to prevent.
CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL REFERENCES changes(id),
  phase             TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  kind              TEXT NOT NULL CHECK (kind IN (${quoted(QUESTION_KINDS)})),
  message           TEXT NOT NULL CHECK (length(trim(message)) > 0),
  schema_json       TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open','answered','applied','superseded')),
  asked_at          TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One Change asks one question at a time. A second open question would mean two
-- people-facing decisions racing for the same gate, and whichever answer landed
-- second would be applied to a snapshot the asker never saw.
CREATE UNIQUE INDEX IF NOT EXISTS uq_questions_one_open
  ON questions (change_id) WHERE status = 'open';

-- The plugin's only write. It cannot touch the changes table, so it cannot move
-- -- it can only record what a human said when asked.
CREATE TABLE IF NOT EXISTS answers (
  question_id  TEXT PRIMARY KEY REFERENCES questions(id),
  action       TEXT NOT NULL CHECK (action IN (${quoted(ANSWER_ACTIONS)})),
  content_json TEXT NOT NULL,
  answered_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- L5
-- ---------------------------------------------------------------------------

-- An editable set of yes/no standards for one (scope, phase, role).
--
-- Editing makes a NEW version row; old rows stay. That is what lets a rubric be
-- editable without invalidating anything already sealed: every assessment
-- records the version it was made against, and nothing recomputes backwards.
--
-- change_id NULL means the project-level default. A Change-level row overrides
-- it for that Change only.
--
-- reason carries why an edit was made, and is REQUIRED when the edit retires a
-- criterion that was blocking (PRD 1.1). That is not enforceable here -- knowing
-- whether an edit retires something needs the previous version -- so RubricStore
-- refuses it instead. The column exists so the answer is on the record.
CREATE TABLE IF NOT EXISTS rubrics (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  change_id   TEXT     NULL REFERENCES changes(id),
  phase       TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  role        TEXT NOT NULL CHECK (role IN (${quoted(RUBRIC_ROLES)})),
  version     INTEGER NOT NULL CHECK (version >= 1),
  is_current  INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  reason      TEXT     NULL,
  created_at  TEXT NOT NULL
);

-- TWO partial indexes, not one, and the reason is a trap rather than a style.
--
-- SQLite treats NULLs as distinct inside a unique index. A single index over
-- (project_id, change_id, phase, role) therefore constrains nothing at all for
-- the project-level rows, where change_id IS NULL -- every version of a
-- project-level rubric would be is_current = 1 simultaneously, and the failure
-- is SILENT: reads just start returning whichever row came back first.
--
-- Splitting on change_id IS NULL is what makes the constraint real on both
-- sides. Same trap, same fix, for version uniqueness below.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_current_change
  ON rubrics (project_id, change_id, phase, role)
  WHERE is_current = 1 AND change_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_current_project
  ON rubrics (project_id, phase, role)
  WHERE is_current = 1 AND change_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_version_change
  ON rubrics (project_id, change_id, phase, role, version)
  WHERE change_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_version_project
  ON rubrics (project_id, phase, role, version)
  WHERE change_id IS NULL;

-- One standard. criterion_key is the identity that survives editing.
--
-- Keyed by (rubric_id, criterion_key) rather than by a row id, because the key
-- IS the identity: a rubric-derived gap's id is built from it, and
-- gate.snapshotOf hashes blocker ids. A key that moved when the wording
-- changed would move every derived gap id, move the snapshot, and invalidate the
-- fence on every open question -- refusing an answer a person was in the middle
-- of giving. See docs/RUBRIC-REMAP-2026-07-29.md section 3.2.
CREATE TABLE IF NOT EXISTS rubric_criteria (
  rubric_id      TEXT NOT NULL REFERENCES rubrics(id),
  criterion_key  TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  text           TEXT NOT NULL CHECK (length(trim(text)) > 0),
  blocking       INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  PRIMARY KEY (rubric_id, criterion_key)
);

-- What one round decided about one criterion.
--
-- ## Keyed by round, never by run
--
-- A blue-side continuation does not re-run the red side, so under that run there
-- are no producer rows -- while the old ones are still there under the SAME
-- round. Reading by run sees "producer has no assessments", reads it as "there
-- is no rubric", and passes. That is precisely the failure this table exists to
-- prevent.
--
-- ## Why the criterion is snapshotted here
--
-- criterion_text and blocking_then are what the criterion SAID when the
-- judgement was made. Deriving a blocker reads these; retiring one reads the
-- CURRENT rubric. That asymmetry is what makes editing a rubric able only to
-- close a blocker, never to open one -- so no edit can put a sealed Change back
-- behind a gate.
--
-- ## change_id is not redundant
--
-- An assessment made against a PROJECT-level rubric would otherwise have no link
-- to the Change it was about: rubric_id points at something that outlives the
-- Change entirely.
CREATE TABLE IF NOT EXISTS rubric_assessments (
  change_id      TEXT NOT NULL REFERENCES changes(id),
  phase          TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  role           TEXT NOT NULL CHECK (role IN (${quoted(RUBRIC_ROLES)})),
  round          INTEGER NOT NULL,
  rubric_id      TEXT NOT NULL REFERENCES rubrics(id),
  criterion_key  TEXT NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN (${quoted(RUBRIC_VERDICTS)})),
  evidence       TEXT     NULL,
  criterion_text TEXT NOT NULL,
  blocking_then  INTEGER NOT NULL CHECK (blocking_then IN (0, 1)),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (change_id, phase, role, round, criterion_key)
);

-- 一轮里那两句只写给人看的话：裁判的结论，和反方的整体判断。
--
-- ## 为什么它们不进上面那三张表
--
-- gaps 是问题、rubric_assessments 是逐条判定、change_evidence 是闸门看的东西。
-- 这两句哪一样都不是：它们**不动闸门**（用户 2026-07-31 —— 裁判给结论、人按按钮），
-- 也不对应任何一条 criterion。塞进去会让那三张表各自多一种「不算数的行」。
--
-- ## 按轮存，不覆盖
--
-- 和 rubric_assessments 同一个理由：「第几轮说了什么」要留得住。人在第 4 轮回头看
-- 第 2 轮的裁判怎么说，是他判断「这几轮到底有没有进展」的唯一依据。
--
-- ## another_round 只有裁判那一句可能有
--
-- 反方那句整体判断没有这一位：它是印象，不是建议，硬给它编一个布尔就是发明一个
-- 不存在的维度。这半边由 schema 挡住，不靠调用方记得 -- 和 gaps 那条 kind/severity
-- 的配对是同一个路子。
--
-- **但反过来那半边不成立：裁判那一句也可能没有。** 它给了结论却写坏了的时候，
-- 「还要不要再来一轮」这个问题是没有答案的。早先这里写的是双向配对
-- （judge_conclusion 必须有），逼得那种情况只能记 0 -- 而 0 会被渲染成「可以了」，
-- 也就是**替裁判说了一句它没说过的话**。这一整套改动的立身之本正是不许出现这种话。
--
-- ## 读不出来的结论也存在这里
--
-- text 记的是「读不出来」加原文，another_round 记 NULL。那不是静默跳过 -- 人照样在
-- 裁决那张表上看见它，这正是「每一轮我都要知情」那条要求。
CREATE TABLE IF NOT EXISTS round_notes (
  change_id     TEXT    NOT NULL REFERENCES changes(id),
  phase         TEXT    NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  round         INTEGER NOT NULL,
  source        TEXT    NOT NULL CHECK (source IN (${quoted(ROUND_NOTE_SOURCES)})),
  another_round INTEGER     NULL CHECK (another_round IN (0, 1)),
  text          TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  created_at    TEXT    NOT NULL,
  CHECK (source = 'judge_conclusion' OR another_round IS NULL),
  PRIMARY KEY (change_id, phase, round, source)
);
`;

/**
 * 给已经存在的库补上后来才加的列。
 *
 * ## 为什么 SCHEMA_SQL 一个人不够
 *
 * 它整篇是 `CREATE TABLE IF NOT EXISTS`。新表没问题 —— 不存在就建。但**已经存在的
 * 表不会因此多出一列**：那条语句直接跳过，然后 `SELECT id, name, path` 抛
 * 「no such column: path」，一个旧库就这么打不开了。
 *
 * 2026-07-30 我自己撞上这个，当时手跑了一次 ALTER 就过去了 —— 而真实的旧库没人替它
 * 跑。所以补在这里。
 *
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以先问 `table_info` 再决定加不加。
 * 这不是一套迁移框架，也不假装是：**只处理「加一个可空列」这一种**。真需要改列类型
 * 或搬数据的那天，请正经写迁移，不要把它塞进这里。
 */
export function migrate(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
}): void {
  const added: [table: string, column: string, type: string][] = [
    ["projects", "path", "TEXT"],
    ["gaps", "note", "TEXT"],
  ];
  for (const [table, column, type] of added) {
    const columns = database.pragma(`table_info(${table})`) as { name: string }[];
    if (columns.length === 0) continue;               // 表还不存在，SCHEMA_SQL 会建
    if (columns.some((entry) => entry.name === column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
