/**
 * `node:sqlite` 的类型声明 —— **只声明我们真正用到的那点表面**。
 *
 * ## 为什么手写而不是升 @types/node
 *
 * `node:sqlite` 的官方类型是 `@types/node` 22+ 才有的，这棵树钉的是 `^20`
 * （实际 20.19.43）。为了一个模块把全仓的 node 类型跨大版本升上去，会在一次
 * 本该很小的改动里牵出一片不相干的类型错 —— 不值得。
 *
 * 而且手写这份还有个好处：**它就是「插件依赖了 node:sqlite 的哪些 API」的清单**。
 * 想多用一个方法，得先在这里写下来，于是依赖面永远是显式的。
 *
 * ## 什么时候删掉它
 *
 * `@types/node` 升到 ≥22 的那一刻，整份删掉，什么都不用改 —— 下面的形状是照着
 * 官方声明写的，不是自己发明的。
 *
 * 运行时要求：Node ≥ 22.5（`DatabaseSync` 落地的版本）。本机跑的是 25.9。
 */
declare module "node:sqlite" {
  interface StatementResultingChanges {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...parameters: readonly unknown[]): unknown[];
    get(...parameters: readonly unknown[]): unknown;
    run(...parameters: readonly unknown[]): StatementResultingChanges;
  }

  interface DatabaseSyncOptions {
    readonly open?: boolean;
    readonly readOnly?: boolean;
    readonly enableForeignKeyConstraints?: boolean;
  }

  class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
