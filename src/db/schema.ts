import { PHASES, TERMINAL_PHASE } from "../domain/phase";
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

/**
 * `changes` 的表定义，单独一份 —— **迁移要重建它**（return_phase → return_stack，
 * SQLite 改不了 CHECK，只能整表重建），重建用的必须和建新库用的是同一份，否则
 * 两条路建出两种表。
 */
const CHANGES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS changes (
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
  -- 回程栈（domain/change-state.ts 的 returnStack，§5.9.2）：JSON 数组，'[]' =
  -- 沿主线走。只有打回上游（sendBack）压它（环 v3 拆掉了送修那条路）。形状
  -- 不变量（严格递减、每层在当前阶段下游）由 domain 判；这里只钉数据库说得清的。
  return_stack  TEXT NOT NULL DEFAULT '[]',
  seq           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- The same invariants the domain enforces, restated where the data lives.
  -- A row that could not have come from transition() must not be storable.
  -- （Fix 那条历史 CHECK 撤了：环 v3 里 transition 根本写不出 phase = 'Fix' 的
  -- 行，而老库的 Fix 历史行要在迁移重建时原样搬得回来。）
  CHECK (status <> 'closed' OR return_stack = '[]'),
  CHECK (status <> 'closed' OR phase = '${TERMINAL_PHASE}')
)`;

/**
 * `changes` 上的两条账本触发器，单独一份 —— 迁移重建 `changes` 时它们随旧表一起
 * 消失，必须当场重建（下一次进程重启才轮到 SCHEMA_SQL，中间这段时间不能没账）。
 */
const CHANGES_TRIGGERS_SQL = `
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
`;

/**
 * `change_bindings` 的表定义，单独一份 —— 和 `CHANGES_TABLE_SQL` 同一个理由：
 * 迁移（加 `kind`、`phase` 放开可空，SQLite 改不了 CHECK/PK，只能整表重建）
 * 用的必须和建新库用的是同一份。
 *
 * ## Which Codex thread work happens in
 *
 * `kind = 'round'`：一个阶段的对抗线程，一线程一 (Change, phase)。按对儿建键
 * 而不是按 Change，理由是 fence：一线程一 Change 的话，阶段的判断有一部分
 * 停在模型对更早阶段的记忆里 —— 那记忆在 Codex 的会话历史里，任何 StagePass
 * 快照都罩不住。按阶段分线程逼着跨阶段信息走文档，而文档才能被快照、被哈希、
 * 被 fence（重建 PRD §6.5）。重进一个阶段复用它的线程（Fix 第三轮最需要的
 * 正是前两轮改了什么、为什么还不行）。
 *
 * `kind = 'aside'`：旁路会话（DESIGN-phase-not-the-only-axis §3.3）—— 人在
 * 里面问问题、聊需求。**不属于任何阶段、不产出、不推闸门、不占「一个阶段
 * 一个进程」的座位**，所以 `phase` 是 NULL。一个 Change 一条 aside：它是
 * 「这个 Change 的闲聊」，两条并存只会让「把闲聊收敛成 brief」不知道读哪条。
 */
const CHANGE_BINDINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS change_bindings (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  kind        TEXT NOT NULL DEFAULT 'round' CHECK (kind IN ('round','aside')),
  phase       TEXT     NULL CHECK (phase IS NULL OR phase IN (${quoted(PHASES)})),
  thread_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('bound','detached')),
  bound_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- round 挂在一个阶段上，aside 不挂 —— 错配的行不可存
  -- （和 gaps 的 kind/severity 配对是同一个路子）。
  CHECK ((kind = 'round') = (phase IS NOT NULL))
)`;

/** 同上，迁移重建时要当场重建，不能等下一次重启的 SCHEMA_SQL。 */
const CHANGE_BINDINGS_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_bindings_round
  ON change_bindings (change_id, phase) WHERE kind = 'round';
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_bindings_aside
  ON change_bindings (change_id) WHERE kind = 'aside';
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_bindings_thread
  ON change_bindings (thread_id) WHERE status = 'bound';
