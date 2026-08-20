/**
 * 判据单答案文件的读回 —— **代码预铺格子，模型只填空。**
 *
 * ## 它撑着的是闸门
 *
 * 一张判据单齐不齐，是 `computeGate` 的第三条判据（`domain/gate.ts` 的
 * `sheetMissing`）。而「齐不齐」必须由**代码**判：前两条闸门问的是模型报了什么，
 * 而 severity 是模型自己填的一格，P2 一条都不挡 —— 今天模型写一个词，一条问题就
 * 从闸门上消失了（PRD §3.1）。这里数出来的东西模型改不动：它只能在自己那一行写
 * 一个枚举和一句散文。
 *
 * ## 为什么和 `domain/worklist.ts` 逐字同构
 *
 * 一个人手里两种格式，就是两次答错的机会 —— 那是 `worklist` 自己的原话。所以行的
 * 形状（`ANSWER_LINE`）、「读不懂的行不算问题」、「答一半不作废」三条全部照抄，
 * 一个字都不另立。有一条测试把同一份文本喂给两个 reader 比结果，因为写在注释里的
 * 「和 xx 同形」保不住任何东西。
 *
 * ## 答一半不作废（和反方那份判定相反）
 *
 * 反方那份数不对就整份作废，理由是它按序号**映射位置**，错位会让一条判定挂到别的
 * 标准上。这一份不会：每行自带序号，映射逐条独立 —— 少一行就是少一条，不会让别的
 * 条错位。而少的那几条会原样出现在 `missing` 里，闸门照挡。
 */

/**
 * 模型对一条判据的声称。**枚举，不是散文。**
 *
 * `pass` 不是「通过」，是「我声称满足了，证据在这里」—— 能不能过要先过代码的形式
 * 检查（这个文件），再过人（面板）。`blocked` 是「这条我判不了」，它是一种**交代**，
 * 不是漏答；`n_a` 是「这个阶段不适用」。
 */
export const CLAIMS = ["pass", "blocked", "n_a"] as const;
export type Claim = (typeof CLAIMS)[number];

export interface SheetLine {
  readonly ordinal: number;
  readonly claim: Claim;
  /**
   * 证据，散文。`claim = pass` 时必须非空（PRD §3.1）—— 空的那条进 `missing`。
   *
   * `blocked` / `n_a` 允许为空：反过来要求它们也写，会让「这条我判不了」变成一条
   * 永远填不完的格子，而那正是它存在的意义。
   */
  readonly evidence: string;
}

export interface SheetRead {
  /** 收下来的那几条，按文件里出现的先后。 */
  readonly lines: readonly SheetLine[];
  /**
   * 还没交代的序号，**升序不重**。它要直接摆到面板上给人照着补，也是闸门读的那一格。
   *
   * 三种都算没交代：整条没写、claim 认不出来、`pass` 但证据是空的。第三种是这里
   * 最要紧的一格 —— 它不是格式错，是没交代，闸门要拦的正是它。
   */
  readonly missing: readonly number[];
  /**
   * 写坏了的地方，**每一条都带序号**，人拿着它能直接翻到那一行。
   *
   * 不叫「错误」是因为它不作废任何东西：答上的照样算数。而认不出来的那一条**同时**
   * 进 `missing` —— 只进这里的话，一张全写着 `maybe` 的单子会一条 missing 都没有，
   * 闸门当场放行。
   */
  readonly problems: readonly string[];
}

/**
 * 一条答案在文件里长什么样。**和 `worklist.ts` 的 `ANSWER_LINE` 逐字相同。**
 *
 * 序号之外，模型写的全是枚举和散文 —— criterion key 一个字都不进这份文件
 * （见 `store/worklist-store.ts` 开头那段：抄漏一段，一整份判定作废）。
 */
const SHEET_LINE = /^(\d+)\s*[:：]\s*([^\s—–-]+)\s*(.*)$/;

const isClaim = (value: string): value is Claim =>
  (CLAIMS as readonly string[]).includes(value);

/**
 * 读回一份判据单的答案。`count` 是这一轮判据单上有几条。
 *
 * `count = 0` 时什么都不缺：**「这个阶段没有判据单」和「有判据单但没填」是两件事**，
 * 前者不该挡门。
 */
export function readSheet(text: string, count: number): SheetRead {
  const lines: SheetLine[] = [];
  const problems: string[] = [];
  const answered = new Set<number>();
  const seen = new Set<number>();

  for (const raw of text.split("\n")) {
    // 前面那个 `- ` 是排版（人爱写成列表），不是内容。和 worklist 同一行代码。
    const line = raw.trim().replace(/^[-*]\s*/, "");
    const matched = SHEET_LINE.exec(line);
    // 读不懂的行不是问题：它可能是标题、说明或者空行。把标题判成格式错，人打开
    // 面板看到的是一串假警报，而真警报就淹在里面了。
    if (matched === null) continue;

    const ordinal = Number(matched[1]);
    const claim = matched[2]!;
    // 依据前面那串破折号/空格是排版，不是内容。
    const evidence = (matched[3] ?? "").replace(/^[—–-]+\s*/, "").trim();

    if (ordinal < 1 || ordinal > count) {
      problems.push(`sheet_line_out_of_range:${ordinal}`);
      continue;
    }
    if (seen.has(ordinal)) {
      // 第二条不覆盖第一条：谁先写的谁算数，而重的那一条要报出来让人自己收拾。
      problems.push(`sheet_line_duplicated:${ordinal}`);
      continue;
    }
    seen.add(ordinal);
    if (!isClaim(claim)) {
      // **两个都要**：只进 problems，这一条就从 missing 里消失了（闸门放行）；
      // 只进 missing，人看见「你没答第 N 条」而他明明写了，会再写一遍同样的东西。
      problems.push(`sheet_claim_unknown:${ordinal}`);
      continue;
    }
    if (claim === "pass" && evidence === "") {
      // 不进 problems：它不是格式错，是没交代。进了 problems，人会去改格式，
      // 而真正缺的是那句话。
      continue;
    }
    answered.add(ordinal);
    lines.push({ ordinal, claim, evidence });
  }

  const missing: number[] = [];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    if (!answered.has(ordinal)) missing.push(ordinal);
  }
  return { lines, missing, problems };
}
