// One requestAnimationFrame loop for the whole app; charts register with it.

export class RenderScheduler {
  add(item: { frame(now: number): boolean }) {
    // TODO: add the chart to a set; start the rAF loop if it isn't running; return a remove function
  }

  private tick = (now: number) => {
    // TODO: schedule the next frame, then call frame() on every registered chart
    // TODO: record how long the work took and the time since the last frame (for the perf HUD)
  };

  stats() {
    // TODO: p50/p99 frame work time, fps, long tasks (PerformanceObserver 'longtask')
  }
}
