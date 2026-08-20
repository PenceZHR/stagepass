import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../mcp/server";

import { blueDocPath } from "../domain/artifact-home";
import type { Gap } from "../domain/gap";
import { PHASES } from "../domain/phase";
import { templateFor } from "../domain/phase-template";
import { judgePrompt } from "../domain/round";
import { renderWorklist, type WorkItemDraft } from "../domain/worklist";

/**
 * **题面里说得出名字的工具，必须真的存在。**
 *
 * ## 这条护栏是用血换的
 *
 * `stagepass_next` / `stagepass_answer` 随 `src/plugin/` 一起删掉，**题面还在叫裁判
 * 去调它们，而 1177 条测试全绿**。后果不是报错：`worklist.read` 读回一份全空的名单，
 * 于是每一轮的 gap 表态全丢、每一条标准记 `not_assessed` —— 而标了阻断的
 * `not_assessed` 是把闸门**沉默地**关死。沉默的那种是最坏的。
 *
 * 三层测试全绿而链子断在层与层之间，这是那次的形状。测试证不了它：没有一个断言
 * 会去问「题面提到的那个东西还在不在」。所以要一条专门问这句话的。
 *
 * ## 它扫的是**渲染出来的题面**，不是源码
 *
 * 拿正则去 `readFileSync` 源码，扫到的是注释里的历史（这棵树的注释里到处写着
 * 「载体从 `stagepass_next` 换成了文件」，那是该留着的）。而 TestPlan §四·1 明写了
 * 正则扫源码只证明字符串在文件里、不证明任何行为 —— 那正是让整张 3D 星图从来没
 * 显示过、而 1137 条全绿的那类测试。
 *
 * 所以这里调**真的渲染函数**，比它们的返回值。
 *
 * ## 名单从**真的工具表**来（2026-08-19 兑现）
 *
 * 原来是写死的一行，注释里记着「等 `src/mcp/server.ts` 落地就换成从工具表读」。
 * 它落地了。现在这份名单是**把 server 真的跑起来、问它 `tools/list`** 拿到的 ——
 * 不是对源码做正则：后者只证明那个字符串在文件里，证不了它真的注册上了
 * （TestPlan §四·1）。
 *
 * 于是「加了一个工具」和「题面里提到它」这两件事自动对齐，没有第二份名单要维护。
 */
