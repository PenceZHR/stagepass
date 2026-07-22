import { createChildLogger } from "../logger";

const log = createChildLogger("per-row-degradation");

/**
 * Run a per-row computation over a collection so that one row's failure costs
 * that row and nothing else.
 *
 * Several read paths fan a whole page out of a `.map()`/`.flatMap()` over DB
 * rows or file paths, and the route above them wraps the lot in a single
 * try/catch that answers 500. That arrangement quietly turns any single-row
 * exception into total loss of the page: fifteen phases, every gate and every
 * action disappear because one stale row pointed at a path whose parent had
 * become a regular file. The per-row work is independent, so the failure
 * containment should be too.
 *
 * Degradation here is deliberately *loud*: every swallowed error is logged with
 * the row that produced it, and `degrade` is required to return a value that
 * still marks the row as bad to the caller. Callers must not use this to paper
 * over failures -- a degraded row has to stay distinguishable from a healthy
 * one in the response, or the next reader learns nothing from the missing data.
 *
 * This is the shared rule for that containment. Both `inspectArtifactMirrors`
 * (artifact-mirror-service) and `readKnownFiles` (change-phase-service) derive
 * their per-row recovery from it rather than each carrying a private try/catch
 * that can drift from the other.
 */
export function mapRowsDegrading<Row, Out>(
  rows: Iterable<Row>,
  options: {
    /** Named for the log line, e.g. "inspectArtifactMirrors". */
    operation: string;
    /** Stable identity of a row, used only for diagnostics. */
    identify: (row: Row) => string;
    /** The real work. May throw; only this row pays for it. */
    perRow: (row: Row) => Out;
    /**
     * Replacement value for a row whose `perRow` threw. Must keep the failure
     * visible to the caller (a warning entry, a `missing` marker, ...) rather
     * than returning something indistinguishable from success.
     */
    degrade: (row: Row, error: unknown) => Out;
  },
): Out[] {
  const results: Out[] = [];
  for (const row of rows) {
    try {
      results.push(options.perRow(row));
    } catch (error) {
      log.error(
        {
          operation: options.operation,
          row: options.identify(row),
          err: error instanceof Error ? error.message : String(error),
        },
        "Row failed; degrading this row instead of the whole response",
      );
      results.push(options.degrade(row, error));
    }
  }
  return results;
}
