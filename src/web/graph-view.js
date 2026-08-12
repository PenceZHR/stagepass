/**
 * 图谱的编排那一半（spec 2026-08-12）：取数、文件列表、详情、门清单、勾目录。
 *
 * 它是 panel.js 之外的第二个前端文件，故意的 —— panel.js 已经 3200 行。
 * 两边只握一次手：panel.js 调 `window.stagepassGraph.open/close`，别的互不认识。
 *
 * **点 3D 的球和点左边的列表是同一件事的两条路**（raycast 会点不准，列表永远点得准，
 * 键盘和屏幕阅读器也只认列表）—— 两边共用同一个选中态，谁点都一样。
 */
import { createGraphScene } from "/graph-scene.js";

const pick = (id) => document.getElementById(id);

let scene = null;          // WebGL 场景；null = 还没建或建不出（降级）
let model = null;
let project = null;
let rows = [];             // 列表行，下标 = 节点下标
let ingredientCache = new Map();

const layerTint = (layer) =>
  ["#d9b28e", "#a97879", "#8e9bb3", "#9fae8e", "#c4a2b8", "#b3a08e"][layer % 6];

async function fetchJson(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({ error: "bad-json" }));
  return { status: response.status, body };
}

/** 错误一句话说清 —— 空图和「路径填错了」长得一模一样，所以绝不画空图。 */
const FAILURES = {
  "no-path": "这个项目还没有路径 —— 先在项目上填它的代码在哪。",
  "not-a-repo": "这个路径下没有 git 仓库。图谱只认 git 跟踪的文件。",
  "project-unknown": "项目不存在了。",
};

async function open(target) {
  project = target;
  pick("graph-project").textContent = `${target.name} · ${target.id}`;
  pick("graph-empty").hidden = true;

  // 选中的 Change 带上：服务端会叠 Arch 的图纸（规划 vs 真实）。
  const withChange = target.changeId
    ? `&change=${encodeURIComponent(target.changeId)}` : "";
  const { status, body } = await fetchJson(
    `/api/graph?project=${encodeURIComponent(target.id)}${withChange}`);
  if (status !== 200) {
    showEmpty(FAILURES[body.error] ?? `图谱取不下来（${body.error ?? status}）`);
    return;
  }
  model = body;

  if (scene === null) {
    scene = createGraphScene(pick("graph-canvas"), { onSelect: reflectSelection });
    if (scene === null) {
      showEmpty("这台浏览器没有 WebGL —— 3D 关了，列表照常能用。");
    }
  }
  scene?.setModel(model);
  scene?.setOverlay(model.plan?.ok ? model.plan.overlay : null);
  renderList("");
  renderDoors();
  renderExcludes();
  renderDetail(null);
  renderPlan();
  if (model.nodes.length === 0) {
    showEmpty("这个项目里没有能解析的代码模块（图谱现在只认 TS/JS 一族）。"
      + "下面的目录清单还是真的。");
  }
}

function close() {
  scene?.dispose();
  scene = null;
  model = null;
  ingredientCache = new Map();
}

function showEmpty(message) {
  const empty = pick("graph-empty");
  empty.textContent = message;
  empty.hidden = false;
}

