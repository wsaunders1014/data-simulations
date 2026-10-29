# Faux Real-Time Data Service

A zero-dependency Node server that simulates six live data feeds for practicing
real-time visualization (D3, Canvas, WebGL, regl, deck.gl, three.js, …).

```bash
node server.js            # or: npm start / npm run dev (auto-restart on edit)
```

Open http://localhost:8080/ for the **Stream Inspector**: raw messages, rates, dropped-sequence
counts, and buttons that trigger scenarios. It has no charts on purpose; building those is the exercise.

| Env var          | Default | Meaning                                         |
| ---------------- | ------- | ----------------------------------------------- |
| `PORT`           | 8080    | HTTP/WS port                                    |
| `SEED`           | 42      | Same seed means the same simulated world        |
| `FLEET_SIZE`     | 1000    | Entities in the `fleet` stream (try 50000)      |
| `AUTO_INCIDENTS` | 1       | `0` disables the random incidents fired every 30–70s |

---

## Streams

Every message has the same envelope:

```json
{ "type": "data", "stream": "metrics", "seq": 1234, "ts": 1761750000000, "t": 123.4, "data": { ... } }
```

- `seq`: per-stream counter. A gap means a message was dropped (see `dropRate` below).
- `ts`: wall-clock ms when the message was published.
- `t`: simulation clock in seconds. It runs faster or slower with the speed control and stops when paused.

| Stream      | Rate          | Good for                                             | `data` shape |
| ----------- | ------------- | ---------------------------------------------------- | ------------ |
| `metrics`   | 10 Hz         | Multi-series line/area charts, sparklines, gauges, heatmaps | `{ hosts: [{ host, cpu, mem, rps, p50, p95, p99, errorRate }] }` |
| `ticker`    | ~12 events/s  | Candlesticks (aggregate trades yourself), order-flow, volume bars | `{ symbol, price, size, side: "buy"\|"sell" }` |
| `geo`       | ~20 events/s  | Maps, hex-bins, arcs, globe (activity follows a moving sun) | `{ id, kind, lat, lon, city, country, value }`; `kind` ∈ pageview, login, order, signup, error; `value` set only for orders |
| `fleet`     | 10 Hz         | WebGL point/instance rendering, interpolation, trails | Columnar: `{ count, x[], y[], heading[], speed[], status[] }`, x/y in [0,1], status 0 idle, 1 moving, 2 alert |
| `network`   | 2 Hz          | Force-directed graphs, Sankey, edge-bundling          | `{ nodes: [{ id, load, status }], edges: [{ id, throughput, utilization, packetLoss, status }] }` |
| `logs`      | ~25 events/s  | Streaming tables, stacked histograms, swimlanes       | `{ id, level, service, message, durationMs, traceId }` |
| `incidents` | on demand     | Annotation markers on any other chart                 | `{ stream, action, target, summary, source: "auto"\|"manual" }` |

`ticker`, `geo` and `logs` are Poisson processes, so each tick can carry zero or several messages.
The other streams send exactly one message per tick.

### Snapshots (initial state)

Some streams only send *changing* values. Fetch the static structure once on load:

- `GET /api/snapshot/network`: topology `{ nodes: [{id,type}], edges: [{id,source,target,capacity}] }`
- `GET /api/snapshot/fleet`: hub locations and status codes
- `GET /api/snapshot/geo`: city list and current sun longitude
- `GET /api/snapshot/ticker`: current price, open and volume per symbol
- `GET /api/snapshot/metrics`, `GET /api/snapshot/logs`: host, service and level names

---

## Transports

### 1. WebSocket: `ws://localhost:8080/ws` (bidirectional, supports binary)

```js
const ws = new WebSocket('ws://localhost:8080/ws');
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', streams: ['metrics', 'incidents'], replay: 300 }));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'data') { /* msg.stream, msg.data ... */ }
};
```

Client → server messages:

| Message | Notes |
| --- | --- |
| `{ type: "subscribe", streams: ["metrics"] }` | `"*"` means all streams. Optional fields: `replay` (backfill the last N messages per stream), `binary` (send fleet as binary, see below), `jitterMs` (random delivery delay, so messages arrive out of order), `dropRate` (0–1, randomly drop messages) |
| `{ type: "unsubscribe", streams: [...] }` | |
| `{ type: "control", action: ..., ... }` | Same commands as `POST /api/control` |
| `{ type: "ping", id }` | Server replies `{ type: "pong", id, ts }`, which you can use to measure latency |

Server → client messages. Every message has a `type` field that says which shape it is. A `?` marks a field that may be absent.

