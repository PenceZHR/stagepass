import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  createSlotDocument,
  readSlotDocument,
  type SlotDocumentResult,
  type SlotHeader,
} from "../domain/round-slots";

/**
 * 格子文件落在磁盘上的那一层。
 *
 * **持久路径，不是临时目录。** 题面文件可以临时（它只读，丢了模型会大声说读不到），
 * 但答案文件承载的是这一轮唯一的产出 —— `/var/folders` 会被系统清掉，清掉之后
 * 「模型没填」和「文件被清了」在账本上长得一模一样，而这两件事人要做的完全不同。
 *
 * 路径本身带 change / phase / round / role，所以两个座位不会抢同一个文件，
 * 上一轮的旧文件也不可能被当成这一轮 —— 抬头里还会再比一次，两道。
 */
export interface SlotFiles {
  /** 铺一份新的，返回它的绝对路径。已经存在就原样覆盖（重放要幂等）。 */
  lay(header: SlotHeader): string;
  /** 读回来判一遍。文件不在时给出的是「不在」，不是「空的」。 */
  collect(header: SlotHeader): SlotDocumentResult;
  /** 这一轮彻底结束之后清掉。 */
  discard(header: SlotHeader): void;
  /** 这一份在哪。 */
  pathOf(header: SlotHeader): string;
}

/**
 * 默认落点。**不是临时目录** —— `/var/folders` 会被系统清掉，而清掉之后
 * 「模型没填」和「文件被清了」在账本上长得一模一样。
 */
export const DEFAULT_SLOT_ROOT = join(homedir(), ".stagepass", "rounds");

export interface SlotFilesOptions {
  /** 根目录。默认 `~/.stagepass/rounds`。 */
  readonly root?: string;
}

const safe = (value: string): string => value.replaceAll(/[^A-Za-z0-9._-]/g, "_");

export function createSlotFiles(options: SlotFilesOptions = {}): SlotFiles {
  const root = options.root ?? DEFAULT_SLOT_ROOT;
  const pathOf = (header: SlotHeader): string => join(
    root,
    safe(header.changeId),
    safe(header.phase),
    `r${header.round}-${safe(header.role)}.json`,
  );

  return {
    pathOf,
    lay(header) {
      const path = pathOf(header);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, createSlotDocument(header), "utf8");
      return path;
    },
    collect(header) {
      let source: string | null = null;
      try {
        source = readFileSync(pathOf(header), "utf8");
      } catch {
        // 不在就是不在 —— 交给 readSlotDocument 说那句话，这里不自己编一个空结果。
        source = null;
      }
      return readSlotDocument(source, header);
    },
    discard(header) {
      rmSync(pathOf(header), { force: true });
    },
  };
}
