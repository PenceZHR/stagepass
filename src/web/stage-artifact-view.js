/**
 * Stage 产物驾驶舱的浏览器编排层：只读取已结算轮次，管理时间轴、搜索、选择和详情。
 * panel.js 只知道 open/close；这个模块不拥有闸门动作，也不触发原生会话。
 */
import { createStageArtifactScene } from "/stage-artifact-scene.js";

const pick = (id) => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`panel.html 里没有 #${id}`);
  return found;
};

const canvas = pick("stage-artifact-canvas");
const empty = pick("stage-artifact-empty");
const list = pick("stage-artifact-list");
const detail = pick("stage-artifact-detail");
const timeline = pick("stage-artifact-timeline");
const search = /** @type {HTMLInputElement} */ (pick("stage-artifact-search"));
const stageState = pick("stage-state");
const roundLabel = pick("stage-round-label");
const gapCount = pick("stage-gap-count");
const next = pick("stage-next");
const nextWhy = pick("stage-next-why");
const adapterLabel = pick("stage-artifact-adapter");
const note = pick("stage-note");

const ADAPTERS = {
  PRD: { label: "REQUIREMENT EVIDENCE", prefer: /\.md$/i },
  Spec: { label: "BEHAVIOR CONTRACT", prefer: /\.md$/i },
  Arch: { label: "ARCHITECTURE PROJECTION", prefer: /arch\.graph\.json$|\.md$/i },
  BuildPlan: { label: "IMPLEMENTATION MAP", prefer: /\.md$/i },
  TestPlan: { label: "TEST STRATEGY", prefer: /\.md$/i },
  Build: { label: "CODE DELIVERY", prefer: /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i },
  Test: { label: "TEST DELIVERY", prefer: /(?:\.test\.|\/tests?\/)/i },
  QA: { label: "VERIFICATION EVIDENCE", prefer: /\.json$|\.md$/i },
};

const CHANGE_WORDS = {
  added: "新增",
  modified: "修改",
  unchanged: "沿用",
  deleted: "删除",
  replaced: "替换",
};

const FAILURE_WORDS = {
  "no-path": "这个项目还没有代码路径，无法建立阶段产物投影。",
  "not-a-repo": "项目路径不是 Git 仓库；历史轮次不能被可靠读取。",
  "change-unknown": "这个 Change 已不存在。",
  "project-mismatch": "Change 与 Project 的归属无法核实，读取已关闭。",
  "phase-invalid": "旁路会话没有阶段产物账本；你仍可用顶部按钮进入原生 Codex。",
  "round-unknown": "这轮历史不在产物账本中。",
  "round-incomplete": "这一轮只知道发生过，无法证明完整文件集合。",
  "file-unavailable": "这份历史文件已经无法从它的 Git commit 读取。",
  "file-too-large": "文件超过 2 MB；为避免阻塞驾驶舱，这里不展开正文。",
};

let target = null;
let model = null;
let scene = null;
let rows = new Map();
let selectedPath = null;
let selectedRound = null;
let refreshTimer = null;
let requestVersion = 0;
let closed = true;

async function fetchJson(path, signal) {
  const response = await fetch(path, { signal });
  const body = await response.json().catch(() => ({ error: "bad-json" }));
  return { status: response.status, body };
}

function showEmpty(message) {
  empty.textContent = message;
  empty.hidden = false;
}

function hideEmpty() { empty.hidden = true; }

function setHeader(input) {
  const mark = input.state.mark === "approved" ? " · 已批准"
    : input.state.mark === "problem" ? " · 有问题" : "";
  stageState.textContent = `${input.state.status}${mark}`;
  gapCount.textContent = `${input.state.openGaps} 个未决问题`;
  next.textContent = input.nextStep?.what ?? "查看已结算产物";
  nextWhy.textContent = input.nextStep?.why
    ?? "这一页只投影事实；所有裁决仍在原生 Codex 选择器中完成。";
  adapterLabel.textContent = ADAPTERS[input.phase]?.label ?? "STAGE EVIDENCE";
}

function countChanges(files) {
  const counts = new Map();
  for (const file of files ?? []) counts.set(file.change, (counts.get(file.change) ?? 0) + 1);
  const words = [];
  for (const change of ["added", "modified", "deleted", "renamed"]) {
    if (counts.has(change)) {
      words.push(`${change === "renamed" ? "替换" : CHANGE_WORDS[change]} ${counts.get(change)}`);
    }
  }
  return words.join(" · ") || "没有文件变化";
}

