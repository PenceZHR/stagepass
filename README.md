# StagePass · Discontinued

**English** · [简体中文](README.zh-CN.md)

> Started 2026-07-19. Stopped 2026-08-19. 653 commits, four pivots.
>
> **What stopped is the software, not the method.** The method lives in
> [`docs/ARCH-method-2026-08-19.md`](docs/ARCH-method-2026-08-19.md) (Chinese).
> It costs nothing, needs no repository, and works today.
>
> The original product README — the eight-phase gated-ring version — is preserved at
> [`docs/README-v1-product-2026-08-17.md`](docs/README-v1-product-2026-08-17.md).
> Most of what it claims **was disproven by this project itself**. Don't read it as current.

**If you only read one section, read [§4 — Field notes](#4--field-notes-codex-and-claude-code-internals).**
That is the part with value to anyone who isn't me: two months of reverse-engineering
two agent harnesses, most of which is not documented anywhere public.

---

## 1 · What this was, and why it stopped

StagePass tried to be a **process instrument for a solo developer working with AI**:
one change walks eight phases, each phase has a rubric, the model fills in evidence,
the human renders the verdict, build and test tracks stay mutually blind, and gates
stop what shouldn't pass.

**It didn't hit a wall. It was evaluated and declined.** Four pieces of evidence:

1. **The core mechanisms are already commodities.** "Separate model-produced evidence
   from human judgment", "local-first", "append-only" are a published paper
   ([ProjectMem](https://arxiv.org/pdf/2606.12329), 2026-06). "Auto-summarize each session
   into local markdown" ships as clerk and several others. The upstream-constraint half of
   the space is occupied by Kiro (international launch 2026-05) and GitHub Spec Kit (93k stars).
2. **What was left was an opinion, not a technology** — that the archive should be written
   for humans, and that sparsity *is* the weighting.
3. **The value does not need software.** What actually works is human judgment, and human
   judgment does not need a plugin. Two text files are enough.
4. **The step it tried to automate is the one step that cannot be automated** (see §3.4).

---

## 2 · Timeline: four pivots

| When | Shape | Why it turned |
|---|---|---|
| 07-19 | Start: dual Codex + Claude, live QA, seven phases | — |
| **07-28** | **Rebuild: drop Claude, Codex only** | Paying the cost of a dual-backend abstraction before either backend worked |
| **08-09** | **Ring v3: eight-phase diamond, mutually blind tracks, Fix/rerun removed** | The seven-phase `Fix` stage and rerun semantics contradicted each other |
| **08-18** | **Retire the web app → ship as a Codex plugin** | Panel process at 2177 lines; terminal-seat complexity out of control |
| **08-19 (night)** | **Plugin route fails — six distinct incidents in one night → back to a workbench, execution channel deleted** | Subscription entitlement, ghost bindings poisoning seats, polling-based completion detection, a daemon holding threads `loaded` |
| **08-19** | **Stop** | See §1 |

**Every pivot removed machinery.** Panel → plugin → plugin+web → files+skill.
The trend line pointed at zero, and that itself was a signal worth reading earlier.

---

## 3 · Assumptions that were disproven

### 3.1 That "unattended operation" was achievable

**It is the logical negation of "I want to know about every round"** — which was this
project's own stated requirement. The 2298 lines of execution channel
(`plugin/runtime` + `seats` + `await-turn` + `codex/app-server-*` + `stream-state`)
were the price of trying to satisfy two mutually exclusive goals.

Deleting it made approval, visibility, interruptibility and durability **hold by default** —
not "fixed", but *dissolved*: when a contradiction goes away, the machinery built for it
becomes void wholesale rather than being repaired piece by piece.

> **Reusable check: before building, list your goals and check whether two of them negate
> each other.** Five minutes. It would have saved two thousand lines.

### 3.2 That phase gates could hold a human back

It contradicts the project's own three-authors model — a gate lets code's judgment
override the person's. And once the execution channel was gone, it couldn't stop anything
anyway: the only thing it could "block" was a state field in a panel that belongs to the
same person.

**A gate should be demoted to a checkup — a linter, not a bouncer. It emits a report,
never a verdict.**

### 3.3 That "mutual blindness" is a TDD principle

It isn't. **TDD is single-author by construction** — it separates *time*, not *perspective*.
Mutual blindness existed in the original methodology one layer up, in **customer-written
acceptance tests** (XP, FIT). The industry kept TDD and dropped that layer.

And blindness would not have caught this project's two most expensive failures (see §5.3):
those were **reality-contact** failures, not interpretation-divergence failures.

### 3.4 That full automation was just "models aren't strong enough yet"

**It's structural.** Requirements do not exist first and then get communicated.
**Requirements take shape the moment you see output.** So a human must be inside the loop —
in the middle of it, not at the two ends.

Scope: work whose requirements *are* fully known before starting (compilers, transpilers,
rule-driven migrations, implementing a fixed protocol) can be fully automated.
Product work is not that kind of work.

### 3.5 That "nobody is doing this" meant "nobody thought of it"

**An absence is not readable.** It is equally consistent with "nobody thought of it",
"people tried and it failed", and "it just hasn't come up yet". Nothing about the absence
itself distinguishes these.

> **Reusable check: don't search "is anyone doing X" (returns an absence).
> Search "who is doing the adjacent thing, and how" (returns a presence).**
> A presence is readable — other people's limitations sections tell you exactly what they hit.

---

## 4 · Field notes: Codex and Claude Code internals

**This is the section with value to anyone else.** All of it was hit on real machines.
Versions are noted where measured; behavior may have changed since.

### Codex — threads and subagents

- **A subagent forks the parent thread's entire history.** It does not start clean.
  So "a fresh adversary doubting from zero each round" only holds across phases,
  never within one thread.
- **Subagent threads reject external input** (0.146.0 stable): they cannot be driven by a
  direct `resume`, regardless of whether the parent thread is alive.
- **Two spawn surfaces, only one sets `agent_path`.** Native `spawn_agent({task_name})` sets it;
  **that surface is not present in every session** — when it's absent the whole round is void.
- **Spawn failure is silent.** The main agent will fabricate an answer on the subagent's behalf
  and the turn still reports success.
- **`thread/list` carries no title**, and does not show zero-turn threads. Thread identification
  has to go through `preview` plus `parent_thread_id` (present in 76/76 rollouts).
- **Never prefix-match a UUIDv7.** Threads created in the same millisecond share a prefix.
- **Subagents inherit MCP servers only from the global `config.toml`**, not from command-line `-c`.

### Codex — sessions and approvals

- **An MCP approval must be granted once per round, and it is scoped per session, not per thread.**
  With nobody there to press it, a run burns silently to the 30-minute timeout.
  This single fact is what makes unattended operation impossible.
- **An untrusted directory blocks a whole turn silently until timeout.** The unit of trust is
  the **git root** — not the cwd, not any ancestor.
- **Codex archives bound threads.** `codex resume` then exits immediately; from the outside it
  looks like "I clicked it and got an error". Cure: `codex unarchive`.
  Note: **a pty that dies on startup takes its last line with it** — you cannot read the error
  from scrollback.
- **A non-subscribed connection can still drive `turn/start`.**

### Codex — MCP and UI

- **Three silent traps in elicitation forms:** fields are **sorted by name** (not by declaration
  order); **`required` is a hard gate** (useful — it's the one truly deterministic block);
  an **empty text field swallows Enter**, and only the last field can submit.
- **The Codex desktop app renders HTML served from an MCP resource** — declare
  `openai/outputTemplate` in `_meta`, implement `resources/list` + `resources/read`
  (`mimeType: "text/html+skybridge"`), and enable the `enable_mcp_apps` feature flag in
  `~/.codex/config.toml`. Measured on codex-cli 0.147.0 / App 0.148.0-alpha.15.
- **But widget width caps at roughly 700px**, and iframes to external origins are blocked by
  the sandbox — a panel has to be packaged as the resource itself. "Fullscreen" is in fact a
  right-side panel tab at 687px, *narrower* than inline.
- **The app-server's public JSON-RPC can open a real session from outside** — 9.3s for a full
  round, and it reports `source=vscode`, same as sessions the app opens itself.
- **The native Terminal Codex TUI can be driven externally**: sending a prompt, closing the
  window and reconnecting all work. It binds to a directory, not a thread id.
  **Enter must be sent as a separate write**, and the handle must be a tty.

### Claude Code

- **Hooks genuinely block**: both `deny` and `Stop` were verified to stop execution.
  But they **only guard state transitions — guarding write operations is bypassed by Bash.**
- **A `claude` CLI subprocess cannot authenticate** (inside or outside a sandbox).
- Session ids can be specified; subagents live in the project directory; elicitation is supported.

### Host environment (may be specific to this machine)

- **`preview_start` cannot launch a dev server**: the spawned process gets cwd `/` and `getcwd`
  is denied (`EPERM: uv_cwd`). All three `runtimeExecutable` forms fail at the same point.
  Workarounds: start the process from a background shell and open by `url`, or write
  `launch.json` as **attach-only** (a `url` entry with no command).
- **A panel must be started from a real terminal** — one launched from an IDE Run button
  dies instantly with EPERM when it spawns `codex`.
- **`curl` cannot reach localhost from inside the sandbox and returns empty silently.**
  Never use it to decide whether a server came up.

---

## 5 · Where the judgment went wrong (mechanism, not character)

### 5.1 Requirements were treated as conclusions, not as bets

There were PRDs, specs, architecture docs, rubrics. **The thinking was not skipped.**
But all of it was written as assertions ("the system shall…"). Not one line said
*"I currently believe X, and here is how I would find out it's wrong."*

**So the requirement could be wrong for two months with no moment that would surface it.**

The failure was not "didn't think". It was closing the channel through which being wrong
could arrive.

### 5.2 The exploration phase was run as if it were the convergence phase

**Writing specs is not exploration. It is formatting your guesses.** It produces no new
information, but it *feels* like progress because it produces artifacts.

The real cause is a feedback asymmetry: a green test gives instant confirmation, a growing
document gives instant confirmation, and "is this requirement right?" gives no signal at all.
People move toward whatever gives signal.

> Which is why "I'll take exploration more seriously next time" fails — that is willpower
> against a gradient. **The fix is to manufacture feedback for the exploration phase**,
> not to resolve harder.

### 5.3 A green suite proves self-consistency, not correctness

The two most expensive incidents:

- **1177 tests green while the MCP channel had been dead all night** — every stub was
  faithfully simulating a tool that no longer existed.
- **1137 tests green while the entire star map had never once rendered** — the frontend
  "tests" were regex greps over source files.

**Mutual blindness would not have caught either.** A blind test author writing from the same
spec stubs the same nonexistent tool, and writes the same greps if they have no browser.
These were failures of *contact with reality*, not of interpretation.

### 5.4 The process architecture was fixed before the exploration

A tool was built for a way of working that had not yet been lived. Which contradicts the
principle this project itself later wrote down: **the information needed to design an
architecture can only be produced by building. Fixing architecture at kickoff is not
difficult — it is information-theoretically unavailable.**

<!-- TODO (author): this section still needs the part only you can write —
     not the mechanism, but why you kept doing it. -->

---

## 6 · What survives

- **The method** — [`docs/ARCH-method-2026-08-19.md`](docs/ARCH-method-2026-08-19.md) (Chinese).
  Zero cost, no repository required.
- **Four reusable checks** — worth more than aphorisms, because you can *run* them:
  1. Point at any field and ask "who is the author of this value?" If you can't answer,
     the design isn't finished.
  2. List your goals and check whether two of them negate each other.
  3. Is the cost of bypassing symmetric with the cost of complying?
     (Asymmetry means people flee toward cheap, not toward correct.)
  4. What is the mechanically checkable shadow of this judgment?
     (Turn semantic judgments into reference-integrity checks.)
- **§4** — the only part that does not depreciate as models improve.
- **`src/domain/`** — dependency propagation and reference validation. The lowest-deletion-rate
  code in the repo; untouched across all four pivots.

<!-- TODO (author): anything else worth keeping — a module, a doc, a specific approach. -->

---

## Repository status

- Default branch `main`; development stopped on `build-the-base-2026-08-05`
- 653 commits, 2026-07-19 → 2026-08-19
- **Not maintained. Issues and pull requests are not accepted.**

<!-- TODO (author): license. §4 is the part others will actually use —
     decide whether you want it freely reusable. -->