/** 列表：全部节点、可搜、可点 —— 「每个文件都点得到」的保底那条路。 */
function renderList(query) {
  const list = pick("graph-list");
  const needle = query.trim().toLowerCase();
  rows = [];
  const fragment = document.createDocumentFragment();
  for (const [index, node] of (model?.nodes ?? []).entries()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "graph-row";
    row.hidden = needle !== "" && !node.path.toLowerCase().includes(needle);
    const dot = document.createElement("span");
    dot.className = "graph-dot";
    dot.style.background = layerTint(node.layer);
    const name = document.createElement("span");
    name.textContent = node.path;
    const blast = document.createElement("em");
    blast.textContent = String(node.blast);
    blast.title = "爆炸半径：改它会波及几个文件";
    row.append(dot, name, blast);
    row.addEventListener("click", () => {
      scene?.select(index);
      scene?.flyTo(index);
      if (scene === null) reflectSelection(index);   // 降级时列表自己当选中态
    });
    rows.push(row);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}

/** 3D 和列表共用的选中态回流：详情卡 + 列表高亮 + 近景配料单牌。 */
function reflectSelection(index) {
  for (const [other, row] of rows.entries()) {
    row.setAttribute("aria-selected", String(other === index));
  }
  renderDetail(index);
  if (index !== null) void loadIngredients(index);
}

function renderDetail(index) {
  const detail = pick("graph-detail");
  if (index === null || model === null) {
    detail.replaceChildren();
    const hint = document.createElement("p");
    hint.className = "graph-hint";
    hint.textContent = model === null ? ""
      : `${model.nodes.length} 个模块 · ${model.edges.length} 条依赖`
        + (model.cycles.length > 0 ? ` · ${model.cycles.length} 个环` : "")
        + (model.dangling.length > 0 ? ` · ${model.dangling.length} 个缺口` : "");
    detail.append(hint);
    return;
  }
  const node = model.nodes[index];
  const dependencies = model.edges.filter((edge) => edge.from === index).length;
  const dependents = model.edges.filter((edge) => edge.to === index).length;
  detail.replaceChildren();
  const path = document.createElement("h3");
  path.textContent = node.path;
  const facts = document.createElement("dl");
  for (const [term, value] of [
    ["它依赖", `${dependencies} 个`],
    ["谁依赖它", `${dependents} 个`],
    ["爆炸半径", `${node.blast} / ${model.nodes.length}`],
    ["导出", `${node.exports} 个`],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    facts.append(dt, dd);
  }
  const gaps = model.dangling.filter((gap) => gap.from === index);
  detail.append(path, facts);
  if (gaps.length > 0) {
    const warn = document.createElement("p");
    warn.className = "graph-warn";
    warn.textContent = `断头的边：${gaps.map((gap) => gap.missing).join("、")}（图里没有这个文件）`;
    detail.append(warn);
  }
  const body = document.createElement("pre");
  body.className = "graph-ingredients";
  body.textContent = "…";
  detail.append(body);
}

/**
 * 近景的真货：`/api/file` = `ingredientsFor` 原样 —— 正文 + 依赖的签名 + 谁依赖它。
 * 飞到跟前看到的就是 AI 被喂的那份配料单本身。
 */
async function loadIngredients(index) {
  const node = model.nodes[index];
  if (!ingredientCache.has(node.path)) {
    const { status, body } = await fetchJson(
      `/api/file?project=${encodeURIComponent(project.id)}`
      + `&path=${encodeURIComponent(node.path)}`);
    ingredientCache.set(node.path, status === 200 ? body : null);
  }
  const list = ingredientCache.get(node.path);
  const holder = pick("graph-detail").querySelector(".graph-ingredients");
  if (holder === null) return;
  if (list === null) { holder.textContent = "配料单取不下来。"; return; }
  const signatures = list.dependencies
    .map((dependency) => `── ${dependency.path}\n${dependency.signatures.join("\n")}`)
    .join("\n\n");
  holder.textContent = `${list.own[0]?.text ?? ""}\n\n${
    signatures === "" ? "（没有依赖 —— 它是地基）" : `依赖的签名（只有签名，没有实现）：\n\n${signatures}`}`;

  // 3D 里的近景牌：名字 + 前几条签名，飞到跟前才翻出来。
  const card = document.createElement("div");
  card.className = "graph-near-card";
  const title = document.createElement("b");
  title.textContent = node.path;
  const lines = document.createElement("pre");
  lines.textContent = (list.dependencies.flatMap((dependency) => dependency.signatures))
    .slice(0, 6).join("\n") || "（没有依赖）";
  card.append(title, lines);
  scene?.showNearCard(index, card);
}

/** kind → 人话。和 reconcile 的六类一一对应，别发明第七类。 */
const FINDING_NAMES = {
  concept_homeless: "概念未落地",
  concept_scattered: "概念散落",
  module_overloaded: "模块超载",
  module_unclaimed: "模块无主",
  relation_unimplemented: "关系没实现",
  dependency_unplanned: "计划外依赖",
};

/**
 * 规划 vs 真实（BACKLOG §十一）。三态分明：没选 Change、Arch 还没产图纸、
 * 图纸坏了逐条读毛病、图纸好了逐条读发现 —— 图上画的和这里读的是同一份。
 */
function renderPlan() {
  const holder = pick("graph-plan");
  holder.replaceChildren();
  const note = (text) => {
    const hint = document.createElement("p");
    hint.className = "graph-hint";
    hint.textContent = text;
    holder.append(hint);
  };
  if (!project?.changeId) {
    note("没有选中的 Change —— 选一个再进图谱，这里会叠 Arch 的图纸。");
    return;
  }
  const plan = model?.plan;
  if (plan === undefined || (plan.ok === false && plan.reason === "missing")) {
    note(`Arch 还没产出图纸（docs/stagepass/${project.changeId}/arch.graph.json）。`
      + "Arch 阶段跑过之后这里会亮。");
    return;
  }
  if (plan.ok === false) {
    note("图纸不合法 —— 这要打回 Arch：");
    for (const defect of plan.defects) {
      const row = document.createElement("p");
      row.className = "graph-warn";
      row.textContent = defect;
      holder.append(row);
    }
    return;
  }
  const overlay = plan.overlay;
  note(`${overlay.concepts.length} 个概念 · ${overlay.relations.length} 条关系 · `
    + (overlay.findings.length === 0 ? "对账无发现 —— 图纸和代码是一致的"
      : `${overlay.findings.length} 条对账发现`));
  for (const finding of overlay.findings) {
    const row = document.createElement("div");
    row.className = "graph-finding";
    const badge = document.createElement("b");
    badge.textContent = FINDING_NAMES[finding.kind] ?? finding.kind;
    const detail = document.createElement("span");
    detail.textContent = finding.detail;
    row.append(badge, detail);
    holder.append(row);
  }
}

/** 门：不上图的那些，一扇一行。点开 = 系统文件管理器，图谱不做文件浏览器。 */
function renderDoors() {
  const doors = pick("graph-doors");
  doors.replaceChildren();
  for (const door of model?.assetDirs ?? []) {
    const row = document.createElement("div");
    row.className = "graph-door";
    const name = document.createElement("span");
    name.textContent = door.dir === "." ? "（仓库根）" : door.dir;
    const count = document.createElement("em");
    count.textContent = `${door.files} 个`;
    row.append(name, count);
    doors.append(row);
  }
}

/** 勾目录：判据的人那半。勾掉 → POST → 整张图重取。 */
function renderExcludes() {
  const holder = pick("graph-excludes");
  holder.replaceChildren();
  const dirs = new Set(
    (model?.nodes ?? []).map((node) =>
      node.path.includes("/") ? node.path.split("/")[0] : "."));
  for (const excluded of model?.excluded ?? []) dirs.add(excluded.split("/")[0]);

  for (const dir of [...dirs].sort()) {
    if (dir === ".") continue;
    const label = document.createElement("label");
    label.className = "graph-exclude";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !(model?.excluded ?? []).includes(dir);
    box.addEventListener("change", () => { void toggleDir(dir, box.checked); });
    const text = document.createElement("span");
    text.textContent = `${dir}/`;
    label.append(box, text);
    holder.append(label);
  }
}

async function toggleDir(dir, keep) {
  const excluded = new Set(model?.excluded ?? []);
  if (keep) excluded.delete(dir);
  else excluded.add(dir);
  await fetch(`/api/graph-excludes?project=${encodeURIComponent(project.id)}`, {
    method: "POST",
    body: JSON.stringify([...excluded]),
  });
  await open(project);   // 判据变了就整张重取 —— 图不缓存，这里也不缝补
}

const search = /** @type {HTMLInputElement} */ (pick("graph-search"));
search.addEventListener("input", () => { renderList(search.value); });

window.stagepassGraph = { open: (target) => { void open(target); }, close };
