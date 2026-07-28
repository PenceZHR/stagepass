import { BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA } from "./spec-battle-ledger";
import {
  materialiseRoleBriefs,
  roundOutputPath,
} from "./delegated-round-workspace";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import { renderPromptTemplate } from "./prompt-service";
import { rubricCriteriaSection } from "./delegated-round-rubric-answer";

/**
 * Builds the three role briefs for one round and writes them into the repo.
 *
 * ## Why the schema is injected rather than written into each brief
 *
 * There are nine briefs across four phases. A schema pasted into each of them
 * is nine copies of a contract the server validates from ONE definition, and
 * the copies only have to drift once for a side to be asked for a document the
 * server then refuses -- reported as "side output invalid", with nothing
 * pointing at the stale brief. So each brief carries `{outputContract}` and the
 * schema is rendered in from the descriptor.
 *
 * Blue's and the judge's schemas are shared across all four phases; only red's
 * differs, and it reuses the phase's existing producer schema rather than
 * introducing a second definition of the same document.
 */

function outputContractSection(input: {
  outputPath: string;
  schema: Record<string, unknown>;
}): string {
  return [
    "## 输出协议",
    "",
    `把你的结果**写入 \`${input.outputPath}\`**。文件内容必须**就是一个 JSON 文档**，`,
    "符合下面这份 Schema。Schema 由系统给定，你只负责填内容，",
    "**不得增删字段、不得改字段名、不得自创取值**。",
    "",
    "```json",
    JSON.stringify(input.schema, null, 2),
    "```",
    "",
    "- 文件里**只有**这一个 JSON 对象，前后不要有说明文字，不要用 ``` 围栏包裹。",
    "- 不要在聊天里复述这份 JSON —— 系统只读文件，聊天回复只需要一句话说明你做完了。",
    `- 不要写除 \`${input.outputPath}\` 以外的任何文件。`,
  ].join("\n");
}

export interface DelegatedRoundBriefPaths {
  judge: string;
  red: string;
  blue: string;
  redOutput: string;
  blueOutput: string;
  verdictOutput: string;
}

export interface VerdictCriterion {
  id: string;
  text: string;
}

export function buildAndMaterialiseRoundBriefs(input: {
  descriptor: DelegatedRoundPhase;
  changeId: string;
  changeTitle?: string;
  repoPath: string;
  roundNo: number;
  /**
   * The verdict rubric's criteria, with the ids the judge must answer by.
   *
   * Without this the judge has no way to know the ids exist: it invents
   * plausible slugs from the criterion text ("claims_verified_by_critic"), the
   * store rejects them as unknown, and the round dies after red and blue have
   * already been committed. Observed exactly that way on CHG-006.
   */
  verdictCriteria?: readonly VerdictCriterion[];
  /**
   * The CRITIC rubric's criteria, for blue.
   *
   * Same reason as `verdictCriteria`, one role over: a critic rubric nothing is
   * asked to answer is the blank checklist `rubric-rollout` refuses to ship, and
   * blue is the only role in the round that IS the critic.
   */
  criticCriteria?: readonly VerdictCriterion[];
}): DelegatedRoundBriefPaths {
  const { descriptor, changeId, repoPath, roundNo } = input;
  const vars = { changeId, changeTitle: input.changeTitle, repoPath };

  const redOutput = roundOutputPath(changeId, descriptor.phase, roundNo, "red");
  const blueOutput = roundOutputPath(changeId, descriptor.phase, roundNo, "blue");
  const verdictOutput = roundOutputPath(changeId, descriptor.phase, roundNo, "verdict");

  const red = renderPromptTemplate(descriptor.redPromptPhase, vars)
    .replace(/\{outputPath\}/g, redOutput)
    .replace(/\{outputContract\}/g, outputContractSection({
      outputPath: redOutput,
      schema: descriptor.redOutputSchema,
    }));

  const blue = renderPromptTemplate(descriptor.bluePromptPhase, vars)
    .replace(/\{outputPath\}/g, blueOutput)
    .replace(
      /\{criticCriteria\}/g,
      rubricCriteriaSection(
        input.criticCriteria ?? [],
        "（本阶段没有配置 critic rubric，`rubric` 写空数组 `[]`。）",
      ),
    )
    .replace(/\{outputContract\}/g, outputContractSection({
      outputPath: blueOutput,
      schema: BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
    }));

  // Written first so the judge brief can name their paths, and so a brief is
  // never missing when the judge tells a sub-agent to read it.
  const briefPaths = materialiseRoleBriefs({
    repoPath,
    changeId,
    phase: descriptor.phase,
    briefs: {
      // Placeholder; replaced below once the brief paths are known. Writing
      // twice is cheaper than threading the path calculation through two
      // modules, and the second write is what the judge actually reads.
      judge: "",
      red,
      blue,
    },
  });

  const judge = renderPromptTemplate("delegated_round_judge", vars)
    .replace(/\{phaseLabel\}/g, descriptor.label)
    .replace(/\{redUnit\}/g, descriptor.redUnit)
    .replace(/\{blueUnit\}/g, descriptor.blueUnit)
    .replace(/\{roundNo\}/g, String(roundNo))
    .replace(/\{redBriefPath\}/g, briefPaths.red)
    .replace(/\{blueBriefPath\}/g, briefPaths.blue)
    .replace(/\{redOutputPath\}/g, redOutput)
    .replace(/\{blueOutputPath\}/g, blueOutput)
    .replace(/\{verdictOutputPath\}/g, verdictOutput)
    .replace(
      /\{verdictChecklist\}/g,
      descriptor.verdictChecklist.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      /\{verdictCriteria\}/g,
      rubricCriteriaSection(
        input.verdictCriteria ?? [],
        "（本阶段没有配置 verdict rubric，`rubric` 写空数组 `[]`。）",
      ),
    );

  materialiseRoleBriefs({
    repoPath,
    changeId,
    phase: descriptor.phase,
    briefs: { judge, red, blue },
  });

  return {
    ...briefPaths,
    redOutput,
    blueOutput,
    verdictOutput,
  };
}

