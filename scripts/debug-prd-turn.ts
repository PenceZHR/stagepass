/**
 * Runs a PRD turn with the whole error chain printed.
 *
 * The route reports only the outermost message, and this pipeline wraps a
 * failure at least twice -- once by the run bookkeeping and once by the route --
 * so the surfaced text has repeatedly named the last thing that went wrong
 * while hiding the first.
 */
import { prdTurn } from "../server/services/prd-service.ts";

const projectId = process.argv[2] ?? "PRJ-001";
const message = process.argv[3]
  ?? "StagePass 是一个本地的变更流水线控制台。请开始 PRD。";

function dump(error: unknown, depth = 0): void {
  const pad = "  ".repeat(depth);
  const e = error as Error & { code?: string; cause?: unknown };
  console.error(`${pad}name : ${e?.name}`);
  console.error(`${pad}code : ${e?.code}`);
  console.error(`${pad}msg  : ${String(e?.message).slice(0, 400)}`);
  if (depth === 0 && e?.stack) {
    console.error(e.stack.split("\n").slice(1, 9).map((l) => `${pad}${l}`).join("\n"));
  }
  if (e?.cause) {
    console.error(`${pad}cause:`);
    dump(e.cause, depth + 1);
  }
}

async function main() {
  try {
    const result = await prdTurn(projectId, message);
    console.log("PRD TURN OK:", JSON.stringify(result, null, 2).slice(0, 800));
  } catch (error) {
    console.error("PRD TURN FAILED");
    dump(error);
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("unexpected:", error);
  process.exit(1);
});
