// Server timestamps come from a different clock than ours. Estimate the
// offset so charts can scroll on a smooth local clock.

export function monotonicEpochNow() {
  return performance.timeOrigin + performance.now() // it never jumps, and it's comparable across worker/main
}

export class ClockSync {
  private readonly maxDriftMsPerSec: number;
  private estimate:number | null = null;
  private prevArrivalTime: number = 0;
  constructor({maxDriftMsPerSec}:{maxDriftMsPerSec: number}){
    this.maxDriftMsPerSec = maxDriftMsPerSec;
  }
  observe(serverTs: number, localArrival: number) {
    const sample = localArrival - serverTs;
    if(this.estimate === null){
      this.estimate = sample;
      this.prevArrivalTime = localArrival;
      return;
    }
    const secondsSinceLast = (localArrival - this.prevArrivalTime) / 1000;
    const creep = this.estimate + (this.maxDriftMsPerSec * secondsSinceLast);
    this.estimate = Math.min(sample,creep);
    this.prevArrivalTime = localArrival;
   
  }

  get offset() {
    return this.estimate;
    
  }
}