function renderTimeline() {
  timeline.replaceChildren();
  const rounds = [...(model?.rounds ?? [])].sort((left, right) => left.round - right.round);
  const incomplete = (model?.incompleteRounds ?? []).map((round) => ({ round, incomplete: true }));
  const entries = [...rounds, ...incomplete]
    .sort((left, right) => left.round - right.round);
  if (entries.length === 0) {
    const message = document.createElement("span");
    message.className = "stage-detail-hint";
    message.textContent = "还没有已结算轮次";
    timeline.append(message);
    return;
  }
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stage-round-button";
    button.dataset.incomplete = String(entry.incomplete === true);
    button.setAttribute("aria-current", String(entry.round === selectedRound));
    const title = document.createElement("strong");
    title.textContent = `ROUND ${entry.round}`;
    const summary = document.createElement("span");
    summary.textContent = entry.incomplete === true
      ? "历史清单不完整" : `${entry.source === "reconstructed" ? "保守重建 · " : ""}${countChanges(entry.files)}`;
    button.append(title, summary);
    button.addEventListener("click", () => { void load(entry.round); });
    timeline.append(button);
  }
}

function fileMeta(file) {
  return `${CHANGE_WORDS[file.display] ?? file.display} · ${file.role} · R${file.changedInRound}`;
}

function renderList() {
  rows = new Map();
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const file of model?.scene.files ?? []) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "stage-file-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(file.path === selectedPath));
    row.title = file.path;
    const change = document.createElement("span");
    change.className = "stage-file-change";
    change.dataset.change = file.display;
    const path = document.createElement("span");
    path.className = "stage-file-path";
    path.textContent = file.path;
    const meta = document.createElement("span");
    meta.className = "stage-file-meta";
    meta.textContent = fileMeta(file);
    row.append(change, path, meta);
    row.addEventListener("click", () => { void selectFile(file.path); });
    rows.set(file.path, row);
    fragment.append(row);
  }
  list.append(fragment);
  filterFiles(search.value);
}

function filterFiles(value) {
  const needle = value.trim().toLocaleLowerCase();
  const visible = [];
  for (const [path, row] of rows) {
    const show = needle === "" || path.toLocaleLowerCase().includes(needle);
    row.hidden = !show;
    if (show) visible.push(path);
  }
  scene?.filter(needle === "" ? null : visible);
}

function preferredFile() {
  const files = model?.scene.files ?? [];
  const adapter = ADAPTERS[target?.phase];
  return files.find((file) => adapter?.prefer.test(file.path))?.path
    ?? files.find((file) => file.display !== "deleted")?.path
    ?? files[0]?.path
    ?? null;
}

function appendText(parent, tag, value, className = "") {
  const element = document.createElement(tag);
  if (className !== "") element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function renderMarkdown(parent, content) {
  const lines = content.split("\n");
  let code = null;
  let listElement = null;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code === null) {
        code = document.createElement("pre");
        code.textContent = "";
      } else {
        parent.append(code);
        code = null;
      }
      listElement = null;
      continue;
    }
    if (code !== null) {
      code.textContent += `${code.textContent === "" ? "" : "\n"}${line}`;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      appendText(parent, `h${heading[1].length}`, heading[2]);
      listElement = null;
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) {
      if (listElement === null) {
        listElement = document.createElement("ul");
        parent.append(listElement);
      }
      appendText(listElement, "li", item[1]);
      continue;
    }
    if (line.trim() !== "") appendText(parent, "p", line);
    else listElement = null;
  }
  if (code !== null) parent.append(code);
}

function makePre(content, className = "") {
  const pre = document.createElement("pre");
  pre.className = className;
  pre.textContent = content;
  return pre;
}

function contentPanel(file, reading) {
  const holder = document.createElement("div");
  holder.className = "stage-detail-content";
  if (reading.kind === "binary") {
    appendText(holder, "p", `二进制文件 · ${reading.size} bytes。正文不作为文本展开。`, "stage-detail-hint");
    return holder;
  }
  if (/\.md$/i.test(file.path)) {
    const markdown = document.createElement("article");
    markdown.className = "stage-markdown";
    renderMarkdown(markdown, reading.content);
    holder.append(markdown);
    return holder;
  }
  if (/\.json$/i.test(file.path)) {
    let normalized = reading.content;
    try { normalized = JSON.stringify(JSON.parse(reading.content), null, 2); } catch { /* 原文照显 */ }
    holder.append(makePre(normalized));
    return holder;
  }
  holder.append(makePre(reading.content));
  return holder;
}

