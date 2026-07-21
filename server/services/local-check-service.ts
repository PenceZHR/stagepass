import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";

const log = createChildLogger("local-check-service");

export interface CheckResult {
  name: string;
  command: string;
  success: boolean;
  exitCode: number;
  durationMs: number;
  logPath: string;
  summary: string;
}

export interface Finding {
  source: string;
  severity: string;
  category: string;
  title: string;
  file?: string;
  line?: number;
  evidence?: string;
  requiredFix?: string;
  status: string;
}

export interface LocalCheckResult {
  success: boolean;
  checks: CheckResult[];
  findings: Finding[];
}

export interface RunLocalChecksOptions {
  requiredCommands?: string[];
}

interface PolicyConfig {
  requiredChecks?: string[];
  optionalChecks?: string[];
  defaultValidationCommands?: Record<string, string>;
}

function loadPolicy(repoPath: string): PolicyConfig {
  const policyPath = path.join(repoPath, ".ship", "policy.json");
  if (!fs.existsSync(policyPath)) return {};
  return JSON.parse(fs.readFileSync(policyPath, "utf-8"));
}

function runCheck(
  name: string,
  command: string,
  repoPath: string,
  logsDir: string
): CheckResult {
  const logFile = path.join(logsDir, `${name}.log`);
  const start = Date.now();
  let exitCode = 0;
  let output = "";

  const env = { ...process.env, NODE_ENV: "production" } as NodeJS.ProcessEnv;

  try {
    output = execSync(command, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? 1;
    output = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
  }

  const durationMs = Date.now() - start;
  fs.writeFileSync(logFile, output);

  return {
    name,
    command,
    success: exitCode === 0,
    exitCode,
    durationMs,
    logPath: logFile,
    summary: exitCode === 0 ? "passed" : output.split("\n").slice(-5).join("\n"),
  };
}

/**
 * Turns check state into findings.
 *
 * `missingCommands` are checks the policy declared *required* but for which no
 * command could be resolved. They never executed, so they have no CheckResult —
 * without an explicit finding they would vanish, and "required check has no
 * command" would be indistinguishable from "required check passed".
 */
function generateFindings(checks: CheckResult[], missingCommands: string[] = []): Finding[] {
  const findings: Finding[] = [];
  for (const check of checks) {
    if (!check.success) {
      let fullOutput = "";
      if (check.logPath && fs.existsSync(check.logPath)) {
        fullOutput = fs.readFileSync(check.logPath, "utf-8");
      }
      // Keep up to 200 lines of output for the agent to work with
      const trimmedOutput = fullOutput
        .split("\n")
        .slice(0, 200)
        .join("\n");

      findings.push({
        source: check.name,
        severity: "P1",
        category: "quality",
        title: `${check.name} check failed`,
        evidence: trimmedOutput || check.summary,
        requiredFix: `Fix all ${check.name} errors shown in evidence`,
        status: "open",
      });
    }
  }

  for (const name of missingCommands) {
    findings.push({
      source: name,
      severity: "P0",
      category: "quality",
      title: `Required check has no command: ${name}`,
      evidence:
        `"${name}" is declared in requiredChecks but no command resolves for it, so it never ran. ` +
        `A required check that cannot run is not a passing check.`,
      requiredFix:
        `Define a command for "${name}" (.ship/policy.json defaultValidationCommands, a matching ` +
        `package.json script, or a TestPlan required command), or drop "${name}" from requiredChecks.`,
      status: "open",
    });
  }

  if (checks.length === 0) {
    findings.push({
      source: "local_check",
      severity: "P0",
      category: "quality",
      title: "No checks were executed",
      evidence:
        "Zero checks produced a result. An empty check set carries no evidence about the change " +
        "and must not be settled as a pass.",
      requiredFix:
        "Declare at least one runnable validation command for this repository " +
        "(.ship/policy.json, a package.json script, or a TestPlan required command).",
      status: "open",
    });
  }

  return findings;
}

export function runLocalChecks(
  repoPath: string,
  changeId: string,
  outputDir?: string,
  options: RunLocalChecksOptions = {},
): LocalCheckResult {
  const policy = loadPolicy(repoPath);

  // Read package.json scripts to know what's available
  const pkgJsonPath = path.join(repoPath, "package.json");
  const hasPkgJson = fs.existsSync(pkgJsonPath);
  let pkgScripts: Record<string, string> = {};
  if (hasPkgJson) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    pkgScripts = pkg.scripts ?? {};
  }

  const defaultCommands: Record<string, string> = {};
  if (pkgScripts.lint) defaultCommands.lint = "pnpm lint";
  if (pkgScripts.typecheck) defaultCommands.typecheck = "pnpm typecheck";
  if (pkgScripts.test) defaultCommands.test = "pnpm test";
  if (pkgScripts.build) defaultCommands.build = "pnpm build";

  const commands = options.requiredCommands?.length
    ? Object.fromEntries(
        options.requiredCommands.map((command, index) => [`testplan_${index + 1}`, command]),
      )
    : policy.defaultValidationCommands ?? defaultCommands;

  const required = options.requiredCommands?.length
    ? Object.keys(commands)
    : policy.requiredChecks ?? Object.keys(commands);
  const optional = options.requiredCommands?.length ? [] : policy.optionalChecks ?? [];
  const allChecks = [...required, ...optional];

  const logsDir = outputDir ?? path.join(repoPath, ".ship", "changes", changeId);
  fs.mkdirSync(logsDir, { recursive: true });

  const results: CheckResult[] = [];
  // Required checks that resolved to no command. Recorded rather than skipped:
  // the caller declared these must run, so silently dropping them would report a
  // pass for validation that never happened. Optional checks may stay absent.
  const requiredNames = new Set(required);
  const missingCommands: string[] = [];

  for (const name of allChecks) {
    const cmd = commands[name];
    if (!cmd) {
      if (requiredNames.has(name) && !missingCommands.includes(name)) {
        log.warn({ name }, "Required check has no command - recording as a blocker");
        missingCommands.push(name);
      }
      continue;
    }

    // Skip pnpm/npm/yarn commands if no package.json exists
    if (!hasPkgJson && /^(pnpm|npm|yarn)\s/.test(cmd)) {
      log.info({ name, command: cmd }, "Skipping check - no package.json");
      results.push({
        name,
        command: cmd,
        success: true,
        exitCode: 0,
        durationMs: 0,
        logPath: "",
        summary: "skipped - no package.json",
      });
      continue;
    }

    const resolved = cmd.replace(/\{changeId\}/g, changeId);
    log.info({ name, command: resolved }, "Running check");
    const result = runCheck(name, resolved, repoPath, logsDir);
    results.push(result);
    log.info({ name, success: result.success, durationMs: result.durationMs }, "Check done");
  }

  const findings = generateFindings(results, missingCommands);
  // `[].every(...)` is `true`, so the bare `every` reported a pass whenever
  // nothing ran. QA reads this flag directly (pipeline-qa-stage-service: a truthy
  // `success` with a clean scope check settles the change as MERGE_READY), so an
  // empty check set used to mint a merge-ready verdict from zero evidence.
  // Success now requires that checks actually ran, that every one of them passed,
  // and that no required check was dropped for want of a command.
  const success =
    results.length > 0 && missingCommands.length === 0 && results.every((r) => r.success);

  const output: LocalCheckResult = { success, checks: results, findings };
  const outputPath = path.join(logsDir, "local-check.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  return output;
}
