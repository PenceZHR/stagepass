import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]"
);

describe("project-scoped change routes", () => {
  it("loads change details by both project id and change id", () => {
    const content = readFileSync(path.join(ROUTE_ROOT, "route.ts"), "utf-8");

    assert.match(content, /getChangeForProject\(projectId, changeId\)/);
    assert.doesNotMatch(content, /const change = await getChange\(changeId\)/);
  });

  it("keeps change detail reads free of stale-provider recovery writes", () => {
    const content = readFileSync(path.join(ROUTE_ROOT, "route.ts"), "utf-8");
    assert.doesNotMatch(content, /recoverStaleProviderRuns/);
    assert.match(content, /const change = await getChangeForProject\(projectId, changeId\)/);
  });

  it("does not expose generic status mutation through PATCH", () => {
    const content = readFileSync(path.join(ROUTE_ROOT, "route.ts"), "utf-8");
    const patchSource = content.slice(content.indexOf("export async function PATCH"), content.indexOf("export async function DELETE"));

    assert.match(patchSource, /pipeline\/gate-specific actions/);
    assert.match(patchSource, /status:\s*400/);
    assert.doesNotMatch(content, /updateChangeStatus/);
    assert.doesNotMatch(patchSource, /PatchBody\.safeParse/);
  });

  it("guards high-risk change subroutes before reading or mutating state", () => {
    const guardedRoutes = [
      "gate/route.ts",
      "gate/approve/route.ts",
      "gate/reject/route.ts",
      "spec-battle/route.ts",
      "spec-battle/decision/route.ts",
      "spec-battle/report/route.ts",
      "plan-sandbox/route.ts",
      "plan-sandbox/decision/route.ts",
      "plan-sandbox/report/route.ts",
      "tech-spec/route.ts",
      "events/route.ts",
      "events/stream/route.ts",
      "artifacts/route.ts",
      "findings/route.ts",
      "intake/route.ts",
      "spec/route.ts",
      "plan/route.ts",
      "implement/route.ts",
      "review/route.ts",
      "review-center/route.ts",
      "review-report/recompute/route.ts",
      "review-artifacts/rebuild/route.ts",
      "check/route.ts",
      "fix/route.ts",
      "test-plan/route.ts",
      "release/route.ts",
      "retro/route.ts",
      "stop/route.ts",
      "block/route.ts",
      "approve-plan/route.ts",
    ];

    for (const route of guardedRoutes) {
      const content = readFileSync(path.join(ROUTE_ROOT, route), "utf-8");
      assert.match(content, /requireProjectChange\(projectId, changeId\)/, `${route} should guard project/change ownership`);
      assert.match(content, /if \(guard\.response\) return guard\.response;/, `${route} should return 404 on project mismatch`);
    }
  });

  it("uses the correct relative route guard import from nested subroutes", () => {
    const twoLevelNestedRoutes = [
      "events/stream/route.ts",
      "gate/approve/route.ts",
      "gate/reject/route.ts",
      "spec-battle/decision/route.ts",
      "spec-battle/report/route.ts",
      "review-report/recompute/route.ts",
      "review-artifacts/rebuild/route.ts",
      "plan-sandbox/decision/route.ts",
      "plan-sandbox/report/route.ts",
    ];

    for (const route of twoLevelNestedRoutes) {
      const content = readFileSync(path.join(ROUTE_ROOT, route), "utf-8");
      assert.match(content, /from "\.\.\/\.\.\/route-guard"/, `${route} should import route guard from two levels up`);
      assert.doesNotMatch(content, /from "\.\.\/route-guard"/, `${route} should not use the shallow route guard import`);
    }

    const threeLevelNestedRoutes = [
      "artifacts/[artifactId]/content/route.ts",
      "findings/[findingId]/waive/route.ts",
    ];

    for (const route of threeLevelNestedRoutes) {
      const content = readFileSync(path.join(ROUTE_ROOT, route), "utf-8");
      assert.match(content, /from "\.\.\/\.\.\/\.\.\/route-guard"/, `${route} should import route guard from three levels up`);
      assert.doesNotMatch(content, /from "\.\.\/\.\.\/route-guard"/, `${route} should not use the two-level route guard import`);
    }
  });

  it("requires auditable human review waivers and blocks P0 review waivers", () => {
    const content = readFileSync(path.join(ROUTE_ROOT, "findings/[findingId]/waive/route.ts"), "utf-8");
    const service = readFileSync(path.join(process.cwd(), "server", "services", "review-waiver-service.ts"), "utf-8");

    assert.match(content, /review-waiver-service/);
    assert.match(content, /waiveReviewFinding/);
    assert.match(content, /reason/);
    assert.match(service, /P0 review findings cannot be waived/);
    assert.match(service, /P1 review findings require a waiver reason/);
    assert.match(service, /review_p1_waiver/);
    assert.match(service, /"human"/);
    assert.match(service, /reviewAttemptId/);
    assert.match(service, /sourceBuildRunId/);
    assert.doesNotMatch(content, /getReviewCenterState/);
    assert.doesNotMatch(content, /db\.update\(findings\)/);
  });
});