function diffPanel(reading) {
  const holder = document.createElement("div");
  holder.className = "stage-detail-content";
  holder.append(reading.diff
    ? makePre(reading.diff, "stage-diff")
    : appendText(document.createElement("div"), "p", "这份产物没有可证明的 Git diff。", "stage-detail-hint"));
  return holder;
}

function factSection(title) {
  const section = document.createElement("section");
  section.className = "stage-fact-section";
  appendText(section, "h3", title);
  return section;
}

function factsPanel(file, reading) {
  const holder = document.createElement("div");
  holder.className = "stage-detail-content";

  const source = factSection("来源与历史");
  const upstream = model?.scene.inputs ?? [];
  appendText(source, "p", upstream.length === 0
    ? "这一阶段没有登记上游输入。"
    : `本轮实际输入：${upstream.map((item) => `${item.phase}（${item.artifactIds.length} 份）`).join("、")}。`);
  appendText(source, "p", `${file.path} 在第 ${file.changedInRound} 轮被${CHANGE_WORDS[file.display] ?? file.display}；`
    + `${file.commit ? `内容固定在 ${file.commit.slice(0, 10)}` : "来源是可证明的工作树文件"}。`);
  holder.append(source);

  const dependency = factSection("代码依赖");
  const data = reading.dependencies;
  if (data.dependencies.length === 0 && data.dependents.length === 0) {
    appendText(dependency, "p", file.code ? "在本轮可见文件中没有直接依赖边。" : "非代码文件不编造 import 关系。");
  } else {
    appendText(dependency, "p", `本轮爆炸半径 ${data.blast}。`);
    if (data.dependencies.length > 0) appendList(dependency, "它依赖", data.dependencies);
    if (data.dependents.length > 0) appendList(dependency, "谁依赖它", data.dependents);
  }
  holder.append(dependency);

  const issues = factSection("关联问题");
  const fileGaps = reading.relatedGaps ?? [];
  const stageGaps = model?.stageFacts ?? [];
  if (fileGaps.length === 0 && stageGaps.length === 0) {
    appendText(issues, "p", "没有与这份文件精确关联的未决问题。模糊位置不会被强绑到文件。", "stage-detail-hint");
  }
  for (const gap of fileGaps) appendGap(issues, gap, "文件");
  for (const gap of stageGaps) appendGap(issues, gap, "阶段");
  holder.append(issues);
  return holder;
}

function appendList(parent, label, values) {
  appendText(parent, "p", label);
  const items = document.createElement("ul");
  for (const value of values) appendText(items, "li", value);
  parent.append(items);
}

function appendGap(parent, gap, scope) {
  const row = document.createElement("p");
  row.className = "stage-gap-fact";
  row.textContent = `${scope} · ${gap.severity ?? "标准"} · ${gap.title}`
    + `${gap.why ? ` —— ${gap.why}` : ""}`;
  parent.append(row);
}

