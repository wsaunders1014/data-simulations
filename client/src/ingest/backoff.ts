export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30 * 1000;
export function backoffDelay(attempt: number, random = Math.random) {
  const ceiling = Math.min(BACKOFF_BASE_MS * 2**attempt, BACKOFF_MAX_MS);
  const delay = Math.floor(random() * ceiling);

  return delay;
}
