/**
 * One definition of "what is the next `PREFIX-NNN` id" for the ledger tables
 * that mint sequenced ids (CHG, EVT, ART, FND, RUN...).
 *
 * The codebase had four different spellings of this question, and two of them
 * asked it wrong. The wrong spelling is `id.match(/\d+$/)` -- "the digits at the
 * end of the id" -- which is not the same question as "the sequence number of
 * this id", because the ledger tables do not hold only sequenced ids. They also
 * hold ids minted by `${prefix}-${Date.now().toString(36)}-${randomBytes(n)}`
 * (stage-raw-capture-service, prd-briefing-service, spec-battle-*) and long
 * descriptive process ids that end in a UUID fragment. Both end in digits.
 *
 * Verified against the production database on 2026-07-22:
 *
 *   - `EVT-provider_process_ended-...-3b00a3d8-e516-4591-9fd6-d25758540648`
 *     yields 25758540648 under `/\d+$/`, so the tail-reading minters produce
 *     `EVT-25758540649`. That id *does* satisfy the anchored `^EVT-(\d+)$` that
 *     the other minters read, so one refine turn moves the whole EVT sequence
 *     from 976 to 25,758,540,650 permanently.
 *   - `ART-mrut313g-70f24fb3f0768944` yields 768944, so the very next artifact
 *     minted through a tail-reading path is `ART-768945` while the anchored
 *     paths are still at `ART-075`.
 *
 * There is also a failure mode past the cosmetic one. `randomBytes(8).toString("hex")`
 * is sixteen *contiguous* hex characters with no separator, so its trailing
 * digit run can reach sixteen digits -- past 2^53. `parseInt` saturates there,
 * `n + 1 === n` becomes true, and a max+1 minter turns into a fixed point that
 * returns the same id for every subsequent row. That is a hard primary-key
 * collision, not a cosmetic one, which is why `parseSequencedId` refuses values
 * outside the safe-integer range instead of trusting them.
 *
 * These are pure functions over id strings on purpose, for the same reason
 * `build-record-identity.ts` is: the callers each own a different database seam
 * (the module singleton, an injected test db, or an in-flight transaction handle
 * so allocation can observe uncommitted rows), so an authority that held a
 * connection could not be shared by all of them.
 */

/** Width the sequence number is zero-padded to. Wider numbers are left alone. */
export const SEQUENCED_ID_PAD = 3;

/**
 * The sequence number of `id` within `prefix`'s sequence, or null if `id` is not
 * a member of that sequence.
 *
 * Membership is exact: `PREFIX-` followed by digits and nothing else. An id that
 * merely *ends* in digits is not a member, which is the whole point -- see the
 * module comment for the production ids that make the difference.
 */
export function parseSequencedId(id: string, prefix: string): number | null {
  const head = `${prefix}-`;
  if (!id.startsWith(head)) return null;
  const digits = id.slice(head.length);
  if (digits.length === 0) return null;
  for (let index = 0; index < digits.length; index += 1) {
    const code = digits.charCodeAt(index);
    if (code < 48 || code > 57) return null;
  }
  const value = Number(digits);
  // Past 2^53 the arithmetic every caller performs on this number (max, +1)
  // stops being exact and max+1 stops making progress. Such an id cannot be
  // minted by this module; if one is somehow present it is excluded from the
  // sequence rather than allowed to freeze it.
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** `PREFIX-NNN` for a sequence number. */
export function formatSequencedId(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(SEQUENCED_ID_PAD, "0")}`;
}

/** The highest sequence number in use for `prefix`, or 0 when none is. */
export function maxSequencedNumber(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    const sequence = parseSequencedId(id, prefix);
    if (sequence !== null && sequence > max) max = sequence;
  }
  return max;
}

/**
 * The next free id in `prefix`'s sequence.
 *
 * Allocation is monotonic -- max+1, never the lowest free gap. Reuse is not a
 * cosmetic preference: `createChange` names each change's git branch after its
 * id, `deleteChange` deliberately leaves that branch alone (it can hold
 * unmerged work), and `createChange` checks out a branch that already exists
 * rather than failing. Handing a fresh change a recycled id therefore hands it
 * the deleted change's branch, with the deleted change's commits already on it,
 * as the starting point for its first diff. Reproduced end to end on
 * 2026-07-22 in a throwaway repo: create -> commit -> delete -> create returned
 * the same `CHG-001`, checked out `ship/chg-001/<slug>`, and the prior change's
 * file was sitting in the working tree.
 *
 * The trailing collision walk covers the ids that are in the sequence but above
 * the maximum only by accident, and keeps allocation total even if the table
 * already holds something unexpected.
 */
export function nextSequencedId(ids: Iterable<string>, prefix: string): string {
  const taken = new Set<string>();
  let max = 0;
  for (const id of ids) {
    taken.add(id);
    const sequence = parseSequencedId(id, prefix);
    if (sequence !== null && sequence > max) max = sequence;
  }

  // Bounded, not `while (taken.has(candidate))`. Every candidate the walk
  // rejects is a distinct member of `taken`, so a free one must appear within
  // `taken.size + 1` steps *provided each step advances*. Past 2^53 it does not:
  // `sequence += 1` is a no-op there, the candidate never changes, and an
  // unbounded walk spins forever. parseSequencedId already keeps such values out
  // of `max`, so this is the second lock on the same door -- but it was found by
  // removing the first one and watching the test run hang instead of fail, which
  // is a worse failure than the one being guarded against.
  let sequence = max + 1;
  let candidate = formatSequencedId(prefix, sequence);
  for (let step = 0; step <= taken.size && taken.has(candidate); step += 1) {
    sequence += 1;
    candidate = formatSequencedId(prefix, sequence);
  }
  if (taken.has(candidate)) {
    throw new Error(
      `Cannot allocate a ${prefix} id: the sequence stopped advancing at ${candidate}`,
    );
  }
  return candidate;
}
