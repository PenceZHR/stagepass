import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "spec-battle"
);

const GATE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "gate"
);

describe("spec battle routes", () => {
  it("GET /spec-battle returns battle state", () => {
    const routePath = path.join(ROUTE_ROOT, "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*getSpecBattleState[^}]*\}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /getSpecBattleState\(changeId\)/);
  });

  it("POST /spec-battle/report regenerates deterministic reports", () => {
    const routePath = path.join(ROUTE_ROOT, "report", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /generateSpecReport\(changeId\)/);
    assert.match(content, /generateWarReport\(changeId\)/);
    assert.match(content, /export async function POST/);
  });

  it("POST /spec-battle/decision applies human decisions and maps battle errors to 409", () => {
    const routePath = path.join(ROUTE_ROOT, "decision", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*applySpecBattleDecision[^}]*SpecBattleError[^}]*\}/);
    assert.match(content, /await request\.json\(\)/);
    assert.match(content, /applySpecBattleDecision\(\{[\s\S]*changeId/);
    assert.doesNotMatch(content, /runSpec/);
    assert.match(content, /err instanceof SpecBattleError/);
    assert.match(content, /status: 409/);
  });

  it("POST /spec-battle/decision rejects approve because approval must use gate preflight", () => {
    const routePath = path.join(ROUTE_ROOT, "decision", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /PublicSpecBattleDecisionAction/);
    assert.match(content, /Exclude<SpecBattleDecisionInput\["action"\], "approve">/);
    assert.match(content, /payload\.action === "approve"/);
    assert.match(content, /invalid_battle_decision_action/);
    assert.match(content, /Spec approval must use \/gate\/approve/);
    assert.match(content, /status: 422/);
  });

  it("POST /gate/approve maps Spec Battle conflicts to 409", () => {
    const routePath = path.join(GATE_ROOT, "approve", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /SpecBattleError/);
    assert.match(content, /err instanceof SpecBattleError/);
    assert.match(content, /actionNotAllowedEnvelope/);
    assert.match(content, /NextResponse\.json\(envelope, \{ status: 409 \}\)/);
    assert.doesNotMatch(content, /NextResponse\.json\(\{ error: message \}, \{ status: 409 \}\)/);
  });
});
