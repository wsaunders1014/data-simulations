import { test, expect } from 'vitest';

import { allocateRing, ringLayout, RingWriter, RingReader, H_CAPACITY, H_COLUMNS, H_COUNT } from './RingBuffer';

// Tiny ring (capacity 4, 2 columns) so every slot is easy to reason about.
// Test values are chosen to be exact in Float32 (0.5, 1.25, 40...), so toBe can compare them.
const CAPACITY = 4;
const COLUMNS = 2;

function setup() {
  const buffer = allocateRing(CAPACITY, COLUMNS);
  const { timesOffset, valuesOffset } = ringLayout(CAPACITY, COLUMNS);
  return {
    writer: new RingWriter(buffer),
    header: new Int32Array(buffer, 0, 4),
    times: new Float64Array(buffer, timesOffset, CAPACITY),
    values: new Float32Array(buffer, valuesOffset, CAPACITY * COLUMNS),
  };
}

test('allocates header + times + values for 3000 slots, 8 columns', () => {
  expect(allocateRing(3000, 8).byteLength).toBe(120016);
});

test('capacity and columns being passed to shared buffer', ()=>{
    const buffer = allocateRing(3000,8);
    const view = new Int32Array(buffer, 0, 4);
    expect(view[H_CAPACITY]).toBe(3000);
    expect(view[H_COLUMNS]).toBe(8);
})

test('RingWriter can be built over a buffer from allocateRing', () => {
  expect(() => new RingWriter(allocateRing(3000, 8))).not.toThrow();
});

test('RingWriter rejects a buffer that allocateRing did not make', () => {
  // A raw buffer is all zeros, so its header says capacity 0 and columns 0
  expect(() => new RingWriter(new SharedArrayBuffer(64))).toThrow();
});
test('push writes the time and each column into slot 0, then publishes count 1', () => {
  const { writer, header, times, values } = setup();
  writer.push(1000, [40, 60]);

  expect(times[0]).toBe(1000);
  expect(values[0]).toBe(40);            // column 0, slot 0 → 0 * 4 + 0
  expect(values[CAPACITY]).toBe(60);     // column 1, slot 0 → 1 * 4 + 0
  expect(header[H_COUNT]).toBe(1);
});

test('consecutive pushes fill consecutive slots', () => {
  const { writer, times, values } = setup();
  writer.push(1000, [40, 60]);
  writer.push(1100, [41, 61]);
  writer.push(1200, [42, 62]);

  expect([...times.slice(0, 3)]).toEqual([1000, 1100, 1200]);
  expect([...values.slice(0, 3)]).toEqual([40, 41, 42]);                       // cpu column
  expect([...values.slice(CAPACITY, CAPACITY + 3)]).toEqual([60, 61, 62]);     // mem column
});

test('push wraps around and overwrites the oldest slot once full', () => {
  const { writer, header, times, values } = setup();
  for (let i = 0; i < CAPACITY + 1; i++) writer.push(1000 + i * 100, [i, i + 0.5]);

  // Push 4 (the 5th) lands in slot 4 % 4 = 0, replacing push 0
  expect(times[0]).toBe(1400);
  expect(values[0]).toBe(4);
  expect(values[CAPACITY]).toBe(4.5);
  // Slot 1 still holds push 1, untouched
  expect(times[1]).toBe(1100);
  // The count keeps going up; only the slot wraps
  expect(header[H_COUNT]).toBe(5);
});

test('a push with too few values leaves NaN in the missing column, not stale data', () => {
  const { writer, values } = setup();
  for (let i = 0; i < CAPACITY; i++) writer.push(1000 + i, [i, 99]);  // fill every slot, mem = 99

  writer.push(2000, [7]);   // wraps to slot 0, but forgets the mem value

  expect(values[0]).toBe(7);
  expect(values[CAPACITY]).toBeNaN();   // must NOT still be 99 from the first lap
});

