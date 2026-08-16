# StagePass

**English** · [简体中文](README.zh-CN.md)

> **A model does not get to pass its own work.**

StagePass is a **macOS-native local delivery control plane for Codex**. It gives
one software change a durable workflow, independent adversarial review, visible
artifacts, and a human-owned gate at every phase. The browser controls structure
and shows facts; Terminal.app runs the official Codex TUI and owns every
interactive turn, MCP prompt, approval, and interrupt.

StagePass is intentionally macOS-only. It does not ship a browser terminal, PTY
compatibility layer, tmux session manager, or Windows/Linux fallback.

## Why it exists

Letting a model decide whether its own phase is complete is letting it grade its
own exam. In ordinary agent workflows, an earlier problem can disappear because
the next response forgot to mention it, a confident “no blockers” can open a
gate, and the same reasoning error can be copied into both implementation and
tests.

StagePass makes those failures structurally harder:

1. **Silence cannot close a problem.** Gaps survive rounds until a reasoned
   verdict or explicit human decision changes them.
2. **Gates read durable evidence.** A phase advances only through the state
   machine and its ledger, never because UI text looks successful.
3. **The model does not own the final decision.** Business choices are put to a
   person through Codex MCP elicitation and recorded through one StagePass use
   case.
4. **Build and Test are mutually blind.** They share the Arch contract, not each
   other’s implementation, and collide at QA.
5. **Identifiers are never hand-transcribed by the model.** Exact IDs come from
   protocol and database facts; model output is limited to choices and prose.

## The eight-phase diamond

```text
PRD → Spec → Arch → BuildPlan ─→ Build ─┐
                  └→ TestPlan  ─→ Test ─┴→ QA
```

Arch is the fork. BuildPlan/Build and TestPlan/Test form two controlled tracks.
QA runs the real tests, attacks the tests with mutations, and attributes a
failure to Build, Test, or Arch. A send-back is a re-walk: downstream approvals
that depended on the rejected fact are not silently preserved.

Every active phase runs an adversarial round:

```text
red produces → blue attacks → judge rules → rubric roles score → human gate
```

## Stage artifact cockpit

Opening a phase now leads to a read-only artifact cockpit instead of an empty
Terminal portal. It shows:

- the exact upstream Stage evidence consumed by the selected round;
- real folders and every produced, modified, carried, deleted, or replaced file;
- production lineage as the macro structure;
- direct dependencies, dependents, and blast radius only after a code file is
  selected;
- fixed historical content and Git diff for older rounds;
- file-specific gaps, Stage-level gaps, and the explicit next controlled move;
- an always-available **Open / Focus Codex** control that stays separate from
  artifact browsing.

The cockpit reads an append-only per-round artifact ledger. Legacy rounds are
reconstructed only from exact Stage paths or a proven evidence commit; missing
history is labelled incomplete instead of being filled from the current working
tree. File reads are fenced by Change → Project ownership, manifest path,
realpath, size, and recorded commit. The browser cannot submit an arbitrary Git
ref.

Every file remains reachable through a keyboard-focusable list. If WebGL is not
available, the spatial scene falls back to a two-dimensional folder projection
without losing files or detail controls.

## Project black hole

The sun at the center of the Stage ring opens the whole project’s dependency
graph, parsed with the TypeScript compiler rather than regex.

- The black hole represents dependency pressure. Highly depended-on layers
  orbit closer to the center; higher blast-radius modules sink inward.
- Healthy dependencies point inward. Outward arcs expose a layer violation.
- Arch produces `arch.graph.json`; StagePass reconciles its concepts and
  relations against real code and overlays the plan on the project graph.
- Assets and generated directories are kept outside the code scene according to
  the project’s persisted inclusion rules.

The project graph answers “what is this repository?” The Stage cockpit answers
“what did this round produce?” They share visual language, not business state.

## Native Codex ownership

StagePass keeps durable Codex App Server threads and normalized lifecycle facts.
The official Codex TUI in Terminal.app remains the only interactive client:

- Terminal receives keyboard input, ANSI color, MCP forms, approvals, and
  `Ctrl+C` directly;
- the browser never receives or redraws terminal bytes;
- closing a Terminal window discards only that client; reopening resumes the
  same bound Codex thread;
- entering a Stage only refreshes terminal status. Terminal opens or focuses
  only when the person presses the explicit button.

Before first use, macOS may ask permission for the process running StagePass to
control Terminal. Allow it in **System Settings → Privacy & Security →
Automation**. StagePass fails closed if it cannot identify exactly one managed
Terminal window.

## Honest status

| Capability | Status |
|---|---|
| SQLite state machine, gates, leases, crash recovery | Implemented and covered by the offline suite |
| Eight-phase diamond, blind tracks, QA attribution and re-walk | Implemented; real Changes have traversed the ring |
| Managed App Server threads + official native Codex TUI | Implemented and previously accepted on macOS |
| Project black-hole graph + Arch reconciliation | Implemented and previously accepted on macOS |
| Append-only round artifacts + Stage cockpit | Implemented on this experimental worktree; final 4173 browser evidence is recorded in the current handoff |
| StagePass producing and shipping its own next Change end to end | Not yet earned; this remains the bootstrap criterion |

Nothing above claims a cross-platform runtime. A rendering surface is a
projection, not a decision authority: looking at a Stage, file, round, or graph
must not start a turn or write business state.

## Run on port 4173

Requirements:

- macOS with Terminal.app;
- Node.js 20+ and pnpm;
- Codex CLI with `codex app-server`;
- macOS Automation permission for Terminal control.

Install and verify:

```bash
pnpm install
pnpm check
```

Start the real local control plane from this worktree:

```bash
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). Port **4173 is the
only supported product port**: if it is occupied, stop the existing StagePass
instance and restart it on 4173; do not start a second copy on another port.

Without `--db`, the panel creates a throwaway database for isolated inspection.
It does not migrate or replace the real database unless that path is explicitly
provided.

## Architecture boundaries

| Area | Owns | Must not own |
|---|---|---|
| `src/domain`, `src/store`, `src/app` | State, gates, evidence, questions, decisions | Rendering |
| `src/work`, `src/codex`, `src/system` | Jobs, Git facts, App Server protocol, native Terminal lifecycle | Browser UI decisions |
| `src/graph` | Compiler graph, deterministic layouts, safe artifact reads | Workflow transitions |
| `src/web` | Read-only projections, HTTP boundaries, native-client controls | Terminal bytes or a second gate path |
| `src/plugin` | MCP elicitation bridge | Deciding what is legal |

SQLite is the sole business authority. State updates require matching ledger
facts at write time. `src/architecture.test.ts` enforces downward-only layers,
callers for production exports, one phase vocabulary, no PTY/private-state
runtime, and size/closure ratchets.

Key documents:

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) — product authority
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — single list of unfinished work
- [`docs/HANDOFF-2026-08-16-native-tui.md`](docs/HANDOFF-2026-08-16-native-tui.md) — current worktree and verification handoff
- [`docs/CODEX-CONTRACT.md`](docs/CODEX-CONTRACT.md) — measured App Server behavior
- [`docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md`](docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md) — native TUI ownership contract
- [`docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md`](docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md) — cockpit design and acceptance criteria

## License

[MIT](LICENSE)
