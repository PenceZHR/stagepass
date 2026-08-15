import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOps {
  run(request: ProcessRequest): Promise<ProcessResult>;
  spawn(request: Omit<ProcessRequest, "input">): ChildProcessWithoutNullStreams;
}

class NodeProcessOps implements ProcessOps {
  spawn(request: Omit<ProcessRequest, "input">): ChildProcessWithoutNullStreams {
    // Node documents spawn argv and shell:false as the direct-process boundary.
    // Source: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
    return spawn(request.command, [...request.args], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: request.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(request);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
      child.stdin.end(request.input);
    });
  }
}

export function createProcessOps(): ProcessOps {
  return new NodeProcessOps();
}
