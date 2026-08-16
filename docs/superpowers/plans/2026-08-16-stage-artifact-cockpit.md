# Stage Artifact Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in this worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty native-Terminal portal with a macOS-first Stage artifact cockpit that shows durable per-round inputs, produced files, directory structure, selected code dependencies, read-only file contents/diffs, current state, next action, and a fixed native Codex button.

**Architecture:** Record one append-only artifact manifest when each round settles, in the same SQLite transaction as current evidence and state. A separate injected read-only API projects those manifests through a pure Stage layout and a path/commit-fenced file reader; focused browser modules render the cockpit without adding another decision path or embedding Terminal bytes.

**Tech Stack:** TypeScript, better-sqlite3, Node `execFileSync` Git boundary, existing TypeScript compiler graph engine, native browser ES modules, Three.js/CSS2D, Node test runner, real-browser acceptance on `127.0.0.1:4173`.

---

## File map

**Create**

- `src/domain/stage-artifact.ts` — manifest vocabulary, validation, round comparison.
- `src/domain/stage-artifact.test.ts` — pure manifest and replacement-state tests.
- `src/store/stage-artifact-store.ts` — append-only manifest persistence.
- `src/store/stage-artifact-store.test.ts` — idempotency, ordering and migration tests.
- `src/graph/stage-artifact-layout.ts` — pure upstream/folder/file scene projection.
- `src/graph/stage-artifact-layout.test.ts` — deterministic layout and fallback model tests.
- `src/graph/reconstruct-stage-artifact.ts` — conservative, read-only projection for pre-ledger history.
- `src/graph/reconstruct-stage-artifact.test.ts` — exact-path/commit reconstruction and incomplete-history tests.
- `src/graph/read-stage-artifact.ts` — the only Stage artifact filesystem/Git read boundary.
- `src/graph/read-stage-artifact.test.ts` — path, symlink, historical and binary tests.
- `src/web/stage-artifact-api.ts` — injected read-only Stage manifest/file routes.
- `src/web/stage-artifact-api.test.ts` — HTTP contract and no-side-effect tests.
- `src/web/stage-artifact-view.js` — fetch, timeline, search, selection and inspector orchestration.
- `src/web/stage-artifact-scene.js` — Three.js scene and 2D fallback.
- `src/web/stage-artifact.css` — cockpit-only layout and responsive styling.

**Modify**

- `src/db/schema.ts` — add the append-only `stage_round_artifacts` table.
- `src/store/change-store.ts` and `src/store/change-store.test.ts` — delete manifests with a Change.
- `src/work/repo.ts` and `src/work/repo.test.ts` — list a commit's changed files and read a file/diff at a validated commit.
- `src/work/turn-loop.ts` and `src/work/turn-loop.test.ts` — commit manifest + evidence + settle atomically.
- `src/work/round-turn-runner.ts` and `src/work/round-turn-runner.test.ts` — return the exact round/upstream/file manifest.
- `src/web/panel-server.ts` and `src/web/panel-server.test.ts` — inject Stage artifact routes and serve new static assets.
- `scripts/panel.ts` — wire one shared repo into the new API.
- `src/web/panel.html` — replace the empty portal markup with the cockpit shell.
- `src/web/panel.js` — enter Stage without opening Terminal; mount artifact/terminal controllers.
- `src/web/panel-globals.d.ts` — type the one `panel.js` ↔ artifact-view handshake.
- `src/web/terminal-bridge.test.ts` — prove status refresh stays side-effect-free.
- `src/architecture.test.ts` — declare new modules and keep closure/function ratchets honest.
- `.gitignore` — keep local visual-brainstorm runtime artifacts out of product commits.
- `README.md`, `README.zh-CN.md` — macOS-only positioning and verified cockpit description.
- `docs/HANDOFF-2026-08-16-native-tui.md`, `docs/BACKLOG.md` — final evidence and closed item.

---

### Task 1: Add the append-only round artifact ledger

**Files:**
- Create: `src/domain/stage-artifact.ts`
- Create: `src/domain/stage-artifact.test.ts`
- Create: `src/store/stage-artifact-store.ts`
- Create: `src/store/stage-artifact-store.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/store/change-store.ts`
- Modify: `src/store/change-store.test.ts`

