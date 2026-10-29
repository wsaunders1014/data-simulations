// Delivers each stream's messages in order, exactly once, using `seq`.
// Detects gaps and fills them from the REST history endpoint.

export class Sequencer {
  push(env: unknown) {
    // TODO: seq <= lastSeq → duplicate, drop it. seq === lastSeq + 1 → deliver it
    // TODO: seq > lastSeq + 1 → gap: queue it and start a backfill
    // TODO: while backfilling, queue all live messages (with a size cap)
  }

  private async runBackfill() {
    // TODO: fetch history since lastSeq, sort by seq, deliver whatever isn't a duplicate
    // TODO: then drain the queue; if a hole is still left, mark a permanent gap
  }

  reset() {
    // TODO: forget lastSeq and the queue (the server restarted and its seq counters reset)
  }
}
