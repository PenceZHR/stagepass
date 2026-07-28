import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CodexDesktopBridgeError } from "./codex-desktop-bridge";

const execFileAsync = promisify(execFile);
const SYSTEM_LSOF = "/usr/sbin/lsof";
const SYSTEM_PYTHON = "/usr/bin/python3";
const SYSTEM_PLUTIL = "/usr/bin/plutil";
const SYSTEM_CODESIGN = "/usr/bin/codesign";
const PROC_PIDPATH_MAX_OUTPUT = 4096;
const IDENTITY_PROBE_TIMEOUT_MS = 10_000;
const EXPECTED_APP_SERVER_BINARY_VERSION =
  "codex-cli 0.146.0-alpha.3.1";
const ALLOWED_CODEX_PATH_ALIAS_WARNING =
  "WARNING: proceeding, even though we could not create PATH aliases: "
  + "Operation not permitted (os error 1)";
const PROC_PIDPATH_SCRIPT = [
  "import ctypes",
  "import sys",
  "pid = int(sys.argv[1], 10)",
  "if pid <= 0: raise SystemExit(2)",
  `buffer = ctypes.create_string_buffer(${PROC_PIDPATH_MAX_OUTPUT})`,
  "libproc = ctypes.CDLL('/usr/lib/libproc.dylib')",
  "proc_pidpath = libproc.proc_pidpath",
  "proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]",
  "proc_pidpath.restype = ctypes.c_int",
  "length = proc_pidpath(pid, buffer, len(buffer))",
  "if length <= 0: raise SystemExit(3)",
  "sys.stdout.buffer.write(buffer.value)",
].join("\n");

export interface CodexDesktopSocketStat {
  isSocket: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
  device: number;
  inode: number;
}

export interface CodexDesktopDiscoveryFileSystem {
  lstat(endpoint: string): Promise<CodexDesktopSocketStat>;
}

export interface CodexDesktopAttestedIpcEndpoint {
  path: string;
  pid: number;
  desktopBundleIdentity: CodexDesktopSignedBundleIdentity;
  appServerBinary: CodexDesktopAttestedAppServerBinary;
  socket: CodexDesktopSocketStat;
  parentPath: string;
  parent: CodexDesktopSocketStat;
}

export interface CodexDesktopAdvertisedEndpoint {
  path: string;
  pid: number;
  desktopVerified: boolean;
  desktopBundleIdentity: CodexDesktopSignedBundleIdentity | null;
  appServerBinary: CodexDesktopAttestedAppServerBinary | null;
}

export interface CodexDesktopSignedBundleIdentity {
  bundleIdentifier: string;
  bundleShortVersion: string;
  bundleVersion: string;
  chromiumBaseVersion: string;
}

export interface CodexDesktopAttestedAppServerBinary {
  path: string;
  version: string;
  file: CodexDesktopSocketStat;
  bundlePath: string;
  bundleFile: CodexDesktopSocketStat;
  bundleIdentifier: string;
  teamIdentifier: string;
}

export interface CodexDesktopProcessProbe {
  currentUid(): number;
  advertisedEndpoints(): Promise<CodexDesktopAdvertisedEndpoint[]>;
  isRunning(pid: number): Promise<boolean>;
}

export interface CodexDesktopDiscoveryDependencies {
  fileSystem: CodexDesktopDiscoveryFileSystem;
  processProbe: CodexDesktopProcessProbe;
}

export type CodexDesktopProbeCommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface CodexDesktopProcessProbeOptions {
  endpoint: string;
  currentUid: () => number;
  runCommand: CodexDesktopProbeCommandRunner;
  realpath: (candidate: string) => Promise<string>;
  lstat: (candidate: string) => Promise<CodexDesktopSocketStat>;
  isRunning: (pid: number) => Promise<boolean>;
}

const CANONICAL_DESKTOP_MAINS = [
  {
    executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    bundle: "/Applications/ChatGPT.app",
    // Verified from the canonical bundle's codesign metadata on 2026-07-23.
    identifier: "com.openai.codex",
  },
  {
    executable: "/Applications/Codex.app/Contents/MacOS/Codex",
    bundle: "/Applications/Codex.app",
    identifier: "com.openai.codex",
  },
] as const;
const TRUSTED_OPENAI_TEAM_IDENTIFIER = "2DC432GLL2";

