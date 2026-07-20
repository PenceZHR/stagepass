import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";

import {
  createPlatformProcessIdentityProbe,
  decodeLsofName,
  isUnreadableProcessCommand,
  ProcessIdentityProbeError,
  ProcessIdentityMismatchError,
  type ProcessIdentityCommandOptions,
  type ProcessIdentityCommandRunner,
  type ProcessIdentity,
} from "./process-identity-service";

/**
 * On linux `observeLinuxCommand` reads /proc/<pid>/cmdline and takes precedence
 * over whatever `ps` printed, so the `ps`-placeholder path these cases drive
 * only exists on darwin/BSD. The pure `isUnreadableProcessCommand` cases below
 * cover the shapes on every platform.
 */
const psPlaceholderOnly = process.platform === "linux"
  ? { skip: "ps command output is only consulted on darwin/BSD" }
  : {};

/** One `ps -o ppid= -o pgid= -o lstart= -o command=` line. */
function psLine(command: string, startedAt = "Mon Jul 20 02:42:00 2026"): string {
  return `${process.ppid || 1} ${process.pid} ${startedAt} ${command}`;
}

/**
 * Replays a scripted `ps` transcript, one line per call, so a capture can be
 * driven through the exact reading sequence a racing child produces. `lsof` is
 * answered with the real cwd; on darwin `observeCwd(process.pid)` short-circuits
 * before shelling out, so this only matters if that ever changes.
 */
function scriptedPsRunner(lines: readonly string[]): {
  runner: ProcessIdentityCommandRunner;
  psCalls: () => number;
} {
  let psCalls = 0;
  const runner: ProcessIdentityCommandRunner = async (file) => {
    if (file === "ps") {
      const line = lines[Math.min(psCalls, lines.length - 1)];
      psCalls += 1;
      return { stdout: `${line}\n`, stderr: "" };
    }
    if (file === "lsof") return { stdout: `n${process.cwd()}\n`, stderr: "" };
    throw new Error(`unexpected probe command: ${file}`);
  };
  return { runner, psCalls: () => psCalls };
}

function nodeCommandRunner(script: string, onPid?: (pid: number) => void): ProcessIdentityCommandRunner {
  return (_file, _args, options) => new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["-e", script, String(options.maxBuffer)],
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (child.pid !== undefined) onPid?.(child.pid);
  });
}

async function assertCaptureMismatch(
  field: keyof ProcessIdentity,
  value: ProcessIdentity[keyof ProcessIdentity],
): Promise<void> {
  const probe = createPlatformProcessIdentityProbe();
  await assert.rejects(
    probe.capture(process.pid, { [field]: value }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessIdentityMismatchError);
      assert.equal(error.code, "process_identity_mismatch");
      assert.equal(error.field, field);
      return true;
    },
  );
}

