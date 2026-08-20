import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";

/**
 * 用 Node 内置的 `node:sqlite` 顶出一个 better-sqlite3 形状的句柄。
 *
 * ## 为什么需要它
 *
 * 插件（`~/.codex/plugins/cache/…/server.mjs`）是 Codex 拉起来的一个裸 node 进程，
 * **没有 node_modules**。而 better-sqlite3 是原生模块，打不进 bundle，也不能指望
 * 用户机器上正好有一份能用的编译产物。
 *
 * 好在整棵树里 better-sqlite3 只出现在 `import type` 里（运行时引它的**只有测试**），
 * 所以领域层和 view 层拿到什么句柄都行 —— 只要形状对。`node:sqlite` 是 Node 22.5+
 * 内置的，**零依赖**，正好补上。
 *
 * ## 只顶到「用得到」为止
 *
 * 全树实际用到的只有：`prepare().all()/.get()/.run()`、`exec()`、`pragma()`、
 * `transaction()`、`close()`。没实现的成员**不会静默返回 undefined，会当场抛**
 * 并说出是谁 —— 悄悄给个 undefined 会让调用方以为「这个库没数据」，那种错要查很久。
 *
 * ## 两处刻意的行为对齐
 *
 * - `run()` 的 `lastInsertRowid` 在 `node:sqlite` 里可能是 bigint，这里统一成 number，
 *   和 better-sqlite3 一致（调用方拿它当数字用）。
 * - `transaction()` 用 SAVEPOINT 而不是 BEGIN，因为调用方会嵌套
 *   （`turn-loop` 里事务套事务），裸 BEGIN 在嵌套时会抛。
 */

/** better-sqlite3 里 `transaction(fn)` 返回的是**一个函数**，调用它才真的跑。 */
type Transaction = <T>(fn: () => T) => (() => T);

export interface OpenOptions {
  /** 只读打开。看状态的路径应该用它 —— 看不该有副作用。 */
  readonly readOnly?: boolean;
}

export function openDatabase(path: string, options: OpenOptions = {}): Database.Database {
  const inner = new DatabaseSync(
    path,
    options.readOnly === true ? { readOnly: true } : {},
  );

  let savepointDepth = 0;

  const transaction: Transaction = (fn) => () => {
    const name = `sp_tx_${savepointDepth}`;
    savepointDepth += 1;
    inner.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      inner.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      /*
       * ROLLBACK TO 只是回到存点，存点本身还在栈上 —— 必须再 RELEASE 一次才算弹掉。
       * 少这一句，同一个连接上后续的事务会越堆越深。
       */
      inner.exec(`ROLLBACK TO ${name}`);
      inner.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      savepointDepth -= 1;
    }
  };

  const handle = {
    prepare(sql: string) {
      const statement = inner.prepare(sql);
      return {
        all: (...parameters: readonly unknown[]) => statement.all(...parameters),
        get: (...parameters: readonly unknown[]) => statement.get(...parameters),
        run: (...parameters: readonly unknown[]) => {
          const changes = statement.run(...parameters);
          return {
            changes: Number(changes.changes),
            lastInsertRowid: Number(changes.lastInsertRowid),
          };
        },
      };
    },
    exec(sql: string): void {
      inner.exec(sql);
    },
    /**
     * `pragma("foreign_keys = ON")` 这种赋值式没有结果集，返回空数组；
     * `pragma("table_info(changes)")` 这种查询式返回行 —— 和 better-sqlite3 一致。
     */
    pragma(source: string): unknown {
      return inner.prepare(`PRAGMA ${source}`).all();
    },
    transaction,
    close(): void {
      inner.close();
    },
  };

  /*
   * 没顶到的成员当场抛，别静默返回 undefined。
   * （`then` 要放行：`await` 一个对象时 JS 会去摸它的 `then`，摸到抛错就炸了。）
   */
  const passthrough = new Set(["then", "constructor", Symbol.toStringTag]);
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property in target || passthrough.has(property as string)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(
        `node:sqlite 句柄没有顶 \`${String(property)}\` —— `
        + "要用它就先在 src/plugin/sqlite-handle.ts 里实现，别让它静默返回 undefined",
      );
    },
  }) as unknown as Database.Database;
}