- [ ] **Step 1: Write the failing domain and store tests**

Use exact round facts rather than UI-shaped rows:

```ts
const R1: StageRoundArtifact = {
  changeId: "CHG-1", phase: "Build", round: 1, jobId: "JOB-1",
  artifactIds: ["a1b2c3d"], commit: "a1b2c3d", source: "recorded",
  files: [
    { path: "src/a.ts", role: "delivery", change: "added" },
    { path: "docs/stagepass/CHG-1/Build-r1.md", role: "producer", change: "added" },
  ],
  upstream: [{ phase: "Arch", artifactIds: ["docs/stagepass/CHG-1/Arch-r1.md"] }],
  settledAt: "2026-08-16T12:00:00.000Z",
};

assert.deepEqual(compareStageRounds(null, R1).map((f) => f.display), ["added", "added"]);
store.record(R1);
store.record(R1); // exact replay is idempotent
assert.equal(store.list("CHG-1", "Build").length, 1);
assert.throws(
  () => store.record({ ...R1, files: [] }),
  /stage_artifact_conflict:CHG-1\/Build\/1/,
);
```

Also assert newest-first ordering, invalid phase/round rejection, malformed JSON fail-loud, and that `ChangeStore.delete("CHG-1")` leaves zero manifest rows.

- [ ] **Step 2: Run the tests and verify the feature is absent**

Run:

```bash
node --import tsx --test src/domain/stage-artifact.test.ts src/store/stage-artifact-store.test.ts
```

Expected: FAIL because the domain/store modules and table do not exist.

- [ ] **Step 3: Add the canonical manifest types and comparison**

Implement this public vocabulary in `src/domain/stage-artifact.ts`:

```ts
export const ARTIFACT_ROLES = ["producer", "critic", "delivery", "structured"] as const;
export const FILE_CHANGES = ["added", "modified", "deleted", "renamed"] as const;
export const DISPLAY_CHANGES = [
  "added", "modified", "unchanged", "deleted", "replaced",
] as const;

export interface StageArtifactFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly role: (typeof ARTIFACT_ROLES)[number];
  readonly change: (typeof FILE_CHANGES)[number];
}

export interface StageArtifactUpstream {
  readonly phase: Phase;
  readonly artifactIds: readonly string[];
}

export interface StageRoundArtifact {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly jobId: string;
  readonly artifactIds: readonly string[];
  readonly commit: string | null;
  readonly source: "recorded" | "reconstructed";
  readonly files: readonly StageArtifactFile[];
  readonly upstream: readonly StageArtifactUpstream[];
  readonly settledAt: string;
}
```

`materializeStageRound(history, round)` must fold manifests in ascending round order, keyed by exact repository-relative path. Files omitted from a later commit remain `unchanged`; only an explicit current `deleted` row is `deleted`; a current `renamed` row removes `previousPath` and marks the new path `replaced`. `compareStageRounds(previous, current)` compares those materialized snapshots, rather than treating an absent delta row as deletion. Reject absolute paths, `..` segments, blank ids and rounds below 1.

- [ ] **Step 4: Add the table and store**

Add to `SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS stage_round_artifacts (
  change_id    TEXT NOT NULL REFERENCES changes(id),
  phase        TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  round        INTEGER NOT NULL CHECK (round >= 1),
  job_id       TEXT NOT NULL,
  artifact_ids TEXT NOT NULL,
  commit_sha   TEXT NULL,
  source       TEXT NOT NULL CHECK (source IN ('recorded','reconstructed')),
  files_json   TEXT NOT NULL,
  upstream_json TEXT NOT NULL,
  settled_at   TEXT NOT NULL,
  PRIMARY KEY (change_id, phase, round)
);
CREATE INDEX IF NOT EXISTS ix_stage_round_artifacts_job
  ON stage_round_artifacts (job_id);
```

`StageArtifactStore.record()` reads an existing row first: equal canonical JSON returns; a different payload throws `stage_artifact_conflict`. `list(changeId, phase)` orders by round descending. `read` returns `null` only when the row does not exist; malformed persisted JSON throws.

Add `stage_round_artifacts` before `change_events` in `ChangeStore.delete()`'s topological wipe list.