describe("process-identity-service", () => {
  it("kills a hung platform command and validates fail-closed within the probe budget", async () => {
    let childPid: number | undefined;
    let receivedOptions: ProcessIdentityCommandOptions | undefined;
    const runner = nodeCommandRunner("setInterval(() => {}, 10_000)", (pid) => {
      childPid = pid;
    });
    const probe = createPlatformProcessIdentityProbe({
      timeoutMs: 60,
      commandRunner: (file, args, options) => {
        receivedOptions = options;
        return runner(file, args, options);
      },
    });
    const startedAt = Date.now();

    const result = await probe.validate({
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pid,
      nonce: "expected-nonce",
      processStartTime: "expected-start",
      cwd: process.cwd(),
      command: ["expected-command"],
    });

    assert.deepEqual(result, { ok: false, reason: "probe_timeout" });
    assert.ok(Date.now() - startedAt < 750, "hung probe exceeded its response budget");
    assert.equal(receivedOptions?.timeout, 60);
    assert.equal(receivedOptions?.killSignal, "SIGKILL");
    assert.ok((receivedOptions?.maxBuffer ?? 0) > 0);
    assert.ok((receivedOptions?.maxBuffer ?? Infinity) <= 64 * 1024);
    assert.ok(childPid !== undefined);
    assert.throws(() => process.kill(childPid!, 0), (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH"
    ));
  });

  it("maps oversized command output to a typed bounded failure", async () => {
    const probe = createPlatformProcessIdentityProbe({
      commandRunner: nodeCommandRunner(
        "process.stdout.write('x'.repeat(Number(process.argv[1]) + 1024))",
      ),
      timeoutMs: 200,
    });

    await assert.rejects(
      probe.capture(process.pid),
      (error: unknown) => {
        assert.ok(error instanceof ProcessIdentityProbeError);
        assert.equal(error.code, "probe_output_limit");
        assert.equal(error.message, "Process identity probe output exceeded limit");
        return true;
      },
    );
  });

  it("does not expose command paths or stderr through capture or validate failures", async () => {
    const secret = "/private/workspace/customer-secret";
    const runner: ProcessIdentityCommandRunner = async () => {
      throw Object.assign(new Error(`spawn ${secret}/bin/ps failed`), {
        code: "EACCES",
        stderr: `permission denied: ${secret}`,
      });
    };
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 100 });

    await assert.rejects(
      probe.capture(process.pid),
      (error: unknown) => {
        assert.ok(error instanceof ProcessIdentityProbeError);
        assert.equal(error.code, "probe_failed");
        assert.equal(error.message, "Process identity probe failed");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    const validation = await probe.validate({
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pid,
      nonce: "expected-nonce",
      processStartTime: "expected-start",
      cwd: process.cwd(),
      command: ["expected-command"],
    });
    assert.deepEqual(validation, { ok: false, reason: "probe_failed" });
  });

  it("captures and validates the complete current-process identity", async () => {
    const probe = createPlatformProcessIdentityProbe();

    const identity = await probe.capture(process.pid);
    const result = await probe.validate(identity);

    assert.equal(identity.pid, process.pid);
    assert.equal(identity.ppid, process.ppid);
    assert.equal(typeof identity.pgid, "number");
    assert.ok(identity.nonce.length >= 16);
    assert.ok(identity.processStartTime.length > 0);
    assert.equal(identity.cwd, process.cwd());
    assert.ok(identity.command.length > 0);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.observed, identity);
    }
  });

  it("reports pid_missing without throwing when the process no longer exists", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const missing: ProcessIdentity = {
      pid: 2_147_483_647,
      ppid: null,
      pgid: null,
      nonce: "missing-process-nonce",
      processStartTime: "missing",
      cwd: "/missing",
      command: ["missing"],
    };

    assert.deepEqual(await probe.validate(missing), {
      ok: false,
      reason: "pid_missing",
    });
  });

  it("checks every provided expected identity field during capture", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const identity = await probe.capture(process.pid);
    const mismatches: Array<[
      keyof ProcessIdentity,
      ProcessIdentity[keyof ProcessIdentity],
    ]> = [
      ["pid", identity.pid + 1],
      ["ppid", (identity.ppid ?? 0) + 1],
      ["pgid", (identity.pgid ?? 0) + 1],
      ["cwd", `${identity.cwd}/other`],
      ["command", [...identity.command, "--unexpected"]],
      ["processStartTime", `${identity.processStartTime}-old`],
      ["nonce", "wrong-nonce"],
    ];

    for (const [field, value] of mismatches) {
      await assertCaptureMismatch(field, value);
    }
  });

  it("rejects a mismatched expected parent pid during capture", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const identity = await probe.capture(process.pid);

    await assertCaptureMismatch("ppid", (identity.ppid ?? 0) + 1);
  });

  it("rejects a mismatched expected cwd during capture", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const identity = await probe.capture(process.pid);

    await assertCaptureMismatch("cwd", `${identity.cwd}/other`);
  });

  it("classifies an expected start-time mismatch as pid reuse during validation", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const identity = await probe.capture(process.pid);

    const reused = await probe.validate({
      ...identity,
      processStartTime: `${identity.processStartTime}-old`,
    });

    assert.equal(reused.ok, false);
    assert.equal(!reused.ok && reused.reason, "pid_reused");
  });

  it("distinguishes reused pids and mismatched persisted identity fields", async () => {
    const probe = createPlatformProcessIdentityProbe();
    const identity = await probe.capture(process.pid);

    const cwdMismatch = await probe.validate({ ...identity, cwd: `${identity.cwd}/other` });
    const commandMismatch = await probe.validate({
      ...identity,
      command: [...identity.command, "--unexpected"],
    });
    const nonceMismatch = await probe.validate({ ...identity, nonce: "wrong-nonce" });

    assert.equal(cwdMismatch.ok, false);
    assert.equal(!cwdMismatch.ok && cwdMismatch.reason, "cwd_mismatch");
    assert.equal(commandMismatch.ok, false);
    assert.equal(!commandMismatch.ok && commandMismatch.reason, "command_mismatch");
    assert.equal(nonceMismatch.ok, false);
    assert.equal(!nonceMismatch.ok && nonceMismatch.reason, "nonce_mismatch");
  });

  // --- The live incident ------------------------------------------------
  // stagepass spawns codex as `/usr/bin/env node .../codex exec ...`, so the
  // child's accounting name is `env` and it immediately execs into `node`.
  // Captures taken inside that window produced `["(env)"]` (argv not yet
  // readable) or `["/usr/bin/env node ..."]` (readable but pre-exec) in the
  // production database; every one of them was later killed with
  // `command_mismatch` against a completely healthy, heartbeating run.

  it("refuses to record a ps accounting-name placeholder as a command", psPlaceholderOnly, async () => {
    const { runner } = scriptedPsRunner([psLine("(env)")]);
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 200 });

    await assert.rejects(
      probe.capture(process.pid),
      (error: unknown) => {
        assert.ok(error instanceof ProcessIdentityProbeError);
        assert.equal(error.code, "probe_command_unreadable");
        return true;
      },
    );
  });

  it("reports an unreadable command as a probe failure, not an identity fact", psPlaceholderOnly, async () => {
    const { runner } = scriptedPsRunner([psLine("(env)")]);
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 200 });

    const result = await probe.validate({
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pid,
      nonce: "expected-nonce",
      processStartTime: "expected-start",
      cwd: process.cwd(),
      command: ["/usr/bin/env", "node", "codex"],
    });

    // Never `command_mismatch`: `(env)` is ps saying it could not read argv.
    assert.deepEqual(result, { ok: false, reason: "probe_command_unreadable" });
  });

  it("settles on the post-exec command rather than recording the pre-exec one", psPlaceholderOnly, async () => {
    // Reading 1 catches the child still as `/usr/bin/env`; by reading 2 it has
    // exec'd into node. The disagreement must discard the capture, not persist
    // a command line the process no longer has.
    const preExec = "/usr/bin/env node /opt/homebrew/bin/codex exec --json";
    const postExec = "node /opt/homebrew/bin/codex exec --json";
    const { runner } = scriptedPsRunner([psLine(preExec), psLine(postExec), psLine(postExec)]);
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 200 });

    const identity = await probe.capture(process.pid);

    assert.deepEqual(identity.command, [postExec]);
  });

  it("discards a capture whose process was replaced between the ps and cwd probes", psPlaceholderOnly, async () => {
    // Defect B: `ps` and `lsof` are separate external commands, so a pid that
    // dies and is recycled between them yields a chimera record. The start time
    // is the cheap anchor that proves it is no longer the same process.
    const command = "node /opt/homebrew/bin/codex exec --json";
    // Two interleaved processes: every confirmation round sees the pid flip, so
    // no round ever agrees with itself and the capture is abandoned.
    const { runner } = scriptedPsRunner(Array.from({ length: 8 }, (_unused, index) => (
      psLine(command, index % 2 === 0 ? "Mon Jul 20 02:42:00 2026" : "Mon Jul 20 03:11:44 2026")
    )));
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 200 });

    await assert.rejects(
      probe.capture(process.pid),
      (error: unknown) => {
        assert.ok(error instanceof ProcessIdentityProbeError);
        assert.equal(error.code, "probe_identity_unstable");
        return true;
      },
    );
  });

  it("still captures a stable process in a single confirmed round trip", psPlaceholderOnly, async () => {
    const command = "node /opt/homebrew/bin/codex exec --json";
    const { runner, psCalls } = scriptedPsRunner([psLine(command)]);
    const probe = createPlatformProcessIdentityProbe({ commandRunner: runner, timeoutMs: 200 });

    const identity = await probe.capture(process.pid);

    assert.deepEqual(identity.command, [command]);
    // Confirmation costs exactly one extra `ps`; it must not become a loop.
    assert.equal(psCalls(), 2);
  });
});

