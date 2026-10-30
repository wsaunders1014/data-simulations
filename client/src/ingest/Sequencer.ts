// Delivers each stream's messages in order, exactly once, using `seq`.
// Detects gaps and fills them from the REST history endpoint.
import type { Envelope } from "../shared/protocol";

type Gap = {
  firstMissing: number;
  lastMissing: number;
  ts: number
}
type SequencerOptions = {
  deliver: (env: Envelope) => void;
  onGap: (gap: Gap) => void;
  fetchHistory: (sinceSeq: number) => Promise<Envelope[]>,
  holdMs: number;
  maxHeld: number;
}
export class Sequencer {
  private deliver: (env: Envelope) => void;
  private onGap: (gap: Gap) => void;
  private fetchHistory: (sinceSeq: number) => Promise<Envelope[]>;
  private holdMs;
  private maxHeld;
  private inFlight = false;
  private generation = 0;
  private backFillFailures = 0;
  private lastSeq: number | null = null;
  private held: Map<number, Envelope> = new Map();
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor({ deliver, onGap, fetchHistory, holdMs, maxHeld }: SequencerOptions) {
    this.deliver = deliver;
    this.onGap = onGap;
    this.fetchHistory = fetchHistory;
    this.holdMs = holdMs;
    this.maxHeld = maxHeld;
  }
  private clearTimer() {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
  private drain() {
    if (this.lastSeq === null) return;
    let next = this.held.get(this.lastSeq + 1);
    while (next !== undefined) {
      this.deliver(next);
      this.held.delete(this.lastSeq + 1)
      this.lastSeq = this.lastSeq + 1;
      next = this.held.get(this.lastSeq + 1);
    }
    if (this.held.size === 0) {
      this.clearTimer();
    }
  }
  giveUp() {
    this.clearTimer();
    const heldKeys = [...this.held.keys()];
    heldKeys.sort((a, b) => a - b);
    if (this.lastSeq === null) return;
    for (const seq of heldKeys) {

      const env = this.held.get(seq);
      if (env === undefined) continue;
      if (seq > this.lastSeq + 1) {
        // There's a hole.

        this.onGap({ firstMissing: this.lastSeq + 1, lastMissing: seq - 1, ts: env.ts })

      }


      this.deliver(env);
      this.lastSeq = seq;
    }

    this.held.clear();
  }
  push(env: Envelope) {

    if (this.lastSeq !== null) { // not first message
      if (env.seq <= this.lastSeq) {
        return;
      } else if (env.seq === this.lastSeq + 1) {
        this.deliver(env);
        this.lastSeq = env.seq;
        this.drain();


      } else {
        //SEQ is out of order, so we hold them so we can display them chronologically.
        this.held.set(env.seq, env);
        if (this.held.size > this.maxHeld) {
          this.giveUp();
          return;
        }
        if (this.timerId === null && !this.inFlight) {
          this.timerId = setTimeout(() => {
            this.clearTimer();
            void this.runBackfill();
          }, this.holdMs);
        }

      }


    } else { //first message
      this.deliver(env);
      this.lastSeq = env.seq;
    }
  }
  private async runBackfill() {
    if (this.lastSeq === null) return;

    const myGeneration = this.generation;
    let fetched: Envelope[] = [];

    try {
      this.inFlight = true;
      fetched = await this.fetchHistory(this.lastSeq);
    } catch (e) {
      console.warn(e);
      this.backFillFailures++;
    }
    if (this.generation !== myGeneration) return;
    for (const env of fetched) {

      if (env.seq > this.lastSeq) {
        this.held.set(env.seq, env)
      }
    }
    this.drain();
    this.giveUp();
    this.inFlight = false;

  }

  reset() {
    this.lastSeq = null;
    this.held.clear();
    this.clearTimer();
    this.inFlight = false;
    this.generation++;
  }
  get getBackFillFailures() {
    return this.backFillFailures;
  }
}
