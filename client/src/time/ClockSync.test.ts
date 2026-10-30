import { test, expect } from 'vitest';
import { ClockSync } from './ClockSync';

// A realistic server timestamp, so the tests use the same magnitudes as production
const SERVER_T0 = 1_761_750_000_000;

// Builds one sample: the server sent at serverTs, and it arrived after `delay` ms
// on a local clock that runs `trueOffset` ms ahead of the server.
function sample(serverTs: number, trueOffset: number, delay: number) {
  return { serverTs, localArrival: serverTs + trueOffset + delay };
}

test('offset is null before any sample arrives', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  expect(sync.offset).toBeNull();
});

test('the first sample becomes the estimate: arrival minus server time', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  const s = sample(SERVER_T0, 500, 20);   // true offset 500, delayed 20 ms

  sync.observe(s.serverTs, s.localArrival);

  expect(sync.offset).toBe(520);          // offset + delay: the best guess we have so far
});

test('a less-delayed sample lowers the estimate (keeps the minimum)', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  // One sample per second, with varying network delay; the least-delayed one comes last
  [80, 30, 120, 60, 5].forEach((delay, i) => {
    const s = sample(SERVER_T0 + i * 1000, 500, delay);
    sync.observe(s.serverTs, s.localArrival);
  });

  expect(sync.offset).toBe(505);          // the 5 ms sample is the closest to the truth
});

test('one slow packet does not pull the estimate up', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  const fast = sample(SERVER_T0, 500, 10);
  const slow = sample(SERVER_T0 + 100, 500, 900);   // arrives 100 ms later, but delayed 900 ms

  sync.observe(fast.serverTs, fast.localArrival);
  sync.observe(slow.serverTs, slow.localArrival);

  // 1 second passed locally, so the estimate may creep up by at most 0.1 ms
  expect(sync.offset).toBeLessThanOrEqual(510.1);
});

test('the estimate creeps up at no more than maxDriftMsPerSec when the clocks drift apart', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  const before = sample(SERVER_T0, 500, 0);
  // 10 seconds later the true offset has grown to 600 (a big drift), still 0 delay
  const after = sample(SERVER_T0 + 10_000, 600, 0);

  sync.observe(before.serverTs, before.localArrival);
  sync.observe(after.serverTs, after.localArrival);

  // ~10 s of local time × 0.1 ms/s = at most 1 ms of creep: 500 → ~501, not a jump to 600
  expect(sync.offset).toBeCloseTo(501, 1);
});

test('creeping never overshoots a newer sample', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  const before = sample(SERVER_T0, 500, 0);
  const after = sample(SERVER_T0 + 10_000, 500.5, 0);   // drifted by only 0.5 ms

  sync.observe(before.serverTs, before.localArrival);
  sync.observe(after.serverTs, after.localArrival);

  // 1 ms of creep is allowed, but the new sample says 500.5, so stop there
  expect(sync.offset).toBeCloseTo(500.5, 5);
});

test('given enough time, the estimate follows sustained drift all the way', () => {
  const sync = new ClockSync({ maxDriftMsPerSec: 0.1 });
  // One sample per second for 100 seconds; the true offset rises 0.05 ms per second
  // (well under the 0.1 ms/s creep limit), and every packet has the same 10 ms delay
  for (let s = 0; s <= 100; s++) {
    const smp = sample(SERVER_T0 + s * 1000, 500 + s * 0.05, 10);
    sync.observe(smp.serverTs, smp.localArrival);
  }

  // The final sample says 500 + 5 + 10 = 515; the estimate should have kept up with it
  expect(sync.offset).toBeCloseTo(515, 1);
});