describe("isUnreadableProcessCommand", () => {
  // Darwin's ps prints the kernel accounting name (p_comm, MAXCOMLEN = 16, and
  // always a bare basename) in parentheses when KERN_PROCARGS2 cannot give it
  // argv, and `<defunct>` for a zombie. Neither is a command line.
  it("detects the parenthesised accounting-name placeholder", () => {
    for (const field of ["(env)", "(node)", "(codex)", "(Google Chrome H)"]) {
      assert.equal(isUnreadableProcessCommand(field), true, field);
    }
  });

  it("detects a zombie's defunct marker on darwin and linux", () => {
    for (const field of ["<defunct>", "[env] <defunct>"]) {
      assert.equal(isUnreadableProcessCommand(field), true, field);
    }
  });

  it("treats an empty command field as unreadable", () => {
    assert.equal(isUnreadableProcessCommand(""), true);
    assert.equal(isUnreadableProcessCommand("   "), true);
  });

  it("detects the linux bracketed placeholder", () => {
    assert.equal(isUnreadableProcessCommand("[kthreadd]"), true);
  });

  it("does not mistake a real command containing parentheses for a placeholder", () => {
    for (const field of [
      // Live on macOS: launchd really does pass `(System)` as an argument.
      "/usr/libexec/UserEventAgent (System)",
      "/usr/bin/env node /opt/homebrew/bin/codex exec --cd /Users/dev/proj",
      "/Users/dev/My (Project)/bin/tool --flag",
      "(a) foo (b)",
      // A path is never an accounting name, and MAXCOMLEN + 1 is over the cap.
      "(/usr/bin/env)",
      `(${"a".repeat(17)})`,
    ]) {
      assert.equal(isUnreadableProcessCommand(field), false, JSON.stringify(field));
    }
  });
});

describe("decodeLsofName", () => {
  it("decodes lsof -F \\xNN escapes for a non-ASCII (CJK) path back to real UTF-8", () => {
    // lsof -Fn escapes each UTF-8 byte of 项目 as a literal \xNN sequence.
    const escaped = "/home/dev/\\xe9\\xa1\\xb9\\xe7\\x9b\\xae";
    assert.equal(decodeLsofName(escaped), "/home/dev/项目");
  });

  it("leaves a plain ASCII path untouched", () => {
    assert.equal(decodeLsofName("/home/dev/stagepass"), "/home/dev/stagepass");
  });

  it("only rewrites \\xNN runs, not other backslashes", () => {
    assert.equal(decodeLsofName("/tmp/a\\b"), "/tmp/a\\b");
  });
});
