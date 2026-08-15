# New-project App Server durability acceptance — 2026-08-15

## Subject and scope

- Branch: `codex/native-streaming-app-server`
- Worktree: `/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`
- Real database: `/Users/zhanghr/.stagepass/panel.db`
- Real Change: `CHG-002 / PRD` (`建立项目骨架`)
- Project path: `/Users/zhanghr/Desktop/海战小游戏`
- Listener: exactly one process on `127.0.0.1:4173`
- Original StagePass worktree and the product/Cocos project were not edited.

The durability change is split across these commits:

- `90fd19e` — keep a newly opened zero-turn App Server thread ephemeral;
- `8b68405` — make `PanelSessions` the product durability boundary and bind only after the first
  successful `turn/start`;
- `814a250` — reserve the loopback port before opening SQLite, running recovery or starting Codex.

The final acceptance commit also contains two browser-found presentation regressions: an inline
favicon removes the otherwise healthy `/favicon.ico` 404, and an empty restored `userMessage`
placeholder is omitted instead of being rendered as `未识别项目`. Final review also caught the
specified post-start persistence edge: if `turn/start` succeeds but binding fails, the API now
returns `thread_binding_failed_after_turn_start`, logs change/seat/thread/turn, and can bind the
same in-process thread on a later retry.

## Automated gate

Fresh command:

```bash
pnpm check
```

Result:

- strict TypeScript checks: exit 0;
- tests: 1,073;
- suites: 243;
- pass: 1,073;
- fail/cancelled/skipped/todo: 0;
- test duration: 41,126.201083 ms;
- overall command: exit 0.

The regression suite includes the ephemeral-open rule, failed-first-turn cleanup, post-start
binding, detached rebind, archived unarchive/resume, one product session facade, pre-state port
reservation, collision-before-database and both browser regressions found during the real walk.
It also forces a binding write failure after an accepted turn, checks the named response and full
diagnostic identity, then proves the same thread is reused when persistence is retried.

The first final-suite attempt exposed an unrelated timing race in the existing SIGKILL escalation
test: a fixed 50 ms sleep could expire before the child installed its SIGTERM handler under load.
The fixture now emits `fake/ready` after installing that handler. The focused test passed three
parallel repetitions before the complete 1,073-test gate passed.

## Real CHG-002 browser walk

Chrome opened `http://127.0.0.1:4173/?change=CHG-002` against the real database.

### Empty open and first durable turn

Entering PRD created temporary thread `01a0058a-f372-7d12-9ed5-3dad47c7718e`. Before input, the
database still contained only the old detached row, so opening the UI did not durably claim the new
thread.

The real browser composer sent:

```text
只回复 STAGEPASS_STREAM_OK；不要修改任何文件。
```

Turn `01a0058c…` streamed to a terminal `completed` state and rendered
`STAGEPASS_STREAM_OK`. Only after `turn/start` succeeded did StagePass write this exact binding:

```text
CHG-002 / round / PRD / 01a0058a-f372-7d12-9ed5-3dad47c7718e / bound
```

No command or file-change item was produced.

### Steer and exact-turn interrupt

A deliberately long, no-tool/no-file turn (`01a0058f…`) was started. While it was active the real
composer steered it with:

```text
停止长文，改为只回复 STEER_OK；不要调用工具。
```

The UI reported `方向已送进正在运行的这一轮`. The visible interrupt control then interrupted
that exact turn; the snapshot ended with no active turn and the UI reported `这一轮已中断`.

### StagePass MCP interaction without inventing the user's requirements

The real `说清楚我要什么` entry reached the App Server permission interaction for
`stagepass_ask`; choosing `交给 StagePass` produced the StagePass human-checkpoint sheet. The
acceptance run selected `不回答` rather than fabricate product requirements. The MCP item reached
`completed`, the dialog closed, and no interaction or active turn remained.

This intentionally differs from mechanically answering an arbitrary acceptance choice: the real
Change belongs to the user. Database and panel evidence after the decline:

- the generated question is no longer `open` (`status = applied`);
- `change_briefs` has no `CHG-002` row;
- `/api/panel?change=CHG-002` returns `brief: null`, `PRD / pending`;
- the gate was not advanced and no product file was written.

### Restart and clean-browser restore

The service was stopped cleanly and restarted on 4173. A new Chrome profile then reopened PRD.
The restored full thread id remained:

```text
01a0058a-f372-7d12-9ed5-3dad47c7718e
```

The fresh final snapshot returned HTTP 200, `activeTurnId: null`, `turnStatus: completed`, 10
items and 10 unique item ids. `STAGEPASS_STREAM_OK` was present, `未识别项目` was absent, no dialog
was open, and all failed-resource, Runtime exception, browser log-error and network-failure lists
were empty.

The Chrome accessibility tree contained 220 nodes, named navigation/action buttons and the named
`给 Codex 的消息` textbox. Final screenshot:

- `docs/evidence/screenshots/chg-002-prd-restored-2026-08-15.png`

## Port collision proof

With PID 85881 already listening from this worktree, a second real launch used the same database,
Change and port:

```bash
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173 --change CHG-002
```

It exited 1 immediately with:

```text
listen EADDRINUSE: address already in use 127.0.0.1:4173
```

The PRD binding before and after was byte-for-byte identical, including both timestamps, and the
original listener remained on 4173. A direct no-proxy request after the experiment returned HTTP
200. This is the real-process counterpart of the automated assertion that a collision does not
create the supplied nonexistent database path.

## Runtime notes

The Codex child emitted global plugin/model-refresh warnings during startup and a session-closed
warning when the deliberately declined MCP flow disposed its session. They did not become browser
errors, did not leave a pending interaction/turn and did not alter the StagePass gate. The final
fresh-browser pass was clean.

## Only restart command

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

Do not start this worktree on another StagePass port.