async function registeredTools(): Promise<readonly string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-names", version: "0" });
  await Promise.all([buildServer().connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  return tools.map((one) => one.name);
}

const TOOL_NAME = /\bstagepass_[a-z_]+\b/g;

/** 一段文本里提到、而没人注册的工具名。**这是这份文件的全部逻辑。** */
function unknownToolNames(text: string, registered: readonly string[]): string[] {
  const known = new Set(registered);
  const found = new Set<string>();
  for (const match of text.matchAll(TOOL_NAME)) {
    if (!known.has(match[0])) found.add(match[0]);
  }
  return [...found].sort();
}

/** 夹具：两条 gap，一人提一模型报，两种在提示词里分属不同的区。 */
const FIXTURE_GAPS: readonly Gap[] = [
  {
    id: "HUMAN-1", kind: "finding", severity: "P1", title: "人明确要求的那一条",
    status: "open", openedRound: 1, resolution: null, note: "人对这条说的话",
    closedBy: null, where: null, why: null, owner: null,
  },
  {
    id: "SPEC-SCOPE-1", kind: "finding", severity: "P0", title: "模型报出来的那一条",
    status: "open", openedRound: 1, resolution: null, note: null,
    closedBy: null, where: null, why: null, owner: null,
  },
];

const FIXTURE_ITEMS: readonly WorkItemDraft[] = FIXTURE_GAPS.map((gap) => ({
  kind: "gap" as const,
  target: gap.id,
  prompt: `这个问题还成不成立？\n${gap.title}`,
  choices: ["closed", "still_open"],
}));

/**
 * 每一个派得出去的阶段的裁判题面，**所有可选的那几节全部打开**。
 *
 * 可选节缺席时那几行一个字都不印 —— 夹具不传它们，扫的就是一份生产上不存在的
 * 题面，而工具名恰恰最可能出现在「逐条表态怎么走」这种可选节里。
 */
function everyRenderedPrompt(): { where: string; text: string }[] {
  return PHASES
    .filter((phase) => phase !== "Done")
    .map((phase) => ({
      where: `judgePrompt(${phase})`,
      text: judgePrompt({
        phase, round: 2, task: "（这一阶段的任务书）", openGaps: FIXTURE_GAPS,
        template: templateFor(phase) ?? undefined,
        openGapsPath: "/tmp/stagepass-round/open-gaps.md",
        worklist: {
          listPath: "/tmp/stagepass-round/worklist.md",
          answersPath: "/tmp/stagepass-round/worklist-answers.md",
          count: FIXTURE_GAPS.length,
        },
        redSlotPath: "/tmp/stagepass-round/red-slots.json",
        blueSlotPath: "/tmp/stagepass-round/blue-slots.json",
        sentBack: { from: "Build", reason: "契约对不上", round: 3 },
        blueDocPath: blueDocPath("CHG-1", phase, 2),
        blueRubric: {
          criteriaPath: "/tmp/stagepass-round/rubric.md",
          answersPath: "/tmp/stagepass-round/rubric-answers.md",
          count: 3,
        },
        settledPath: "/tmp/stagepass-round/settled.md",
        contractNotesPath: "/tmp/stagepass-round/result-contract-notes.md",
      }),
    }));
}

/** `src/prompts/` 下的每一份 —— 那些文件整份都是题面，不含代码也不含注释。 */
function promptFiles(directory = join(process.cwd(), "src", "prompts")): { where: string; text: string }[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return promptFiles(path);
    return [{ where: path, text: readFileSync(path, "utf-8") }];
  });
}

describe("standing · 题面说得出名字的工具都真的存在", () => {
  it("**这条护栏抓得住那次事故** —— 拿当时那句原话喂进去", async () => {
    /*
     * 一条绿着诞生的护栏证明不了任何事（TestPlan §六）。这一条是它的替代品：
     * 下面这句是 2026-08-19 之前 `judgePrompt` 真的印给裁判的原话（`git show
     * HEAD~1:src/domain/round.ts`），抄进来当夹具。护栏认不出它，护栏就是摆设。
     */
    const asItWas = "   反复调 `stagepass_next`（不带参数）取下一条，看完用 `stagepass_answer`"
      + "\n   回答，直到它说没有了。**你不需要、也无法指定答的是哪一条** —— StagePass 记着。";
    assert.deepEqual(
      unknownToolNames(asItWas, await registeredTools()),
      ["stagepass_answer", "stagepass_next"],
    );
    // 注册过的不许报出来，否则它每加一个工具就要红一次，很快会被人 skip 掉。
    assert.deepEqual(unknownToolNames("去调 stagepass_ask 问他", await registeredTools()), []);
  });

  it("**这条护栏真的扫到了题面** —— 语料不能是空的", () => {
    // 渲染函数换了签名、`src/prompts/` 搬了家，都会让语料悄悄变成零份，而那时
    // 下面那条主测试永远绿。它答的是「护栏在不在岗」。
    const corpus = [...everyRenderedPrompt(), ...promptFiles()];
    assert.ok(corpus.length >= PHASES.length, `语料只有 ${corpus.length} 份`);
    assert.ok(
      corpus.every((source) => source.text.length > 0),
      "有语料是空的：" + corpus.filter((s) => s.text.length === 0).map((s) => s.where).join(", "),
    );
  });

  it("题面里出现的每一个 stagepass_* 工具名，都在工具表里", async () => {
    const offences: string[] = [];
    for (const source of [
      ...everyRenderedPrompt(),
      { where: "renderWorklist()", text: renderWorklist(FIXTURE_ITEMS) },
      ...promptFiles(),
    ]) {
      for (const name of unknownToolNames(source.text, await registeredTools())) {
        offences.push(`${source.where} 叫模型去调 ${name}，而没有人注册它`);
      }
    }
    assert.deepEqual(offences, []);
  });
});
