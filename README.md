# StagePass

**English** · [简体中文](README.zh-CN.md)

> **A model does not get to pass its own work.**

StagePass is a local delivery control plane. It splits one change into twelve
phases, runs Codex once per phase to produce evidence and find problems, and then
**stops and waits for a person to decide**. The decision happens in Codex's own
selector, not on a web page. Only once you have chosen does StagePass advance.

---

## ⚠️ Status: under construction — five of six layers done

This is not usable software yet. **The table below is honest**; what is not done
is simply not done:

| Layer | What it is | Status |
|---|---|---|
| **L0** | Schema, state machine, transitions, audit ledger | ✅ Proved fully offline |
| **L1** | Gate computation, fencing, leases, heartbeats, idempotency, crash recovery | ✅ Proved offline; crash recovery seen on a real machine 2026-08-03 |
| **L2** | Launching the Codex TUI, thread binding, turn records, reading results from the rollout | ✅ Real turns, twice (osascript and pty) |
| **L3** | Compose question → Codex's native selector → a person chooses → answer lands → state advances | ✅ A real person really chose |
| **L4** | Red / blue / judge adversarial rounds, settled into something decidable | ✅ Real rounds: gaps stored, gate held shut, gaps closed by later rounds |
| **L5** | Rubric scoring, gap tracking | ✅ End-to-end on a real machine 2026-08-03 (PRD, round 3) |
| **L6** | Rolled out to the remaining phases | 🟡 Three of eleven run end to end on a real machine (PRD and Spec both approved 2026-08-04, now at TechSpec). The other eight share the same code path and factory rubrics but have not been run. |

**A layer that has not passed is a layer you may not build on.** That is this
repository's construction discipline, not a suggestion — and it is also how this
README is written: every line corresponds to something that actually ran.

> The README before the rebuild described an architecture that **never ran** — MCP
> App decision cards, follower IPC, a separate web dashboard. All of it was deleted
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

### A fourth rule, learned the expensive way

**No string StagePass compares for equality may appear in text a model has to
write.** A judge once dropped a segment from a 36-character UUID and four
perfectly good verdicts were voided together. The audit that followed found seven
such surfaces; five had already burned at least once.

So a model's output may now contain only **a choice from an enumeration** and
**prose**. Identifiers never travel through a model:

- Which threads a round ran on — StagePass works it out from the rollout's
  `parent_thread_id`, rather than asking the judge to report them.
- Per-item verdicts — the model calls `stagepass_next` for the next item and
  `stagepass_answer` to answer it. **Not one of the three plugin tools accepts an
  identifier**: two take nothing at all, and `stagepass_answer` takes only
  `answer` and `reason`. *Which* item is being answered is StagePass's business.
- Rubric criteria the opposition scores — written to a file numbered `1..N`, and
  the answers come back by number. One missing or duplicated number voids the
  whole sheet rather than shifting every verdict onto the wrong criterion.

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

### Looking is not an action

Opening a phase's terminal used to start a Codex process. So somebody who only
wanted to check on a phase would spawn one — and because a live process holds the
phase's only seat, every other action on that phase was then refused. Two separate
buttons now:

| | |
|---|---|
| **See this terminal** | Attaches if a process is running; shows the last screen if one died; says **"this phase has no process"** if it never ran. Starts nothing. |
| **Open a terminal** | Starts one, explicitly, with the plugin registered. Hidden while a process is already running. |

---

## What actually runs today

```bash
pnpm install
pnpm check            # 751 tests + strict typecheck, fully offline, no Codex needed
```

These need a real Codex:

```bash
pnpm panel                 # the terminal panel: stage orbit, one terminal per phase
pnpm verify:rebuild        # the whole L0–L2 chain (offline)
pnpm verify:decision       # L3: compose → selector → a person chooses → the gate advances
pnpm verify:round          # L4: run one real adversarial round
pnpm verify:rubric-round   # L5: a round that also scores rubrics
```

`pnpm panel` takes flags, all optional:

```bash
node --import tsx scripts/panel.ts \
  --db <path> --port 4173 \
  --project-name <name> --project-path <dir> \
  --model <name> --effort minimal|low|medium|high|xhigh \
  --ask-timeout <minutes> --turn-timeout <minutes>
```

