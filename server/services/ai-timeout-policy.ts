export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function resolveAiProviderTimeoutMs(
  envName: string,
  fallback = DEFAULT_AI_PROVIDER_TIMEOUT_MS,
): number {
  const raw = process.env[envName];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= MAX_NODE_TIMER_DELAY_MS
    ? parsed
    : fallback;
}

/**
 * Race a promise against a wall-clock timeout, always clearing the timer.
 * Shared by the build and document stage runners so the timeout mechanism
 * lives in one place rather than being copied per stage service.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
