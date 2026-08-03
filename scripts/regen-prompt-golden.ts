/**
 * 重生成十三个阶段的提示词快照。
 *
 * **只在你确认那些差异就是你想要的时候跑它。** 那份 golden 的全部意义是拦住无意的
 * 漂移 —— 一个「跑一下就绿了」的习惯会把它变成装饰。
 *
 *   node --import tsx scripts/regen-prompt-golden.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { everyPhasePrompt } from "../src/domain/round-prompt.golden.test";

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "src", "domain", "round-prompt.golden.txt",
);
writeFileSync(target, everyPhasePrompt(), "utf-8");
console.log(`写好了：${target}`);