Effort defaults to `xhigh`: a round takes minutes either way, and trading that for
a shallower verdict is a bad deal. Without `--db` a throwaway database is created,
so you can click around without touching anything real.

Probes answer one factual question each about Codex, and print what they measured:

```bash
pnpm probe:pty        # does the elicitation selector work inside a pty?
pnpm probe:elicit     # does `-a never` silently auto-decline elicitation? (it does)
pnpm probe:sandbox    # read-only vs workspace-write: which one stalls on approval?
pnpm probe:subagent   # which threads refuse input from outside their parent?
```

### Requirements

- **macOS.** node-pty uses prebuilt binaries and `verify:decision` shells out to
  `osascript`. No other platform has been verified — do not assume it works.
- **Node 20+** (developed on 25.9) and **pnpm**.
- **Codex CLI** (developed against 0.146.0). Every command above L2 needs it.

### Two traps worth knowing

**`-a never` breaks the only way to ask a person anything.** It does not merely
govern shell approvals — it makes Codex **auto-decline MCP `elicitation/create`**.
The failure is silent: back comes a perfectly well-formed `{"action":"decline"}`,
indistinguishable from someone pressing Esc. In this codebase that value is
**unrepresentable in the type system** (`CodexInvocation.approval` accepts only
`"untrusted" | "on-request"`). Better to make it fail to compile than to leave a
comment warning the next person.

**A sub-agent thread refuses input from anyone but its parent.** `codex resume
<sub-agent thread>` starts, loads its MCP servers, and then answers any submitted
prompt with `■ This sub-agent is controlled by its parent. Direct input is
disabled.` — regardless of whether the parent is still alive. Measured 2026-08-03
on 0.146.0 (`pnpm probe:subagent`: two sub-agent threads refused, one ordinary
thread accepted and answered). A design that drives a sub-agent thread directly
cannot work; the only channel left is its parent, which is why rubric criteria now
travel as two file paths the judge relays verbatim.

---

## Repository layout

```
src/
  domain/     Pure logic: phases, state machine, gate, gaps, leases, rounds, questions,
              per-phase prompts — no IO, so every legal and illegal transition is
              provable offline
  store/      SQLite reads and writes: change, evidence, gap, command, binding, turn,
              question, rubric, worklist
  work/       Long-running work: job leases, the turn loop, adversarial and rubric rounds
  codex/      Talking to Codex: invocation, TUI transport, rollout parsing, subagents,
              directory trust, archive
  plugin/     The MCP plugin. Its only write is recording what a person said.
  web/        The terminal panel: pty session, panel server, and the browser half
  architecture.test.ts   the five standing guards
docs/         PRD, handoffs, design notes. **The PRD is the single authority.**
scripts/      panel, verify:*, probe:*
```

13,586 lines of production code across 45 modules, 13,125 lines of tests. SQLite is
the authority — a trigger on `changes` makes the database **abort on the spot** any
state update that does not come with its ledger row, rather than leaving a missing
audit entry to be discovered later.

Two files are pinned byte for byte, on purpose:

- `src/domain/round-prompt.golden.txt` — the judge prompt for every phase. Changing
  one phase's entry must leave the other ten byte-identical; that is what keeps the
  eleven phases from quietly growing a shared template again.
- The plugin's tool contract — three tools, and **not one of them takes an
  identifier**. `stagepass_ask` used to accept a `questionId`; that parameter was
  one of the seven surfaces, and removing it is why the model can no longer answer
  the wrong question.

Main documents (written in Chinese):

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) — **the single authority**, including why the rebuild happened
- [`docs/HANDOFF-2026-08-03.md`](docs/HANDOFF-2026-08-03.md) — current progress, traps found the hard way, what is still missing
- [`docs/DESIGN-no-hand-transcription-2026-08-02.md`](docs/DESIGN-no-hand-transcription-2026-08-02.md) — the seven surfaces where a model was copying identifiers, and how each was taken to zero
- [`docs/STAGEPASS-ACTUAL-REQUIREMENTS.md`](docs/STAGEPASS-ACTUAL-REQUIREMENTS.md) — what the product solves and what each of the twelve phases produces

---

## Licence

[MIT](LICENSE)