function renderDetail(file, reading) {
  detail.replaceChildren();
  appendText(detail, "h2", file.path).id = "stage-artifact-detail-title";
  const meta = document.createElement("div");
  meta.className = "stage-detail-meta";
  for (const value of [
    fileMeta(file), file.folder === "." ? "仓库根目录" : `${file.folder}/`,
    `${reading.size} bytes`, reading.kind === "binary" ? "binary" : "text",
  ]) appendText(meta, "span", value);
  detail.append(meta);

  const panels = {
    content: contentPanel(file, reading),
    diff: diffPanel(reading),
    facts: factsPanel(file, reading),
  };
  const tabs = document.createElement("div");
  tabs.className = "stage-detail-tabs";
  tabs.setAttribute("role", "tablist");
  const body = document.createElement("div");
  const defaultTab = file.code && reading.diff ? "diff" : "content";
  const choose = (name) => {
    for (const button of tabs.children) {
      button.setAttribute("aria-selected", String(button.dataset.tab === name));
    }
    body.replaceChildren(panels[name]);
  };
  for (const [name, label] of [["content", "正文"], ["diff", "DIFF"], ["facts", "来源与依赖"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tab = name;
    button.setAttribute("role", "tab");
    button.textContent = label;
    button.addEventListener("click", () => choose(name));
    tabs.append(button);
  }
  detail.append(tabs, body);
  choose(defaultTab);
}

function renderDetailMessage(title, message) {
  detail.replaceChildren();
  appendText(detail, "h2", title).id = "stage-artifact-detail-title";
  appendText(detail, "p", message, "stage-detail-hint");
}

async function selectFile(path) {
  const file = model?.scene.files.find((candidate) => candidate.path === path);
  if (!file || selectedRound === null || target === null) return;
  selectedPath = path;
  for (const [candidate, row] of rows) {
    row.setAttribute("aria-selected", String(candidate === path));
  }
  scene?.select(path);
  renderDetailMessage(path, "正在读取这轮固定下来的正文与差异…");
  const version = ++requestVersion;
  const query = new URLSearchParams({
    change: target.changeId,
    phase: target.phase,
    round: String(selectedRound),
    path,
  });
  try {
    const { status, body } = await fetchJson(`/api/stage-file?${query}`);
    if (closed || version !== requestVersion || selectedPath !== path) return;
    if (status !== 200) {
      renderDetailMessage(path, FAILURE_WORDS[body.error] ?? `文件读取失败（${body.error ?? status}）。`);
      return;
    }
    scene?.select(path, body.dependencies);
    renderDetail(file, body);
  } catch (error) {
    if (error?.name !== "AbortError" && version === requestVersion) {
      renderDetailMessage(path, "文件读取中断；StagePass 会继续保留这轮的清单事实。");
    }
  }
}

function installScene() {
  scene?.dispose();
  scene = createStageArtifactScene(canvas, {
    onSelect(path) { void selectFile(path); },
  });
}

async function load(round = selectedRound, quiet = false) {
  if (target === null || closed) return;
  const version = ++requestVersion;
  if (!quiet) showEmpty("正在从产物账本建立本轮投影…");
  const query = new URLSearchParams({ change: target.changeId, phase: target.phase });
  if (round !== null) query.set("round", String(round));
  try {
    const { status, body } = await fetchJson(`/api/stage-artifacts?${query}`);
    if (closed || version !== requestVersion) return;
    if (status !== 200) {
      model = null;
      selectedRound = null;
      scene?.setModel({ inputs: [], folders: [], files: [], production: [] });
      list.replaceChildren(); timeline.replaceChildren();
      roundLabel.textContent = "产物不可用";
      showEmpty(FAILURE_WORDS[body.error] ?? `阶段产物读取失败（${body.error ?? status}）。`);
      renderDetailMessage("没有可读投影", empty.textContent);
      return;
    }
    model = body;
    selectedRound = body.selectedRound;
    roundLabel.textContent = selectedRound === null
      ? "尚无已结算轮次"
      : `第 ${selectedRound} 轮${body.scene.source === "reconstructed" ? " · 保守重建" : " · 已结算"}`;
    renderTimeline();
    const keep = body.scene.files.some((file) => file.path === selectedPath)
      ? selectedPath : preferredFile();
    selectedPath = keep;
    scene?.setModel(body.scene);
    renderList();
    if (body.incomplete) {
      showEmpty("这一轮发生过，但旧数据不足以证明完整文件集合；StagePass 没有拿当前工作树来冒充历史。 ");
      renderDetailMessage("历史清单不完整", "你仍可从时间轴切回有证据的轮次。 ");
    } else if (body.scene.empty) {
      showEmpty(selectedRound === null
        ? "这个阶段还没有已结算产物。顶部的下一步会告诉你现在该做什么。"
        : "这一轮已结算，但产物清单中没有文件。这里不会拿未结算工作树填空。 ");
      renderDetailMessage("尚无文件", "上游入口和轮次事实仍保留；文件产生后会出现在这里。 ");
    } else {
      hideEmpty();
      if (keep !== null) void selectFile(keep);
    }
    note.textContent = `只读 · ${body.scene.files.length} 个文件 · ${body.scene.inputs.length} 个上游入口`
      + (body.stageFacts.length > 0 ? ` · ${body.stageFacts.length} 个阶段级问题` : "")
      + "。浏览不会启动 turn 或推动闸门。";
  } catch (error) {
    if (error?.name !== "AbortError" && version === requestVersion) {
      showEmpty("产物 API 暂时不可达；已结算事实没有被改动。 ");
    }
  }
}

function close() {
  closed = true;
  requestVersion += 1;
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
  scene?.dispose();
  scene = null;
  target = null;
  model = null;
  selectedPath = null;
  selectedRound = null;
  rows.clear();
  search.value = "";
}

function open(input) {
  close();
  closed = false;
  target = input;
  setHeader(input);
  installScene();
  showEmpty("正在从产物账本建立本轮投影…");
  void load(null);
  refreshTimer = setInterval(() => { void load(selectedRound, true); }, 5_000);
}

search.addEventListener("input", () => { filterFiles(search.value); });

window.stagepassArtifacts = { open, close };
