# StagePass

**English** · [简体中文](README.zh-CN.md)

> **A model does not get to pass its own work.**

StagePass is a local delivery control plane. It lays one change onto an
**eight-phase diamond ring**, runs an adversarial Codex round at every phase
(red produces, blue attacks, a judge rules), collects evidence, surfaces
problems — and then **stops and waits for a person to decide**. In this isolated
branch, Codex runs through one supervised App Server and StagePass renders its
typed stream and interaction sheet. Only the person's recorded choice can
advance a gate.

```
PRD → Spec → Arch → ⟨BuildPlan ∥ TestPlan⟩ → ⟨Build ∥ Test⟩ → QA
                └───── two mutually blind tracks ─────┘
```

Arch is the fork of the diamond: the build track and the test track split
there and **cannot see each other** (Build may not even read the tests). They
collide at QA — which reads the code, runs the tests, and mutation-attacks the
test suite itself. What QA finds is sent back with three-way attribution
(Build / Test / Arch), and a send-back means a **re-walk**: phases in between
are no longer presumed correct, and every parallel seat is cleared.

---

## ⚠️ Status: foundation green, ring closed, bootstrap not yet

This is not usable software yet. **The table below is honest**; what is not
done is simply not done:

| Layer | What it is | Status |
|---|---|---|
| **L0–L5** | Schema, state machine, gates, leases, crash recovery, pure App Server hosting, human interactions, adversarial rounds, rubric scoring | ✅ 1057-test baseline plus App Server protocol and browser acceptance |
| **Ring v3** | Eight-phase diamond, blind parallel tracks, QA's three attacks, send-back-as-rewalk, parallel seats | ✅ Landed in six batches (2026-08-09); CHG-001 really walked the new ring to QA and is re-walking after a send-back |
| **Project graph** | Black-hole-and-Saturn-rings 3D dependency view, Arch blueprint reconciliation overlay | ✅ Verified on a real machine (2026-08-12); one semantic boundary still awaits a ruling |
| **Bootstrap** | Run one Change through StagePass that produces StagePass's own next change | ❌ Has not happened — this is the test of whether the word "bootstrap" is earned |

**A layer that has not passed is a layer you may not build on.** That is this
repository's construction discipline, not a suggestion — and it is also how
this README stays alive: every line corresponds to something that actually ran.

> The README before the rebuild described an architecture that **never ran**.
> It was deleted along with the old code; the rebuild started 2026-07-28.
> Writing unproven things in the past tense is exactly how that README became
> waste paper. The old twelve-phase mainline is retired too (TechSpec merged
> into Arch, Review absorbed by QA, Fix became the send-back interaction) —
> the names belong to history now, and historical ledger rows are never
> rewritten.

---

## The problem it exists for

Letting a model judge "is this phase done?" is letting it grade its own exam.
Real failures look like this:

- Round two regenerates the document and **last round's problems, never
  mentioned again, count as solved**;
- The model reports "no blockers", the gate opens, the problem rides into the
  next phase;
- The same mind writes the code and the tests, so the tests pin the
  implementation's text rather than its behaviour.

StagePass answers each with a hard rule:

1. **Silence cannot close a problem.** Rows in `gaps` survive across rounds;
   closing one requires a reason — "not mentioned this round" and "this round
   claims it is fixed" are two different rows in the database.
2. **Gates read evidence, not self-assessment.** A phase node turns green only
   because **a person approved it in the ledger**.
3. **There is exactly one decision path.** App Server approval and elicitation
   requests appear in the StagePass interaction sheet, but the answer still
   enters the same StagePass use case and ledger. Rendering cannot move a gate.
4. **The code author and the test author are blind to each other.** The two
   tracks share only the Arch contract and collide at QA, where mutation
   attacks vet the tests themselves (a no-op mutation must stay green;
   reverting the change must turn red).

### The fifth rule was paid for in full

