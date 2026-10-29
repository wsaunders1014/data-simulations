// The contract between the ingest worker and the main thread.
// Bulk data goes through shared ring buffers, never through postMessage.

// TODO: WorkerToMain message types: 'ready' (buffer + schema), 'health', 'incident', 'fatal'
// TODO: MainToWorker message type: 'start' (ws url, api url, window size)
// TODO: HealthSnapshot shape: connection state, clock offset, per-stream rate/staleness/gap stats
