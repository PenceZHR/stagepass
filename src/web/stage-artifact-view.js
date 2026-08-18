/**
 * Stage 产物驾驶舱的浏览器编排层：只读取已结算轮次，管理时间轴、搜索、选择和详情。
 * panel.js 只知道 open/close；这个模块不拥有闸门动作，也不触发原生会话。
 */
import { createStageArtifactScene } from "./stage-artifact-scene.js";

const pick = (id) => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`panel.html 里没有 #${id}`);
  return found;
};

const canvas = pick("stage-artifact-canvas");
const empty = pick("stage-artifact-empty");
const list = pick("stage-artifact-list");
const detail = pick("stage-artifact-detail");
const cockpit = pick("stage-view");
const roundStrip = pick("stage-artifact-round");
const timelineSummary = pick("stage-timeline-summary");
const search = /** @type {HTMLInputElement} */ (pick("stage-artifact-search"));
const stageState = pick("stage-state");
const adapterLabel = pick("stage-artifact-adapter");
const note = pick("stage-note");

const ADAPTERS = {
  PRD: { label: "REQUIREMENT EVIDENCE", role: "producer", prefer: /\.md$/i },
  Spec: { label: "BEHAVIOR CONTRACT", role: "producer", prefer: /\.md$/i },
  Arch: { label: "ARCHITECTURE PROJECTION", role: "structured", prefer: /arch\.graph\.json$|\.md$/i },
  BuildPlan: { label: "IMPLEMENTATION MAP", role: "producer", prefer: /\.md$/i },
  TestPlan: { label: "TEST STRATEGY", role: "producer", prefer: /\.md$/i },
  Build: { label: "CODE DELIVERY", role: "delivery", prefer: /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i },
  Test: { label: "TEST DELIVERY", role: "delivery", prefer: /(?:\.test\.|\/tests?\/)/i },
  QA: { label: "VERIFICATION EVIDENCE", role: "structured", prefer: /\.json$|\.md$/i },
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
let groups = new Map();
let selectedPath = null;
let selectedRound = null;
let listSignature = null;
let timelineSignature = null;
let detailKey = null;
let refreshTimer = null;
let requestVersion = 0;
let closed = true;
/** 产物区这边在哪一态：files 或 graph。星图的场景只在 graph 上存在。 */
let mode = "files";

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

function setProjectionState(state) {
  cockpit.dataset.projection = state;
  search.disabled = state !== "ready";
}

/**
 * 顶带上归这边写的那一格。
 *
 * 2026-08-17 三层合一页之后这里**只剩状态一句**：下一步、判定章、未决问题数、
 * 轮次标签原来在这儿各画一份，而弹层里也各有一份 —— 同一句话两个出处，迟早
 * 有一天只有一个跟上。四份重复现在都归 panel.js 那半边或轮次条独有。
 */
function setHeader(input) {
  stageState.textContent = input.status;
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

function roundEntries() {
  const rounds = [...(model?.rounds ?? [])].sort((left, right) => left.round - right.round);
  const incomplete = (model?.incompleteRounds ?? []).map((round) => ({ round, incomplete: true }));
  return [...rounds, ...incomplete].sort((left, right) => left.round - right.round);
}

function describeRound(entry) {
  if (entry === undefined) return "";
  if (entry.incomplete === true) return `第 ${entry.round} 轮 · 历史清单不完整`;
  return `第 ${entry.round} 轮 · ${entry.source === "reconstructed" ? "保守重建 · " : "已结算 · "}`
    + countChanges(entry.files);
}

/**
 * 时间轴换行排布，永远不出现横向滚动条 —— 上一版把 22 个轮次塞进一条横带里，
 * 当前轮停在最左端看不见，人得同时拖两条横向滚动条才找得到自己在哪。
 */
function renderRounds() {
  const entries = roundEntries();
  if (entries.length === 0) {
    renderTimelineMessage("还没有已结算轮次");
    return;
  }
  const signature = JSON.stringify([entries.map((entry) => [entry.round, entry.incomplete === true]), selectedRound]);
  if (signature !== timelineSignature) {
    timelineSignature = signature;
    roundStrip.replaceChildren();
    for (const entry of entries) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "stage-round-tick";
      tick.setAttribute("role", "tab");
      tick.dataset.round = String(entry.round);
      tick.dataset.state = entry.incomplete === true ? "incomplete"
        : entry.source === "reconstructed" ? "reconstructed" : "settled";
      tick.setAttribute("aria-selected", String(entry.round === selectedRound));
      tick.title = describeRound(entry);
      tick.textContent = String(entry.round);
      tick.addEventListener("click", () => { void load(entry.round); });
      roundStrip.append(tick);
    }
  } else {
    for (const tick of roundStrip.children) {
      tick.setAttribute("aria-selected", String(Number(tick.dataset.round) === selectedRound));
    }
  }
  timelineSummary.textContent = describeRound(
    entries.find((entry) => entry.round === selectedRound),
  ) || `共 ${entries.length} 轮`;
}

function renderTimelineMessage(message) {
  timelineSignature = null;
  roundStrip.replaceChildren();
  timelineSummary.textContent = message;
}

const renderUnavailableRound = () => { renderTimelineMessage("轮次不可用"); };
const renderLoadingRound = () => { renderTimelineMessage("正在读取轮次…"); };

function fileMeta(file) {
  return `${CHANGE_WORDS[file.display] ?? file.display} · ${file.role} · R${file.changedInRound}`;
}

function renderList() {
  // 每 5 秒把整棵文件树拆了重建，会把人滚到的位置和展开状态一起清掉。
  const signature = JSON.stringify(
    (model?.scene.files ?? []).map((file) => [file.path, file.display, file.role]),
  );
  if (signature === listSignature) {
    for (const [candidate, row] of rows) {
      row.setAttribute("aria-selected", String(candidate === selectedPath));
    }
    filterFiles(search.value);
    return;
  }
  listSignature = signature;
  rows = new Map();
  groups = new Map();
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  const byFolder = new Map();
  for (const file of model?.scene.files ?? []) {
    const folder = file.folder || ".";
    const files = byFolder.get(folder) ?? [];
    files.push(file);
    byFolder.set(folder, files);
  }
  for (const [folder, files] of byFolder) {
    const group = document.createElement("section");
    group.className = "stage-file-group";
    const heading = document.createElement("div");
    heading.className = "stage-file-group-heading";
    appendText(heading, "span", folder === "." ? "仓库根目录" : `${folder}/`);
    appendText(heading, "small", String(files.length));
    const items = document.createElement("div");
    items.setAttribute("role", "group");
    group.append(heading, items);
    const paths = [];
    for (const file of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "stage-file-row";
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-selected", String(file.path === selectedPath));
      row.title = file.path;
      const change = document.createElement("span");
      change.className = "stage-file-change";
      change.dataset.change = file.display;
      const path = document.createElement("span");
      path.className = "stage-file-path";
      path.textContent = folder === "." ? file.path : file.path.slice(folder.length + 1);
      const meta = document.createElement("span");
      meta.className = "stage-file-meta";
      meta.textContent = fileMeta(file);
      row.append(change, path, meta);
      row.addEventListener("click", () => { void selectFile(file.path); });
      rows.set(file.path, row);
      paths.push(file.path);
      items.append(row);
    }
    groups.set(group, paths);
    fragment.append(group);
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
  for (const [group, paths] of groups) {
    group.hidden = !paths.some((path) => rows.get(path)?.hidden === false);
  }
  scene?.filter(needle === "" ? null : visible);
}

function preferredFile() {
  const files = model?.scene.files ?? [];
  const adapter = ADAPTERS[target?.phase];
  return files.find((file) => file.role === adapter?.role && adapter.prefer.test(file.path))?.path
    ?? files.find((file) => file.role === adapter?.role)?.path
    ?? files.find((file) => adapter?.prefer.test(file.path))?.path
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
  detailKey = `${selectedRound}::${path}`;
  for (const [candidate, row] of rows) {
    row.setAttribute("aria-selected", String(candidate === path));
  }
  rows.get(path)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  if (!quiet) {
    setProjectionState("loading");
    showEmpty("正在从产物账本建立本轮投影…");
  }
  const query = new URLSearchParams({ change: target.changeId, phase: target.phase });
  if (round !== null) query.set("round", String(round));
  try {
    const { status, body } = await fetchJson(`/api/stage-artifacts?${query}`);
    if (closed || version !== requestVersion) return;
    if (status !== 200) {
      model = null;
      selectedRound = null;
      scene?.setModel({ inputs: [], folders: [], files: [], production: [] });
      list.replaceChildren();
      renderUnavailableRound();
      setProjectionState("unavailable");
      showEmpty(FAILURE_WORDS[body.error] ?? `阶段产物读取失败（${body.error ?? status}）。`);
      renderDetailMessage("没有可读文件", "原因与下一步在这一页上边那条动作带里。 ");
      return;
    }
    model = body;
    selectedRound = body.selectedRound;
    renderRounds();
    const keep = body.scene.files.some((file) => file.path === selectedPath)
      ? selectedPath : preferredFile();
    selectedPath = keep;
    scene?.setModel(body.scene);
    renderList();
    if (body.incomplete) {
      setProjectionState("incomplete");
      showEmpty("这一轮发生过，但旧数据不足以证明完整文件集合；StagePass 没有拿当前工作树来冒充历史。 ");
      renderDetailMessage("历史清单不完整", "你仍可从轮次选择器切回有证据的轮次。 ");
    } else if (body.scene.empty) {
      setProjectionState("empty");
      showEmpty(selectedRound === null
        ? "这个阶段还没有已结算产物。上边那条动作带会告诉你现在该做什么。"
        : "这一轮已结算，但产物清单中没有文件。这里不会拿未结算工作树填空。 ");
      renderDetailMessage("尚无文件", "上游入口和轮次事实仍保留；文件产生后会出现在这里。 ");
    } else {
      setProjectionState("ready");
      hideEmpty();
      // 只有真的换了轮次或换了文件才重读正文。轮询期间人正在读的那一屏
      // 不能被自己刷掉 —— 旧实现每 5 秒把详情打回“正在读取”，滚动位置和
      // 正文/DIFF/来源的页签选择一起没。
      const wanted = keep === null ? null : `${selectedRound}::${keep}`;
      if (keep !== null && wanted !== detailKey) void selectFile(keep);
    }
    note.textContent = `只读 · ${body.scene.files.length} 个文件 · ${body.scene.inputs.length} 个上游入口`
      + (body.stageFacts.length > 0 ? ` · ${body.stageFacts.length} 个阶段级问题` : "")
      + "。浏览不会启动 turn 或推动闸门。";
  } catch (error) {
    if (error?.name !== "AbortError" && version === requestVersion) {
      model = null;
      selectedRound = null;
      scene?.setModel({ inputs: [], folders: [], files: [], production: [] });
      list.replaceChildren();
      renderUnavailableRound();
      setProjectionState("unavailable");
      showEmpty("产物 API 暂时不可达；已结算事实没有被改动。 ");
      renderDetailMessage("没有可读文件", "原因与下一步在这一页上边那条动作带里。 ");
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
  mode = "files";
  target = null;
  model = null;
  selectedPath = null;
  selectedRound = null;
  listSignature = null;
  timelineSignature = null;
  detailKey = null;
  rows.clear();
  groups.clear();
  search.value = "";
  delete cockpit.dataset.projection;
}

/**
 * 产物区切到 files 还是 graph（rubric 那一态归 panel.js，这边只当它是「不是
 * graph」）。
 *
 * **星图的场景按需建、切走就停。** 2026-08-17 之前它是一进阶段就 `installScene()`：
 * 而合成一页之后星图默认不在屏幕上，那等于开一个 WebGL 场景在看不见的地方转 ——
 * 白烧电，而且 `setSize` 量的是一个还没有尺寸的盒子。
 */
function setMode(next) {
  mode = next === "graph" ? "graph" : "files";
  if (mode !== "graph") {
    scene?.dispose();
    scene = null;
    return;
  }
  if (closed || scene !== null) return;
  installScene();
  // 场景是刚建的，它手上还没有模型 —— 已经读到的那一份现在就交给它，
  // 不然要等下一次 5 秒轮询才看得见东西。
  if (model !== null) scene.setModel(model.scene);
}

function open(input) {
  close();
  closed = false;
  target = input;
  setHeader(input);
  list.replaceChildren();
  rows.clear();
  groups.clear();
  renderLoadingRound();
  renderDetailMessage("正在读取阶段产物", "正在从产物账本建立只读投影…");
  note.textContent = "只读加载中；不会启动 turn、推动闸门或改写项目文件。";
  setProjectionState("loading");
  showEmpty("正在从产物账本建立本轮投影…");
  void load(null);
  refreshTimer = setInterval(() => { void load(selectedRound, true); }, 5_000);
}

search.addEventListener("input", () => { filterFiles(search.value); });

window.stagepassArtifacts = { open, close, setMode };
