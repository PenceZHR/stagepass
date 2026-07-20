import fs from "node:fs";
import path from "node:path";

export interface AcceptanceInjection {
  root: string;
  workerBarrier: string | null;
  claudeTransportBin: string | null;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveContainedFile(root: string, inputRoot: string, raw: string, code: string, executable: boolean): string {
  if (!path.isAbsolute(raw)) throw new Error(code);
  const absolute = path.resolve(raw);
  if (!contained(inputRoot, absolute)) throw new Error(code);
  try {
    const projected = path.join(root, path.relative(inputRoot, absolute));
    let current = root;
    for (const segment of path.relative(root, projected).split(path.sep)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(code);
    }
    const candidate = fs.realpathSync(projected);
    if (!contained(root, candidate)) throw new Error(code);
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) throw new Error(code);
    if (executable) fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    throw new Error(code);
  }
}

export function resolveAcceptanceInjection(env: NodeJS.ProcessEnv = process.env): AcceptanceInjection | null {
  if (env.STAGEPASS_ACCEPTANCE_MODE !== "1") return null;
  const rawRoot = env.STAGEPASS_ACCEPTANCE_ROOT;
  if (!rawRoot || !path.isAbsolute(rawRoot)) throw new Error("acceptance_root_invalid");
  const inputRoot = path.resolve(rawRoot);
  const root = fs.realpathSync(inputRoot);
  const resolveOptional = (raw: string | undefined, code: string, executable = false): string | null => {
    if (!raw) return null;
    return resolveContainedFile(root, inputRoot, raw, code, executable);
  };
  return {
    root,
    workerBarrier: resolveOptional(env.STAGEPASS_WORKER_BARRIER, "worker_barrier_invalid"),
    claudeTransportBin: resolveOptional(env.STAGEPASS_CLAUDE_TRANSPORT_BIN, "claude_transport_invalid", true),
  };
}