function unavailable(message: string, cause?: unknown): CodexDesktopBridgeError {
  return new CodexDesktopBridgeError(
    "desktop_bridge_unavailable",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export async function discoverCodexDesktopIpcEndpoint(
  dependencies: CodexDesktopDiscoveryDependencies,
): Promise<CodexDesktopAttestedIpcEndpoint> {
  const advertised = await dependencies.processProbe.advertisedEndpoints();
  const candidates: CodexDesktopAttestedIpcEndpoint[] = [];
  const uid = dependencies.processProbe.currentUid();
  for (const endpoint of advertised) {
    if (
      !endpoint.desktopVerified
      || !endpoint.desktopBundleIdentity
      || !endpoint.appServerBinary
    ) continue;
    if (!(await dependencies.processProbe.isRunning(endpoint.pid))) continue;
    try {
      const parentPath = path.dirname(endpoint.path);
      const [socket, parent] = await Promise.all([
        dependencies.fileSystem.lstat(endpoint.path),
        dependencies.fileSystem.lstat(parentPath),
      ]);
      if (!socket.isSocket || socket.isSymbolicLink) continue;
      if (!parent.isDirectory || parent.isSymbolicLink) continue;
      if (socket.uid !== uid || parent.uid !== uid) continue;
      if ((socket.mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0) continue;
      candidates.push({
        path: endpoint.path,
        pid: endpoint.pid,
        desktopBundleIdentity: endpoint.desktopBundleIdentity,
        appServerBinary: endpoint.appServerBinary,
        socket,
        parentPath,
        parent,
      });
    } catch {
      // A disappearing endpoint is stale and must not be selected.
    }
  }
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex(({ path: value, pid }) =>
      value === candidate.path && pid === candidate.pid)
      === index);
  if (unique.length !== 1) {
    throw unavailable(
      unique.length > 1
        ? "multiple verified Codex Desktop main processes advertised the IPC endpoint"
        : "no running verified Codex Desktop IPC endpoint was advertised",
    );
  }
  return unique[0]!;
}

function sameFileIdentity(
  left: CodexDesktopSocketStat,
  right: CodexDesktopSocketStat,
): boolean {
  return left.isSocket === right.isSocket
    && left.isDirectory === right.isDirectory
    && left.isSymbolicLink === right.isSymbolicLink
    && left.uid === right.uid
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode;
}

function isRegularFile(stat: CodexDesktopSocketStat): boolean {
  return !stat.isSocket && !stat.isDirectory && !stat.isSymbolicLink;
}

function plutilScalar(output: string): string | null {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  return value.length > 0
      && value.length <= 256
      && !value.includes("\0")
      && !value.includes("\r")
      && !value.includes("\n")
    ? value
    : null;
}

async function readSignedBundleIdentity(
  infoPlist: string,
  runCommand: CodexDesktopProbeCommandRunner,
): Promise<CodexDesktopSignedBundleIdentity | null> {
  const fields = [
    ["bundleIdentifier", "CFBundleIdentifier"],
    ["bundleShortVersion", "CFBundleShortVersionString"],
    ["bundleVersion", "CFBundleVersion"],
    ["chromiumBaseVersion", "ChromiumBaseVersion"],
  ] as const;
  const identity: Partial<CodexDesktopSignedBundleIdentity> = {};
  for (const [property, key] of fields) {
    const result = await runCommand(
      SYSTEM_PLUTIL,
      ["-extract", key, "raw", "-o", "-", infoPlist],
    );
    if (result.stderr.length > 0) return null;
    const value = plutilScalar(result.stdout);
    if (!value) return null;
    identity[property] = value;
  }
  return identity as CodexDesktopSignedBundleIdentity;
}

async function readAppServerBinaryVersion(
  executable: string,
  runCommand: CodexDesktopProbeCommandRunner,
): Promise<string | null> {
  const result = await runCommand(executable, ["--version"]);
  const stderr = result.stderr.endsWith("\n")
    ? result.stderr.slice(0, -1)
    : result.stderr;
  if (stderr !== "" && stderr !== ALLOWED_CODEX_PATH_ALIAS_WARNING) {
    return null;
  }
  const value = plutilScalar(result.stdout);
  return value === EXPECTED_APP_SERVER_BINARY_VERSION ? value : null;
}

async function kernelProcessExecutable(
  pid: number,
  dependencies: Pick<
    CodexDesktopProcessProbeOptions,
    "runCommand" | "realpath"
  >,
): Promise<string | null> {
  const { stdout } = await dependencies.runCommand(
    SYSTEM_PYTHON,
    ["-I", "-S", "-c", PROC_PIDPATH_SCRIPT, String(pid)],
  );
  if (
    stdout.length === 0
    || stdout.length > PROC_PIDPATH_MAX_OUTPUT
    || stdout.includes("\0")
    || stdout.includes("\n")
    || stdout.includes("\r")
    || !path.isAbsolute(stdout)
  ) {
    return null;
  }
  return dependencies.realpath(stdout);
}

async function verifiedDesktopProcess(
  pid: number,
  dependencies: Pick<
    CodexDesktopProcessProbeOptions,
    "runCommand" | "realpath" | "lstat"
  >,
): Promise<{
  desktopBundleIdentity: CodexDesktopSignedBundleIdentity;
  appServerBinary: CodexDesktopAttestedAppServerBinary;
} | null> {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const resolvedExecutable = await kernelProcessExecutable(pid, dependencies);
    if (!resolvedExecutable) return null;
    const main = CANONICAL_DESKTOP_MAINS.find(
      (candidate) => candidate.executable === resolvedExecutable,
    );
    if (!main) return null;
    const infoPlist = path.join(main.bundle, "Contents", "Info.plist");
    const appServerBinaryPath = path.join(
      main.bundle,
      "Contents",
      "Resources",
      "codex",
    );
    const [
      resolvedBundle,
      resolvedInfoPlist,
      resolvedAppServerBinary,
    ] = await Promise.all([
      dependencies.realpath(main.bundle),
      dependencies.realpath(infoPlist),
      dependencies.realpath(appServerBinaryPath),
    ]);
    if (
      resolvedBundle !== main.bundle
      || resolvedInfoPlist !== infoPlist
      || resolvedAppServerBinary !== appServerBinaryPath
    ) return null;
    const [
      executableBefore,
      bundleBefore,
      infoPlistBefore,
      appServerBinaryBefore,
    ] =
      await Promise.all([
        dependencies.lstat(main.executable),
        dependencies.lstat(main.bundle),
        dependencies.lstat(infoPlist),
        dependencies.lstat(appServerBinaryPath),
      ]);
    if (
      !isRegularFile(executableBefore)
      || !bundleBefore.isDirectory
      || bundleBefore.isSymbolicLink
      || !isRegularFile(infoPlistBefore)
      || !isRegularFile(appServerBinaryBefore)
    ) return null;
    const identityBefore = await readSignedBundleIdentity(
      infoPlist,
      dependencies.runCommand,
    );
    if (
      !identityBefore
      || identityBefore.bundleIdentifier !== main.identifier
    ) return null;
    await dependencies.runCommand(
      SYSTEM_CODESIGN,
      ["--verify", "--deep", "--strict", main.bundle],
    );
    const result = await dependencies.runCommand(
      SYSTEM_CODESIGN,
      ["-dv", "--verbose=4", main.bundle],
    );
    const identity = `${result.stdout}\n${result.stderr}`;
    const fields = new Set(
      identity.split(/\r?\n/).map((line) => line.trim()),
    );
    if (
      !fields.has(`Identifier=${main.identifier}`)
      || !fields.has(`TeamIdentifier=${TRUSTED_OPENAI_TEAM_IDENTIFIER}`)
    ) return null;
    const appServerVersionBefore = await readAppServerBinaryVersion(
      appServerBinaryPath,
      dependencies.runCommand,
    );
    if (!appServerVersionBefore) return null;
    const identityAfter = await readSignedBundleIdentity(
      infoPlist,
      dependencies.runCommand,
    );
    await dependencies.runCommand(
      SYSTEM_CODESIGN,
      ["--verify", "--deep", "--strict", main.bundle],
    );
    const appServerVersionAfter = await readAppServerBinaryVersion(
      appServerBinaryPath,
      dependencies.runCommand,
    );
    const [
      resolvedExecutableAfter,
      resolvedBundleAfter,
      resolvedInfoPlistAfter,
      resolvedAppServerBinaryAfter,
      executableAfter,
      bundleAfter,
      infoPlistAfter,
      appServerBinaryAfter,
    ] = await Promise.all([
      kernelProcessExecutable(pid, dependencies),
      dependencies.realpath(main.bundle),
      dependencies.realpath(infoPlist),
      dependencies.realpath(appServerBinaryPath),
      dependencies.lstat(main.executable),
      dependencies.lstat(main.bundle),
      dependencies.lstat(infoPlist),
      dependencies.lstat(appServerBinaryPath),
    ]);
    if (
      !identityAfter
      || JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)
      || resolvedExecutableAfter !== main.executable
      || resolvedBundleAfter !== main.bundle
      || resolvedInfoPlistAfter !== infoPlist
      || resolvedAppServerBinaryAfter !== appServerBinaryPath
      || appServerVersionAfter !== appServerVersionBefore
      || !sameFileIdentity(executableBefore, executableAfter)
      || !sameFileIdentity(bundleBefore, bundleAfter)
      || !sameFileIdentity(infoPlistBefore, infoPlistAfter)
      || !sameFileIdentity(appServerBinaryBefore, appServerBinaryAfter)
    ) return null;
    return {
      desktopBundleIdentity: identityAfter,
      appServerBinary: {
        path: appServerBinaryPath,
        version: appServerVersionAfter,
        file: appServerBinaryAfter,
        bundlePath: main.bundle,
        bundleFile: bundleAfter,
        bundleIdentifier: identityAfter.bundleIdentifier,
        teamIdentifier: TRUSTED_OPENAI_TEAM_IDENTIFIER,
      },
    };
  } catch {
    return null;
  }
}