- [ ] **Step 5: Run the focused and deletion tests**

Run:

```bash
node --import tsx --test src/domain/stage-artifact.test.ts src/store/stage-artifact-store.test.ts src/store/change-store.test.ts
```

Expected: PASS, including migration on an old database that lacks the new table.

- [ ] **Step 6: Commit the ledger**

```bash
git add src/db/schema.ts src/domain/stage-artifact.ts src/domain/stage-artifact.test.ts src/store/stage-artifact-store.ts src/store/stage-artifact-store.test.ts src/store/change-store.ts src/store/change-store.test.ts
git commit -m "feat: add the stage artifact ledger"
```

---

### Task 2: Make Git report exact per-round file facts

**Files:**
- Modify: `src/work/repo.ts`
- Modify: `src/work/repo.test.ts`

- [ ] **Step 1: Write real-Git failing tests**

Extend the existing temporary-repository tests to create one commit containing add, modify, delete and rename. Assert:

```ts
assert.deepEqual(ops.changedFiles(cwd, sha), [
  { path: "added.ts", change: "added" },
  { path: "kept.ts", change: "modified" },
  { path: "gone.ts", change: "deleted" },
  { path: "new-name.ts", previousPath: "old-name.ts", change: "renamed" },
]);
assert.match(ops.fileAt(cwd, sha, "added.ts") ?? "", /added/);
assert.match(ops.fileBefore(cwd, sha, "gone.ts") ?? "", /before deletion/);
assert.match(ops.diffAt(cwd, sha, "kept.ts") ?? "", /^\+changed/m);
assert.equal(ops.changedFiles(cwd, "not-a-sha"), null);
```

Assert Chinese and spaced paths survive unchanged and that an unknown commit/path returns `null` rather than HEAD content.

- [ ] **Step 2: Run the repo test and see the missing methods**

```bash
node --import tsx --test src/work/repo.test.ts
```

Expected: FAIL with `changedFiles/fileAt/fileBefore/diffAt is not a function`.

- [ ] **Step 3: Extend `RepoOps` without invoking a shell**

Add:

```ts
export interface RepoFileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly change: "added" | "modified" | "deleted" | "renamed";
}

changedFiles(cwd: string, sha: string): readonly RepoFileChange[] | null;
fileAt(cwd: string, sha: string, path: string): string | null;
fileBefore(cwd: string, sha: string, path: string): string | null;
diffAt(cwd: string, sha: string, path: string): string | null;
```

Validate `sha` with `looksLikeSha` before Git. Use `git diff-tree --root --no-commit-id --name-status -z -r -M <sha>` and parse rename records as status/old/new. Sort the returned rows by `path` for deterministic manifests. Use argument arrays for `git show <sha>:<path>`, `git show <sha>^:<path>` and `git show --format= --find-renames --patch <sha> -- <path>`; never concatenate a shell command. `fileBefore` is the only allowed parent-commit read and exists specifically for explicit deletion rows.

- [ ] **Step 4: Run the repo suite**

