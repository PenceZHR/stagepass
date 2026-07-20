import {
  CRASH_ACCEPTANCE_CASES,
  runCrashAcceptance,
  type CrashAcceptanceCase,
} from "../server/services/crash-resilience-harness";

interface Args {
  caseName: CrashAcceptanceCase;
  changeId?: string;
  runId?: string;
  execute: boolean;
}

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseCrashAcceptanceArgs(argv: string[]): Args {
  const caseName = value(argv, "--case") as CrashAcceptanceCase | undefined;
  if (!caseName || !CRASH_ACCEPTANCE_CASES.includes(caseName)) {
    throw new Error(`--case must be one of: ${CRASH_ACCEPTANCE_CASES.join(", ")}`);
  }
  const changeId = value(argv, "--change");
  const runId = value(argv, "--run");
  const execute = argv.includes("--execute");
  if (caseName === "kill-provider" && (!changeId || !runId)) {
    throw new Error("kill-provider requires --change <id> and --run <id>");
  }
  if (caseName === "restart-recovery" && !execute) {
    throw new Error("restart-recovery requires --execute because it mutates the temporary recovery matrix");
  }
  return { caseName, changeId, runId, execute };
}

async function main(): Promise<void> {
  const args = parseCrashAcceptanceArgs(process.argv.slice(2));
  const result = await runCrashAcceptance(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
