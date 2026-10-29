// A live line chart: canvas for the data, SVG overlay for the axes.
// Imperative: React mounts it once, the RenderScheduler drives it.

export class TimeSeriesChart {
  constructor(root: HTMLElement /*, options: source, field, windowMs, renderDelayMs, serverNow */) {
    // TODO: create the <canvas> and the <svg> (with axis <g> groups) inside root
    // TODO: create the D3 scales ONCE here; each frame only updates their domain/range
  }

  resize(width: number, height: number) {
    // TODO: sizeCanvas, resize the SVG, mark the chart as needing a redraw
  }

  frame(now: number) {
    // TODO: t1 = serverNow() - renderDelay; t0 = t1 - window
    // TODO: dirty check: skip if there's no new data, < 1px of scroll, and no resize
    // TODO: decimate each series into its scratch buffer, then draw()
  }

  private draw(t0: number, t1: number) {
    // TODO: update the scale domains/ranges; clear the plot area
    // TODO: one path per series, moveTo after a NaN (gap), a single stroke() per series
    // TODO: render the axes (d3.axisBottom/axisLeft) and measure what that costs
  }

  destroy() {
    // TODO: remove the DOM elements this chart created
  }
}