```bash
node --import tsx --test src/work/repo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the Git boundary**

```bash
git add src/work/repo.ts src/work/repo.test.ts
git commit -m "feat: expose round file changes from git"
```

---

### Task 3: Land manifests atomically with evidence and state

**Files:**
- Modify: `src/work/round-turn-runner.ts`
- Modify: `src/work/round-turn-runner.test.ts`
- Modify: `src/work/turn-loop.ts`
- Modify: `src/work/turn-loop.test.ts`

- [ ] **Step 1: Write the failing runner and transaction tests**

In `round-turn-runner.test.ts`, assert a Build outcome carries its actual round, commit delta, both fixed report paths, and the exact upstream evidence snapshot. In `turn-loop.test.ts`, inject an outcome with `artifactManifest`, then assert the manifest, evidence and settled state all land.

Add a trigger that aborts `stage_round_artifacts` insert and assert the entire transaction rolls back:

```ts
database.exec(`
  CREATE TRIGGER fail_manifest BEFORE INSERT ON stage_round_artifacts
  BEGIN SELECT RAISE(ABORT, 'manifest failed'); END;
`);
assert.deepEqual(await loop.runOnce(claim), {
  kind: "failed", jobId: "JOB-1", reason: "manifest failed",
});
assert.equal(changes.read("CHG-1").state.status, "blocked");
assert.equal(new EvidenceStore(database).read("CHG-1", "Build").artifactIds.length, 0);
```

- [ ] **Step 2: Run the focused tests and verify the manifest is absent**

```bash
node --import tsx --test src/work/round-turn-runner.test.ts src/work/turn-loop.test.ts
```

Expected: FAIL because `TurnOutcome` has no manifest and the ledger is never written.

- [ ] **Step 3: Return a manifest from the real round runner**

Compute `upstream` once before composing the prompt and reuse that same value for both prompt text and manifest. Change `producedBy` to return both the gate artifacts and commit:

```ts
interface ProducedRound {
  readonly artifactIds: readonly string[];
  readonly commit: string | null;
}
```

After commit, map `repo.changedFiles(cwd, commit)` into manifest files. Exact `redDocPath` is role `producer`; exact `blueDocPath` is `critic`; `arch.graph.json` is `structured`; other files are `delivery`. If commit is null, retain valid reported paths and fixed report paths as file rows whose read endpoint may later say `file-unavailable`—do not invent a commit.

Extend `TurnOutcome` with:

```ts
readonly artifactManifest?: Omit<StageRoundArtifact, "settledAt">;
```

The real `RoundTurnRunner` always supplies it; scripted/offline runners may omit it.

- [ ] **Step 4: Record inside the existing settle transaction**

Construct `StageArtifactStore` in `TurnLoop`. Inside the existing database transaction, before `evidence.put`, record:

```ts
if (outcome.artifactManifest !== undefined) {
  this.artifacts.record({
    ...outcome.artifactManifest,
    settledAt: this.now().toISOString(),
  });
}
```

Keep manifest insert, evidence replacement, gap settlement and main/parallel settle in that one transaction. Job completion remains after the transaction, as today.

- [ ] **Step 5: Run the focused runtime tests**

```bash
node --import tsx --test src/work/round-turn-runner.test.ts src/work/turn-loop.test.ts
```

Expected: PASS, including parallel Build/Test manifests with independent `(phase, round)` keys.

- [ ] **Step 6: Commit transactional recording**

```bash
git add src/work/round-turn-runner.ts src/work/round-turn-runner.test.ts src/work/turn-loop.ts src/work/turn-loop.test.ts
git commit -m "feat: record each settled stage round"
```

---

### Task 4: Build the pure Stage projection and fenced reader

**Files:**
- Create: `src/graph/stage-artifact-layout.ts`
- Create: `src/graph/stage-artifact-layout.test.ts`
- Create: `src/graph/reconstruct-stage-artifact.ts`
- Create: `src/graph/reconstruct-stage-artifact.test.ts`
- Create: `src/graph/read-stage-artifact.ts`
- Create: `src/graph/read-stage-artifact.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing layout tests**

Use a two-folder manifest and a small parsed module graph. Assert:

```ts
const current = materializeStageRound([R1, R2], 2);
const scene = layoutStageArtifacts({ current, graph });
assert.deepEqual(scene.inputs.map((n) => n.phase), ["Arch", "BuildPlan"]);
assert.deepEqual(scene.folders.map((f) => f.path), ["src/core", "src/ui"]);
assert.equal(scene.files.find((f) => f.path === "src/core/a.ts")?.display, "modified");
assert.deepEqual(selectedDependencies(scene, "src/core/a.ts").direct, ["src/ui/b.ts"]);
```

Assert a path omitted from R2 remains `unchanged`, only an explicit deletion becomes `deleted`, coordinates are deterministic, an empty Stage produces an explicit empty model, folder aggregation activates above the documented threshold, and non-code files never receive invented dependency edges.

- [ ] **Step 2: Write failing legacy reconstruction and reader security tests**

For a pre-ledger Change, cover conservative reconstruction in `reconstruct-stage-artifact.test.ts`:

