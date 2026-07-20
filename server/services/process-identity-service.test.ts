import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";

import {
  createPlatformProcessIdentityProbe,
  decodeLsofName,
  ProcessIdentityProbeError,
  ProcessIdentityMismatchError,
  type ProcessIdentityCommandOptions,
  type ProcessIdentityCommandRunner,
  type ProcessIdentity,
} from "./process-identity-service";

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
