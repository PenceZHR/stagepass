/**
 * `-s` 这个轴到底管不管「无人值守跑 turn」。
 *
 *   pnpm probe:sandbox
 *
 * ## 为什么要有这个探针
 *
 * 交接 2026-07-29 §4.2 的结论是「两档各有一种停，没有第三档，无人值守跑 turn
 * 在当前权限模型下没有解」。但那一轮**只变了 `-a`**，`-s` 从头到尾钉死在
 * `read-only`（`scripts/panel.ts` 至今如此）。而在 read-only 下，模型想写文件就
 * **必然**要升级审批 —— 那次 turn 停 20 分钟是 `-s` 逼出来的，不是 `-a` 的锅。
 *
 * 没试过的组合是 `-s workspace-write` + `-a on-request`：工作区内的写入由沙箱
 * 直接放行，同时 `-a` 不是 `never`，所以 elicitation 通道还活着（§4.1）。
 *
 * ## 判据是文件系统，不是屏幕
 *
 * turn 的任务就是写一个文件，而 **turn 跑起来之后一个键都不按** —— 不按键才叫
 * 无人值守。所以判据只有一条：那个文件到底出没出现。
 *
 * 屏幕文字只作旁证，用来看它停在哪一步。TUI 的文字不能用普通正则匹配（它用光标
 * 移动而不是空格排版），所以比对一律走 `squash`，理由见 §4.4。
 *
 * ## 信任提示：按一次，而且只按一次
 *
 * Codex 第一次进一个目录会问「要不要信任这个文件夹」。**那是目录级的一次性开关，
 * 不是 turn 的一部分** —— 生产环境里它早就答过了（`~/.codex/config.toml` 里
 * `/Users/zhanghr/Desktop/stagepass` 就在 trust 列表中，而 `panel.ts` 用的正是
 * 仓库自己的 cwd）。所以这里按一次 Enter 放行，然后 turn 全程零按键。
 *
 * 试过但**行不通**的两条路，别再试：
 *
 * 1. `-c projects."<dir>".trust_level="trusted"` —— 不生效。
 * 2. 把工作区建在已 trust 的目录底下 —— **trust 不从父目录继承**，实测只认精确
 *    路径。
 *
 * 第一版探针栽在这上面：两档都只跑出 1463 字节就停在信任提示上，turn 根本没开始，
 * 却打印出了一个像模像样的「两档都停」的结论。所以下面留着一条硬检查：**turn 开始
 * 之后再出现信任提示，就当场判这次运行无效**，不许它安静地等满时限再去猜。
 * 沉默不是成功。
 *
 * 副作用：Codex 会把这个临时目录写进 `~/.codex/config.toml` 的 trust 列表。
 * 两档共用一个目录，所以只会多一条。
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as ptySpawn } from "node-pty";

const SANDBOXES = ["read-only", "workspace-write"] as const;
type Sandbox = (typeof SANDBOXES)[number];

const MARKER = "probe.txt";
const DEADLINE_MS = 150_000;
const KEY_ENTER = "\r";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 剥掉 TUI 混在文字里的转义序列。
 *
 * 两个各花掉一轮的坑：CSI 模式必须允许中间字节（Codex 会发 `ESC [ 0 SP q`，
 * 最后那个 `q` 前面有个空格，`[0-9;?]*[a-zA-Z]` 会漏掉它）；剥完还不够，TUI 用
 * 光标移动而不是空格排版，所以要连空白一起去掉再比对。
 */
const clean = (text: string): string => text
  .replace(/\x1b\][^\x07]*\x07/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[()][AB012]/g, "")
  .replace(/\x1b[=>]/g, "");

const squash = (text: string): string => clean(text).replace(/\s+/g, "");

/**
 * 屏幕上出现这些就说明它在等人。只是旁证，判据仍然是文件在不在。
 *
 * **宁可宽也别窄。** 第一版只列了 edits 那一支（`Would you like to make the
 * following edits?`），而 read-only 实际弹的是命令那一支（`Would you like to run
 * the following command?`）—— 于是探针把一次「明明白白停在审批上」报成了
 * 「原因未知」。词表漏一个，读的人就会以为这里发生了什么没人懂的事。
 */
const HALTED_ON = [
  "Wouldyouliketo",          // run the following command? / make the following edits?
  "Presentertoconfirm",
  "Allowcommand",
  "requiresapproval",
  "Doyouwanttoallow",
];

const TRUST_PROMPT = "Doyoutrustthecontentsofthisdirectory";

class ProbeVoid extends Error {}

interface Outcome {
  readonly wrote: boolean;
  readonly seconds: string;
  readonly haltedAt: string | null;
  readonly transcript: string;
}