- enumerate only exact tracked `docs/stagepass/<change>/<Phase>-rN.md` and `<Phase>-rN-opposition.md` paths;
- accept a current evidence artifact id as a commit only when it is a validated SHA that `RepoOps.changedFiles` can resolve;
- group exact document paths by their parsed round and attach a proven current-evidence commit only to the matching current round;
- mark every returned row `source: "reconstructed"` without inserting it into `stage_round_artifacts`;
- return an explicit incomplete-history model when a settled round is known but its file set cannot be proven;
- never parse commit messages, enumerate arbitrary current worktree files, or guess fuzzy path names.

In a temporary Git repository and database manifest, assert:

```ts
assert.equal(reader.read({ ...request, path: "../../.ssh/id_rsa" }).reason, "path-outside");
assert.equal(reader.read({ ...request, path: "tracked-but-not-in-manifest.ts" }).reason,
  "path-not-in-round");
assert.equal(reader.read({ ...request, commit: "HEAD~1" }).reason, "commit-mismatch");
assert.equal(reader.read({ ...request, path: "deleted.ts" }).ok, true);
```

Also cover a symlink escaping root, binary content, missing historical commit, Markdown current content, code historical content/diff, deleted content read only through `fileBefore`, and a dependency parser failure that leaves text readable.

- [ ] **Step 3: Run both tests and verify the modules are missing**

```bash
node --import tsx --test src/graph/stage-artifact-layout.test.ts src/graph/reconstruct-stage-artifact.test.ts src/graph/read-stage-artifact.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the pure scene model**

Export a serializable model:

```ts
export interface StageArtifactScene {
  readonly round: number | null;
  readonly empty: boolean;
  readonly inputs: readonly StageInputNode[];
  readonly folders: readonly StageFolderNode[];
  readonly files: readonly StageFileNode[];
  readonly production: readonly StageProductionEdge[];
  readonly dependencyIndex: Readonly<Record<string, {
    readonly dependencies: readonly string[];
    readonly dependents: readonly string[];
    readonly blast: number;
  }>>;
}
```

Large geometry is input → output. Directory path groups files. The scene receives a materialized round snapshot (prior files folded forward plus the current delta), while preserving the current round's display status. Reuse `parseModuleGraph`/`blastRadiusOf` only for materialized code paths that exist in the project graph. Export `selectedDependencies(scene, path)` separately; it derives dependency edges only after selection so the default scene cannot become a full-edge hairball.

- [ ] **Step 5: Implement the one read boundary**

`read-stage-artifact.ts` accepts a Project root, a server-materialized round snapshot, a whitelisted path and injected `RepoOps`. It must:

1. reject absolute/`..` paths;
2. require exact membership in the materialized round snapshot (never a browser-supplied whitelist);
3. require the requested commit to equal `manifest.commit` rather than accepting a browser ref;
4. realpath current files under the project root;
5. use `fileAt/diffAt` for historical files and `fileBefore` only for an explicit deletion row;
6. cap text at 2 MB;
7. detect NUL bytes and return `{ kind: "binary", size }`;
8. return text even if dependency parsing fails, with a separate dependency error.

- [ ] **Step 6: Declare architecture placement and run the guards**

Add the new domain/store/graph/web modules to the existing layer map. Do not weaken ratchet limits; if a new function crosses the limit, split it.

```bash
node --import tsx --test src/graph/stage-artifact-layout.test.ts src/graph/reconstruct-stage-artifact.test.ts src/graph/read-stage-artifact.test.ts src/architecture.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the projection and reader**

```bash
git add src/graph/stage-artifact-layout.ts src/graph/stage-artifact-layout.test.ts src/graph/reconstruct-stage-artifact.ts src/graph/reconstruct-stage-artifact.test.ts src/graph/read-stage-artifact.ts src/graph/read-stage-artifact.test.ts src/architecture.test.ts
git commit -m "feat: project stage artifacts safely"
```

---

### Task 5: Expose a read-only Stage artifact API

**Files:**
- Create: `src/web/stage-artifact-api.ts`
- Create: `src/web/stage-artifact-api.test.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/web/panel-server.test.ts`
- Modify: `scripts/panel.ts`

- [ ] **Step 1: Write failing route tests**

Build a temporary project/Change with two manifests. Assert:

