import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTrustOps } from "./trust";

/**
 * Codex 的目录信任，从这一侧查得出来。
 *
 * ## 为什么非要查
 *
 * 2026-07-30 实测：一个 Codex 没信任过的目录，派一轮下去它**停在信任提问上等人**，
 * 而 StagePass 这一侧看得见的只有「没有新线程出现」—— 然后等满 30 分钟超时。
 * 界面上它和「在跑」一模一样，正是这个产品存在的理由那一类。
 *
 * ```
 * You are in …/workspace
 * Do you trust the contents of this directory?
 * › 1. Yes, continue   2. No, quit
 * ```
 *
 * ## 判据是 git 根，不是 cwd，也不是逐级往上找
 *
 * 同一天用排除法定下来的：`…/full-round-0730/workspace` 不是 git 仓库、它的 git 根是
 * 受信任的 `stagepass`，跑得起来；`…/build-0730/workspace` 我 `git init` 过、于是
 * git 根是它自己，不在名单里，撞上了提问。
 *
 * **两者的祖先目录完全一样**（都在 stagepass 和 /Users/zhanghr 底下，两个都受信任），
 * 所以「逐级往上找」解释不了这个差别 —— 只有「按 git 根查、精确匹配」解释得了。
 */

function configWith(entries: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "stagepass-trust-")), "config.toml");
  writeFileSync(path, entries, "utf-8");
  return path;
}

const TRUSTED = "/Users/someone/Desktop/repo";

describe("codex · 这个目录信任过吗", () => {
  it("名单里有，而且写着 trusted", () => {
    const ops = createTrustOps({
      configPath: configWith(`[projects."${TRUSTED}"]\ntrust_level = "trusted"\n`),
      gitRoot: () => TRUSTED,
    });
    assert.equal(ops.isTrusted("/Users/someone/Desktop/repo/sub"), true);
  });

  it("**名单里没有 —— 是 false，不是 null**", () => {
    // 这一格是承重的：只有明确的 false 才拦得住派发。分不清「没信任」和「查不出来」，
    // 这一层就白加了。
    const ops = createTrustOps({
      configPath: configWith(`[projects."${TRUSTED}"]\ntrust_level = "trusted"\n`),
      gitRoot: () => "/Users/someone/Desktop/别的仓库",
    });
    assert.equal(ops.isTrusted("/Users/someone/Desktop/别的仓库"), false);
  });

  it("有这一条但不是 trusted —— 也是 false", () => {
    const ops = createTrustOps({
      configPath: configWith(`[projects."${TRUSTED}"]\ntrust_level = "untrusted"\n`),
      gitRoot: () => TRUSTED,
    });
    assert.equal(ops.isTrusted(TRUSTED), false);
  });

  it("**查按 git 根，不按 cwd** —— 仓库里的子目录跟着仓库", () => {
    const ops = createTrustOps({
      configPath: configWith(`[projects."${TRUSTED}"]\ntrust_level = "trusted"\n`),
      gitRoot: (cwd) => (cwd.startsWith(TRUSTED) ? TRUSTED : null),
    });
    assert.equal(ops.isTrusted(`${TRUSTED}/docs/deep/inside`), true);
  });

  it("不是 git 仓库 —— 退回按目录本身查", () => {
    const plain = "/Users/someone/scratch";
    const ops = createTrustOps({
      configPath: configWith(`[projects."${plain}"]\ntrust_level = "trusted"\n`),
      gitRoot: () => null,
    });
    assert.equal(ops.isTrusted(plain), true);
  });

  it("**读不到配置 —— null，不是 false**", () => {
    // 读不到别人的配置就说不知道，然后照旧往下走。因为读不到就拦住派发，等于
    // 一个装了 Codex 但配置换了地方的人从此什么都跑不了。
    const ops = createTrustOps({
      configPath: "/nowhere/config.toml", gitRoot: () => TRUSTED,
    });
    assert.equal(ops.isTrusted(TRUSTED), null);
  });

  it("别的项目那一段的 trust_level 不算这一段的", () => {
    // 段落边界要认得住 —— 认错了会把一个没信任的目录报成信任。
    const ops = createTrustOps({
      configPath: configWith(
        `[projects."${TRUSTED}"]\ntrust_level = "trusted"\n\n`
        + `[projects."/Users/someone/other"]\n`),
      gitRoot: () => "/Users/someone/other",
    });
    assert.equal(ops.isTrusted("/Users/someone/other"), false);
  });

  it("路径里有正则元字符也查得对", () => {
    // `[projects."…"]` 是拿路径拼出来的。不转义的话，名字里一个 `.` 或 `+`
    // 就会让它匹配到别的目录 —— 而报错的方向是「说它信任」，最坏的那个方向。
    const weird = "/Users/someone/a+b (c)/d.e";
    const ops = createTrustOps({
      configPath: configWith(`[projects."${weird}"]\ntrust_level = "trusted"\n`),
      gitRoot: () => weird,
    });
    assert.equal(ops.isTrusted(weird), true);
  });
});
