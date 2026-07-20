#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import {
  recoverStaleProviderRuns,
  type ProviderRunRecoveryReport,
  type StaleProviderRunRecoveryOptions,
} from "../services/stale-provider-run-recovery-service";

export interface RepairCliArguments {
  mode: "dry-run" | "execute";
  options: StaleProviderRunRecoveryOptions;
}

export function repairCliExitCode(report: ProviderRunRecoveryReport): number {
  if (report.failed.length > 0) return 1;
  if (report.truncated || report.deferred.length > 0) return 2;
  return 0;
}

function nonNegativeNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export function parseRepairCliArguments(argv: string[]): RepairCliArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--change-id",
    "--change",
    "--observed-at",
    "--provider-start-grace-ms",
    "--provider-heartbeat-stale-ms",
    "--legacy-lifecycle-grace-ms",
  ]);
  const flagOptions = new Set(["--execute", "--dry-run", "--all"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flagOptions.has(argument)) {
      if (flags.has(argument)) throw new Error(`duplicate argument: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (values.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  if (flags.has("--execute") && flags.has("--dry-run")) {
    throw new Error("--execute and --dry-run are mutually exclusive");
  }
  const changeId = values.get("--change-id") ?? values.get("--change");
  if (values.has("--change-id") && values.has("--change")) {
    throw new Error("use only one of --change-id or --change");
  }
  if (flags.has("--all") && changeId) {
    throw new Error("--all cannot be combined with --change-id or --change");
  }
  const execute = flags.has("--execute");
  if (execute && !flags.has("--all") && !changeId) {
    throw new Error("global execution requires explicit --all");
  }

  const observedAtRaw = values.get("--observed-at");
  const observedAt = observedAtRaw ? new Date(observedAtRaw) : undefined;
  if (observedAt && Number.isNaN(observedAt.getTime())) {
    throw new Error("--observed-at must be a valid date");
  }
  const options: StaleProviderRunRecoveryOptions = {
    changeId,
    execute,
    observedAt,
    providerStartGraceMs: values.has("--provider-start-grace-ms")
      ? nonNegativeNumber("--provider-start-grace-ms", values.get("--provider-start-grace-ms") as string)
      : undefined,
    providerHeartbeatStaleMs: values.has("--provider-heartbeat-stale-ms")
      ? nonNegativeNumber("--provider-heartbeat-stale-ms", values.get("--provider-heartbeat-stale-ms") as string)
      : undefined,
    legacyLifecycleGraceMs: values.has("--legacy-lifecycle-grace-ms")
      ? nonNegativeNumber("--legacy-lifecycle-grace-ms", values.get("--legacy-lifecycle-grace-ms") as string)
      : undefined,
  };
  return { mode: execute ? "execute" : "dry-run", options };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseRepairCliArguments(argv);
  const report = await recoverStaleProviderRuns(parsed.options);
  const exitCode = repairCliExitCode(report);
  console.log(JSON.stringify({
    mode: parsed.mode,
    status: exitCode === 0 ? "ok" : exitCode === 2 ? "partial" : "failed",
    ...report,
  }, null, 2));
  if (exitCode !== 0) process.exitCode = exitCode;
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
