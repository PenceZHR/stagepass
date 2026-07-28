/**
 * Run the rebuilt chain end to end and print what landed in the database.
 *
 * Evidence, not narration: every line below is read back out of SQLite after
 * the fact. Nothing here reports what the code intended to do.
 *
 *   pnpm verify:rebuild            # scripted transport, no Codex, no network
 *   pnpm verify:rebuild -- --real  # the L2 gate; needs a real transport
 *
 * The second form is the acceptance the PRD asks for at L2 and it does not
 * exist yet -- there is no transport that talks to Codex. It fails with that
 * sentence rather than pretending, because a verification script that passes
 * without verifying is worse than no script.
 */
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { ChangeStore } from "../src/store/change-store";
import { CommandStore } from "../src/store/command-store";
import { BindingStore } from "../src/store/binding-store";
import { TurnStore } from "../src/store/turn-store";
import { TurnLoop } from "../src/work/turn-loop";
import { CodexTurnRunner } from "../src/codex/turn-runner";
import { ScriptedCodexTransport, type CodexTransport } from "../src/codex/transport";

const REAL = process.argv.includes("--real");
const CHANGE = "CHG-VERIFY";
const NOW = 1_000_000;

function realTransport(): CodexTransport {
  throw new Error(
    "No transport talks to Codex yet. That is exactly the L2 gate:\n"
    + "  docs/PRD-stagepass-rebuild-2026-07-28.md §9.2 -- "
    + "\"start a real turn, get a result, binding and logical turn land in the database\".\n"
    + "Everything around the transport is proved offline; run without --real to see it.",
  );
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
  const approved = commands.apply({
    changeId: CHANGE, action: "approve", idempotencyKey: "c2",
    expectedSnapshot: gate.snapshot,
  });
  console.log("5. approved ->        ", `${approved.state.phase}/${approved.state.status}`);

  console.log("\n--- read back out of the database ---");
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
