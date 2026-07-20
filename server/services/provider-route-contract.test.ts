import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ACTION_DEFINITIONS } from "./action-contract-registry-service";
import { PROVIDER_BACKED_ACTION_IDS } from "./provider-selection-service";

const routeRoot = path.join(process.cwd(), "app", "api", "projects", "[id]", "changes", "[changeId]");
const providerRoutes = [
  "intake/route.ts",
  "spec/route.ts",
  "plan/route.ts",
  "test-plan/route.ts",
  "implement/route.ts",
  "review/route.ts",
  "fix/route.ts",
  "retro/route.ts",
];

describe("provider-backed route contract", () => {
  it("has one authoritative provider-backed action set", () => {
    for (const actionId of PROVIDER_BACKED_ACTION_IDS) {
      assert.ok(
        ACTION_DEFINITIONS.some((definition) => definition.actionId === actionId),
        `${actionId} must be registered before it can be provider-backed`,
      );
    }
    for (const definition of ACTION_DEFINITIONS) {
      if (definition.requiresProvider) assert.equal(PROVIDER_BACKED_ACTION_IDS.has(definition.actionId), true);
    }
  });

  it("passes provider from every generic provider-backed route into enqueue", () => {
    for (const relativePath of providerRoutes) {
      const source = fs.readFileSync(path.join(routeRoot, relativePath), "utf8");
      assert.match(
        source.replace(/\s+/g, " "),
        /enqueueProviderActionAtomically\(\{[^}]*provider:/,
        `${relativePath} must pass parsed provider to enqueue`,
      );
    }
  });

  it("uses the shared body parser for custom and briefing provider routes", () => {
    for (const relativePath of [
      "tech-spec/route.ts",
      "release/route.ts",
      "prd-briefing/questions/route.ts",
      "prd-briefing/draft/route.ts",
      "prd-briefing/final-review/route.ts",
    ]) {
      const source = fs.readFileSync(path.join(routeRoot, relativePath), "utf8");
      assert.match(source, /readActionPayload|parseRequestProvider|resolveRequestProvider/,
        `${relativePath} must parse provider from its request body`);
      assert.match(source.replace(/\s+/g, " "), /enqueueProviderActionAtomically\(\{[^}]*provider:/,
        `${relativePath} must pass provider to enqueue`);
    }
  });

  it("does not silently swallow providers on provider-free custom payloads", () => {
    for (const relativePath of [
      "check/route.ts",
      "approve-plan/route.ts",
      "build-workspace/route.ts",
    ]) {
      const source = fs.readFileSync(path.join(routeRoot, relativePath), "utf8");
      assert.match(source, /resolveRequestProviderForAction/,
        `${relativePath} must reject an explicit provider_not_applicable`);
    }
  });

  it("validates explicit providers on every JSON human-action route", () => {
    const humanActionRoutes = [
      "gate/approve/route.ts",
      "gate/reject/route.ts",
      "block/route.ts",
      "stop/route.ts",
      "approve-plan/route.ts",
      "confirm/route.ts",
      "rework/route.ts",
      "spec-battle/decision/route.ts",
      "plan-sandbox/decision/route.ts",
      "plan-sandbox/report/route.ts",
      "prd-briefing/lock/route.ts",
      "prd-briefing/route.ts",
      "prd-briefing/questions/[questionId]/route.ts",
      "spec-battle/report/route.ts",
      // init_git_repo / commit_changes: local git operations, never provider-backed.
      "git/route.ts",
    ];

    for (const relativePath of humanActionRoutes) {
      const source = fs.readFileSync(path.join(routeRoot, relativePath), "utf8");
      assert.match(
        source,
        /readActionPayload|resolveRequestProviderForAction|assertRequestProviderNotApplicable|assertRequestActionAllowed/,
        `${relativePath} must parse and validate an explicit provider`,
      );
      assert.match(
        source,
        /resolveRequestProviderForAction|assertRequestProviderNotApplicable|assertRequestActionAllowed/,
        `${relativePath} must reject provider_not_applicable for provider-free actions`,
      );
    }
  });
});
