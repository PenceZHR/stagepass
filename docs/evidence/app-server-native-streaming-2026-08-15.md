# Pure App Server native streaming acceptance — 2026-08-15

## Subject

- Branch: `codex/native-streaming-app-server`
- Runtime commit: `c185f07` (`feat: complete pure app-server runtime`)
- Worktree: `/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`
- Codex: `codex-cli 0.147.0`
- Runtime database: `/Users/zhanghr/.stagepass/panel.db`
- Listener: `127.0.0.1:4173`
- Original StagePass worktree: intentionally unchanged

## Architecture acceptance

The production source guard rejects `node-pty`, xterm, `/pty/`, `state_5.sqlite`, rollout-file
access and any Codex process spawn outside `src/codex/app-server-client.ts`. The removed modules and
PTY-only probes are absent from the dependency graph. The only production launch shape is:

```text
codex app-server --listen stdio://
```

The checked-in protocol layer is intentionally minimal. The authoritative upgrade probe is:

```bash
pnpm schema:app-server
```

which runs `codex app-server generate-json-schema --experimental --out docs/app-server-schema`;
the generated directory is ignored and must not become a second protocol implementation.

## Automated protocol and business evidence

`pnpm check` covers the supervised JSONL process boundary, chunked stdout, request identity,
timeout/exit failure, stderr redaction, thread start/resume/read/archive/unarchive, archived binding
recovery, turn start/steer/interrupt, terminal states, interaction fail-closed behavior, stream
materialization, reconnect replay gaps, command/file/MCP/sub-agent items, StagePass gate ownership,
and responsive DOM contracts.

Security/resource assertions cover:

- no raw App Server item/request payload in public snapshots or SSE;
- 256 KiB item text/output cap with visible truncation state;
- replay caps of 512 events and 2 MiB;
- allowlisted interaction fields only;
- unknown notifications expose only their method;
- only HTTP(S) MCP links, with `noopener noreferrer`.

Final full-suite result: 1,062 tests across 242 suites, zero failures, zero cancelled, zero skipped,
with strict TypeScript checks and the pure-App-Server architecture guard passing. The command exited
0 after 23.4 seconds of test execution.

## Real App Server / archived-session acceptance

The live service opened `CHG-001 / PRD` against the real StagePass database through
`POST /api/codex/open`, then read the materialized snapshot through the public panel API.

```json
{
  "threadId": "019fd6d4-0a71-7052-92ae-71a09e7b197e",
  "activeTurnId": null,
  "lastTurnId": "019fd70e-528c-7eb0-912d-a1a6eff70779",
  "turnStatus": "completed",
  "itemCount": 42,
  "interactionCount": 0,
  "lastSeq": 6
}
```

The recovered thread id equals the pre-existing StagePass binding. No acceptance prompt was sent,
no turn was started, and no StagePass phase/gate state was changed. A second snapshot returned the
same materialized history. This exercises the archive unarchive/resume path without paying for or
mutating a real business turn.

HTTP smoke results before final restart:

- `GET /?change=CHG-001` → 200
- `GET /api/panel?change=CHG-001` → `Build / settled`
- legacy `GET /pty/CHG-001/PRD` → 404

## Browser acceptance

The real 4173 page was rendered with headless Chrome at 1440, 1024, 768 and 320 CSS pixels.
StagePass's dark-purple cloud sea, warm sand/grey-pink palette, serif headings, fine-ring stage orbit
and restrained hierarchy remain intact. At 820 px and below the workspace stacks vertically; at
1180 px and below long gate values wrap instead of hiding the blocking reason.

Screenshots from the acceptance run:

- `/private/tmp/stagepass-appserver-final-1440.png`
- `/private/tmp/stagepass-appserver-final-1024.png`
- `/private/tmp/stagepass-appserver-final-768.png`
- `/private/tmp/stagepass-appserver-final-320.png`

The behavior suite separately covers one active stream subscription per visible seat, cleanup when
leaving a seat, non-duplicating materialized deltas, composer start-vs-steer routing, exact-turn
interrupt, keyboard submit and real interaction-dialog behavior.

## Restart command

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```
