// React owns the <div>; the imperative chart owns everything inside it.

export function ChartHost(/* { create } */) {
  // TODO: useRef for the div; in useEffect: create the chart, attach a ResizeObserver, register with the scheduler
  // TODO: cleanup: unregister, disconnect the observer, chart.destroy() (StrictMode will run this in dev; it must be safe)
  return <div />;
}
