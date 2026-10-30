import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';
import type { Envelope } from '../shared/protocol';

// ── The API these tests define ────────────────────────────────────────────────
//
//   new Sequencer({
//     deliver: (env) => void,                              // each message, in seq order, exactly once
//     onGap: ({ firstMissing, lastMissing, ts }) => void,  // when we give up on missing seqs
//     fetchHistory: (sinceSeq) => Promise<Envelope[]>,     // ask the server for messages after sinceSeq
//     holdMs: number,                                      // how long to wait before asking the server
//     maxHeld: number,                                     // give up at once if more than this are waiting
//   })
//   sequencer.push(env)    // feed it every message as it arrives, in any order
//   sequencer.reset()      // the server restarted: forget everything
//
// Flow for a hole: hold → (holdMs passes) → fetchHistory → still missing? → onGap, deliver the rest.
// `ts` in onGap is the ts of the first message AFTER the hole, so the chart can break the line there.

const HOLD_MS = 100;
const MAX_HELD = 50;

function env(seq: number): Envelope {
  return { type: 'data', stream: 'metrics', seq, ts: 1_000_000 + seq * 100, t: seq / 10, data: {} };
}

// A promise the test resolves or rejects by hand, to control exactly when "the server answers"
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type FetchHistory = (sinceSeq: number) => Promise<Envelope[]>;

// Records every deliver and onGap call, in order, as short strings like "deliver 5" or "gap 5-6".
// By default the server has nothing to offer (fetchHistory resolves to []).
const emptyServer: FetchHistory = () => Promise.resolve([]);

function setup({ maxHeld = MAX_HELD, fetchHistory = emptyServer }: { maxHeld?: number; fetchHistory?: FetchHistory } = {}) {
  const log: string[] = [];
  const gaps: { firstMissing: number; lastMissing: number; ts: number }[] = [];
  const fetches: number[] = [];   // the sinceSeq of every fetchHistory call
  const sequencer = new Sequencer({
    deliver: (e) => { log.push(`deliver ${e.seq}`); },
    onGap: (gap) => {
      gaps.push(gap);
      log.push(`gap ${gap.firstMissing}-${gap.lastMissing}`);
    },
    fetchHistory: (sinceSeq) => {
      fetches.push(sinceSeq);
      return fetchHistory(sinceSeq);
    },
    holdMs: HOLD_MS,
    maxHeld,
  });
  const push = (...seqs: number[]) => { for (const s of seqs) sequencer.push(env(s)); };
  return { sequencer, log, gaps, fetches, push };
}

// Fake timers: time only moves when a test advances it.
// The *Async version also lets promises (like a fetchHistory answer) settle along the way.
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ═════════════════════════ STAGE 1: ordering, holding, giving up ═════════════════════════

// ── In order: no waiting ──────────────────────────────────────────────────────

test('the first message is delivered immediately, whatever its seq', () => {
  const { log, push } = setup();
  push(42);   // we may join mid-stream, so there is nothing to compare against yet
  expect(log).toEqual(['deliver 42']);
});

test('consecutive messages are delivered immediately, in order', () => {
  const { log, push } = setup();
  push(1, 2, 3);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);
});

test('no gap is ever reported while messages arrive in order', async () => {
  const { log, fetches, push } = setup();
  push(1, 2, 3);
  await advance(HOLD_MS * 10);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);
  expect(fetches).toEqual([]);
});

// ── Duplicates: exactly once ──────────────────────────────────────────────────

test('a repeated seq is dropped', () => {
  const { log, push } = setup();
  push(1, 2, 2, 3);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);
});

test('an older seq that was already delivered is dropped', () => {
  const { log, push } = setup();
  push(1, 2, 3, 1);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);
});

// ── Holes: hold, then either fill or give up ──────────────────────────────────

test('messages after a hole are held, not delivered', () => {
  const { log, push } = setup();
  push(1, 2, 4, 5);   // 3 is missing
  expect(log).toEqual(['deliver 1', 'deliver 2']);
});

test('when the missing message arrives in time, everything is delivered in order with no gap', async () => {
  const { log, fetches, push } = setup();
  push(1, 2, 4, 5);
  await advance(HOLD_MS / 2);   // still within the hold window
  push(3);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'deliver 4', 'deliver 5']);

  await advance(HOLD_MS * 10);  // the old timer must not fire later
  expect(log).toHaveLength(5);
  expect(fetches).toEqual([]);  // and no server request was needed
});

test('after holdMs (and an empty backfill), the missing seqs become a gap, then the held messages are delivered', async () => {
  const { log, gaps, push } = setup();
  push(1, 2, 5, 6);   // 3 and 4 are missing
  await advance(HOLD_MS);

  expect(log).toEqual(['deliver 1', 'deliver 2', 'gap 3-4', 'deliver 5', 'deliver 6']);
  expect(gaps[0]?.ts).toBe(env(5).ts);   // the line breaks just before message 5
});