| `type` | Shape | When it's sent |
| --- | --- | --- |
| `data` | `{ type, stream, seq, ts, t, data }` | Stream data (the envelope described under **Streams**) |
| `welcome` | `{ type, clientId: number, streams: string[], t: number, speed: number }` | Once, right after the socket opens. `t` is the current sim clock, which you can use to detect a server restart |
| `subscribed` | `{ type, streams: string[] }` | After every `subscribe` or `unsubscribe`. Lists *all* current subscriptions, not just the change |
| `pong` | `{ type, id?: number, ts: number }` | Reply to `ping`. `id` echoes yours, and is absent if you didn't send one |
| `control` | `{ type, id?: number, ok: true, summary: string }` | A control command succeeded. A failed one comes back as `error` instead |
| `error` | `{ type, error: string, id?: number }` | Bad JSON, an unknown message type, an unknown stream or a failed control. `id` is present only if the request that failed included one |

All fields are plain JSON values (strings, numbers, booleans, arrays, objects). Timestamps are numbers (epoch ms), never `Date` objects.

**Binary fleet frames** (`binary: true`): fleet messages arrive as an `ArrayBuffer` (set
`ws.binaryType = 'arraybuffer'`), little-endian:

```
[uint32 seq][uint32 count][count × (float32 x, float32 y, float32 heading, float32 speed, float32 status)]
```

```js
const header = new Uint32Array(buf, 0, 2);          // [seq, count]
const floats = new Float32Array(buf, 8);            // stride 5, upload straight to a GL buffer
```

### 2. Server-Sent Events: `http://localhost:8080/sse?streams=metrics,logs`

This transport is one-way, reconnects on its own, and needs no client library. The SSE `event` name is
the stream name. `jitterMs` and `dropRate` also work as query params.

```js
const es = new EventSource('http://localhost:8080/sse?streams=metrics,geo');
es.addEventListener('metrics', (e) => { const msg = JSON.parse(e.data); });
```

### 3. REST

| Endpoint | |
| --- | --- |
| `GET /api/streams` | Stream list with descriptions, rates and a sample message |
| `GET /api/history/:stream?limit=200&since=<seq>` | Recent messages (buffer: 1000 for event streams, 600 metrics, 120 network, 30 fleet). Use it for initial backfill, or for **polling** practice with `since` |
| `GET /api/snapshot/:stream` | See above |
| `GET /api/status` | Sim clock, speed and connected clients with sent/dropped counts |
| `POST /api/control` | JSON body, see below |

## Scenarios (`POST /api/control`)

```bash
curl -X POST localhost:8080/api/control -H 'Content-Type: application/json' -d '{"stream":"metrics","action":"spike","target":"api-1","seconds":20}'
```

| Body | Effect |
| --- | --- |
| `{stream:"metrics", action:"spike", target?:"api-1"\|"*", seconds?}` | Load spike: CPU, latency and errors rise |
| `{stream:"ticker", action:"shock", target?:"ACME", pct?:-8, seconds?}` | Price jump plus a period of high volatility |
| `{stream:"geo", action:"surge", target?:"Tokyo", seconds?}` | 12× traffic from one city |
| `{stream:"fleet", action:"alert", count?:50, seconds?}` | Entities go erratic and fast (status 2) |
| `{stream:"network", action:"outage", target?:"agg-2" \| "edge-3~agg-3", seconds?}` | Node or link goes down, traffic reroutes and neighbors congest |
| `{stream:"logs", action:"burst", target?:"payments", seconds?}` | Error storm from one service |
| `{action:"speed", value:5}` | Sim time multiplier (0–50). Tick streams keep their Hz but change faster; event streams (ticker, geo, logs) emit proportionally more messages, which makes a good load test |
| `{action:"pause"}` / `{action:"resume"}` | Freeze or unfreeze the sim |
| `{action:"incidents", value:false}` | Toggle random auto-incidents |

Each scenario also publishes to the `incidents` stream.

---

## Suggested exercises (roughly easy → hard)

1. **Live line chart (D3 + SVG)**: `metrics` CPU per host in a sliding 60s window. Learn the enter/update/exit pattern, how to transition a time scale, and how to throttle redraws to `requestAnimationFrame`.
2. **Streaming candlesticks**: aggregate `ticker` trades into 5s OHLC buckets client-side. Mark `incidents` on the chart as annotations.
3. **Log histogram + virtualized table**: `logs` is too fast to put in the DOM row by row, so you'll need batching and windowing.
4. **Map (D3-geo or deck.gl)**: plot `geo` points that fade over time and follow the sun. Try hex-binning.
5. **Force graph**: load the `network` snapshot, then animate link widths and colors from live data. Handle outages without making the layout jump.
6. **WebGL fleet**: render `fleet` with raw WebGL or regl from binary frames, and interpolate between 10 Hz updates at 60 fps. Then restart with `FLEET_SIZE=50000`.
7. **Resilience**: subscribe with `jitterMs: 300, dropRate: 0.05`. Reorder by `seq`, detect gaps, backfill from `/api/history?since=`, and reconnect after you kill the server.
