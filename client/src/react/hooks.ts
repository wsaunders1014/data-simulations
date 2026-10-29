// The only bridge from the data layer into React: low-frequency state, never raw stream data.

export function useHealth() {
  // TODO: useSyncExternalStore(ingest.subscribe, ingest.getHealth)
}

export function useNow(intervalMs: number) {
  // TODO: re-render on a timer, so staleness is judged on the main thread's clock even if the worker dies
}
