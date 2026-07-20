/** Shared safety limits for repeated Fix work. */
export const MAX_FIX_ITERATIONS = 99;

export function maxFixIterationsErrorMessage(): string {
  return `Max fix iterations (${MAX_FIX_ITERATIONS}) reached`;
}
