# StagePass

**English** · [简体中文](README.zh-CN.md)

> **A model does not get to pass its own work.**

StagePass is a local delivery control plane. It splits one change into twelve
phases, runs Codex once per phase to produce evidence and find problems, and then
**stops and waits for a person to decide**. The decision happens in Codex's own
selector, not on a web page. Only once you have chosen does StagePass advance.

---

## ⚠️ Status: under construction — four of six layers done

This is not usable software yet. **The table below is honest**; what is not done
is simply not done:

| Layer | What it is | Status |
|---|---|---|
| **L0** | Schema, state machine, transitions, audit ledger | ✅ Proved fully offline |
| **L1** | Gate computation, fencing, leases, heartbeats, idempotency, crash recovery | ✅ Proved fully offline |
| **L2** | Launching the Codex TUI, thread binding, turn records, reading results from the rollout | ✅ Real turns, twice (osascript and pty) |
| **L3** | Compose question → Codex's native selector → a person chooses → answer lands → state advances | ✅ A real person really chose |
| **L4** | Red / blue / judge adversarial rounds, settled into something decidable | ✅ One real round: gaps stored, gate held shut |
| **L5** | Rubric scoring, gap tracking | ⬜ Not started |
| **L6** | Rolled out to the remaining phases | ⬜ Not started |

**A layer that has not passed is a layer you may not build on.** That is this
repository's construction discipline, not a suggestion — and it is also how this
README is written: every line corresponds to something that actually ran.

> The previous README described an architecture that **never ran** — MCP App
> decision cards, follower IPC, a separate web dashboard. All of it was deleted
> along with the old tree; the rebuild started 2026-07-28. Writing something that
> never worked as if it were finished is exactly what turned that README into
> waste paper.

---

## The problem it exists for

Asking a model whether it finished a phase is asking it to grade itself. The real
failures look like this:

- Round two regenerates the document, **fails to mention round one's problem, and
  the problem is thereby resolved**.
- The model reports "no blockers", the gate opens, and the problem travels into
  the next phase.
- A person wants to intervene, but the way in is a button on a web page — and a
  button on a web page only tells the web page.

StagePass answers each with a hard rule:

1. **Silence cannot close a problem.** Rows in `gaps` outlive the round that found
   them, and closing one requires stating a reason — "this round did not mention
   it" and "this round says it is fixed" are different rows in the database.
2. **The gate reads evidence, never the model's opinion of its own work.** A phase
   node turns green because **the ledger records that a human approved it**, not
   because some round reported no problems.
3. **There is exactly one answer path.** A person's choice happens inside the
   elicitation selector Codex draws. There is no button on the web surface that
   can move a gate, and there never will be.

---

## Three parts, no overlapping responsibility

| | Does | **Explicitly does not** |
|---|---|---|
| **State machine and gate** (`src/domain`, `src/store`) | Transitions, gate, fence, leases, recovery; composes questions, validates answers, advances state | **Renders nothing** |
| **Terminal panel** (`src/web`) | Looking and launching: the stage orbit, evidence, risks; **hosts the pty the Codex TUI actually runs inside** | **Carries no decision entrance** |
| **Codex plugin** (`src/plugin`) | Puts questions to a person over MCP `elicitation` and sends the answer back | Decides nothing, composes nothing, judges no legality |

**The terminal panel is a host, not an entrance.** Every pixel of the execution
and of the selector you see in the browser is drawn by the `codex` binary itself,
in escape sequences; StagePass only moves bytes from the pty into xterm.js. What
changed is who owns the glass, not who does the drawing.

That is not left to good intentions. `src/architecture.test.ts` holds five
standing guards that may never go red:

1. Every module declares which layer it belongs to.
2. A lower layer may not import a higher one.
3. No export exists without a caller.
4. One concept, one name (no aliases for a phase).
5. **`src/web/` may not contain `TextDecoder`, `.toString(`, `JSON.parse`, or
   `String.fromCharCode`** — the four ways to turn pty bytes into a string, none
   of them left open.

Guard 5 is the precondition the terminal panel was accepted on: the moment
StagePass starts parsing Codex's output to draw its own interface, it has slid
back into the approach that was rejected outright. That is not a style question,
so it cannot be left to judgement.

---

## What actually runs today

```bash
pnpm install
pnpm check            # 246 tests + strict typecheck, fully offline, no Codex needed
```

These need a real Codex:

```bash
pnpm panel            # the terminal panel: 2:2:6 columns, stage orbit, one terminal per phase
pnpm verify:rebuild   # the whole L0–L2 chain (offline)
pnpm verify:decision  # L3: compose → selector → a person chooses → the gate advances
pnpm verify:round     # L4: run one real adversarial round; --read <thread> replays one that happened
```

Without `--db`, `pnpm panel` creates a throwaway database, so you can click around
without touching anything real.

### Requirements

- **macOS.** node-pty uses prebuilt binaries and `verify:decision` shells out to
  `osascript`. No other platform has been verified — do not assume it works.
- **Node 20+** (developed on 25.9) and **pnpm**.
- **Codex CLI** (developed against 0.146.0). Every command above L2 needs it.

### One trap worth knowing

Codex's `-a never` does not only govern shell approvals — it makes Codex
**auto-decline MCP `elicitation/create`**, which is StagePass's only channel for
asking a person anything. The failure is silent: back comes a perfectly
well-formed `{"action":"decline"}`, indistinguishable from someone pressing Esc.

In this codebase that value is **unrepresentable in the type system**
(`CodexInvocation.approval` accepts only `"untrusted" | "on-request"`). Better to
make it fail to compile than to leave a comment warning the next person.

---

## Repository layout

```
src/
  domain/     Pure logic: phases, state machine, gate, gaps, leases, rounds, questions
              — no IO, so every legal and illegal transition is provable offline
  store/      SQLite reads and writes: change, evidence, gap, command, binding, turn, question
  work/       Long-running work: job leases, the turn loop, adversarial round wiring
  codex/      Talking to Codex: invocation, TUI transport, rollout parsing, subagents
  plugin/     The MCP plugin. Its only write is recording what a person said.
  web/        The terminal panel: pty session, panel server, and the browser half
  architecture.test.ts   the five standing guards
docs/         PRD, handoffs, visual design. **The PRD is the single authority.**
scripts/      verify:* and probe:*
```

5,141 lines of production code, 4,875 lines of tests, 30 modules. SQLite is the
authority — a trigger on `changes` makes the database **abort on the spot** any
state update that does not come with its ledger row, rather than leaving a missing
audit entry to be discovered later.

Main documents (written in Chinese):

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) — **the single authority**, including why the rebuild happened
- [`docs/HANDOFF-2026-07-29.md`](docs/HANDOFF-2026-07-29.md) — current progress, traps found the hard way, what is still missing
- [`docs/STAGEPASS-ACTUAL-REQUIREMENTS.md`](docs/STAGEPASS-ACTUAL-REQUIREMENTS.md) — what the product solves and what each of the twelve phases produces

---

## Licence

[MIT](LICENSE)
