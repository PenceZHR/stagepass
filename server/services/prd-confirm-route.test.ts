import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const ROUTE = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "prd",
  "confirm",
  "route.ts",
);

describe("PRD confirm route", () => {
  it("uses revision confirmation when the project is revising", () => {
    const content = fs.readFileSync(ROUTE, "utf-8");

    assert.match(content, /import \{ getProject \} from "@\/server\/services\/project-service"/);
    assert.match(content, /const project = await getProject\(id\)/);
    assert.match(content, /project\.prdStatus === "revising"/);
    assert.match(content, /\? await confirmPrdRevision\(id\)/);
    assert.match(content, /: await confirmPrd\(id\)/);
  });
});