`;

export const SCHEMA_SQL = `
-- What a Change belongs to. One row per body of work a person thinks of as a
-- thing: it carries a name, and nothing else. No status, no phase, no gate --
-- a project cannot be approved or blocked, so it holds none of that.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- 这个项目的代码在哪。**Codex 就跑在这个目录里。**
  --
  -- 2026-07-30 用户发现的洞：在这之前 projects 只有 id 和 name，而 Codex 的 cwd 是
  -- 服务启动时定死的一个值（scripts/panel.ts 里的 process.cwd()）。于是你新建一个
  -- 项目、在它下面建 Change、按「跑这个阶段」—— Codex 跑在 stagepass 这个仓库里，
  -- 用的还是 workspace-write。**它会读写本仓库，同时声称在给你那个项目干活。**
  --
  -- 可空是为了不弄坏已有的库；但没有它不许跑（panel-server 在排队之前就拒），
  -- 和 change_briefs 同一个 fail-closed 形状。空字符串不算路径，所以有 CHECK。
  path        TEXT     NULL CHECK (path IS NULL OR length(trim(path)) > 0),
  -- 这个项目走哪几个阶段（BACKLOG §4.5：不是每个项目都值得走 12 个）。
  -- JSON 数组，必须是全序的子序列、以 Done 收尾（domain/phase.ts 的 phaseGraphOf
  -- 在读取时校验）。NULL = 走全序。
  phase_order TEXT     NULL,
  -- 图谱上被人勾掉的目录（图谱 spec 2026-08-12：「关键代码」的判据在面板上勾）。
  -- JSON 数组，NULL = 没勾过。**没有索引引用它，也不许有** —— 引用新列的索引
  -- 会让还没跑 migrate 的旧库当场打不开（prepareSchema 的顺序陷阱）。
  graph_excludes TEXT  NULL,
  created_at  TEXT NOT NULL
);

${CHANGES_TABLE_SQL};

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

-- 这就是那条事件流（BACKLOG §4.3）：append-only（触发器强制）、按 seq 稠密单调。
-- 跳转表（§5.9.2）是它的投影（domain/journey.ts），不另建表。
CREATE TABLE IF NOT EXISTS change_events (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  seq         INTEGER NOT NULL,
  -- 'rerun' 是历史席位（环 v3 删掉的动作）：域层再也写不出它，但老账本里的行
  -- 在整表重建时要原样搬得回来 —— 和退休阶段名留在 PHASES 里同一条原则。
  action      TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)},'create','rerun')),
  from_phase  TEXT     NULL,
  from_status TEXT     NULL,
  to_phase    TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  -- 这一步为什么发生，人的话（打回的理由等）。NULL = 这一步没带理由。
  -- 环上历史箭头的「什么理由」就从这儿来 —— 别处不许另存一份。
  reason      TEXT     NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (change_id, seq)
);
${CHANGES_TRIGGERS_SQL}

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
  -- 'rerun'：历史席位，理由同 change_events.action。
  action            TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)},'rerun')),
  request_hash      TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  result_seq        INTEGER NOT NULL,
  result_phase      TEXT NOT NULL CHECK (result_phase IN (${quoted(PHASES)})),
  result_status     TEXT NOT NULL CHECK (result_status IN (${quoted(PHASE_STATUSES)})),
  at                TEXT NOT NULL
);

