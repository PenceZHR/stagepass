/**
 * Read one adversarial round the way StagePass will: from each role's own file.
 *
 *   pnpm verify:round <judge-thread-id>
 *
 * The judge is not asked what red and blue said. Their session files are read
 * directly, which is the difference between an adversarial round and a summary
 * of one -- a judge that relayed blue could soften it.
 *
 * Given a thread that ran a real round, this prints what each role actually
 * produced and what the round would do to the phase's gaps. It touches no
 * StagePass database: it reads, it reports, it changes nothing.
 */
import { BLUE, RED, readRound } from "../src/domain/round";
import { applyRound, blockersFrom } from "../src/domain/gap";
import { createSubAgentLookup, readRoleTranscript } from "../src/codex/subagent";

const judgeThreadId = process.argv[2];

function main(): void {
  if (!judgeThreadId) {
    console.error("usage: pnpm verify:round <judge-thread-id>");
    process.exit(1);
  }
  const lookup = createSubAgentLookup();
  const children = lookup.children(judgeThreadId);
  console.log("judge     ", judgeThreadId);
  console.log("spawned   ", children.map((child) => child.agentPath).join(", ") || "(nothing)");
  if (children.length === 0) {
    console.error("\nThat thread spawned no sub-agents; there is no round here to read.");
    process.exit(1);
  }

  const transcript = {
    round: 1,
    red: readRoleTranscript({ lookup, parentThreadId: judgeThreadId, agentPath: RED }),
    blue: readRoleTranscript({ lookup, parentThreadId: judgeThreadId, agentPath: BLUE }),
    judge: "",
  };
  console.log("\n--- 红方，它自己说的 ---\n" + transcript.red.slice(0, 400));
  console.log("\n--- 蓝方，它自己说的（没有经过裁判转述）---\n" + transcript.blue.slice(0, 400));

  // Only meaningful when both answered in the result contract; a round whose
  // roles replied in prose fails here, which is the correct outcome.
  const reading = readRound(transcript);
  const gaps = applyRound([], reading.outcome);
  console.log("\n--- 这一轮对 gap 的影响 ---");
  console.log("artifacts ", reading.artifactIds.join(", ") || "(none)");
  console.log("blockers  ", blockersFrom(gaps).map((gap) => `${gap.id}[${gap.severity}]`).join(" ") || "(none)");
}

try {
  main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
