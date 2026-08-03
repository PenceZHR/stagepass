import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { judgePrompt } from "./round";
import { PHASES } from "./phase";
import type { Gap } from "./gap";

/**
 * 十三个阶段的裁判提示词，**逐字节钉死**。
 *
 * ## 它是干什么用的
 *
 * 2026-08-03 起要把「一份小模板套十三个阶段」拆成「每阶段各写一份」（用户原话：
 * 「每个阶段都要重排，功能不变，但是不能再用同一个小基座了」）。
 *
 * **「功能不变」这句话必须是机械可查的，不能靠谁说了算。** 所以先把当前十二个可派发
 * 阶段生成的提示词整份存下来，重排之后一个字符都不许变。
 *
 * ## 拆完之后它不退休
 *
 * 到那时它的意思换了一层：从「重排没改东西」变成「**改某一个阶段不会波及别的阶段**」。
 * 那正是解耦要买的东西 —— 改 Build 那一条，别的十一条的快照必须纹丝不动。
 *
 * ## 夹具是写死的
 *
 * 任务、gap、轮次全部固定，因为这里要比的是**模板**，不是内容。夹具里两种 gap 都有
 * （人提的 `HUMAN-`、模型报的），因为它们在提示词里分属两个区，措辞不一样。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "round-prompt.golden.txt");

const FIXTURE_GAPS: Gap[] = [
  {
    id: "HUMAN-1", kind: "finding", severity: "P1",
    title: "人明确要求的那一条", status: "open",
    openedRound: 1, resolution: null, note: "人对这条说的话",
  },
  {
    id: "SPEC-SCOPE-1", kind: "finding", severity: "P0",
    title: "模型报出来的那一条", status: "open",
    openedRound: 1, resolution: null, note: null,
  },
];

/** 每个可派发阶段一份。`Done` 是终点，什么都不派，所以不在里面。 */
export function everyPhasePrompt(): string {
  return PHASES
    .filter((phase) => phase !== "Done")
    .map((phase) => [
      `########## ${phase} ##########`,
      judgePrompt({
        phase, round: 2, task: "（这一阶段的任务书）", openGaps: FIXTURE_GAPS,
      }),
    ].join("\n"))
    .join("\n\n");
}

describe("L4 · 十三个阶段的提示词逐字节钉死", () => {
  it("和 golden 一字不差", () => {
    const golden = readFileSync(GOLDEN, "utf-8");
    const now = everyPhasePrompt();
    if (now === golden) return;

    // 差在哪一行 —— 整份 diff 太长，人看不动。
    const a = golden.split("\n");
    const b = now.split("\n");
    const at = a.findIndex((line, index) => line !== b[index]);
    assert.fail([
      `提示词变了（第 ${at + 1} 行起）：`,
      `  golden: ${JSON.stringify(a[at])}`,
      `  现在  : ${JSON.stringify(b[at])}`,
      "",
      "改动是有意的就重生成：pnpm exec node --import tsx scripts/regen-prompt-golden.ts",
      "**但先确认那些差异确实是你想要的** —— 这份文件的全部意义就是拦住无意的漂移。",
    ].join("\n"));
  });

  it("十二个阶段一个不少", () => {
    const golden = readFileSync(GOLDEN, "utf-8");
    for (const phase of PHASES) {
      if (phase === "Done") {
        assert.doesNotMatch(golden, new RegExp(`##### ${phase} #####`));
        continue;
      }
      assert.match(golden, new RegExp(`##### ${phase} #####`), `${phase} 没被钉住`);
    }
  });
});