-- 并行座位（批 3，DESIGN-phase-not-the-only-axis §3.1 的第一阶段）。
--
-- ## 主线不动，这张表只放「同时活着的第二个阶段」
--
-- changes.phase 仍然是主状态（账本触发器、fence、seq 全部原样）——「TestPlan 和
-- Build 同时 active」落成：主线停在 TestPlan，Build 在这张表里有一行，各自跑轮、
-- 各自积累 evidence / gaps / rubric（那三张表本来就按 (change, phase) 建键）。
--
-- ## 出口：主线走到时**收编**（ChangeStore.apply）
--
-- 并行座位没有自己的裁决面 —— 主线推进到这个阶段时，把这一行的 status 原样
-- 收编进主状态、删掉这一行，之后走正常的裁决流。于是「人只在状态的出口表一次态」
-- 保持成立，网页上也不用长出第二个裁决入口（PRD §1）。
--
-- status 没有 closed：座位不会自己关掉，它的终点是被收编。
CREATE TABLE IF NOT EXISTS change_states (
  change_id  TEXT NOT NULL REFERENCES changes(id),
  phase      TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  status     TEXT NOT NULL CHECK (status IN ('pending','running','settled','blocked')),
  opened_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (change_id, phase)
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
  -- 这条活儿跑在哪个阶段（批 3：并行座位的轮和主线的轮要分得开）。
  -- NULL = 加这一列之前的老行 —— 按「挡所有阶段」保守对待，别猜它是谁的。
  phase         TEXT NULL CHECK (phase IS NULL OR phase IN (${quoted(PHASES)})),
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

${CHANGE_BINDINGS_TABLE_SQL};
${CHANGE_BINDINGS_INDEXES_SQL}

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
  -- 这一条是谁关掉的。'human' = 人驳回的，NULL = 一轮判它已经修好了。
  --
  -- 两者在 status 上都是 closed，而它们该被怎么对待正好相反：一轮关掉的，下一轮
  -- 重新发现它就该重开（那一轮看了，它还在）；人驳回的不该被重开 —— 人是带着依据
  -- 裁的（resolution 必填），而模型没读过那个依据，它「又看见了」不是新信息。
  --
  -- 2026-08-02 实测：QA-007 被重开三次、跨两个阶段，而人第一次为什么驳它，三次
  -- 之后库里已经查不到了（重开会把 resolution 抹成 NULL）。
  --
  -- 为什么是一列而不是第四个状态：status 的 CHECK 是建表时定死的，SQLite 改不了，
  -- 而 migrate() 只会 ADD COLUMN —— 加状态会让所有已存在的库当场拒收新值。
  closed_by     TEXT NULL CHECK (closed_by IS NULL OR closed_by = 'human'),
  -- 报的人说它在哪儿、为什么是问题，原文照抄。理由见 domain/gate.ts 的 Blocker.where
  -- （用户 2026-08-04：「绝对不能出现语义损失」）。
  --
  -- 列名和域里的字段名不一样，这是**被逼的**：where 是 SQL 保留字，裸着写每一条
  -- 查询都得加引号，而这棵树的规矩是「一个概念一个名字」—— 与其让它在半数地方带
  -- 引号、半数不带，不如在这一层显式改名并把理由写在这儿。域里、JSON 契约里一律
  -- 还是 where / why。
  --
  -- 两列都可空：模型没写就是 NULL。**这不是「可有可无」** —— 有没有写是被 rubric
  -- 判的（critic 第 1、2 条），判据归 rubric，不归建表约束。
  found_where   TEXT NULL,
  -- 这一条该谁修（环 v3 的反馈回路）。NULL = 归发现它的这个阶段自己。
  -- 只有 QA 这种同时读得到两条互盲轨道的对撞点填得出它；打回时它跟着一起走
  -- （runRound 读 returnStack 上那几个阶段里 owner 指着自己的）。
  owner_phase   TEXT NULL,
  found_why     TEXT NULL,
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
  updated_at        TEXT NOT NULL,
  -- 这次裁决的下场（advanced / refused …），落地时写。NULL = 还没落地。
  -- 「闸门拒了」原来只活在 /api/ask 的一次响应里，前端一句话就把它盖掉（§3.2·5）——
  -- 拒绝必须是留得住的状态，人刷新之后还要看得见上次为什么没推动。
  outcome_json      TEXT
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
  -- 它判的是产出模板的哪一节（domain/phase-template.ts 的 key）。
  --
  -- NULL = 不挂节，那是老数据和还没有模板的十一个阶段。挂节是「越界」唯一的机械
  -- 判据：一条标准说得清自己管哪一节，才谈得上「这个问题不归这个阶段管」。
  --
  -- 不加外键：模板住在代码里（和 phase-play 同一条纪律，每阶段独自变），库里没有
  -- 可引用的表。悬空由 store 在存的时候拦（人改 rubric 时挂一个不存在的节）。
  section        TEXT NULL,
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

-- 裁判这一轮要逐条答的东西，**以及它永远看不到的那一列**。
--
-- ## 这张表存在的理由
--
-- 在它之前，裁判是这么表态的：StagePass 把 gap id 和 criterion key 印进提示词，
-- 裁判把它们**手抄**进一个 json 块的 key 位置上。那两串东西是 50 和 40 个字符的
-- UUID，而 StagePass 拿它们做精确相等匹配 -- 抄漏一段，一整份判定作废
-- （2026-08-02 实测：同一个抄错的 UUID 连抄三轮）。
--
-- 判据是用户 2026-08-02 立的规矩：**凡是 StagePass 会拿去做精确匹配的字符串，都不许
-- 出现在模型必须生成的文本里。** 见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
--
-- 所以身份挪到这里：target 是 gap id 或 criterion key，**模型从头到尾看不到它**。
-- 它只被问「第 N 项：<正文>，答 A 还是 B」，然后交一个枚举值和一句散文。
--
-- ## 为什么有 status 这一列
--
-- 「下一项」是插件问出来的，而插件不知道自己在哪个 Change、哪个阶段、第几轮 --
-- 它只有这个库。所以「哪一份是当前那一份」必须是库里的事实。开一份新的会把别的
-- 全部 closed（WorklistStore.open），于是全库任何时刻至多一份开着。
--
-- 上一轮没答完的那些**不会漏到下一轮** -- 那正是这一列挡的：没有它，裁判这一轮
-- 会被喂上一轮的剩饭，而那些条目对应的 gap 可能早就关掉了。
--
-- ## 答案存在这里，不是存在别处
--
-- answer 是枚举值（closed/still_open，或 yes/no），reason 是散文。
-- 上层照旧把它们翻译成 gap 的 verdict 和 rubric 的 assessment -- 那两张表的语义
-- 一个字都没变，变的只是这些值**从哪来**。
-- 旁路会话的账本（彗星，2026-08-11）。
--
-- ## 为什么它不进 change_events
--
-- 那张是**状态机**的账本：seq 稠密单调、触发器守着、每一行都对应一次
-- 状态迁移。旁路不推状态机（那正是它存在的理由），塞进去要么破坏 seq，
-- 要么造一堆 from=to 的假迁移。它是另一种事实，另开一张。
--
-- ## 判据：动了手才留痕
--
-- 只是问个名词、聊两句 -- 前后两个 HEAD 相同，这一行照记，
-- 但不要人写理由（note 为 NULL）。树上真长出了 commit，note 必填：
-- 那是**环外发生的改动**，账上没有它，下游就会对着一份来历不明的树干活。
--
-- 「关掉一个问题必须说明理由」在这条路上的同一句话。
CREATE TABLE IF NOT EXISTS aside_visits (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  seq         INTEGER NOT NULL,
  opened_at   TEXT NOT NULL,
  closed_at   TEXT     NULL,
  -- 进出旁路时仓库的 HEAD。相同 = 只聊过；不同 = 动过手。
  -- 拿不到（项目没路径、不是 git 仓库）时是 NULL，那时不追问。
  head_before TEXT     NULL,
  head_after  TEXT     NULL,
  -- 人自己写的一句：这次旁路做了什么。动过手才要。
  note        TEXT     NULL,
  PRIMARY KEY (change_id, seq)
);

CREATE TABLE IF NOT EXISTS round_worklist (
  change_id   TEXT    NOT NULL REFERENCES changes(id),
  phase       TEXT    NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  round       INTEGER NOT NULL,
  ordinal     INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('gap', 'criterion')),
  -- gap id 或 criterion key。**从不发给模型。**
  target      TEXT    NOT NULL,
  -- 模型看得到的那段话。
  prompt      TEXT    NOT NULL,
  -- 允许的答案，JSON 数组。答别的会被当场拒掉，并把这几个值原样回给它。
  choices     TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('open', 'closed')),
  answer      TEXT        NULL,
  reason      TEXT        NULL,
  answered_at TEXT        NULL,
  PRIMARY KEY (change_id, phase, round, ordinal)
);
CREATE INDEX IF NOT EXISTS ix_worklist_open
  ON round_worklist (status, change_id, phase, round, ordinal);
