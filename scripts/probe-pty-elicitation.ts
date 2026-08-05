/**
 * The road-B prerequisite probe: does the elicitation selector work inside a pty?
 *
 *   pnpm probe:pty
 *
 * This is the one thing the terminal panel cannot be built without. If the
 * selector does not render, or the arrow keys do not move it, or Enter does not
 * confirm, then the panel is the wrong shape and no amount of front-end work
 * fixes it. So it is answered before anything is built, and answered
 * mechanically rather than by eye.
 *
 * ## Why the second option, not the first
 *
 * The probe presses Down once and then Enter. A selector that never rendered,
 * or arrow keys that went nowhere, would still let Enter confirm the default --
 * and the default is the FIRST enum value. Landing on the SECOND value is
 * therefore a single observation that proves all three things at once:
 * something rendered, the arrow key moved it, and Enter committed it.
 *
 * ## Why it may read the bytes
 *
 * PRD §9.3 forbids StagePass from interpreting pty output. That rule is about
 * `src/` -- the production path that merely forwards bytes to a browser. This
 * file is a verification script whose entire job is to look at what Codex drew,
 * which is the opposite job, and it ships no behaviour into the product.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { spawn as ptySpawn } from "node-pty";

import { SCHEMA_SQL } from "../src/db/schema";
import { gateDecisionQuestion } from "../src/domain/question";
import { ChangeStore } from "../src/store/change-store";
import { CommandStore } from "../src/store/command-store";
import { EvidenceStore } from "../src/store/evidence-store";
import { QuestionStore } from "../src/store/question-store";

const CHANGE = "CHG-PROBE";
const QUESTION = "Q-PROBE";
const REPO = process.cwd();

/**
 * Which approval policy to run under.
 *
 *   pnpm probe:pty            -- never (what PRD §6.6 prescribes)
 *   pnpm probe:pty on-request
 *
 * Parameterised because `never` reads as "Never ask for user approval", and an
 * elicitation IS asking the user. If Codex applies the flag to elicitations too,
 * the policy StagePass prescribes would silently disable the only way it has of
 * reaching a human -- so the two must be compared, not assumed.
 */
const APPROVAL = process.argv[2] ?? "never";

const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";