```ts
const rounds = await getJson(`${base}/api/stage-artifacts?change=CHG-1&phase=Build`);
assert.equal(rounds.body.rounds[0].round, 2);
assert.equal(rounds.body.scene.files[0].path, "src/a.ts");

const file = await getJson(
  `${base}/api/stage-file?change=CHG-1&phase=Build&round=2&path=src%2Fa.ts`,
);
assert.equal(file.status, 200);
assert.match(file.body.diff, /changed/);
```

Add a pre-ledger Change and assert the list endpoint returns proven exact-path history as `source: "reconstructed"`, leaves uncertain history explicitly incomplete, and still inserts zero ledger rows. Snapshot row counts for `jobs`, `turns`, `questions`, `change_events`, `change_evidence`, `stage_round_artifacts` and `gaps` before and after all GETs and assert exact equality. Cover `change-required`, `phase-invalid`, `round-invalid`, `change-unknown`, `project-mismatch`, `no-path`, `not-a-repo`, `path-not-in-round`, `path-outside`, `commit-mismatch`, `file-unavailable` and `binary`.

- [ ] **Step 2: Run the API test and see 404s**

```bash
node --import tsx --test src/web/stage-artifact-api.test.ts
```

Expected: FAIL because the injected routes do not exist.

- [ ] **Step 3: Implement the independent handler**

Mirror `createGraphApi`'s boundary:

```ts
export function createStageArtifactApi(input: {
  database: Database.Database;
  repo: RepoOps;
}): (
  url: URL, request: IncomingMessage, response: ServerResponse,
) => Promise<boolean>;
```

Handle only `GET /api/stage-artifacts` and `GET /api/stage-file`; return false for every other path. Resolve Change → Project → root server-side. Do not accept project id or commit from the browser. Fold stored deltas into a materialized snapshot before layout and file reads. If the ledger is empty, call the conservative read-only reconstruction helper and never persist its output. Return JSON errors with stable codes and no cache.

Load open gaps as related facts, never as a second action surface. Bind a gap to a file only when its `where` field is exactly one complete, boundary-valid repository-relative path present in that materialized snapshot; put every other gap in `stageFacts`. Do not use substring, basename or fuzzy matching.

Add a `stageArtifacts?: handler` injection to `PanelOptions`, call it adjacent to the existing graph handler, and wire it in `scripts/panel.ts` with the same `database` and shared `repo` instance.

- [ ] **Step 4: Run API and panel tests**

```bash
node --import tsx --test src/web/stage-artifact-api.test.ts src/web/panel-server.test.ts
```

Expected: PASS and no architecture closure increase from importing the new family into `panel-server.ts`.

- [ ] **Step 5: Commit the read API**

```bash
git add src/web/stage-artifact-api.ts src/web/stage-artifact-api.test.ts src/web/panel-server.ts src/web/panel-server.test.ts scripts/panel.ts
git commit -m "feat: expose stage artifacts read only"
```

---

### Task 6: Replace the empty Stage portal with the cockpit

**Files:**
- Create: `src/web/stage-artifact-view.js`
- Create: `src/web/stage-artifact-scene.js`
- Create: `src/web/stage-artifact.css`
- Modify: `src/web/panel.html`
- Modify: `src/web/panel.js`
- Modify: `src/web/panel-globals.d.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/web/terminal-bridge.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Add source-level guards before markup changes**

Extend existing architecture/browser-source guards to assert:

```ts
assert.match(panelHtml, /id="stage-artifact-canvas"/);
assert.match(panelHtml, /id="stage-artifact-detail"/);
assert.match(panelHtml, /id="stage-rounds"/);
assert.match(panelJs, /terminalBridge\.refresh\(\)/);
assert.doesNotMatch(panelJs, /await terminalBridge\.openOrFocus\(\)/);
assert.match(panelJs, /window\.stagepassArtifacts\?\.open/);
```

In `terminal-bridge.test.ts`, call `refresh()` and assert only `GET /api/terminal/status` occurs; click primary and assert the existing POST open/focus behavior remains.

- [ ] **Step 2: Run guards and verify the old portal fails them**

```bash
node --import tsx --test src/architecture.test.ts src/web/terminal-bridge.test.ts
```

Expected: FAIL on missing cockpit elements and automatic `openOrFocus`.

- [ ] **Step 3: Build the semantic cockpit shell and stylesheet**

Replace only `#stage-view`'s body with:

```html
<section class="view" id="stage-view" hidden>
  <header class="stage-cockpit-head">
    <button class="back" id="back">← 返回阶段环</button>
    <div><small id="stage-state">STAGE</small><h1 id="stage-name">—</h1></div>
    <p id="stage-thread"></p>
    <p id="stage-next"></p>
    <span id="terminal-summary"></span>
    <button id="terminal-primary" type="button">打开系统终端</button>
    <button id="terminal-close-window" type="button" hidden>关闭终端窗口</button>
  </header>
  <div class="stage-cockpit-body">
    <section id="stage-artifact-canvas" aria-label="本阶段产物结构"></section>
    <aside id="stage-artifact-detail" aria-live="polite"></aside>
  </div>
  <nav id="stage-rounds" aria-label="轮次时间轴"></nav>
  <p class="note" id="stage-note"></p>
</section>
```

Use the existing fog-violet/sand-gold variables. Desktop grid is `minmax(0, 68fr) minmax(280px, 32fr)`; below 900px stack detail under the canvas. Status words and node shape must duplicate color meaning. Add `/stage-artifact.css`, `/stage-artifact-view.js` and `/stage-artifact-scene.js` to `ASSETS` and load the view module from `panel.html`.

- [ ] **Step 4: Implement the isolated browser controller**

Expose one handshake:

```js
window.stagepassArtifacts = {
  open(input) { return controller.open(input); },
  close() { controller.close(); },
};
```

The controller aborts the active fetch, disposes the scene and clears its per-Stage cache on `close()`. `stage-artifact-view.js` must render newest round first, switch rounds without a write, keep one selected file, synchronize search/list/scene selection, fetch details on demand, render Markdown as safe text/structured headings (no raw HTML injection), show diff/code with `textContent`, and use explicit empty/error cards. File-exact related gaps appear in the selected file inspector; `stageFacts` remain Stage-level. Add Stage adapters as data only: default inspector tab and labels for PRD/Spec/Arch/BuildPlan/TestPlan/Build/Test/QA.

`stage-artifact-scene.js` renders upstream portals, folder regions and file stars from API coordinates. It shows selected dependency edges only. If WebGL creation fails, render an SVG/folder list into the same canvas; every manifest file remains a real keyboard-focusable button in the companion list.

- [ ] **Step 5: Change Stage entry to a pure look**

In `panel.js`, rename the sheet action from `进入会话` to `查看阶段产物`. `enter(phase)` must:

1. switch to `#stage-view`;
2. create `terminalBridge` and call `refresh()`, not `openOrFocus()`;
3. call `window.stagepassArtifacts?.open(...)` with the already-computed Stage state/next step;
4. leave the user on the artifact page when the Terminal button is clicked.

`leave()` closes both controllers and returns to the ring. `dispatchThenEnter()` may still enter during a slow human interaction, but must not turn the read-only Stage entry into an automatic Terminal launch.

- [ ] **Step 6: Run focused front-end guards and typecheck**