`;

/**
 * 把一个库准备好 —— **建表和迁移的顺序在这里定死，调用方不许自己排。**
 *
 * ## 顺序是承重的，而它 2026-08-06 真机上炸过一次
 *
 * `SCHEMA_SQL` 里有引用**新列**的部分索引（`change_bindings` 那三个带
 * `WHERE kind = ...`）。旧库里那张表还没有 `kind` —— 它是 `migrate` 才补的，
 * 而 `CREATE TABLE IF NOT EXISTS` 对一张已经存在的表是空操作。于是
 * 「先 SCHEMA_SQL 后 migrate」在旧库上必然抛 `no such column: kind`，
 * 面板压根起不来。全新库不会撞上，所以离线测试全绿也不代表它对。
 *
 * 正确的顺序是**先把旧形状拉平，再补齐新东西**：`migrate` 对全新库是空操作
 * （每一步都先问 `table_info`，表不在就返回），所以这个顺序两种库都成立。
 *
 * 做成一个函数而不是在文档里写一句「记得先 migrate」：一条只能靠人记得的规则
 * 是一条撑到第二个调用者出现的规则，而这棵树一直在删这种东西。
 */
export function prepareSchema(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown; all(): unknown };
}): void {
  migrate(database);
  database.exec(SCHEMA_SQL);
}

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
  prepare(sql: string): { get(): unknown; all(): unknown };
}): void {
  const added: [table: string, column: string, type: string][] = [
    ["projects", "path", "TEXT"],
    ["projects", "phase_order", "TEXT"],
    ["projects", "graph_excludes", "TEXT"],
    ["gaps", "note", "TEXT"],
    ["gaps", "closed_by", "TEXT"],
    ["gaps", "found_where", "TEXT"],
    ["gaps", "owner_phase", "TEXT"],
    ["gaps", "found_why", "TEXT"],
    ["questions", "outcome_json", "TEXT"],
    ["change_events", "reason", "TEXT"],
    ["rubric_criteria", "section", "TEXT"],
    ["jobs", "phase", "TEXT"],
  ];
  for (const [table, column, type] of added) {
    const columns = database.pragma(`table_info(${table})`) as { name: string }[];
    if (columns.length === 0) continue;               // 表还不存在，SCHEMA_SQL 会建
    if (columns.some((entry) => entry.name === column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  migrateReturnStack(database);
  migrateBindingsKind(database);
  migrateStaleChecks(database);
  migrateRetiredPhases(database);
}

/**
 * 停在**退休阶段**上的 Change，挪回主线（2026-08-08：TechSpec 并进 Arch）。
 *
 * ## 为什么非挪不可
 *
 * 退休只是把名字从主线图上拿掉，历史照旧读得出来（见 `domain/phase.ts` 的
 * `RETIRED_PHASES`）。但**正停在那儿的 Change 走不动了**：`advancesTo` 对一个
 * 不在图上的阶段直接抛，于是批准这条路整个没有出口 —— 人在界面上一个能按的
 * 都没有，而这正是这棵树反复在治的那种死结。
 *
 * 合并前查实：CHG-001 当时就停在 `TechSpec/blocked`。
 *
 * ## 挪去哪、怎么记
 *
 * 挪到那个退休阶段**并进去的那一个**（`ABSORBED_BY`）。状态回 `pending` ——
 * 它要用新模板重跑一轮，上一轮的 `blocked` 说的是老阶段的事。
 *
 * **账本照记**（`sendBack`，带理由）：账本是这个产品的地基，一次静默的
 * UPDATE 会被 `ck_changes_ledger` 当场拒掉，而就算能绕过去也不该绕 ——
 * 人回头看时必须看得出这一步是谁、为什么把它挪走的。
 *
 * `returnStack` 原样不动：栈里记的是「回来之后去哪」，那笔债和阶段退休无关。
 * 退休阶段本身不许在栈里（`assertStateValid` 会拒），而它从来也进不去 ——
 * 压栈的只有 sendBack 的发起方和 Review/QA 的送修。
 */
function migrateRetiredPhases(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: unknown[]): unknown; all?(...args: unknown[]): unknown };
}): void {
  /*
   * 环 v3（2026-08-09）一次退了六个，逐个给落点：Plan 是改名（BuildPlan 顶替，
   * 语义逐字相同）；Review 被 QA 收编；Merge / Retro / Done 在新环里是
   * 「QA 之后」的位置 —— 停在那儿的 Change 退回 QA 重验一遍再关，保守但不错。
   *
   * **Fix 故意不在表里**：进过 Fix 的前提是 Review/QA 送修过，而那两个阶段在
   * 任何真库上都没跑过一轮 —— 结构上不存在停在 Fix 上的行。真出现了，读照样
   * 读得出（校验放行退休阶段），走不动就报到人跟前，那是人该做的决定。
   */
  const ABSORBED_BY: Readonly<Record<string, string>> = {
    TechSpec: "Arch",
    Plan: "BuildPlan",
    Review: "QA",
    Merge: "QA",
    Retro: "QA",
    Done: "QA",
  };
  /*
   * **证据跟着退休走**（环 v3 迁移的第二半）。搬 Change 的那半只管「停在退休
   * 阶段上的」，而证据的洞打在**已经走过去的**身上：CHG-001 带着老 Plan 的产物
   * 走到了 Build，v3 里 Build 的上游叫 BuildPlan —— `upstreamOf` 按新名取证据，
   * 取到一个空行，红方的任务书里就没有它该读的计划文档。
   *
   * 只在承接方还没有自己证据时拷贝：TechSpec 并进 Arch 那种**合并**里，Arch
   * 自己的产物才是权威，拷过去反而是把两份说法摆在一起让下游挑一个信。
   */
  for (const [retired, absorbedBy] of Object.entries(ABSORBED_BY)) {
    try {
      database.exec(
        `INSERT INTO change_evidence
           (change_id, phase, artifact_ids, blockers, waived_ids, updated_at)
         SELECT change_id, '${absorbedBy}', artifact_ids, blockers, waived_ids, updated_at
           FROM change_evidence AS retiring WHERE phase = '${retired}'
           AND NOT EXISTS (SELECT 1 FROM change_evidence
             WHERE change_id = retiring.change_id AND phase = '${absorbedBy}')`,
      );
    } catch {
      return;   // change_evidence 表还不存在（全新库）
    }
  }
  const at = new Date().toISOString();
  for (const [retired, absorbedBy] of Object.entries(ABSORBED_BY)) {
    let rows: { id: string; seq: number }[];
    try {
      rows = (database.prepare(
        "SELECT id, seq FROM changes WHERE phase = ?",
      ).all?.(retired) ?? []) as { id: string; seq: number }[];
    } catch {
      return;   // changes 表还不存在（全新库）
    }
    for (const row of rows) {
      const seq = row.seq + 1;
      database.exec("BEGIN");
      try {
        // 账本先写 —— `ck_changes_ledger` 在下面那句 UPDATE 触发时会找它。
        (database.prepare(
          `INSERT INTO change_events
             (change_id, seq, action, from_phase, from_status, to_phase, to_status, reason, at)
           SELECT id, ?, 'sendBack', phase, status, ?, 'pending', ?, ?
             FROM changes WHERE id = ?`,
        ) as unknown as { run(...args: unknown[]): unknown }).run(
          seq, absorbedBy,
          `${retired} 并进 ${absorbedBy}（阶段退休），这个 Change 退回 ${absorbedBy} 重写`,
          at, row.id,
        );
        (database.prepare(
          "UPDATE changes SET phase = ?, status = 'pending', seq = ?, updated_at = ? WHERE id = ?",
        ) as unknown as { run(...args: unknown[]): unknown }).run(
          absorbedBy, seq, at, row.id,
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

/**
 * 旧库的 phase CHECK 名单里补上 `Arch`（批 5，2026-08-06）。
 *
 * ## 为什么是「整表重建 × N」
 *
 * 十几张表的 `CHECK (phase IN (...))` 是建表时从 PHASES 生成的 —— 旧库里那份
 * 名单没有 Arch，新代码一写 `phase = 'Arch'` 就被旧约束当场拒掉。SQLite 改不了
 * CHECK，只能按官方十二步重建；表多，所以判据和过程都做成**通用的**：
 *
 * - 判据：`sqlite_master.sql` 里有 `'PRD'`（说明带 phase 名单）而没有 `'Arch'`
 * - 新定义从 `SCHEMA_SQL` 里按表名截出来 —— 建新库和迁旧库用的必须是同一份
 * - 列按旧表的名单拷（`added` 那批列的迁移排在这之前，所以两边列一致）
 * - 索引和触发器随旧表消失，重建完把 `SCHEMA_SQL` 整篇补一遍（全是 IF NOT
 *   EXISTS，幂等）—— 不能等下一次重启，中间这段时间账本没人守
 */
function migrateStaleChecks(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown; all(): unknown };
}): void {
  const count = (table: string): number =>
    (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const definitionOf = (name: string): string | null => {
    const found = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\)`,
    ).exec(SCHEMA_SQL);
    // SCHEMA_SQL 里没有的表不归这里迁（有人在库里手建过表，或者它是迁移的中间产物）。
    return found === null ? null : found[0];
  };
  /**
   * 一段建表 SQL 归一化成「可比的形状」。
   *
   * 三处不许参与比较，都是 SQLite 或迁移自己造成的差异，不是库落后：
   *
   * - **`IF NOT EXISTS` 被 SQLite 丢掉** —— 存进 `sqlite_master` 的没有它。
   * - **重建改名之后表名带引号** —— `ALTER TABLE … RENAME TO t` 存的是
   *   `CREATE TABLE "t" (`。不抹掉这一处，每次启动都会重建一遍同一张表。
   * - **注释和空白** —— 改一句注释不该触发整表重建；而注释里一个英文所有格
   *   （`model's`）会让按引号配对的比较整体错位，先删掉就没有这回事。
   *
   * 上面这三条都是 2026-08-07 用一个探针在真 SQLite 上量出来的，不是推测。
   */
  const shapeOf = (sql: string): string => sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z_]+)"?/, "CREATE TABLE $1")
    .trim();

  /**
   * **库里那张表和代码现在说的不一样** —— 差一个字就重建。
   *
   * 判据走过两版，都是被真机推着走的：
   *
   * 1. 「有 `'PRD'` 却没有 `'Arch'`」—— 只认阶段名。2026-08-07 栽在
   *    `change_events.action` 上：老库的名单里没有 `sendBack`，于是人选了
   *    「打回上游」，账本写不进去、事务回滚、`apply` 抛 SqliteError，
   *    最后是一个 500。**那个库物理上记不下这个动作。**
   * 2. 「代码允许而库里没有的字面量」—— 覆盖了全部枚举，可是**一个字面量都
   *    没有的表它永远看不见**。真库实测：`projects` / `change_briefs` /
   *    `rubric_criteria` 三张表因此从没被迁过，而 `projects.path` 那条
   *    `CHECK (length(trim(path)) > 0)` 至今不在库里 —— 空路径存得进去，
   *    而 `ensure` 的 COALESCE 让它永不自愈。
   *
   * 所以第三版直接比整段定义：枚举、CHECK、类型、主键、外键，一次全在里面。
   * 代价是「注释改了也重建」，而那已经被 `shapeOf` 抹掉了。
   */
  const stale = (database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL",
  ).all() as { name: string; sql: string }[])
    .filter((table) => {
      const canonical = definitionOf(table.name);
      return canonical !== null && shapeOf(canonical) !== shapeOf(table.sql);
    });
  if (stale.length === 0) return;

  database.pragma("foreign_keys=OFF");
  try {
    database.exec("BEGIN");
    try {
      /*
       * **重建期间先摘掉账本触发器。**
       *
       * 它们挂在 `changes` 上、引用 `change_events` —— 而 `change_events` 自己
       * 也可能在这一批待重建的表里（2026-08-07：`action` 的名单缺 `sendBack`）。
       * 表一 DROP，触发器就悬空，下一条语句撞上
       * 「error in trigger ck_changes_ledger: no such table: main.change_events」。
       *
       * 摘掉是安全的：整段包在一个事务里，而结尾的 `exec(SCHEMA_SQL)` 用**同一份
       * 定义**把它们装回来（`CHANGES_TRIGGERS_SQL`）。失败则整体回滚，触发器跟着
       * 一起回来 —— 任何一条路上都不存在「账本没人守」的时刻。
       */
      database.exec(
        "DROP TRIGGER IF EXISTS ck_changes_ledger;"
        + "DROP TRIGGER IF EXISTS ck_changes_seq_advances;",
      );
      for (const { name } of stale) {
        const columns = (database.pragma(`table_info(${name})`) as { name: string }[])
          .map((column) => column.name).join(", ");
        const rows = count(name);
        database.exec(definitionOf(name)!.replace(
          `CREATE TABLE IF NOT EXISTS ${name} (`,
          `CREATE TABLE ${name}_migrating (`,
        ));
        database.exec(
          `INSERT INTO ${name}_migrating (${columns}) SELECT ${columns} FROM ${name}`,
        );
        if (count(`${name}_migrating`) !== rows) {
          throw new Error(`check migration lost rows in ${name}; rolling back`);
        }
        database.exec(`DROP TABLE ${name}`);
        database.exec(`ALTER TABLE ${name}_migrating RENAME TO ${name}`);
      }
      database.exec(SCHEMA_SQL);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.pragma("foreign_keys=ON");
  }
}

