import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTmuxOps,
  posixShellArg,
  tmuxSessionName,
  TmuxError,
} from "./tmux";
import type {
  ProcessOps,
  ProcessRequest,
  ProcessResult,
} from "../system/process";

const THREAD_ID = "019f0000-0000-7000-8000-000000000001";
const IDENTITY = { changeId: "CHG / 有空格", seat: "PRD" } as const;

function result(
  code = 0,
  stdout = "",
  stderr = "",
): ProcessResult {
  return { code, signal: null, stdout, stderr };
}

function recordingProcess(
  answer: (request: ProcessRequest) => ProcessResult | Promise<ProcessResult> = () => result(),
): { readonly process: ProcessOps; readonly calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return {
    calls,
    process: {
      run: async (request) => {
        calls.push(request);
        return answer(request);
      },
      spawn: () => { throw new Error("not used"); },
    },
  };
}

describe("tmux owner", () => {
  it("derives an opaque stable session name", () => {
    const name = tmuxSessionName(IDENTITY.changeId, IDENTITY.seat);

    assert.match(name, /^sp_[0-9a-f]{20}$/);
    assert.equal(name, tmuxSessionName(IDENTITY.changeId, IDENTITY.seat));
    assert.notEqual(name, tmuxSessionName(IDENTITY.changeId, "Tech"));
    assert.doesNotMatch(name, /CHG|PRD|有空格/);
  });

  it("quotes every POSIX shell metacharacter as one literal argument", () => {
    const value = "space ' quote $dollar;semi\nline`tick`";
    assert.equal(
      posixShellArg(value),
      "'space '\"'\"' quote $dollar;semi\nline`tick`'",
    );
    assert.throws(() => posixShellArg("before\0after"), /NUL/);
  });

  it("maps missing, detached, and attached sessions without reading screen output", async () => {
    const states = [
      recordingProcess(() => result(1, "", "can't find session")),
      recordingProcess(({ args }) => args[0] === "has-session" ? result() : result(0, "")),
      recordingProcess(({ args }) => args[0] === "has-session" ? result() : result(0, "%1\n")),
    ];

    assert.equal(await createTmuxOps({ process: states[0]!.process }).status(IDENTITY), "absent");
    assert.equal(await createTmuxOps({ process: states[1]!.process }).status(IDENTITY), "detached");
    assert.equal(await createTmuxOps({ process: states[2]!.process }).status(IDENTITY), "attached");
    assert.deepEqual(states[2]!.calls.map(({ args }) => args[0]), ["has-session", "list-clients"]);
  });

  it("creates a concurrent session once and keeps project values out of the shell command", async () => {
    let releasesCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releasesCreation = resolve; });
    const recorded = recordingProcess(async ({ args }) => {
      if (args[0] === "has-session") return result(1);
      if (args[0] === "new-session") await creationGate;
      return result();
    });
    const tmux = createTmuxOps({ process: recorded.process });
    const cwd = "/Users/example/StagePass experiment; $(touch nope)";

    const first = tmux.ensureSession(IDENTITY, THREAD_ID, cwd);
    const second = tmux.ensureSession(IDENTITY, THREAD_ID, cwd);
    await Promise.resolve();
    releasesCreation();
    const [a, b] = await Promise.all([first, second]);

    assert.deepEqual(a, b);
    assert.equal(a.marker, `STAGEPASS:${a.name}`);
    const creates = recorded.calls.filter(({ args }) => args[0] === "new-session");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0]!.args.slice(0, 6), [
      "new-session", "-d", "-s", a.name, "-c", cwd,
    ]);
    const shellCommand = creates[0]!.args[6]!;
    assert.equal(
      shellCommand,
      `exec codex resume --remote unix:// '${THREAD_ID}'`,
    );
    assert.ok(!shellCommand.includes(IDENTITY.changeId));
    assert.ok(!shellCommand.includes(IDENTITY.seat));
    assert.ok(!shellCommand.includes(cwd));
  });

  it("loads and pastes the short envelope before sending Enter separately", async () => {
    const recorded = recordingProcess();
    const tmux = createTmuxOps({ process: recorded.process });
    const sessionName = "sp_0123456789abcdef0123";
    const envelope = "请先读取：/private/tmp/stagepass-prompt-1/prompt.md";

    await tmux.submit(sessionName, envelope);

    assert.deepEqual(recorded.calls.map(({ args }) => args[0]), [
      "load-buffer", "paste-buffer", "send-keys",
    ]);
    assert.deepEqual(recorded.calls[0], {
      command: "tmux",
      args: ["load-buffer", "-b", "sp_input", "-"],
      input: envelope,
    });
    assert.deepEqual(recorded.calls[1]!.args, [
      "paste-buffer", "-d", "-b", "sp_input", "-t", sessionName,
    ]);
    assert.deepEqual(recorded.calls[2]!.args, ["send-keys", "-t", sessionName, "Enter"]);
  });

  it("detaches without killing and kills only on explicit end", async () => {
    const recorded = recordingProcess();
    const tmux = createTmuxOps({ process: recorded.process });
    const sessionName = "sp_0123456789abcdef0123";

    await tmux.detach(sessionName);
    assert.deepEqual(recorded.calls.map(({ args }) => args[0]), ["detach-client"]);
    assert.equal(recorded.calls.some(({ args }) => args.includes("kill-session")), false);

    await tmux.endSession(sessionName);
    assert.deepEqual(recorded.calls.map(({ args }) => args[0]), ["detach-client", "kill-session"]);
  });

  it("normalizes unavailable, command, and invalid-thread failures", async () => {
    const unavailable = recordingProcess(() => Promise.reject(
      Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }),
    ));
    await assert.rejects(
      createTmuxOps({ process: unavailable.process }).version(),
      (error) => error instanceof TmuxError && error.code === "tmux_unavailable",
    );

    const failed = recordingProcess(() => result(2, "", "server exploded"));
    await assert.rejects(
      createTmuxOps({ process: failed.process }).status(IDENTITY),
      (error) => error instanceof TmuxError && error.code === "tmux_command_failed",
    );

    const untouched = recordingProcess();
    await assert.rejects(
      createTmuxOps({ process: untouched.process }).ensureSession(IDENTITY, "not-a-uuid", "/tmp"),
      (error) => error instanceof TmuxError && error.code === "invalid_thread_id",
    );
    assert.equal(untouched.calls.length, 0);
  });
});
