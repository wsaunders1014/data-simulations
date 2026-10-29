// Level of detail: reduce thousands of points to ~4 per pixel column
// without changing what the chart looks like (M4 algorithm).

export class SeriesScratch {
  // TODO: preallocated typed arrays for the output x/y plus a length (reused every frame, no garbage)
  push(x: number, y: number) {
    // TODO: append; grow the arrays (rarely) if they fill up
  }
  reset() {
    // TODO: set length back to 0 (keep the memory)
  }
}

export function decimateM4(/* reader, window, column, t0, t1, widthPx, out */) {
  // TODO: find the index range for [t0, t1] with lowerBound, plus one point past each edge
  // TODO: group points by pixel column; for each column emit first, min, max, last, in time order
  // TODO: a NaN value is a gap: flush the current column and emit a NaN so the line breaks
}
