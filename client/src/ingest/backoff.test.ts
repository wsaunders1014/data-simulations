import { test, expect } from 'vitest';
import { backoffDelay, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from './backoff';

// backoffDelay(attempt, random = Math.random)
//   ceiling = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^attempt)
//   delay   = random() * ceiling          ← "full jitter": anywhere from 0 up to the ceiling
// Tests pass a fake `random` so the result is predictable.
const always = (n: number) => () => n;

test('the base and max are sensible: base well under a second, max at most a minute', () => {
  expect(BACKOFF_BASE_MS).toBeGreaterThan(0);
  expect(BACKOFF_BASE_MS).toBeLessThan(1000);
  expect(BACKOFF_MAX_MS).toBeGreaterThan(BACKOFF_BASE_MS);
  expect(BACKOFF_MAX_MS).toBeLessThanOrEqual(60_000);
});

test('full jitter can return 0: a lucky client retries immediately', () => {
  expect(backoffDelay(3, always(0))).toBe(0);
});

test('the ceiling doubles with each attempt', () => {
  const half = always(0.5);
  expect(backoffDelay(0, half)).toBe(BACKOFF_BASE_MS * 0.5);
  expect(backoffDelay(1, half)).toBe(BACKOFF_BASE_MS * 1);
  expect(backoffDelay(2, half)).toBe(BACKOFF_BASE_MS * 2);
  expect(backoffDelay(3, half)).toBe(BACKOFF_BASE_MS * 4);
});

test('the delay stays below the ceiling, even when random is at its highest', () => {
  const almostOne = always(0.999999);
  expect(backoffDelay(0, almostOne)).toBeLessThan(BACKOFF_BASE_MS);
  expect(backoffDelay(3, almostOne)).toBeLessThan(BACKOFF_BASE_MS * 8);
});

test('the ceiling stops growing at BACKOFF_MAX_MS', () => {
  expect(backoffDelay(20, always(0.5))).toBe(BACKOFF_MAX_MS * 0.5);
  expect(backoffDelay(21, always(0.5))).toBe(BACKOFF_MAX_MS * 0.5);
});

test('a huge attempt count still gives a finite delay within the cap', () => {
  // 2 ** 2000 is Infinity in JavaScript; the cap must still win
  const delay = backoffDelay(2000, always(0.5));
  expect(Number.isFinite(delay)).toBe(true);
  expect(delay).toBe(BACKOFF_MAX_MS * 0.5);
});

test('with real randomness, every delay lands in [0, ceiling)', () => {
  for (let i = 0; i < 1000; i++) {
    const delay = backoffDelay(4);   // no fake: uses Math.random
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(BACKOFF_BASE_MS * 16);
  }
});