test('nothing is given up before holdMs has fully passed', async () => {
  const { log, fetches, push } = setup();
  push(1, 3);
  await advance(HOLD_MS - 1);
  expect(log).toEqual(['deliver 1']);
  expect(fetches).toEqual([]);
});

test('a message that arrives after its gap was reported is dropped as too late', async () => {
  const { log, push } = setup();
  push(1, 3);
  await advance(HOLD_MS);   // gives up on 2
  push(2);                  // finally shows up
  expect(log).toEqual(['deliver 1', 'gap 2-2', 'deliver 3']);
});

test('several holes among the held messages each become their own gap, in order', async () => {
  const { log, push } = setup();
  push(1, 4, 6);   // missing 2-3 and 5
  await advance(HOLD_MS);
  expect(log).toEqual(['deliver 1', 'gap 2-3', 'deliver 4', 'gap 5-5', 'deliver 6']);
});

test('a held message that arrives twice is still delivered only once', () => {
  const { log, push } = setup();
  push(1, 3, 3);
  push(2);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);
});

test('held messages arriving out of order are still delivered in seq order', () => {
  const { log, push } = setup();
  push(1, 5, 3, 4);
  push(2);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'deliver 4', 'deliver 5']);
});

// ── Safety valve: don't hold forever ──────────────────────────────────────────

test('once more than maxHeld messages are waiting, it gives up right away (no timer, no backfill)', async () => {
  const { log, fetches, push } = setup({ maxHeld: 3 });
  push(1, 3, 4, 5);       // 3 held: at the limit, still waiting
  expect(log).toEqual(['deliver 1']);

  push(6);                // 4 held: over the limit
  expect(log).toEqual(['deliver 1', 'gap 2-2', 'deliver 3', 'deliver 4', 'deliver 5', 'deliver 6']);

  await advance(HOLD_MS * 10);
  expect(fetches).toEqual([]);   // nothing left to fetch for
  expect(log).toHaveLength(6);
});

// ── Reset: the server restarted and its seq counters started over ─────────────

test('after reset, any seq is accepted as a new starting point', () => {
  const { sequencer, log, push } = setup();
  push(500, 501);
  sequencer.reset();
  push(1);   // would be a "duplicate" without the reset
  expect(log).toEqual(['deliver 500', 'deliver 501', 'deliver 1']);
});

test('reset drops held messages and cancels the pending timer', async () => {
  const { sequencer, log, fetches, push } = setup();
  push(1, 3);            // 3 is held, timer is running
  sequencer.reset();
  await advance(HOLD_MS * 10);
  expect(log).toEqual(['deliver 1']);   // no gap, and 3 is never delivered
  expect(fetches).toEqual([]);
});

// ═════════════════════════ STAGE 2: backfill from the server ═════════════════════════

test('a backfill is requested only once holdMs has passed, asking for everything after the last delivered seq', async () => {
  const { fetches, push } = setup();
  push(1, 2, 5);
  await advance(HOLD_MS - 1);
  expect(fetches).toEqual([]);
  await advance(1);
  expect(fetches).toEqual([2]);
});

test('a backfill that fills the hole delivers everything in order, with no gap', async () => {
  const server = deferred<Envelope[]>();
  const { log, push } = setup({ fetchHistory: () => server.promise });
  push(1, 2, 5);
  await advance(HOLD_MS);
  expect(log).toEqual(['deliver 1', 'deliver 2']);   // waiting on the server

  server.resolve([env(3), env(4)]);
  await advance(0);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'deliver 4', 'deliver 5']);
});

test('backfill results are sorted and de-duplicated before delivery', async () => {
  const { log, push } = setup({
    // the server returns old messages too, out of order
    fetchHistory: () => Promise.resolve([env(4), env(2), env(3), env(1)]),
  });
  push(1, 2, 5);
  await advance(HOLD_MS);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'deliver 4', 'deliver 5']);
});

test('a backfill that only partly fills the hole reports a gap for the rest', async () => {
  const { log, gaps, push } = setup({
    fetchHistory: () => Promise.resolve([env(2), env(3)]),   // the server no longer has 4 and 5
  });
  push(1, 6);
  await advance(HOLD_MS);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'gap 4-5', 'deliver 6']);
  expect(gaps[0]?.ts).toBe(env(6).ts);
});

