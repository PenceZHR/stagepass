import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dialogSrc = readFileSync(resolve(__dirname, "[id]", "create-change-dialog.tsx"), "utf-8");
const pageSrc = readFileSync(resolve(__dirname, "[id]", "page.tsx"), "utf-8");
const projectsPageSrc = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const changeDetailSrc = readFileSync(resolve(__dirname, "[id]", "changes", "[changeId]", "page.tsx"), "utf-8");
const changeDetailDataSrc = readFileSync(resolve(__dirname, "[id]", "changes", "[changeId]", "use-change-detail-data.ts"), "utf-8");

describe("create change flow", () => {
  it("resets loading in a finally block after submit attempts", () => {
    const submitStart = dialogSrc.indexOf("async function handleSubmit");
    assert.notEqual(submitStart, -1, "handleSubmit should exist");

    const submitEnd = dialogSrc.indexOf("return (", submitStart);
    const submitSource = dialogSrc.slice(submitStart, submitEnd);

    assert.match(submitSource, /try\s*\{/);
    assert.match(submitSource, /catch\s*\(/);
    assert.match(submitSource, /finally\s*\{[\s\S]*setLoading\(false\)/);
  });

  it("passes the created change to the page so it can navigate to details", () => {
    assert.match(dialogSrc, /readJsonResponse\(res\)/);
    assert.match(dialogSrc, /onCreated\(\{ id: change\.id \}\)/);
    assert.match(pageSrc, /useRouter/);
    assert.match(pageSrc, /router\.push\(`\/projects\/\$\{projectId\}\/changes\/\$\{change\.id\}`\)/);
    assert.doesNotMatch(pageSrc, /<CreateChangeDialog projectId=\{projectId\} onCreated=\{loadChanges\} \/>/);
  });

  it("does not render stale or failed project loads as an empty project list", () => {
    assert.match(projectsPageSrc, /const \[loading, setLoading\] = useState\(true\)/);
    assert.match(projectsPageSrc, /const \[loadError, setLoadError\] = useState\(""\)/);
    assert.match(projectsPageSrc, /Loading projects/);
    assert.match(projectsPageSrc, /Retry/);
    assert.match(projectsPageSrc, /let cancelled = false/);
    assert.match(projectsPageSrc, /if \(!cancelled\) setLoading\(false\)/);
    assert.match(projectsPageSrc, /setProjects\(Array\.isArray\(data\) \? data : \[\]\)/);
  });

  it("explains the PRD prerequisite before New Change is available", () => {
    assert.match(pageSrc, /const needsPrdBeforeChange = !prdStatusLoading && !canCreateChange/);
    assert.match(pageSrc, /先完成项目 PRD/);
    assert.match(pageSrc, /去写 PRD/);
    assert.match(pageSrc, /onClick=\{\(\) => setActiveSection\("prd"\)\}/);
    assert.match(pageSrc, /先完成项目 PRD 后才能新建 Change/);
  });

  it("shows a not-found state when the change detail API returns an error", () => {
    assert.match(changeDetailDataSrc, /const \[changeError, setChangeError\] = useState\(""\)/);
    assert.match(changeDetailDataSrc, /if \(!res\.ok\)/);
    assert.match(changeDetailSrc, /Change not found/);
    assert.match(changeDetailSrc, /if \(!change && changeError\)/);
    assert.doesNotMatch(changeDetailDataSrc, /\.then\(setChange\)/);
  });
});
