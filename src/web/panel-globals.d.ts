/*
 * 图谱那两个前端文件是 ES module，靠 importmap（panel.html）把裸名和绝对路径
 * 指到 ASSETS 喂出来的真文件。tsc 不认识 importmap，所以在这里把**运行时真实
 * 存在的模块名**逐个声明掉：描述现实，不发明。
 */
declare module "three";
declare module "three/addons/renderers/CSS2DRenderer.js";
declare module "three/addons/controls/OrbitControls.js";

/** panel.js ↔ graph-view.js 唯一的握手（图谱 spec 2026-08-12）。 */
interface Window {
  /**
   * 起始收起状态 —— 只有 Codex widget 那一面会设。
   *
   * 浏览器里这件事由 `?collapsed=1` 说；widget 里没有地址栏，只能由宿主注入的
   * 那段序言给。插件默认收起：~700px 的框里，大环独占才看得清。
   */
  __SP_COLLAPSED__?: boolean;
  /**
   * 起始的 Change 和项目 —— 只有 Codex widget 那一面会设。
   *
   * 浏览器里这两样在地址栏（`?change=`/`?project=`）；widget 里没有地址栏，
   * 由插件按 **Codex 当前打开的目录**认好之后从 `toolOutput` 交过来
   * （用户 2026-08-18 定：项目不再由人挑）。
   */
  __SP_CHANGE__?: string;
  __SP_PROJECT__?: string;
  /*
   * 阶段页上产物那半边（stage-artifact-view.js）。
   *
   * 2026-08-17 三层合一页时**把握手削到只剩真用得上的三个字段**：原来还传
   * threadId / current / live / mark / openGaps / nextStep，而它们在那边一个都
   * 没被读 —— 顶带上那几格已经改由 panel.js 自己画。传过去没人读的字段迟早
   * 变成两份会打架的事实。
   */
  stagepassArtifacts?: {
    open(stage: { changeId: string; phase: string; status: string }): void;
    /** 产物区切态。rubric 归 panel.js，这边只认 files / graph。 */
    setMode(mode: "files" | "graph"): void;
    close(): void;
  };
  stagepassGraph?: {
    open(project: {
      id: string;
      name: string;
      /** 选中的 Change —— 图谱要叠它的 Arch 图纸。null = 没选。 */
      changeId?: string | null;
    }): void;
    close(): void;
  };
}