/**
 * `change_bindings` 加 `kind`、`phase` 放开可空（DESIGN-phase-not-the-only-axis §3.3）。
 *
 * 和 `migrateReturnStack` 同一个形状：旧列绑在 CHECK 和 PRIMARY KEY 里，SQLite
 * 改不了约束，只能整表重建。老数据无损：已有的行全是阶段线程，`kind = 'round'`。
 * 索引随旧表一起消失，当场用同一份定义重建。
 */
function migrateBindingsKind(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown };
}): void {
  const columns = database.pragma("table_info(change_bindings)") as { name: string }[];
  if (columns.length === 0) return;                       // 新库，SCHEMA_SQL 会建
  if (columns.some((entry) => entry.name === "kind")) return;   // 已迁移

  const count = (table: string): number =>
    (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  database.pragma("foreign_keys=OFF");
  try {
    database.exec("BEGIN");
    try {
      const rows = count("change_bindings");
      database.exec(CHANGE_BINDINGS_TABLE_SQL.replace(
        "CREATE TABLE IF NOT EXISTS change_bindings (",
        "CREATE TABLE change_bindings_migrating (",
      ));
      database.exec(`
        INSERT INTO change_bindings_migrating
          (change_id, kind, phase, thread_id, status, bound_at, updated_at)
        SELECT change_id, 'round', phase, thread_id, status, bound_at, updated_at
        FROM change_bindings;
      `);
      if (count("change_bindings_migrating") !== rows) {
        throw new Error("bindings kind migration lost rows; rolling back");
      }
      database.exec("DROP TABLE change_bindings");
      database.exec("ALTER TABLE change_bindings_migrating RENAME TO change_bindings");
      database.exec(CHANGE_BINDINGS_INDEXES_SQL);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.pragma("foreign_keys=ON");
  }
}

/**
 * `return_phase`（单字段）→ `return_stack`（栈，§5.9.2）。
 *
 * **这是这棵树第一次「正经写迁移」**（上面那段注释预告过的那一天）：旧列绑在
 * CHECK 里，SQLite 改不了约束，只能按官方十二步整表重建。老数据无损：
 * `return_phase = 'Review'` 变成 `'["Review"]'`，NULL 变成 `'[]'`。
 *
 * 触发器随旧表一起消失，**当场**用同一份定义重建（`CHANGES_TRIGGERS_SQL`）——
 * 等下一次重启的 SCHEMA_SQL 来补，中间这段时间账本就没人守了。
 *
 * `foreign_keys=OFF` 只包着重建这几步：十几张表引用 changes(id)，开着外键连
 * DROP 都过不去。重建前后行数必须相等，不等就直接抛 —— 一半的库比旧库更糟。
 */
function migrateReturnStack(database: {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown };
}): void {
  const columns = database.pragma("table_info(changes)") as { name: string }[];
  if (columns.length === 0) return;                       // 新库，SCHEMA_SQL 会建
  if (columns.some((entry) => entry.name === "return_stack")) return;   // 已迁移

  const count = (table: string): number =>
    (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  database.pragma("foreign_keys=OFF");
  try {
    database.exec("BEGIN");
    try {
      const rows = count("changes");
      database.exec(CHANGES_TABLE_SQL.replace(
        "CREATE TABLE IF NOT EXISTS changes (",
        "CREATE TABLE changes_migrating (",
      ));
      database.exec(`
        INSERT INTO changes_migrating
          (id, project_id, title, phase, status, return_stack, seq, created_at, updated_at)
        SELECT id, project_id, title, phase, status,
               CASE WHEN return_phase IS NULL THEN '[]'
                    ELSE '["' || return_phase || '"]' END,
               seq, created_at, updated_at
        FROM changes;
      `);
      if (count("changes_migrating") !== rows) {
        throw new Error("return_stack migration lost rows; rolling back");
      }
      database.exec("DROP TABLE changes");
      database.exec("ALTER TABLE changes_migrating RENAME TO changes");
      database.exec(CHANGES_TRIGGERS_SQL);
      database.exec("CREATE INDEX IF NOT EXISTS ix_changes_project ON changes (project_id, created_at)");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.pragma("foreign_keys=ON");
  }
}
