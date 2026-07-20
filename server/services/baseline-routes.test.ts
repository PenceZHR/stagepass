import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const ROUTE_ROOT = path.join(process.cwd(), "app", "api", "projects", "[id]", "baseline");

describe("baseline routes", () => {
  it("GET /baseline returns the baseline document list", () => {
    const routePath = path.join(ROUTE_ROOT, "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{ listBaselineDocs \}/);
    assert.match(content, /import \{ getProject \}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id \} = await params/);
    assert.match(content, /listBaselineDocs\(project\.repoPath\)/);
  });

  it("GET /baseline/[docName] returns one baseline document", () => {
    const routePath = path.join(ROUTE_ROOT, "[docName]", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{ readBaselineDoc \}/);
    assert.match(content, /import \{ getProject \}/);
    assert.match(content, /export async function GET/);
    assert.match(content, /const \{ id, docName \} = await params/);
    assert.match(content, /readBaselineDoc\(project\.repoPath, docName\)/);
  });
});

