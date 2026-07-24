import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CODEX_DECISION_PHASES,
  assertCompleteCodexDecisionRollout,
} from "../config/codex-decision-rollout";
import { buildManagedAiCallerInventory } from "./codex-managed-ai-caller-inventory";

const ROOT = process.cwd();

const REQUIRED_EVIDENCE = [
  "codex-thread-binding-service.test.ts",
  "codex-logical-turn-service.test.ts",
  "codex-follower-start-attempt-service.test.ts",
  "codex-native-recovery-service.test.ts",
  "codex-turn-lifecycle-service.test.ts",
  "codex-desktop-bridge.test.ts",
  "codex-desktop-engine.test.ts",
  "project-ai-run-service.test.ts",
  "human-interaction-broker.test.ts",
  "interaction-wakeup-orchestrator.test.ts",
  "pipeline-command-gateway.test.ts",
  "canonical-session-callers.test.ts",
  "spec-role-context-service.test.ts",
] as const;

describe("Codex-native migration acceptance", () => {
  it("has executable evidence for the durable follower, project, interaction, and gateway chains", () => {
    for (const file of REQUIRED_EVIDENCE) {
      const absolute = path.join(ROOT, "server/services", file);
      assert.equal(fs.existsSync(absolute), true, file);
      assert.ok(fs.readFileSync(absolute, "utf8").includes("it("), file);
    }
  });

  it("classifies every production AI caller as a logical resolver", () => {
    const inventory = buildManagedAiCallerInventory(ROOT);
    assert.deepEqual(inventory.unclassified, []);
    assert.equal(inventory.callers.length > 0, true);
    assert.equal(
      inventory.callers.every((caller) => caller.mode === "logical_resolver"),
      true,
    );
    assert.equal(
      inventory.callers.some((caller) => caller.file.endsWith("prd-service.ts")),
      true,
    );
    assert.equal(
      inventory.callers.some((caller) =>
        caller.file.endsWith("context-init-service.ts")
      ),
      true,
    );
  });

  it("releases only with the exact complete eleven-phase decision rollout", () => {
    const rollout = assertCompleteCodexDecisionRollout({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: CODEX_DECISION_PHASES.join(","),
    });
    assert.deepEqual(rollout.phases, CODEX_DECISION_PHASES);
    assert.equal(rollout.masterEnabled, true);
    assert.equal(rollout.errorCode, null);
  });

  it("retains historical audit readability but no live legacy command writer", () => {
    const historical = fs.readFileSync(
      path.join(ROOT, "server/types/enums.ts"),
      "utf8",
    );
    assert.match(historical, /legacy_web_migration/);
    for (const file of [
      "server/services/pipeline-command-types.ts",
      "server/services/pipeline-command-gateway.ts",
      "app/api/projects/[id]/changes/[changeId]/commands/route.ts",
    ]) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        /legacy_web_migration/,
        file,
      );
    }
  });
});
