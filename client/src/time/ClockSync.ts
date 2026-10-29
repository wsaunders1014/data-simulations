// Server timestamps come from a different clock than ours. Estimate the
// offset so charts can scroll on a smooth local clock.

export function monotonicEpochNow() {
  // TODO: performance.timeOrigin + performance.now(): it never jumps, and it's comparable across worker/main
}

export class ClockSync {
  observe(serverTs: number, localArrival: number) {
    // TODO: each sample = arrival - serverTs = true offset + network delay
    // TODO: keep the minimum (least-delayed) sample, but let it creep up slowly to follow drift
  }

  get offset() {
    // TODO: return the current estimate (or null before the first sample)
  }
}
