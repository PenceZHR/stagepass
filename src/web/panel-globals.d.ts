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
  stagepassArtifacts?: {
    open(stage: {
      changeId: string;
      phase: string;
      threadId: string | null;
      state: {
        status: string;
        current: boolean;
        live: boolean;
        mark: string | null;
        openGaps: number;
      };
      nextStep: { what: string; why: string } | null;
    }): void;
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
