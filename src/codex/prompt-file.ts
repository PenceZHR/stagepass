import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PromptFile {
  readonly path: string;
  readonly envelope: string;
  release(): void;
}

export interface PromptFiles {
  create(prompt: string): PromptFile;
}

export interface PromptFileOptions {
  readonly root?: string;
}

/**
 * Put the complete task on disk and expose only a short pointer to the TUI.
 *
 * The file is deliberately per-turn and private: it may contain repository
 * context, rubric details, and other material that must not be duplicated into
 * a large terminal paste. Callers own the returned handle until the turn ends.
 */
export function createPromptFiles(options: PromptFileOptions = {}): PromptFiles {
  const root = options.root ?? tmpdir();

  return {
    create(prompt: string): PromptFile {
      if (prompt.trim().length === 0) {
        throw new Error("prompt must not be blank");
      }
      if (prompt.includes("\0")) {
        throw new Error("prompt must not contain NUL bytes");
      }

      const directory = mkdtempSync(join(root, "stagepass-prompt-"));
      const path = join(directory, "prompt.md");
      try {
        writeFileSync(path, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
        chmodSync(path, 0o600);
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      return {
        path,
        envelope: `请先完整读取这个 UTF-8 文件，并把文件内容作为本轮完整任务执行：${path}`,
        release(): void {
          if (released) return;
          released = true;
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
  };
}
