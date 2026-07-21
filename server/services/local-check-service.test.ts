import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runLocalChecks } from "./local-check-service.ts";

const tempDirs: string[] = [];

interface RepoSpec {
  scripts?: Record<string, string>;
  /** Set true to build a repo with no package.json at all (the default writes one). */
  noPackageJson?: boolean;
  policy?: {
    requiredChecks?: string[];
    optionalChecks?: string[];
    defaultValidationCommands?: Record<string, string>;
  };
}

function makeRepo(spec: RepoSpec = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-check-service-"));
  tempDirs.push(dir);
  if (!spec.noPackageJson) {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", scripts: spec.scripts ?? {} }, null, 2),
    );
  }
  if (spec.policy) {
    fs.mkdirSync(path.join(dir, ".ship"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".ship", "policy.json"), JSON.stringify(spec.policy, null, 2));
  }
  return dir;
}

function outDir(repo: string): string {
  return path.join(repo, "out");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * The defect: `results.every(...)` on an empty array is `true`, so "nothing ran"
 * was indistinguishable from "everything passed". QA consumes `success` directly
 * (pipeline-qa-stage-service.ts: `!localResult.success` -> CHECK_FAILED, else
 * MERGE_READY), so an empty check set silently minted a merge-ready verdict.
 */
describe("runLocalChecks: an empty check set is never a pass", () => {
  it("fails when no check ran at all (no policy, no runnable package scripts)", () => {
    const repo = makeRepo({ scripts: { start: "node index.js" } });

    const result = runLocalChecks(repo, "CHG-1", outDir(repo));

    assert.equal(result.checks.length, 0, "precondition: nothing was runnable");
    assert.equal(result.success, false, "zero executed checks must not report success");
    assert.ok(result.findings.length > 0, "a failed verdict must be explained by a finding");
    assert.ok(
      result.findings.some((finding) => finding.severity === "P0"),
      "no-checks-executed is a P0 blocker (merge-readiness only blocks on open P0/P1)",
    );
  });

  it("fails, and names each check, when requiredChecks have no matching command", () => {
    const repo = makeRepo({
      policy: {
        requiredChecks: ["typecheck", "test"],
        defaultValidationCommands: { lint: "true" },
      },
    });

    const result = runLocalChecks(repo, "CHG-2", outDir(repo));

    assert.equal(result.success, false, "a required check with no command must not pass");
    const sources = result.findings.map((finding) => finding.source);
    assert.ok(sources.includes("typecheck"), "the skipped required check must be named");
    assert.ok(sources.includes("test"), "the skipped required check must be named");
    for (const finding of result.findings.filter((f) => f.source === "typecheck" || f.source === "test")) {
      assert.equal(finding.severity, "P0");
    }
  });

  it("fails when a caller-supplied required command is an empty string", () => {
    const repo = makeRepo();

    const result = runLocalChecks(repo, "CHG-3", outDir(repo), { requiredCommands: [""] });

    assert.equal(result.checks.length, 0, "precondition: an empty command cannot execute");
    assert.equal(result.success, false, "an unrunnable required command must not pass");
    assert.ok(result.findings.length > 0);
  });

  it("persists the failed verdict to local-check.json", () => {
    const repo = makeRepo();

    runLocalChecks(repo, "CHG-4", outDir(repo), { requiredCommands: [""] });

    const written = JSON.parse(fs.readFileSync(path.join(outDir(repo), "local-check.json"), "utf-8"));
    assert.equal(written.success, false, "the persisted artifact must agree with the return value");
  });
});

/**
 * The same defect one step later: the command resolved, but the environment
 * cannot run it. This branch used to push a synthetic passing CheckResult, which
 * satisfied every conjunct of `success` from zero executed commands.
 *
 * Not a corner case. server/templates/policy.json ships four required checks, all
 * `pnpm ...`, and both projects in the production DB on 2026-07-21 have no
 * package.json at their repoPath.
 */
describe("runLocalChecks: a command the repo cannot run is never a pass", () => {
  it("blocks a required pnpm check when the repo has no package.json", () => {
    const repo = makeRepo({
      noPackageJson: true,
      policy: {
        requiredChecks: ["test"],
        defaultValidationCommands: { test: "pnpm test" },
      },
    });

    const result = runLocalChecks(repo, "CHG-NP-1", outDir(repo));

    assert.equal(result.checks.length, 0, "precondition: pnpm cannot run without package.json");
    assert.equal(result.success, false, "a required check that never executed must not pass");
    const finding = result.findings.find((entry) => entry.source === "test");
    assert.equal(finding?.severity, "P0", "merge-readiness only blocks on open P0/P1");
    assert.match(finding?.evidence ?? "", /pnpm test/, "the finding must name the command that could not run");
    assert.match(finding?.evidence ?? "", /package\.json/, "...and why it could not run");
  });

  it("blocks every required check of the factory policy template on a non-Node repo", () => {
    const repo = makeRepo({
      noPackageJson: true,
      policy: {
        requiredChecks: ["lint", "typecheck", "test", "build"],
        defaultValidationCommands: {
          lint: "pnpm lint",
          typecheck: "pnpm typecheck",
          test: "pnpm test",
          build: "pnpm build",
        },
      },
    });

    const result = runLocalChecks(repo, "CHG-NP-2", outDir(repo));

    assert.equal(result.checks.length, 0, "zero commands executed");
    assert.equal(result.success, false, "QA settles a truthy success as MERGE_READY");
    for (const name of ["lint", "typecheck", "test", "build"]) {
      const finding = result.findings.find((entry) => entry.source === name);
      assert.equal(finding?.severity, "P0", `${name} must be reported as a blocker`);
    }
  });

  it("still skips an OPTIONAL pnpm check silently and passes on the check that ran", () => {
    const repo = makeRepo({
      noPackageJson: true,
      policy: {
        requiredChecks: ["smoke"],
        optionalChecks: ["lint"],
        defaultValidationCommands: { smoke: "true", lint: "pnpm lint" },
      },
    });

    const result = runLocalChecks(repo, "CHG-NP-3", outDir(repo));

    // Nothing declared the optional check must run, so its absence is not a lie.
    assert.equal(result.checks.length, 1, "only the runnable required check executed");
    assert.equal(result.checks[0]?.name, "smoke");
    assert.equal(result.success, true, "a genuine pass must survive the stricter rule");
    assert.equal(result.findings.length, 0);
  });
});

/**
 * Guards against over-correction: checks that genuinely ran and genuinely passed
 * must still report success, and a check the policy marks *optional* may still be
 * absent without commands.
 */
describe("runLocalChecks: real results are still reported faithfully", () => {
  it("passes when the single required check runs and exits 0", () => {
    const repo = makeRepo();

    const result = runLocalChecks(repo, "CHG-5", outDir(repo), { requiredCommands: ["true"] });

    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0]!.success, true);
    assert.equal(result.checks[0]!.exitCode, 0);
    assert.equal(result.success, true, "a check that ran and passed must report success");
    assert.deepEqual(result.findings, []);
  });

  it("passes when every one of several required checks exits 0", () => {
    const repo = makeRepo();

    const result = runLocalChecks(repo, "CHG-6", outDir(repo), {
      requiredCommands: ["true", "echo ok", "true"],
    });

    assert.equal(result.checks.length, 3);
    assert.equal(result.success, true);
    assert.deepEqual(result.findings, []);
  });

  it("passes using policy-declared commands that all exit 0", () => {
    const repo = makeRepo({
      policy: {
        requiredChecks: ["lint", "typecheck"],
        defaultValidationCommands: { lint: "true", typecheck: "true" },
      },
    });

    const result = runLocalChecks(repo, "CHG-7", outDir(repo));

    assert.equal(result.checks.length, 2);
    assert.equal(result.success, true);
    assert.deepEqual(result.findings, []);
  });

  it("still fails, with a finding, when an executed check exits non-zero", () => {
    const repo = makeRepo();

    const result = runLocalChecks(repo, "CHG-8", outDir(repo), { requiredCommands: ["false"] });

    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0]!.success, false);
    assert.equal(result.success, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.severity, "P1", "an executed-and-failed check keeps its P1 severity");
  });

  it("lets an optional check with no command stay a silent skip", () => {
    const repo = makeRepo({
      policy: {
        requiredChecks: ["lint"],
        optionalChecks: ["coverage"],
        defaultValidationCommands: { lint: "true" },
      },
    });

    const result = runLocalChecks(repo, "CHG-9", outDir(repo));

    assert.equal(result.checks.length, 1, "only the commanded check runs");
    assert.equal(result.success, true, "an absent *optional* check is not a failure");
    assert.deepEqual(result.findings, [], "an absent optional check raises no finding");
  });
});
