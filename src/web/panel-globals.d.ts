/**
 * panel.js 在浏览器里跑，xterm 和 fit 插件由 <script> 标签挂成全局（panel.html）。
 *
 * **形状按运行时真实的样子写，不是按好写的样子写。** 2026-08-05 装类型检查时
 * 我先把它声明成 `declare class FitAddon`，然后为了迁就声明把调用点从
 * `new FitAddon.FitAddon()` 改成了 `new FitAddon()` —— 类型检查绿了，
 * 而面板在浏览器里当场死在那一行（`FitAddon is not a constructor`），整个环
 * 一个节点都画不出来。**方向反了：声明是描述现实的，不是规定现实的。**
 *
 * 实测（0.146 那版 addon-fit.js）：`FitAddon` 是一个命名空间对象，构造器在
 * `FitAddon.FitAddon`；`Terminal` 本身就是构造器。
 */
declare class Terminal {
  constructor(options?: Record<string, unknown>);
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array): void;
  reset(): void;
  focus(): void;
  loadAddon(addon: unknown): void;
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  readonly cols: number;
  readonly rows: number;
}
declare namespace FitAddon {
  class FitAddon {
    fit(): void;
  }
}