test('a failed backfill falls back to reporting the gap', async () => {
  const { log, push } = setup({
    fetchHistory: () => Promise.reject(new Error('503 Service Unavailable')),
  });
  push(1, 3);
  await advance(HOLD_MS);
  expect(log).toEqual(['deliver 1', 'gap 2-2', 'deliver 3']);
});

test('messages that arrive while the backfill is in flight are held, then delivered after it', async () => {
  const server = deferred<Envelope[]>();
  const { log, push } = setup({ fetchHistory: () => server.promise });
  push(1, 3);
  await advance(HOLD_MS);   // backfill starts
  push(4, 5);               // live messages keep coming meanwhile
  expect(log).toEqual(['deliver 1']);

  server.resolve([env(2)]);
  await advance(0);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'deliver 4', 'deliver 5']);
});

test('only one backfill runs at a time', async () => {
  const server = deferred<Envelope[]>();
  const { fetches, push } = setup({ fetchHistory: () => server.promise });
  push(1, 3);
  await advance(HOLD_MS);   // backfill #1 starts
  push(5);                  // a second hole while #1 is still in flight
  await advance(HOLD_MS * 5);
  expect(fetches).toEqual([1]);
});

test('if the backfill leaves holes, they become gaps as soon as it finishes (no second wait)', async () => {
  const server = deferred<Envelope[]>();
  const { log, push } = setup({ fetchHistory: () => server.promise });
  push(1, 3);
  await advance(HOLD_MS);
  push(5);                  // another hole (4) appears during the backfill
  server.resolve([env(2)]);
  await advance(0);
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3', 'gap 4-4', 'deliver 5']);
});

test('a backfill answer that arrives after reset is ignored (it belongs to the old server)', async () => {
  const server = deferred<Envelope[]>();
  const { sequencer, log, push } = setup({ fetchHistory: () => server.promise });
  push(1, 3);
  await advance(HOLD_MS);   // backfill to the OLD server starts
  sequencer.reset();        // server restarted; its seqs start again from 1
  push(1);                  // first message from the NEW server

  server.resolve([env(2), env(3)]);   // the old server's answer finally arrives
  await advance(0);
  expect(log).toEqual(['deliver 1', 'deliver 1']);   // old 2 and 3 must NOT be mixed into the new stream
});

test('hitting maxHeld during a backfill gives up at once; the late backfill answer adds nothing', async () => {
  const server = deferred<Envelope[]>();
  const { log, push } = setup({ maxHeld: 3, fetchHistory: () => server.promise });
  push(1, 3);
  await advance(HOLD_MS);   // backfill starts
  push(4, 5, 6);            // 4 held: over the limit
  expect(log).toEqual(['deliver 1', 'gap 2-2', 'deliver 3', 'deliver 4', 'deliver 5', 'deliver 6']);

  server.resolve([env(2)]); // too late: 2 is already a gap
  await advance(0);
  expect(log).toHaveLength(6);
});

test('after a successful backfill, a later hole still gets its own timer and backfill', async () => {
  const { log, fetches, push } = setup({
    fetchHistory: (since) => Promise.resolve(since === 1 ? [env(2)] : [env(5)]),
  });
  push(1, 3);
  await advance(HOLD_MS);   // backfill #1 fills 2
  expect(log).toEqual(['deliver 1', 'deliver 2', 'deliver 3']);

  push(6);                  // a new hole: 4 and 5 are missing
  await advance(HOLD_MS);   // must start backfill #2
  expect(fetches).toEqual([1, 3]);
});

test('a stale backfill answer does not flush messages the NEW server is still waiting on', async () => {
  const oldServer = deferred<Envelope[]>();
  const { sequencer, log, push } = setup({ fetchHistory: () => oldServer.promise });
  push(1, 3);
  await advance(HOLD_MS);   // backfill to the OLD server starts
  sequencer.reset();
  push(1, 3);               // NEW server: 3 is held, waiting on its own timer for 2

  oldServer.resolve([]);    // the old answer arrives
  await advance(0);
  // the new server's 3 must still be waiting: no early gap, not delivered yet
  expect(log).toEqual(['deliver 1', 'deliver 1']);
});

test('a stale backfill answer leaves nothing behind in held for the new server', async () => {
  const oldServer = deferred<Envelope[]>();
  const { sequencer, log, push } = setup({ fetchHistory: () => oldServer.promise });
  push(1, 3);
  await advance(HOLD_MS);
  sequencer.reset();
  push(1);                                  // NEW server

  oldServer.resolve([env(2), env(3)]);      // OLD server's answer
  await advance(0);
  push(2);                                  // the NEW server's real message 2

  // Only the new server's 2. If the old answer had slipped into `held`,
  // the old 3 would be drained right after it.
  expect(log).toEqual(['deliver 1', 'deliver 1', 'deliver 2']);
});