**Any string StagePass will exact-match may never appear in text a model has
to write out.** A judge once dropped a chunk of a 36-character UUID and four
perfectly-formed verdicts died together. A survey found seven such surfaces;
five had already burned at least once.

So model output is now restricted to **enum choices and prose**. Identifiers
never pass through a model's mouth: thread lineage comes from `thread/read`;
none of the plugin's three tools accepts an identifier;
the rubric the critic answers is numbered `1..N`, and a missing or duplicated
number voids the whole sheet instead of letting verdicts slide onto the wrong
criteria.

---

## The project graph: a black hole, Saturn's rings, and Arch's blueprint

The sun at the center of the ring opens the project's **real dependency
graph** (parsed with the actual TypeScript compiler, not regex):

- **The black hole at the center is the pull of dependency itself** — the more
  a layer is depended on, the closer its ring band sits to the hole; within a
  band, the larger a file's blast radius, the closer it sinks to the inner
  edge. `tests`, which nothing depends on, is the outermost ring.
- **Violations are visible at a glance**: healthy dependencies all point
  inward; an arc climbing outward is "depending on something above you".
- **Arch must produce a machine-readable blueprint** (`arch.graph.json`:
  concepts / relations / claims). It is mechanically reconciled against the
  real code and overlaid on the rings — a planned concept hovers directly
  above the stars that carry it; a concept that exists in the requirements but
  not in the code is a rose-colored ghost on a planning orbit outside the
  outermost ring.
- Reconciliation never judges; it lays out facts in six kinds — homeless
  concept, scattered concept, overloaded module, unclaimed module,
  unimplemented relation, unplanned dependency — each readable in the side
  panel and drawn distinctly on the rings.

Which directories count as "real code" is checked off by a person in the
panel (persisted per project); assets and generated files are aggregated into
a short list of doors and never enter the scene. The graph is **never
cached**: ~200ms end to end, always equal to the tree on disk.

---

## Three parts, no overlapping duties

| | Does | **Explicitly does not** |
|---|---|---|
| **State machine & gates** (`src/domain`, `src/store`, `src/app`) | Transitions, gates, fencing, leases, recovery; composing questions, validating answers, advancing state | **Render anything** |
| **App Server workbench** (`src/web`) | Viewing and launching: the phase ring, evidence, graph, normalized Codex snapshots/events and human interactions | Infer gate state from model text or bypass a StagePass use case |
| **Codex plugin** (`src/plugin`) | Asks the person via MCP `elicitation`, sends the answer back | Decide, compose, or judge legality |

**The panel is a projection, not a decision authority.** StagePass materializes
typed App Server thread/turn/item state and renders it in its own visual system.
Raw JSON-RPC ids and payloads never cross into the browser.

This is not left to judgement. The standing guards in
`src/architecture.test.ts` may never go red. The founding five:

1. Every module declares its layer;
2. A lower layer may not import a higher one;
3. No export with zero callers;
4. One name per concept (no phase-name aliases);
5. **No PTY/TUI/private-record runtime path.** Production scanning rejects
   `node-pty`, xterm, `/pty/`, rollout paths and `state_5.sqlite`; only the
   supervised App Server client may spawn Codex.

Ratchets grew later: single-function line counts, per-module dependency
closure share, ingredient-list share of the tree — existing violations are
pinned in an exception table that may only shrink. The graph routes exist as
injected wiring precisely because the closure ratchet went red on the direct
version: the guard was right, so the code followed it.

### Looking must have no side effects

Reading a snapshot or opening the graph writes nothing and never starts a turn.
**A look is just a look.** Opening a Codex thread and starting a turn remain two
separate actions.

---

## What runs today

```bash
pnpm install
pnpm check            # strict typecheck + complete offline suite
```

With a real Codex:

```bash
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

All `pnpm panel` flags are optional:

```bash
node --import tsx scripts/panel.ts \
  --db <path> --port 4173 \
  --project-name <name> --project-path <dir> \
  --model <model> --effort minimal|low|medium|high|xhigh \
  --ask-timeout <minutes> --turn-timeout <minutes> --round-budget <rounds>