interface JsonRpc {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seed(database: Database.Database): void {
  const changes = new ChangeStore(database);
  changes.create(CHANGE);
  changes.apply(CHANGE, "start");
  changes.apply(CHANGE, "settle");
  new EvidenceStore(database).put(CHANGE, "PRD", {
    artifactIds: ["prd.md"],
    blockers: [{ id: "B-1", kind: "finding", severity: "P1", title: "验收标准还不可测", where: null, why: null }],
    waivedBlockerIds: ["B-1"],
  });
}

/** Wait until `test` passes, or give up. Returns whether it passed. */
async function until(
  test: () => boolean, timeoutMs: number, label: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await sleep(250);
  }
  console.log(`   timed out waiting for ${label} (${timeoutMs / 1000}s)`);
  return false;
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "stagepass-probe-"));
  const dbPath = join(directory, "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);

  seed(database);
  const questions = new QuestionStore(database);
  const gate = new CommandStore(database).gateFor(CHANGE);
  const question = gateDecisionQuestion({
    phase: "PRD", gate, summary: "第 1 轮已结算，1 项 P1 已被接受",
  });
  if (!question) throw new Error("the gate offers no decision to ask about");
  questions.ask({
    id: QUESTION, changeId: CHANGE, phase: "PRD", kind: "gate_decision",
    question, expectedSnapshot: gate.snapshot,
  });

  const options = question.requestedSchema.properties.decision?.enum ?? [];
  const [first, second] = options;
  if (!first || !second) throw new Error("need at least two options to prove Down moved");

  console.log("approval   ", `-a ${APPROVAL}`);
  console.log("database   ", dbPath);
  console.log("asking     ", question.message);
  console.log("options    ", options.join(" / "));
  console.log(`expecting  "${second}" -- the SECOND option, reached by one Down\n`);

  // The server is named because the old tree left a `stagepass-card` plugin
  // registered and enabled, whose skill teaches the model to call
  // `present_stagepass_decision` -- the dead card path. Measured 2026-07-29:
  // it hijacked the call and returned gate_decision_card_unavailable_500.
  const prompt = [
    `调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次，questionId 用 "${QUESTION}"。`,
    "不要用 stagepass-card 或任何别的服务器，只用名为 stagepass 的那个。",
    "这个工具会把 StagePass 的问题交给我来选。",
    "不要替我做决定，不要解释我该选什么，调用完就停下。",
  ].join("\n");

  // Every JSON-RPC frame is written here. A TUI redraw stream cannot tell us
  // whether the selector was offered -- the protocol underneath can.
  const tapPath = join(directory, "frames.jsonl");
  const tap = (): Array<{ direction: string; line: string }> => {
    if (!existsSync(tapPath)) return [];
    return readFileSync(tapPath, "utf-8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { direction: string; line: string });
  };
  const frames = (direction: string, test: (parsed: JsonRpc) => boolean) =>
    tap().filter((entry) => entry.direction === direction)
      .map((entry) => { try { return JSON.parse(entry.line) as JsonRpc; } catch { return null; } })
      .filter((parsed): parsed is JsonRpc => parsed !== null && test(parsed));

  // argv goes straight to the binary -- no shell, so no quoting and no mojibake.
  const term = ptySpawn("codex", [
    "-c", `mcp_servers.stagepass.command="npx"`,
    "-c", `mcp_servers.stagepass.args=["tsx","${REPO}/scripts/probe-plugin-tap.ts"]`,
    "-c", `mcp_servers.stagepass.env={STAGEPASS_DB="${dbPath}",STAGEPASS_TAP="${tapPath}"}`,
    "-c", `model_reasoning_effort="low"`,
    // Per-invocation only. The user's config.toml is not touched: turning this
    // off for real is their decision, not the probe's.
    "-c", `plugins."stagepass-card@personal".enabled=false`,
    "-s", "read-only",
    "-a", APPROVAL,
    prompt,
  ], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: "/tmp",
    env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  let alive = true;
  term.onData((data) => { chunks.push(Buffer.from(data, "utf-8")); });
  term.onExit(({ exitCode }) => {
    alive = false;
    console.log(`\n(pty exited, code ${exitCode})`);
  });
  const seen = () => Buffer.concat(chunks).toString("utf-8");

  // Reactive, not phase-timed. The model's pace varies by minutes between runs,
  // so a probe built out of fixed waits presses keys into the wrong prompt and
  // then reports a failure it caused itself. This watches and responds instead.
  const askedAt = () =>
    frames("plugin->client", (m) => m.method === "elicitation/create").length > 0;
  const repliedWith = () =>
    frames("client->plugin", (m) => m.method === undefined && m.result !== undefined)[0]
      ?.result as { action?: string } | undefined;

  let approvals = 0;
  let asked = false;
  let rendered = false;
  let keysSent = false;
  let screenAtAsk = 0;

  console.log("watching (up to 12 min) -- approving tool prompts, then answering the selector\n");
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const screen = seen();

    // §五.9: a blocking update prompt would sit in front of the turn.
    if (/Update available|Press enter to continue/i.test(screen.slice(-4_000))) {
      console.log("  · update prompt -> Skip");
      term.write("2"); await sleep(400); term.write(KEY_ENTER); await sleep(1_500);
      continue;
    }

    // Codex's own gate, separate from `-a never`: may this server run this tool?
    // It eats whatever key comes next, so it must be answered before ours.
    if (!keysSent && /Allow the .* MCP server to run tool/i.test(screen.slice(-6_000))
      && approvals < 3) {
      approvals += 1;
      console.log(`  · tool-approval prompt -> Enter ("1. Allow", nothing persisted)`);
      term.write(KEY_ENTER);
      await sleep(3_000);
      continue;
    }

    if (!asked && askedAt()) {
      asked = true;
      screenAtAsk = screen.length;
      console.log("  · plugin sent elicitation/create");
    }

    if (asked && !keysSent) {
      // Only look at what was drawn AFTER the ask, so the approval prompt's own
      // text cannot be mistaken for our selector.
      const since = seen().slice(screenAtAsk);
      if (options.every((option) => since.includes(option))) {
        rendered = true;
        console.log("  · selector is on screen -> Down, Enter");
        term.write(KEY_DOWN); await sleep(1_200); term.write(KEY_ENTER);
        keysSent = true;
      }
    }

    if (repliedWith()) {
      console.log(`  · client replied to elicitation: ${JSON.stringify(repliedWith())}`);
      break;
    }
    await sleep(500);
  }

  if (!asked) console.log("  · never saw an elicitation/create -- the tool was not called");
  else if (!rendered) console.log("  · elicitation was sent but no selector text ever appeared");

  const answered = await until(
    () => questions.readAnswerFor(QUESTION) !== null, 30_000, "an answer row",
  );

  const capabilities = frames("client->plugin", (m) => m.method === "initialize")[0];
  const elicitReply = frames("client->plugin",
    (m) => m.method === undefined && m.result !== undefined)[0];
  console.log("\n--- protocol evidence ---");
  console.log("client capabilities ", JSON.stringify(
    (capabilities?.params as { capabilities?: unknown } | undefined)?.capabilities));
  console.log("elicitation reply   ", JSON.stringify(elicitReply?.result));

  const answer = questions.readAnswerFor(QUESTION);
  const chosen = answer?.content?.decision;

  console.log("\n--- verdict ---");
  console.log(`selector rendered in pty      ${rendered ? "PASS" : "FAIL"}`);
  console.log(`answer came back              ${answered ? "PASS" : "FAIL"}`);
  console.log(`arrow key + enter selected    ${chosen === second
    ? `PASS (got "${chosen}", the second option)`
    : `FAIL (got ${JSON.stringify(chosen)}, wanted "${second}")`}`);
  console.log("\nraw answer   ", JSON.stringify(answer));

  if (answered) {
    console.log("outcome      ", JSON.stringify(questions.apply(QUESTION)));
    console.log("change       ", new ChangeStore(database).read(CHANGE).state);
  }

  const transcript = join(directory, "pty-output.txt");
  writeFileSync(transcript, seen(), "utf-8");
  console.log("\npty transcript", transcript, `(${Buffer.concat(chunks).length} bytes)`);

  if (alive) term.kill();
  database.close();

  const pass = rendered && answered && chosen === second;
  console.log(`\n${pass ? "PROBE PASSED -- the panel is buildable" : "PROBE FAILED -- do not build the panel yet"}`);
  if (!pass) process.exitCode = 1;
  else rmSync(directory, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