test('pushGap writes the time and NaN in every column, even over old data', () => {
  const { writer, header, times, values } = setup();
  for (let i = 0; i < CAPACITY; i++) writer.push(1000 + i, [i, 99]);  // fill every slot

  writer.pushGap(2000);   // wraps to slot 0

  expect(times[0]).toBe(2000);           // the gap still has a position on the x-axis
  expect(values[0]).toBeNaN();
  expect(values[CAPACITY]).toBeNaN();
  expect(header[H_COUNT]).toBe(CAPACITY + 1);
});

// RingReader needs capacity > its safety margin (40), so these use a bigger ring
function setupReader(capacity = 100) {
  const buffer = allocateRing(capacity, 2);
  return { writer: new RingWriter(buffer), reader: new RingReader(buffer) };
}

test('RingReader rejects a ring too small for its safety margin', () => {
  expect(() => new RingReader(allocateRing(40, 2))).toThrow();
});

test('window is empty before anything is written', () => {
  const { reader } = setupReader();
  expect(reader.window()).toEqual({ start: 0, end: 0 });
});

test('window covers every record while the ring has not wrapped yet', () => {
  const { writer, reader } = setupReader();
  for (let i = 0; i < 10; i++) writer.push(i, [i, i + 0.5]);
  expect(reader.window()).toEqual({ start: 0, end: 10 });
});

test('window skips the safety margin once the ring has wrapped', () => {
  const { writer, reader } = setupReader();
  for (let i = 0; i < 150; i++) writer.push(i, [i, i + 0.5]);
  // oldest surviving record = 150 - 100 = 50, plus a 40-record margin = 90
  expect(reader.window()).toEqual({ start: 90, end: 150 });
});

test('timeAt and valueAt read back what push wrote, by record number, after wrapping', () => {
  const { writer, reader } = setupReader();
  for (let i = 0; i < 150; i++) writer.push(i * 10, [i, i + 0.5]);

  // record 120 lives in slot 120 % 100 = 20
  expect(reader.timeAt(120)).toBe(1200);
  expect(reader.valueAt(120, 0)).toBe(120);
  expect(reader.valueAt(120, 1)).toBe(120.5);
});

// lowerBound(t, start, end): the first record number in [start, end) whose time is >= t,
// or end if there is none. Records here have time = record number × 10.
function readerWithRecords(count: number) {
  const { writer, reader } = setupReader();
  for (let i = 0; i < count; i++) writer.push(i * 10, [i, i + 0.5]);
  return reader;
}

test('lowerBound finds a record whose time matches exactly', () => {
  const reader = readerWithRecords(8);       // times 0, 10, 20 … 70
  expect(reader.lowerBound(40, 0, 8)).toBe(4);
});

test('lowerBound returns the next record when t falls between two times', () => {
  const reader = readerWithRecords(8);
  expect(reader.lowerBound(45, 0, 8)).toBe(5);  // 45 is between 40 and 50 → first time >= 45 is 50
});

test('lowerBound returns start when every record is newer than t', () => {
  const reader = readerWithRecords(8);
  expect(reader.lowerBound(-100, 0, 8)).toBe(0);
});

test('lowerBound returns end when every record is older than t', () => {
  const reader = readerWithRecords(8);
  expect(reader.lowerBound(1000, 0, 8)).toBe(8);  // nothing to draw
});

test('lowerBound returns start for an empty range', () => {
  const reader = readerWithRecords(8);
  expect(reader.lowerBound(40, 3, 3)).toBe(3);
});

test('lowerBound only searches inside [start, end), even if older records match', () => {
  const reader = readerWithRecords(8);
  expect(reader.lowerBound(10, 5, 8)).toBe(5);   // record 1 has time 10, but it's outside the range
});

test('lowerBound works across the wraparound, using record numbers', () => {
  const reader = readerWithRecords(150);     // capacity 100, so records 50–149 survive
  const { start, end } = reader.window();    // { start: 90, end: 150 }
  // record 120 (time 1200) is in slot 20, record 99 (time 990) is in slot 99: the search crosses the wrap
  expect(reader.lowerBound(1195, start, end)).toBe(120);
});
