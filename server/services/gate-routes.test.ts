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
  "gate"
);

describe("gate routes", () => {
  it("GET /gate returns gate status", () => {
    const routePath = path.join(ROUTE_ROOT, "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{ getGateStatus \}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /getGateStatus\(changeId, \{ refreshActions: false \}\)/);
  });

  it("POST /gate/approve drives approveGate through preflight inputs", () => {
    const routePath = path.join(ROUTE_ROOT, "approve", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*approveGate[^}]*\}/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /actionNotAllowedEnvelope/);
    assert.match(content, /export async function POST/);
    assert.match(content, /await request\.json\(\)/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(content, /expectedGateVersion: body\.expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash: body\.expectedSourceDbHash/);
    assert.match(content, /approveGate\(changeId, body\.gate, \{/);
    assert.match(content, /NextResponse\.json\(err\.envelope, \{ status: err\.status \}\)/);
    assert.match(content, /NextResponse\.json\(envelope, \{ status: 409 \}\)/);
    assert.doesNotMatch(content, /NextResponse\.json\(\{ error: message \}, \{ status: 409 \}\)/);
  });

  it("POST /gate/reject drives rejectGate", () => {
    const routePath = path.join(ROUTE_ROOT, "reject", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{[^}]*gateRejectActionId[^}]*rejectGate[^}]*\}/);
    assert.match(content, /export async function POST/);
    assert.match(content, /readActionPayload\(request\)/);
    assert.match(content, /assertRequestActionAllowed\(\{/);
    assert.match(content, /actionId: gateRejectActionId\(gate\)/);
    assert.match(content, /rejectGate\(changeId, gate, reason\)/);
    assert.match(content, /actionPreflightErrorResponse\(err\)/);
  });
});