export function createCodexDesktopProcessProbe(
  options: CodexDesktopProcessProbeOptions,
): CodexDesktopProcessProbe {
  return {
    currentUid: options.currentUid,
    async advertisedEndpoints() {
      try {
        const { stdout } = await options.runCommand(
          SYSTEM_LSOF,
          ["-t", options.endpoint],
        );
        const pids = [...new Set(
          stdout
            .split(/\s+/)
            .map(Number)
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        )];
        return Promise.all(pids.map(async (pid) => {
          const verified = await verifiedDesktopProcess(pid, options);
          return {
            path: options.endpoint,
            pid,
            desktopVerified: verified !== null,
            desktopBundleIdentity:
              verified?.desktopBundleIdentity ?? null,
            appServerBinary: verified?.appServerBinary ?? null,
          };
        }));
      } catch {
        return [];
      }
    },
    isRunning: options.isRunning,
  };
}

export function defaultCodexDesktopDiscoveryDependencies():
CodexDesktopDiscoveryDependencies {
  const endpoint = path.join(os.homedir(), ".codex", "ipc", "ipc.sock");
  const runCommand: CodexDesktopProbeCommandRunner = async (file, args) => {
    const result = await execFileAsync(file, [...args], {
      encoding: "utf8",
      timeout: IDENTITY_PROBE_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const fileSystem: CodexDesktopDiscoveryFileSystem = {
    async lstat(candidate) {
      const stat = await fs.lstat(candidate);
      return {
        isSocket: stat.isSocket(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        uid: stat.uid,
        mode: stat.mode,
        device: stat.dev,
        inode: stat.ino,
      };
    },
  };
  return {
    fileSystem,
    processProbe: createCodexDesktopProcessProbe({
      endpoint,
      currentUid() {
        return process.getuid?.() ?? -1;
      },
      runCommand,
      realpath: (candidate) => fs.realpath(candidate),
      lstat: (candidate) => fileSystem.lstat(candidate),
      async isRunning(pid) {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    }),
  };
}