```

Reasoning effort defaults to `xhigh`: an adversarial round takes minutes
anyway; saving pennies of thinking budget for a shallower verdict is a bad
trade. Without `--db` a throwaway database is created — click anything, no
real data is touched.

Generate the exact local protocol schema after a Codex upgrade with
`pnpm schema:app-server`.

### Requirements

- **Node 20+** (developed on 25.9), **pnpm**.
- **Codex CLI with `app-server`** (verified on 0.147.0).

### Two traps that bite

**Only an explicit App Server “thread missing” may detach a binding.** A timeout,
disconnect or protocol error means “unavailable”, not “gone”; preserving that
distinction prevents archived or temporarily unreachable sessions from being
silently replaced.

**A sub-agent's thread refuses input from anyone but its parent.**
`codex resume <subagent-thread>` starts fine, the MCP server loads, and the
first submission returns `■ This sub-agent is controlled by its parent.
Direct input is disabled.` — regardless of whether the parent is still alive.
Measured 2026-08-03 on 0.146.0. Any design that drives a sub-agent thread
directly is dead on arrival.

---

## Shape of the repository

```
src/
  domain/     Pure logic: phases, state machine, gates, gaps, leases, rounds,
              questions, templates and factory rubrics — no IO, exhaustively provable
  store/      SQLite: changes, evidence, gaps, bindings, rubrics, parallel seats,
              the aside ledger
  app/        Use cases: ask a human, record a brief, decide a gate, waive a risk,
              create and delete
  work/       Long-running: job leases, the turn loop, wiring for adversarial and
              rubric rounds, git
  graph/      The graph engine: compiler-parsed dependencies, selection criteria,
              layout, ingredient lists, blueprint reconciliation — all pure functions
  codex/      App Server JSON-RPC, sessions, history, stream projection,
              transport, directory trust and archive policy
  plugin/     The MCP plugin: its only write is "record what the person said"
  web/        App Server session registry, snapshot/SSE API, native renderer,
              panel server, graph API and browser half
  architecture.test.ts   the standing guards
docs/         PRD, BACKLOG, designs, handoffs. **The PRD is the only authority;
              BACKLOG is the single entry point for undone work.**
scripts/      panel, plugin server, dump-rubrics, regen-prompt-golden
```

SQLite is the sole business authority — a trigger
on `changes` makes the database itself reject, **at write time**, any state
update without its matching ledger row.

Two things are pinned byte-for-byte, deliberately:

- `src/domain/round-prompt.golden.txt` — every phase's judge prompt. Touch one
  phase and the others must not move by a character; this is what stops them
  from growing back into one shared template.
- The plugin's tool contract — three tools, **none accepts an identifier**.

Key documents:

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) — **the only authority**, including why the rebuild
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — what is undone and why, accumulated across sessions
- [`docs/PLAN-2026-08-09-ring-v3.md`](docs/PLAN-2026-08-09-ring-v3.md) — ring v3: eight rulings, seven batches
- [`docs/superpowers/specs/2026-08-15-app-server-native-streaming-design.md`](docs/superpowers/specs/2026-08-15-app-server-native-streaming-design.md) — pure App Server runtime and native stream contract
- [`docs/CODEX-CONTRACT.md`](docs/CODEX-CONTRACT.md) — the live App Server behavior contract
- [`docs/superpowers/specs/2026-08-12-project-graph-3d-design.md`](docs/superpowers/specs/2026-08-12-project-graph-3d-design.md) — the project graph's design and criteria
- [`docs/DESIGN-no-hand-transcription-2026-08-02.md`](docs/DESIGN-no-hand-transcription-2026-08-02.md) — the seven hand-transcription surfaces and how each reached zero

---

## License

[MIT](LICENSE)
