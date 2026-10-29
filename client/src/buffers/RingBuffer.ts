// Fixed-size, column-based storage for live data, shared between the worker
// (writes) and the main thread (reads) through a SharedArrayBuffer.

export function allocateRing(capacity: number, columns: number) {
  // TODO: work out the byte layout: a small header, a time column, then the value columns
  // TODO: allocate one SharedArrayBuffer and write capacity/columns into the header
}

export class RingWriter {
  constructor(buffer: SharedArrayBuffer) {
    // TODO: create typed-array views (Int32 header, Float64 times, Float32 values) over the buffer
  }

  push(time: number, values: ArrayLike<number>) {
    // TODO: find the slot: total written count % capacity (this is the "ring")
    // TODO: write the time and values first, THEN publish the new count with Atomics.store
  }

  pushGap(time: number) {
    // TODO: write a record of NaN values so charts break the line instead of interpolating
  }
}

export class RingReader {
  constructor(buffer: SharedArrayBuffer) {
    // TODO: create the same typed-array views as the writer, but only ever read
  }

  window() {
    // TODO: Atomics.load the count once per frame, so the snapshot is consistent
    // TODO: return the readable [start, end) range, staying a safety margin behind the writer
  }

  timeAt(i: number) {
    // TODO: map a logical index to a physical slot (i % capacity) and read the time
  }

  valueAt(i: number, column: number) {
    // TODO: same mapping, into the column's section of the values array
  }

  lowerBound(t: number) {
    // TODO: binary search for the first index whose time is >= t (times are ascending)
  }
}