```bash
node --import tsx --test src/architecture.test.ts src/web/terminal-bridge.test.ts src/web/panel-server.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the cockpit**

```bash
git add src/web/stage-artifact-view.js src/web/stage-artifact-scene.js src/web/stage-artifact.css src/web/panel.html src/web/panel.js src/web/panel-globals.d.ts src/web/panel-server.ts src/web/terminal-bridge.test.ts src/architecture.test.ts
git commit -m "feat: render the stage artifact cockpit"
```

---

### Task 7: Rewrite README around the macOS product boundary

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `.gitignore`

- [ ] **Step 1: Rewrite positioning, requirements and capability order**

Both READMEs must say, without a cross-platform fallback:

```text
StagePass is a macOS-native local delivery control plane for Codex.
StagePass 是面向 Codex 的 macOS 原生本地交付控制面。
```

Order the story as: positioning → problem → eight-phase diamond ring → Stage artifact cockpit → project black-hole graph → official native TUI ownership → honest status → one 4173 command → architecture and documents.

Requirements must explicitly name macOS, Terminal.app automation permission, Codex CLI with `app-server`, Node 20+ and pnpm. Keep the rule that unverified features are not written in completed tense; update test counts only from the final run.

Ignore `/.superpowers/` in `.gitignore`. It contains the local visual-brainstorm server state, not StagePass product source; preserve it on disk and keep it out of commits.

- [ ] **Step 2: Run wording guards**

```bash
rg -n "macOS-native|macOS 原生|Terminal\.app|--port 4173" README.md README.zh-CN.md
rg -n "Windows|Linux|xterm|tmux|browser terminal" README.md README.zh-CN.md
```

Expected: first command finds the required boundary; second finds no claimed runtime path for retired/cross-platform modes (historical explanation may name a retired mode only if explicitly marked retired).

- [ ] **Step 3: Commit README**

```bash
git add README.md README.zh-CN.md .gitignore
git commit -m "docs: position StagePass as macOS native"
```

---

### Task 8: Browser acceptance, regression and handoff

**Files:**
- Modify: `docs/HANDOFF-2026-08-16-native-tui.md`
- Modify: `docs/BACKLOG.md`
- Modify only if acceptance exposes defects: files from Tasks 1–7 and their focused tests.

- [ ] **Step 1: Run the complete static and offline suite**

```bash
pnpm typecheck
npm test
git diff --check
```

Expected: typecheck exits 0; all tests pass with 0 fail/skip; diff check is empty.

- [ ] **Step 2: Prepare isolated real-shape acceptance data**

Copy the real StagePass database to a temporary directory, never mutate the real file. Use a disposable Git project containing:

- two Build manifests/commits with add/modify/delete/rename;
- producer and opposition Markdown;
- one upstream Arch document;
- one binary asset;
- one deleted historical file;
- one open gap whose `where` exactly names a file and one Stage-only gap.

Start exactly one product instance:

```bash
stagepass_acceptance_dir="$(mktemp -d /private/tmp/stagepass-cockpit-e2e.XXXXXX)"
cp -p /Users/zhanghr/.stagepass/panel.db "$stagepass_acceptance_dir/panel.db"
pnpm panel -- --db "$stagepass_acceptance_dir/panel.db" --port 4173 --change CHG-E2E
```

Run these lines in one shell so the task-specific variable remains resolved; print and record its concrete value in the handoff. Expected: listens only on `127.0.0.1:4173`.

- [ ] **Step 3: Run real-browser acceptance**

Using the browser testing skill, verify:

1. Stage entry does not open/focus Terminal and causes no POST;
2. top bar shows state, next step and current Terminal status;
3. newest round, upstream portals, folders and all file buttons render;
4. selecting code lights only its dependency neighborhood;
5. Markdown, code diff, binary metadata and deleted historical content render correctly;
6. R1/R2 switching changes the projection without changing database row counts;
7. search and keyboard selection reach every manifest file;
8. forced WebGL failure keeps the 2D/list fallback usable;
9. clicking `打开/聚焦 Codex` invokes only the native Terminal route and the artifact page stays mounted;
10. browser console has no uncaught error and no request returns 5xx.

Capture a screenshot in `docs/evidence/screenshots/stage-artifact-cockpit-2026-08-16.png` only after the final visual state passes.

- [ ] **Step 4: Switch back to the real database for read-only verification**

Stop the isolated 4173 process, start the experiment worktree with:

```bash
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

Open `CHG-002`, verify the old unanswered business choice is still not applied, the Stage cockpit shows only conservatively reconstructed history plus an explicit incomplete-history notice where proof is missing, Terminal status remains `idle/open/focus`, and no business table changes after browsing.

- [ ] **Step 5: Update evidence documents**

Record exact test totals, browser scenarios, screenshot path, commit hashes, real DB read-only result and the sole restart command in `HANDOFF-2026-08-16-native-tui.md`. Mark the “thin Stage page” item complete in `BACKLOG.md`; do not close unrelated backlog entries.

- [ ] **Step 6: Review and commit final evidence**

```bash
git diff --check
git status --short
git add docs/HANDOFF-2026-08-16-native-tui.md docs/BACKLOG.md docs/evidence/screenshots/stage-artifact-cockpit-2026-08-16.png
git commit -m "docs: verify the stage artifact cockpit"
```

Expected: experiment worktree clean except ignored visual-brainstorm files; original `/Users/zhanghr/Desktop/stagepass` worktree unchanged; one StagePass server alive on 4173.
