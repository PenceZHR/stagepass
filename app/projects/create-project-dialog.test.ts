import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dialogSrc = readFileSync(resolve(__dirname, "create-project-dialog.tsx"), "utf-8");
const pageSrc = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");

describe("create project flow", () => {
  it("resets loading in a finally block after submit attempts", () => {
    const submitStart = dialogSrc.indexOf("async function handleSubmit");
    assert.notEqual(submitStart, -1, "handleSubmit should exist");

    const submitEnd = dialogSrc.indexOf("return (", submitStart);
    const submitSource = dialogSrc.slice(submitStart, submitEnd);

    assert.match(submitSource, /try\s*\{/);
    assert.match(submitSource, /catch\s*\(/);
    assert.match(submitSource, /finally\s*\{[\s\S]*setLoading\(false\)/);
  });

  it("passes the created project to the page so it can navigate to details", () => {
    assert.match(dialogSrc, /readJsonResponse\(res\)/);
    assert.match(dialogSrc, /onCreated\(\{ id: project\.id \}\)/);
    assert.match(pageSrc, /useRouter/);
    assert.match(pageSrc, /router\.push\(`\/projects\/\$\{project\.id\}`\)/);
    assert.doesNotMatch(pageSrc, /<CreateProjectDialog onCreated=\{load\} \/>/);
  });
});
