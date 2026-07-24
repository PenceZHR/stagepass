# StagePass

**English** · [简体中文](README.zh-CN.md)

StagePass is a local, Codex-native control plane for moving a software change from intent to delivery through explicit stages, evidence, review, and human decisions.

The Web app is the operator dashboard. Codex Desktop is where managed work runs and where the StagePass MCP App presents human decision cards. The StagePass Server remains the only authority for workflow state, commands, idempotency, audit, and recovery.

> Current status: developer preview. The production build and Codex-native boundary suites pass, but a release still requires Phase 0 verification against the exact supported Codex Desktop build.

## What changed in the Codex-native edition

- One persistent Codex task per Change.
- One reusable Project PRD task and one reusable Project Context task per Project.
- Codex app-server provisions, names, lists, and reads persistent task shells.
- Codex Desktop follower IPC exclusively starts and interrupts managed turns.
- The StagePass MCP App presents approvals, rejections, risk acceptance, adoption, and other human decisions inside the bound Codex task.
- Web retains status, evidence, health, settings, start/retry, interrupt, and recovery controls.
- StagePass no longer exposes Git setup, stage, commit, push, or remote-management UI. Use Codex or your normal Git tooling.
- SQLite is the business authority; files under `.ship/` are readable mirrors and audit artifacts.

## Architecture

```text
                              ┌────────────────────────────┐
                              │ Persistent Codex task      │
                              │ work + MCP decision cards  │
                              └─────────────┬──────────────┘
                                            │
                     follower IPC / Host ui/message / task reads
                                            │
┌──────────────────┐      commands      ┌───▼────────────────────┐
│ StagePass Web    ├────────────────────► StagePass Server        │
│ operator control │◄────────────────────┤ workflow authority     │
└──────────────────┘   state/evidence    └───┬───────────┬───────┘
                                             │           │
                                  app-server │           │ SQLite
                                  shell/read │           │ authority
                                             ▼           ▼
                                      persistent     durable state,
                                      task shells    audit, recovery
```

The important boundary is intentional:

- app-server may manage persistent shells, read turns, and list models;
- app-server must not start managed turns;
- Desktop follower IPC starts managed turns only after a durable, fenced attempt exists;
- Web and MCP submit through the same Server command gateway;
- recovery never redispatches an ambiguous attempt.

The full rationale is in the [Codex-native design](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md).

## Workflow

```text
PRD → Spec → Tech Spec → Plan → Test Plan
    → Build → Review → Fix → QA → Merge → Retro → Done
```

Codex produces artifacts and performs work. StagePass records facts, checks freshness and gates, and presents the decisions that only a human may make.

P0 findings block and cannot be waived. P1 findings block unless a human explicitly accepts the risk with a reason. A stale card, stale gate version, changed source hash, or mismatched task binding fails closed.

## Requirements

- macOS with Codex Desktop installed, running, and signed in
- Node.js 20 or newer
- pnpm
- an existing local Git repository for each managed Project

The Hybrid Bridge uses a private, capability-gated Codex Desktop interface. The currently pinned compatibility fingerprint is documented in the [design specification](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md). Unknown builds are rejected until explicitly verified.

## Quick start

```bash
git clone https://github.com/PenceZHR/stagepass.git
cd stagepass
pnpm install
cp .env.example .env
```

Enable the Codex-native surfaces in `.env`:

```dotenv
STAGEPASS_CODEX_DESKTOP_BRIDGE=on
STAGEPASS_MCP_INTERACTIONS=on
STAGEPASS_CODEX_DECISION_SURFACE=on
STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge
```

Then build the MCP App and start StagePass:

```bash
pnpm db:migrate
pnpm mcp:build
pnpm dev
```

Open [http://localhost:3000/projects](http://localhost:3000/projects), create a Project, and point it at the absolute path of an existing local Git repository.

`mcp:start` is designed for a Codex Host-attested launch. Starting it as an arbitrary standalone process fails closed because it does not possess the inherited broker channel and Host evidence.

## Configuration

| Variable | Purpose |
|---|---|
| `STAGEPASS_CODEX_DESKTOP_BRIDGE` | Enables persistent Codex task execution through the Desktop bridge when set to `on`. |
| `STAGEPASS_MCP_INTERACTIONS` | Enables MCP interaction presentation when set to `on`. |
| `STAGEPASS_CODEX_DECISION_SURFACE` | Global master switch for Codex-hosted human decisions. |
| `STAGEPASS_CODEX_DECISION_PHASES` | Exact comma-separated decision rollout allowlist. Invalid or unknown values fail closed. |
| `STAGEPASS_CODEX_BIN` | Optional path to the Codex binary used for app-server shell/read control. |
| `STAGEPASS_DB_PATH` | Optional SQLite path; defaults to `server/db/ship.db`. |
| `STAGEPASS_LOG_DIR` | Optional runtime log directory. |

All Codex-native flags are disabled unless their value is exactly `on`.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run Next.js, migrations, and the pipeline worker. |
| `pnpm build` | Create a production Web build. |
| `pnpm start` | Start the production Web server. |
| `pnpm test` | Run the isolated unit suite. |
| `pnpm test:acceptance` | Run heavyweight process/recovery acceptance tests. |
| `pnpm lint` | Run ESLint on source files. |
| `pnpm exec tsc --noEmit` | Type-check the project. |
| `pnpm mcp:build` | Build the StagePass MCP server and App UI bundle. |
| `pnpm test:phase0-verifier` | Run the Phase 0 bridge contract suites. |

The real-client release verifier consumes explicit evidence and never prints a fake pass:

```bash
STAGEPASS_REAL_CODEX_NATIVE_E2E_EVIDENCE=/absolute/path/evidence.json \
  node --import tsx scripts/verify-codex-native-e2e.ts
```

Without real-client evidence it exits with a skip/fail-closed status.

## Repository layout

| Path | Responsibility |
|---|---|
| `app/` | Next.js operator dashboard and HTTP APIs. |
| `server/` | Workflow authority, SQLite/Drizzle, Codex bridge, gateway, recovery, and evidence services. |
| `mcp/` | StagePass MCP server, supervisor, signer, and interaction App UI. |
| `scripts/` | Development, build, migration, bridge verification, and E2E utilities. |
| `docs/` | Product requirements, architecture, migration plan, and follow-up hardening work. |
| `spikes/` | Self-contained bridge experiments retained as compatibility evidence. |

## Safety model

- Server-owned logical turn identities prevent callers from choosing arbitrary tasks or slots.
- Durable prepared/dispatching attempt rows fence every external follower start.
- Canonical task bindings are re-read before dispatch, settlement, and recovery.
- Known-turn visibility lag is read-only; it never starts another turn or advances the local cursor.
- Ambiguous dispatches reconcile from app-server snapshots or quarantine without redispatch.
- Build work remains isolated in controlled worktrees; repository facts and adoption versioning are retained without a user-facing Git operation surface.
- MCP decision submission is bound to the interaction, command, source task, nonce, and Host-attested transport.

## Documentation

- [Actual product requirements](docs/STAGEPASS-ACTUAL-REQUIREMENTS.md)
- [Codex-native architecture](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md)
- [Migration implementation plan](docs/superpowers/plans/2026-07-23-codex-native-control-plane-migration.md)
- [Deferred hardening and follow-ups](docs/superpowers/plans/2026-07-23-codex-native-control-plane-migration-followups.md)

## Local files

Do not commit local databases, `.env` files, `.next/`, MCP build output, runtime logs, or Host-specific plugin/agent bundles. See [`.gitignore`](.gitignore).

## License

[MIT](LICENSE)
