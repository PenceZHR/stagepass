import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const CHANGE_ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]"
);

const ROUTE_ROOT = path.join(CHANGE_ROUTE_ROOT, "plan-sandbox");

describe("plan sandbox routes", () => {
  it("GET /testplan-sandbox returns the TestPlan snapshot state after project/change guard", () => {
    const routePath = path.join(CHANGE_ROUTE_ROOT, "testplan-sandbox", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*getTestPlanSnapshotState[^}]*\}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /NextResponse\.json\(getTestPlanSnapshotState\(changeId\)\)/);
  });

  it("GET /plan-sandbox returns the sandbox state after project/change guard", () => {
    const routePath = path.join(ROUTE_ROOT, "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*getPlanSandboxState[^}]*\}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /NextResponse\.json\(getPlanSandboxState\(changeId\)\)/);
  });

  it("POST /plan-sandbox/report regenerates the report and returns the state", () => {
    const routePath = path.join(ROUTE_ROOT, "report", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*regeneratePlanReport[^}]*\}/);
    assert.match(content, /export async function POST/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /const state = await regeneratePlanReport\(changeId\)/);
    assert.match(content, /NextResponse\.json\(\{ success: true, state \}\)/);
  });

  it("POST /plan-sandbox/decision validates waiver input and returns the state", () => {
    const routePath = path.join(ROUTE_ROOT, "decision", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*waivePlanRisk[^}]*\}/);
    assert.match(content, /export async function POST/);
    assert.match(content, /await request\.json\(\)/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /typeof payload\.riskId !== "string"/);
    assert.match(content, /typeof payload\.reason !== "string"/);
    assert.match(content, /status: 400/);
    assert.match(content, /const state = await waivePlanRisk\(changeId, payload\.riskId, payload\.reason\)/);
    assert.match(content, /NextResponse\.json\(\{ success: true, state \}\)/);
  });

  it("POST /approve-plan rejects inline P1 waivers before approval side effects", () => {
    const routePath = path.join(CHANGE_ROUTE_ROOT, "approve-plan", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{ approvePlan \}/);
    assert.doesNotMatch(content, /regeneratePlanReport/);
    assert.doesNotMatch(content, /waivePlanRisk/);
    assert.match(content, /await request\.text\(\)/);
    assert.match(content, /p1Waivers/);
    assert.match(content, /p1_waivers_must_use_plan_decision/);
    assert.match(content, /reasonCode:\s*"p1_waivers_must_use_plan_decision"/);
    assert.match(content, /status:\s*422/);
    assert.match(content, /await approvePlan\(changeId, \{ source: "route_preflight" \}\)/);
    assert.match(
      content,
      /p1Waivers[\s\S]*p1_waivers_must_use_plan_decision[\s\S]*assertActionAllowed[\s\S]*await approvePlan\(changeId, \{ source: "route_preflight" \}\)/
    );
  });
});