/**
 * The short message the turn actually carries.
 *
 * Deliberately tiny, and deliberately the same shape on round 1 and round 5.
 * The role definitions live in files the judge reads; the dispatch says which
 * round this is and where to look.
 *
 * This comment used to justify the size differently -- "the Codex task persists
 * across rounds, so the judge already knows its job". That premise is gone: a
 * round's sub-agents must be fresh, sub-agents live in the task, so every round
 * now gets a fresh task (delegated-round-task-rotation.ts). The brief stays
 * small for a better reason -- it is a PATH to the full role definition, and a
 * path cannot be paraphrased into a weaker one on the way through.
 */
export function buildRoundDispatchPrompt(input: {
  descriptor: DelegatedRoundPhase;
  changeId: string;
  roundNo: number;
  paths: DelegatedRoundBriefPaths;
}): string {
  const { descriptor, roundNo, paths } = input;
  return [
    `${descriptor.label} 第 ${roundNo} 轮开始。`,
    "",
    `你是本轮的裁决者 BATTLE_REPORTER。你的完整职责写在 \`${paths.judge}\` ——`,
    "**现在读它，并严格照它执行**。",
    "",
    `- 红方任务书：\`${paths.red}\``,
    `- 蓝方任务书：\`${paths.blue}\``,
    `- 你的裁决写入：\`${paths.verdictOutput}\``,
    "",
    roundNo > 1
      // Deliberately NOT "you remember the earlier rounds". Every round now runs
      // in a FRESH Codex task -- it has to, because a round's sub-agents must be
      // fresh and sub-agents live in the task (delegated-round-task-rotation.ts).
      // Telling the judge it remembers something it cannot remember is how a
      // model ends up filling the gap with an invention. The earlier rounds are
      // on disk, which is better evidence than a task's memory anyway.
      ? `这是第 ${roundNo} 轮，前面已经跑过 ${roundNo - 1} 轮。你是本轮新起的会话，`
        + "**不要凭记忆推断前几轮发生过什么** —— 前几轮的红蓝产出和裁决都在 "
        + `\`.ship/changes/${input.changeId}/rounds/${descriptor.phase.toLowerCase()}/\` 下的 `
        + "`round-01`…`round-%s` 里，需要就去读。本轮要针对仍未关闭的 gap 继续。"
          .replace("%s", String(roundNo - 1).padStart(2, "0"))
      : "这是本阶段的第一轮。",
  ].join("\n");
}
