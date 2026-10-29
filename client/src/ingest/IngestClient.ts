// Main-thread side of the worker. One instance per app, kept outside React.

export class IngestClient {
  start() {
    // TODO: check crossOriginIsolated (SharedArrayBuffer needs it); fail loudly if it's false
    // TODO: create the module worker and send it 'start' with the ws/api URLs
  }

  private onWorkerMessage(msg: unknown) {
    // TODO: 'ready' → wrap the SharedArrayBuffer in a RingReader. 'health'/'incident' → store a new immutable snapshot
    // TODO: notify subscribers (React reads these through useSyncExternalStore)
  }

  subscribe = (listener: () => void) => {
    // TODO: add the listener and return an unsubscribe function
  };

  serverNow() {
    // TODO: monotonicEpochNow() - clock offset = "now" on the server's clock (charts use this every frame)
  }
}
