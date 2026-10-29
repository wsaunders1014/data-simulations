/// <reference lib="webworker" />
// Runs off the main thread: owns the socket, parsing, ordering, clock sync,
// and writing into the ring buffers. The main thread only draws.

async function fetchHistory(stream: string, sinceSeq: number) {
  // TODO: GET /api/history/:stream?since=, with a timeout (AbortSignal.timeout)
  // TODO: validate the response before trusting it
}

async function setupMetrics(windowSeconds: number) {
  // TODO: fetch /api/snapshot/metrics to learn the host list (this defines the buffer's columns)
  // TODO: size the ring (window × rate + headroom), allocate it, post 'ready' to the main thread
  // TODO: create the metrics Sequencer, whose deliver() writes into the ring
}

function connect() {
  // TODO: open the WebSocket and update the connection state
  // TODO: onopen: subscribe. onmessage: record arrival time, then handle. onclose: schedule a reconnect
}

function handleMessage(text: string, arrival: number) {
  // TODO: parse + validate. Feed ClockSync, update per-stream stats, push to that stream's Sequencer
  // TODO: detect a server restart (welcome.t went backwards) → reset sequencers and buffers
}

function scheduleReconnect() {
  // TODO: wait backoffDelay(attempt), then connect() again
}

function startHeartbeat() {
  // TODO: ping every few seconds; if nothing arrives for too long, the socket is half-dead, so close it and reconnect
}

function startHealthReporter() {
  // TODO: a few times a second, post a health snapshot (rates, staleness, gaps, bytes/s, ingest CPU time)
}

self.onmessage = (ev: MessageEvent) => {
  // TODO: on 'start': store urls, setupMetrics(), then connect() + timers. On failure: post 'fatal'
};
