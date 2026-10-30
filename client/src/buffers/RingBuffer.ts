// Fixed-size, column-based storage for live data, shared between the worker
// (writes) and the main thread (reads) through a SharedArrayBuffer.
const HEADER_SLOTS = 4;
export const H_COUNT = 0;
export const H_CAPACITY = 1;
export const H_COLUMNS = 2;
const NO_VALUE: readonly number[] = Object.freeze([]); //create an empty array here for use whenever pushing a gap so we don't reallocate an empty array every time.
export function allocateRing(capacity: number, columns: number) {

  const sharedBuffer = new SharedArrayBuffer(ringLayout(capacity, columns).totalBytes);
  const headerView = new Int32Array(sharedBuffer, 0, HEADER_SLOTS);
  headerView[H_CAPACITY] = capacity;
  headerView[H_COLUMNS] = columns;

  return sharedBuffer;
}

export function ringLayout(capacity: number, columns: number) {
  const timesOffset = HEADER_SLOTS * Int32Array.BYTES_PER_ELEMENT;
  const valuesOffset = timesOffset + (capacity * Float64Array.BYTES_PER_ELEMENT);
  const totalBytes = valuesOffset + (capacity * columns * Float32Array.BYTES_PER_ELEMENT);

  return {
    timesOffset,
    valuesOffset,
    totalBytes
  }
}
abstract class RingViews {
  protected readonly header: Int32Array;
  protected readonly times: Float64Array;
  protected readonly values: Float32Array;
  protected readonly capacity: number;
  protected readonly columns: number;
  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_SLOTS);
    const capacity = this.header[H_CAPACITY];
    const columns = this.header[H_COLUMNS];
    if (!capacity || !columns) throw new Error('buffer was not created by allocateRing')

    const { timesOffset, valuesOffset } = ringLayout(capacity, columns)
    this.times = new Float64Array(buffer, timesOffset, capacity)
    this.values = new Float32Array(buffer, valuesOffset, capacity * columns)
    this.capacity = capacity;
    this.columns = columns;
  }

}
export class RingWriter extends RingViews {
  //super not needed
  push(time: number, values: ArrayLike<number>) {
    const count = Atomics.load(this.header, H_COUNT);
    const slot = count % this.capacity;

    this.times[slot] = time;

    for (let c = 0; c < this.columns; c++) {
      this.values[c * this.capacity + slot] = values[c] ?? NaN;
    }

    Atomics.store(this.header, H_COUNT, count + 1)

  }

  pushGap(time: number) {
    this.push(time, NO_VALUE)
  }
}

export class RingReader extends RingViews {
  private readonly safetyMargin = 40; // Worst case ~20 writes/frame (logs at sim speed 50 ≈ 1,250/s ÷ 60 fps); 2× headroom
  constructor(buffer: SharedArrayBuffer) {
    super(buffer);
    if (this.safetyMargin >= this.capacity) throw new Error(`Capacity must be larger than safety margin:${this.safetyMargin}`);
  }
  window() {
    const end = Atomics.load(this.header, H_COUNT)
    const start = Math.min(Math.max(0, end - this.capacity + this.safetyMargin), end);

    return { start, end }
  }

  timeAt(i: number) {
    return this.times[i % this.capacity] ?? NaN;
  }

  valueAt(i: number, column: number) {
    return this.values[(column * this.capacity) + (i % this.capacity)] ?? NaN
  }

  lowerBound(t: number, start: number, end: number) {

    let lo = start;
    let hi = end;



    while (lo < hi) {
      const middle = Math.floor((lo + hi) / 2);
      if (this.timeAt(middle) >= t) {
        hi = middle;
      } else {
        lo = middle + 1;
      }
    }
    return hi;


  }
}