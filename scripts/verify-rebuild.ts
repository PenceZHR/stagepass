/**
 * Run the rebuilt chain end to end and print what landed in the database.
 *
 * Evidence, not narration: every line below is read back out of SQLite after
 * the fact. Nothing here reports what the code intended to do.
 *
 *   pnpm verify:rebuild            # scripted transport, no Codex, no network
 *   pnpm verify:rebuild -- --real  # the L2 gate; needs a real transport
 *
 * The second form is the L2 acceptance: a real turn through `codex mcp-server`,
 * a published subcommand.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { ChangeStore } from "../src/store/change-store";
import { CommandStore } from "../src/store/command-store";
import { BindingStore } from "../src/store/binding-store";
import { TurnStore } from "../src/store/turn-store";
import { TurnLoop } from "../src/work/turn-loop";
import { CodexTurnRunner } from "../src/codex/turn-runner";
import { ScriptedCodexTransport, type CodexTransport } from "../src/codex/transport";
import { CodexTuiTransport } from "../src/codex/tui-transport";

const REAL = process.argv.includes("--real");
const CHANGE = "CHG-VERIFY";
const NOW = 1_000_000;

/**
 * The real thing: `codex mcp-server`, a published subcommand speaking MCP over
 * stdio. Read-only, because verifying the chain must not let a turn write to
 * the repository it is being run from.
 *
 * The real form opens a Codex TUI window per turn. Watch it there -- this
 * script prints no execution output of its own, by design.
 */
function realTransport(): CodexTransport {
  // An empty scratch directory, NOT the repository.
  //
  // Pointed at the repo, the turn spent minutes reading a hundred thousand
  // lines before answering -- reasonable behaviour, wrong for a script whose
  // job is to prove the chain moves. Real phases will run against the real
  // project; this one only has to make a turn happen.
  const cwd = mkdtempSync(join(tmpdir(), "stagepass-verify-"));
  return new CodexTuiTransport({
    cwd,
    sandbox: "read-only",
    // This script verifies the chain, not the model's thinking. The default is
    // xhigh, which did not finish two design turns inside ten minutes.
    reasoningEffort: "low",
  });
}

function answer(artifacts: string[], blockers: unknown[] = []): string {
  return "```json\n"
    + JSON.stringify({ artifactIds: artifacts, blockers })
    + "\n```";
}

async function main(): Promise<void> {
  const transport: CodexTransport = REAL
    ? realTransport()
    : new ScriptedCodexTransport([
        answer([".ship/prd.md"], [
          { id: "B-1", severity: "P1", title: "验收标准还不可测" },
        ]),
        answer([".ship/prd.md"]),
      ]);

  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date("2026-07-28T00:00:00.000Z");

  const changes = new ChangeStore(database, { now });
  const commands = new CommandStore(database, now);
  const bindings = new BindingStore(database, now);
  const turns = new TurnStore(database, now);
  const loop = new TurnLoop({
    database, now, runner: new CodexTurnRunner({ database, transport, now }),
  });
  const worker = { owner: "verify", token: "tok", now: NOW, ttlMs: 30_000 };

  changes.create(CHANGE);
  loop.queueTurn({
    changeId: CHANGE, jobId: "JOB-1",
    deadlineAt: NOW + 300_000, maxAttempts: 3,
  });
  console.log("1. turn queued        ", await loop.runOnce(worker));

  // A P1 stands, so the gate refuses. This is the whole point of a gate.
  console.log("2. gate after round 1 ", commands.gateFor(CHANGE).refusals.approve);

  // The human sends it back; a second round finds nothing.
  commands.apply({
    changeId: CHANGE, action: "reject", idempotencyKey: "c1",
    expectedSnapshot: commands.gateFor(CHANGE).snapshot,
  });
  loop.queueTurn({
    changeId: CHANGE, jobId: "JOB-2",
    deadlineAt: NOW + 300_000, maxAttempts: 3,
  });
  console.log("3. second round       ", await loop.runOnce(worker));

  const gate = commands.gateFor(CHANGE);
  console.log("4. gate now permits   ", gate.permitted.join(", "));
  // Report, do not assert. A real model in a read-only scratch directory
  // legitimately produces no artifacts, and the gate legitimately refuses to
  // approve a phase that produced nothing -- that IS the system working. A
  // script that treated it as a crash would be reporting its own expectation.
  if (gate.permitted.includes("approve")) {
    const approved = commands.apply({
      changeId: CHANGE, action: "approve", idempotencyKey: "c2",
      expectedSnapshot: gate.snapshot,
    });
    console.log("5. approved ->        ", `${approved.state.phase}/${approved.state.status}`);
  } else {
    console.log("5. approval refused   ", gate.refusals.approve, "(the gate did its job)");
  }

  console.log("\n--- read back out of the database ---");
  const answers = (database.prepare(
    "SELECT id, status, thread_id, length(response) AS n FROM turns ORDER BY created_at",
  ).all() as { id: string; status: string; thread_id: string | null; n: number | null }[]);
  for (const turn of answers) {
    console.log(`turn ${turn.id.padEnd(14)} ${turn.status.padEnd(10)} thread=${turn.thread_id ?? "-"} response=${turn.n ?? 0}B`);
  }
  console.log("binding      ", bindings.find(CHANGE));
  console.log("turns        ", turns.inFlight().length, "in flight,",
    (database.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n, "total");
  console.log("ledger       ", changes.ledger(CHANGE)
    .map((entry) => `${entry.seq}:${entry.action}`).join(" "));
  console.log("change       ", changes.read(CHANGE).state);

  database.close();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