async function run(workspace: string, sandbox: Sandbox): Promise<Outcome> {
  const target = join(workspace, MARKER);
  rmSync(target, { force: true });

  console.log(`\n=== -s ${sandbox} -a on-request ===`);

  const term = ptySpawn("codex", [
    "-c", `model_reasoning_effort="low"`,
    "-C", workspace,
    "-s", sandbox,
    // never 会让 Codex 自动 decline 掉 elicitation（§4.1），所以这里不用它，
    // 也用不了 —— 那正是要保住的通道。
    "-a", "on-request",
    `把 ok 这两个字写进当前目录下的 ${MARKER}，写完就停下，不要解释。`,
  ], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: workspace,
    env: Object.fromEntries(
      Object.entries({ ...process.env, LANG: "en_US.UTF-8" })
        .filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  term.onData((data) => { chunks.push(Buffer.from(data, "utf-8")); });
  const screen = () => squash(Buffer.concat(chunks).toString("utf-8"));
  const transcript = join(workspace, `pty-${sandbox}.txt`);
  const dump = () => {
    writeFileSync(transcript, Buffer.concat(chunks).toString("utf-8"), "utf-8");
  };

  const started = Date.now();
  let wrote = false;
  let haltedAt: string | null = null;
  // 一次性开关。累积缓冲区 + TUI 重绘会让「还匹配得上」的检查一直复发，那样多按
  // 的 Enter 会把后面真正的选择器一并关掉 —— 看起来就和 Codex 拒绝了一模一样。
  let trusted = false;

  while (Date.now() - started < DEADLINE_MS) {
    if (existsSync(target)) { wrote = true; break; }

    const tail = screen().slice(-6_000);

    if (tail.includes(TRUST_PROMPT)) {
      if (trusted) {
        term.kill();
        dump();
        throw new ProbeVoid(
          "turn 开始之后又冒出信任提示 —— 这次运行不算数。\n"
          + `  transcript ${transcript}`);
      }
      trusted = true;
      console.log("· 信任提示 -> Enter（只按这一次，之后 turn 全程零按键）");
      term.write(KEY_ENTER);
      await sleep(2_500);
      continue;
    }

    if (!haltedAt) {
      const hit = HALTED_ON.find((phrase) => tail.includes(phrase));
      if (hit) {
        haltedAt = hit;
        console.log(`· 屏幕上出现了审批提示：${hit}`);
      }
    }
    await sleep(500);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  dump();
  term.kill();

  console.log(`· ${MARKER} ${wrote ? `出现了（${seconds}s）` : `没有出现（等满 ${seconds}s）`}`);
  if (wrote) console.log(`· 内容 ${JSON.stringify(readFileSync(target, "utf-8").trim())}`);
  if (!wrote && !haltedAt) console.log("· 也没匹配到已知的审批提示 —— 看 transcript，别猜");
  console.log(`· transcript ${transcript}`);

  return { wrote, seconds, haltedAt, transcript };
}

async function main(): Promise<void> {
  const only = process.argv[2] as Sandbox | undefined;
  if (only && !SANDBOXES.includes(only)) {
    console.error(`未知的 -s 取值：${only}（可选 ${SANDBOXES.join(" / ")}）`);
    process.exitCode = 1;
    return;
  }
  const list = only ? [only] : SANDBOXES;

  // 两档共用一个工作区：信任只需答一次，config.toml 里也只多一条。
  // realpath 是必须的 —— macOS 上 /var 是 /private/var 的软链，两个字符串指同一个
  // 目录，而 Codex 按真实路径记 trust。
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "stagepass-sandbox-")));
  console.log("turn 跑起来之后一个键都不按。判据是文件出没出现。");
  console.log(`工作区 ${workspace}`);

  const results = new Map<Sandbox, Outcome>();
  for (const sandbox of list) {
    try {
      results.set(sandbox, await run(workspace, sandbox));
    } catch (error: unknown) {
      if (!(error instanceof ProbeVoid)) throw error;
      // 无效运行不许退化成一条结论 —— 第一版就是这么给出错误答案的。
      console.error(`\n!! 这次运行无效，不产出结论\n${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("\n--- 结论 ---");
  for (const [sandbox, outcome] of results) {
    console.log(`-s ${sandbox.padEnd(16)} ${outcome.wrote
      ? `写成了，没停（${outcome.seconds}s）`
      : `没写成${outcome.haltedAt ? `，停在 ${outcome.haltedAt}` : "，原因未知"}`}`);
  }

  const readOnly = results.get("read-only")?.wrote;
  const workspaceWrite = results.get("workspace-write")?.wrote;
  if (readOnly !== undefined && workspaceWrite !== undefined) {
    console.log(workspaceWrite && !readOnly
      ? "\n=> `-s` 就是那第三档。交接 §4.2「没有解」的结论要改。"
      : workspaceWrite && readOnly
        ? "\n=> 两档都写成了 —— 那 20 分钟的停顿另有原因，回去看 transcript。"
        : "\n=> workspace-write 也停。§4.2 的结论成立，理由要补上 -s 这一轴。");
  }
  console.log(`\n工作区留着没删，transcript 在里面：${workspace}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
