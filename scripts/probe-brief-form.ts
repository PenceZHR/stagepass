/**
 * 验一件事：**新形状的录需求表单，全程只按回车交不交得上去。**
 *
 *   npx tsx scripts/probe-brief-form.ts
 *
 * 用户 2026-07-31 否掉了「最后一格必填」（「我明明已选了，但它还是让我输入一些
 * 我自己的话」）。改成：自由文本全部可留空 + 压轴一格**只有一个选项**的提交格。
 * 这形状建立在两个没实测过的假设上：
 *
 *   1. 单选项的 enum 在选择器里正常渲染、回车选得中；
 *   2. 空的 optional 文本格，回车能**走过去**（此前只实测过它在**最后一格**会吃掉
 *      提交，没实测过它在中间挡不挡路）。
 *
 * 任何一条不成立，用户下一次录需求就会再撞一次同一张表 —— 所以先在这里撞。
 *
 * 结构照抄 probe-pty-elicitation.ts（那两条坑就是它量出来的）：一次性库、真 codex
 * TUI 在 pty 里、协议帧从 tap 里读。全程不碰用户真库、不碰他的 config.toml。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { spawn as ptySpawn } from "node-pty";

import { SCHEMA_SQL } from "../src/db/schema";
import { readBriefProposal, briefFrom, CONFIRM_ID, CONFIRM_OPTION } from "../src/domain/brief";
import { clarificationQuestion } from "../src/domain/question";
import { ChangeStore } from "../src/store/change-store";
import { QuestionStore } from "../src/store/question-store";

const CHANGE = "CHG-PROBE";
const QUESTION = "Q-PROBE-BRIEF";
const REPO = process.cwd();
const KEY_ENTER = "\r";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface JsonRpc {
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "stagepass-probe-brief-"));
  const dbPath = join(directory, "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create(CHANGE);

  // 两题就够：形状里每种字段都出现了（enum、optional 文本、BY、BZ）。
  const items = readBriefProposal([
    "```brief",
    "给谁用？ | 只给我自己 | 团队里的人 | 外部用户",
    "放在哪个页面？ | 首页 | 设置页 | 新开一页",
    "```",
  ].join("\n"));
  const question = clarificationQuestion({ title: "录需求（探针）", items })!;
  const questions = new QuestionStore(database);
  questions.ask({
    id: QUESTION, changeId: CHANGE, phase: "PRD", kind: "clarification",
    question, expectedSnapshot: "probe",
  });

  const fieldIds = Object.keys(question.requestedSchema.properties).sort();
  /** 每格按什么键：enum 格回车选默认项，文本格 ctrl+n 跳过。 */
  const keyPlan: [key: string, label: string][] = fieldIds.map((id) => {
    const field = question.requestedSchema.properties[id]!;
    return field.enum !== undefined
      ? ["\r", `Enter(${id})`]
      : ["\x0e", `ctrl+n(${id})`];
  });
  console.log("fields     ", fieldIds.join(" "));
  console.log("required   ", question.requestedSchema.required.join(" "));
  console.log("expecting  全程只按回车：每格要么选默认项、要么空着走过去，最后在提交格交上\n");

  const tapPath = join(directory, "frames.jsonl");
  const frames = (direction: string, test: (parsed: JsonRpc) => boolean) => {
    if (!existsSync(tapPath)) return [];
    return readFileSync(tapPath, "utf-8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { direction: string; line: string })
      .filter((entry) => entry.direction === direction)
      .map((entry) => { try { return JSON.parse(entry.line) as JsonRpc; } catch { return null; } })
      .filter((parsed): parsed is JsonRpc => parsed !== null && test(parsed));
  };

  const prompt = [
    `调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次，questionId 用 "${QUESTION}"。`,
    "不要用别的服务器，只用名为 stagepass 的那个。",
    "这个工具会把 StagePass 的问题交给我来答。不要替我做决定，调用完就停下。",
  ].join("\n");

  const term = ptySpawn("codex", [
    "-c", `mcp_servers.stagepass.command="npx"`,
    "-c", `mcp_servers.stagepass.args=["tsx","${REPO}/scripts/probe-plugin-tap.ts"]`,
    "-c", `mcp_servers.stagepass.env={STAGEPASS_DB="${dbPath}",STAGEPASS_TAP="${tapPath}"}`,
    "-c", `model_reasoning_effort="low"`,
    "-c", `plugins."stagepass-card@personal".enabled=false`,
    "-s", "read-only",
    // **不是 never。** `-a never` 会让客户端对任何 elicitation 自动回 decline
    // （invocation.ts 把它排除在类型外就是为这个）—— 这个探针第二版就栽在这上面：
    // elicitation 发出去了、表单没画、立刻 decline。用生产同款 on-request。
    "-a", "on-request",
    prompt,
  ], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: "/tmp",
    env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  let alive = true;
  term.onData((data) => { chunks.push(Buffer.from(data, "utf-8")); });
  term.onExit(({ exitCode }) => { alive = false; console.log(`\n(pty exited, code ${exitCode})`); });
  const seen = () => Buffer.concat(chunks).toString("utf-8");
  /*
   * **匹配前先拍平。** 0.146 的 TUI 用光标定位画字 —— 单词之间没有真实的空格字节，
   * 屏幕流里是 `AllowthestagepassMCPservertoruntool` 夹着转义序列。带空格的正则
   * 永远匹配不上（这个探针第一版就栽在这上面：批准没按下去，干等了 12 分钟）。
   * 所以：剥掉转义序列、剥掉所有空白，再用**无空格**的针去找。
   */
  const flat = (raw: string) => raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\s+/g, "");

  const askedAt = () =>
    frames("plugin->client", (m) => m.method === "elicitation/create").length > 0;
  const replied = () =>
    frames("client->plugin", (m) => m.method === undefined && m.result !== undefined)[0]
      ?.result as { action?: string; content?: Record<string, unknown> } | undefined;

  let approvals = 0;
  let freshFrom = 0;
  let asked = false;
  let rendered = false;
  let entersSent = 0;
  let lastKeyAt = 0;

  console.log("watching (up to 12 min)\n");
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const screen = seen();

    if (/Updateavailable|Pressentertocontinue/i.test(flat(screen.slice(-4_000)))) {
      console.log("  · update prompt -> Skip");
      term.write("2"); await sleep(400); term.write(KEY_ENTER); await sleep(1_500);
      continue;
    }
    if (entersSent === 0
      && /Allowthe.{0,40}MCPservertoruntool/i.test(flat(screen.slice(freshFrom)))
      && approvals < 3) {
      approvals += 1;
      // **只看这之后新画的字节。** 批准提示的残影留在滚回缓冲里，上一版对着
      // 最后 8000 字节匹配，把同一个提示按了三次 —— 多出来的回车全落进了表单。
      freshFrom = screen.length;
      console.log("  · tool-approval -> Enter");
      term.write(KEY_ENTER); await sleep(3_000);
      continue;
    }

    if (!asked && askedAt()) {
      asked = true;
      console.log("  · plugin sent elicitation/create -> 3 秒后开始走键");
      /*
       * **不再等屏幕上的针。** TUI 重画时 spinner 字符会插进文字中间
       * （`只给[0q◦我自己` 这种），任何针都可能永远匹配不上 —— 上一版就是这么
       * 干等了 12 分钟。elicitation/create 这个协议帧才是「表单要出现了」的
       * 可靠信号；帧到了、留 3 秒渲染，直接按配方走。
       */
      await sleep(3_000);
      rendered = true;
      lastKeyAt = 0;
    }

    /*
     * **按 2026-07-30 量出来的配方走**（codex-elicitation-form-traps）：
     * 选项格回车（提交本格并前进）；空文本格 ctrl+n 跳过 —— 回车会被它吃掉；
     * 最后一格（提交格，enum）回车提交全表。
     */
    if (rendered && entersSent < keyPlan.length && !replied()) {
      if (Date.now() - lastKeyAt > 1_200) {
        const [key, label] = keyPlan[entersSent]!;
        term.write(key);
        entersSent += 1;
        lastKeyAt = Date.now();
        console.log(`  · ${label} ${entersSent}/${keyPlan.length}`);
      }
    }

    if (replied()) {
      console.log(`  · 客户端答复：${JSON.stringify(replied()).slice(0, 200)}`);
      break;
    }
    await sleep(400);
  }

  const answer = questions.readAnswerFor(QUESTION);
  const content = answer?.content ?? {};
  const brief = answer === null ? null : briefFrom(items, answer);

  console.log("\n--- verdict ---");
  console.log(`表单渲染出来了            ${rendered ? "PASS" : "FAIL"}`);
  console.log(`只按回车交上去了          ${answer !== null ? "PASS" : "FAIL"}`);
  console.log(`提交格带着它唯一的选项    ${content[CONFIRM_ID] === CONFIRM_OPTION
    ? "PASS" : `FAIL（${JSON.stringify(content[CONFIRM_ID])}）`}`);
  console.log(`答案能成一份需求          ${brief !== null ? "PASS" : "FAIL"}`);
  console.log("\nraw answer ", JSON.stringify(answer));
  console.log("brief      ", JSON.stringify(brief));

  const transcript = join(directory, "pty-output.txt");
  writeFileSync(transcript, seen(), "utf-8");
  console.log("\npty transcript", transcript);

  if (alive) term.kill();
  database.close();

  const pass = rendered && answer !== null
    && content[CONFIRM_ID] === CONFIRM_OPTION && brief !== null;
  console.log(`\n${pass
    ? "PROBE PASSED -- 全程只按回车，表交上去了"
    : "PROBE FAILED -- 新表单形状有问题，别让用户去撞"}`);
  if (!pass) process.exitCode = 1;
  else rmSync(directory, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
