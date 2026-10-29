// Each simulation models one kind of real-time data source.
//
// Interface:
//   name, description, hz          — stream id, docs, how often step() runs (real-time Hz)
//   step(dt, t) -> payload[]       — advance by dt sim-seconds; returns 0..n messages to publish
//   snapshot()                     — optional: current full state (topology, prices, ...)
//   control(cmd, t) -> string      — apply a manual scenario; returns a human-readable summary
//   randomIncident(t) -> cmd       — a control command the auto-incident scheduler can fire

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// Time-limited effects ("api-1 is spiking for 15s") shared by all sims
class Effects {
  constructor() {
    this.list = [];
  }
  add(kind, target, until, extra = {}) {
    this.list.push({ kind, target, until, ...extra });
  }
  get(kind, target) {
    return this.list.find((e) => e.kind === kind && (e.target === target || e.target === '*'));
  }
  prune(t) {
    this.list = this.list.filter((e) => e.until > t);
  }
}

// A slow "day" cycle so dashboards show visible trends without waiting 24h
const dayCycle = (t, period = 120) => 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period);

// ---------------------------------------------------------------------------
// metrics: classic ops-dashboard time series
// ---------------------------------------------------------------------------
class MetricsSim {
  constructor(rng) {
    this.name = 'metrics';
    this.hz = 10;
    this.description = 'Per-host server metrics: CPU, memory, RPS, latency percentiles, error rate. One message per tick with every host.';
    this.rng = rng;
    this.effects = new Effects();
    this.hosts = [
      ['api-1', 1200],
      ['api-2', 1100],
      ['api-3', 900],
      ['db-1', 600],
      ['cache-1', 3000],
      ['worker-1', 200],
    ].map(([host, base]) => ({ host, base, cpu: 30, mem: 35 + rng() * 25, noise: 0 }));
  }

  step(dt, t) {
    const { rng } = this;
    this.effects.prune(t);
    const day = dayCycle(t);
    const hosts = this.hosts.map((h) => {
      const spike = this.effects.get('spike', h.host) ? 1 : 0;
      // Ornstein-Uhlenbeck noise: wanders but always pulls back toward 0
      h.noise += -h.noise * 0.5 * dt + rng.gauss() * 0.25 * Math.sqrt(dt);
      const load = clamp(0.3 + 0.5 * day + h.noise * 0.3 + spike * 0.7, 0.02, 1.8);
      const rps = h.base * load * (1 + rng.gauss() * 0.03);

      const targetCpu = clamp(8 + 55 * load, 1, 100);
      h.cpu = clamp(h.cpu + (targetCpu - h.cpu) * Math.min(1, dt * 2) + rng.gauss() * 1.2, 0.5, 100);

      // Memory leaks upward, then "GC" drops it (sawtooth)
      h.mem += dt * (0.1 + load * 0.2) + rng.gauss() * 0.05;
      if (h.mem > 88 || rng() < 0.0015) h.mem -= 20 + rng() * 15;
      h.mem = clamp(h.mem, 10, 99);

      const p50 = 8 + Math.pow(h.cpu / 100, 3) * 120 + Math.abs(rng.gauss()) * 2;
      const p95 = p50 * (1.8 + Math.abs(rng.gauss()) * 0.3 + spike * 1.5);
      const p99 = p95 * (1.4 + Math.abs(rng.gauss()) * 0.4);
      const errorRate = clamp(
        0.002 + Math.pow(Math.max(0, h.cpu - 80) / 20, 2) * 0.05 + spike * 0.06 + Math.abs(rng.gauss()) * 0.001,
        0,
        1
      );
      return {
        host: h.host,
        cpu: round(h.cpu, 1),
        mem: round(h.mem, 1),
        rps: round(Math.max(0, rps), 1),
        p50: round(p50, 1),
        p95: round(p95, 1),
        p99: round(p99, 1),
        errorRate: round(errorRate, 4),
      };
    });
    return [{ hosts }];
  }

  snapshot() {
    return { hosts: this.hosts.map((h) => h.host) };
  }

  control(cmd, t) {
    if (cmd.action !== 'spike') throw new Error(`metrics supports: spike`);
    const target = cmd.target || this.rng.pick(this.hosts).host;
    if (target !== '*' && !this.hosts.some((h) => h.host === target)) throw new Error(`unknown host ${target}`);
    const seconds = cmd.seconds || 15;
    this.effects.add('spike', target, t + seconds);
    return `load spike on ${target} for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'spike', target: this.rng.pick(this.hosts).host, seconds: this.rng.int(8, 25) };
  }
}

// ---------------------------------------------------------------------------
// ticker: market trades (random walk / geometric Brownian motion)
// ---------------------------------------------------------------------------
class TickerSim {
  constructor(rng) {
    this.name = 'ticker';
    this.hz = 20;
    this.description = 'Individual trades for 5 fictional symbols (~12/s, Poisson). Aggregate into candles yourself.';
    this.rng = rng;
    this.effects = new Effects();
    this.rate = 12;
    this.symbols = [
      { symbol: 'ACME', price: 100, vol: 1.0, weight: 3 },
      { symbol: 'GLBX', price: 250, vol: 0.6, weight: 2 },
      { symbol: 'INIT', price: 42, vol: 1.5, weight: 2 },
      { symbol: 'NOVA', price: 12, vol: 2.5, weight: 1.5 },
      { symbol: 'ZETA', price: 880, vol: 0.8, weight: 1 },
    ].map((s) => ({ ...s, open: s.price, volume: 0 }));
  }

  step(dt, t) {
    const { rng } = this;
    this.effects.prune(t);
    for (const s of this.symbols) {
      const boost = this.effects.get('volatility', s.symbol) ? 4 : 1;
      const sigma = 0.003 * s.vol * boost;
      s.price *= Math.exp(sigma * Math.sqrt(dt) * rng.gauss());
    }
    const anyHot = this.symbols.some((s) => this.effects.get('volatility', s.symbol));
    const n = rng.poisson(this.rate * dt * (anyHot ? 2.5 : 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = rng.weighted(this.symbols, (x) => x.weight * (this.effects.get('volatility', x.symbol) ? 4 : 1));
      const side = rng() < 0.5 ? 'buy' : 'sell';
      const price = s.price * (1 + (side === 'buy' ? 1 : -1) * 0.0003 * rng());
      const size = Math.max(1, Math.round(Math.exp(3 + rng.gauss() * 1.2)));
      s.volume += size;
      out.push({ symbol: s.symbol, price: round(price, s.price < 20 ? 3 : 2), size, side });
    }
    return out;
  }

  snapshot() {
    return {
      symbols: this.symbols.map((s) => ({
        symbol: s.symbol,
        price: round(s.price, 3),
        open: round(s.open, 3),
        volume: s.volume,
      })),
    };
  }

  control(cmd, t) {
    if (cmd.action !== 'shock') throw new Error('ticker supports: shock');
    const s = this.symbols.find((x) => x.symbol === cmd.target) || this.rng.pick(this.symbols);
    const pct = cmd.pct ?? (this.rng() < 0.5 ? -1 : 1) * this.rng.int(3, 10);
    s.price *= 1 + pct / 100;
    const seconds = cmd.seconds || 20;
    this.effects.add('volatility', s.symbol, t + seconds);
    return `${s.symbol} ${pct > 0 ? '+' : ''}${pct}% shock, high volatility for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'shock', target: this.rng.pick(this.symbols).symbol };
  }
}

// ---------------------------------------------------------------------------
// geo: user activity events on a world map, following daylight
// ---------------------------------------------------------------------------
const CITIES = [
  ['New York', 'US', 40.71, -74.01, 9],
  ['San Francisco', 'US', 37.77, -122.42, 6],
  ['Chicago', 'US', 41.88, -87.63, 4],
  ['Toronto', 'CA', 43.65, -79.38, 3],
  ['Mexico City', 'MX', 19.43, -99.13, 4],
  ['São Paulo', 'BR', -23.55, -46.63, 5],
  ['Buenos Aires', 'AR', -34.6, -58.38, 2],
  ['London', 'GB', 51.51, -0.13, 8],
  ['Paris', 'FR', 48.86, 2.35, 5],
  ['Berlin', 'DE', 52.52, 13.4, 5],
  ['Madrid', 'ES', 40.42, -3.7, 3],
  ['Lagos', 'NG', 6.52, 3.38, 3],
  ['Nairobi', 'KE', -1.29, 36.82, 2],
  ['Cairo', 'EG', 30.04, 31.24, 2],
  ['Dubai', 'AE', 25.2, 55.27, 3],
  ['Mumbai', 'IN', 19.08, 72.88, 7],
  ['Bangalore', 'IN', 12.97, 77.59, 5],
  ['Singapore', 'SG', 1.35, 103.82, 5],
  ['Shanghai', 'CN', 31.23, 121.47, 6],
  ['Seoul', 'KR', 37.57, 126.98, 5],
  ['Tokyo', 'JP', 35.68, 139.69, 8],
  ['Sydney', 'AU', -33.87, 151.21, 4],
].map(([city, country, lat, lon, weight]) => ({ city, country, lat, lon, weight }));

const GEO_KINDS = [
  ['pageview', 0.55],
  ['login', 0.2],
  ['order', 0.15],
  ['signup', 0.08],
  ['error', 0.02],
];

class GeoSim {
  constructor(rng) {
    this.name = 'geo';
    this.hz = 20;
    this.description = 'Geo-tagged user events (~20/s). Activity follows a sun that circles the globe every 4 minutes.';
    this.rng = rng;
    this.effects = new Effects();
    this.rate = 20;
    this.nextId = 1;
    this.sunLon = 0;
  }

  step(dt, t) {
    const { rng } = this;
    this.effects.prune(t);
    this.sunLon = ((((180 - (t * 360) / 240) % 360) + 540) % 360) - 180;
    const weightOf = (c) => {
      const daylight = 0.2 + 0.8 * Math.max(0, Math.cos(((c.lon - this.sunLon) * Math.PI) / 180));
      const surge = this.effects.get('surge', c.city) ? 12 : 1;
      return c.weight * daylight * surge;
    };
    const surging = this.effects.list.some((e) => e.kind === 'surge');
    const n = rng.poisson(this.rate * dt * (surging ? 2 : 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = rng.weighted(CITIES, weightOf);
      const kind = rng.weighted(GEO_KINDS, (k) => k[1])[0];
      out.push({
        id: this.nextId++,
        kind,
        lat: round(c.lat + rng.gauss() * 0.35, 4),
        lon: round(c.lon + rng.gauss() * 0.45, 4),
        city: c.city,
        country: c.country,
        value: kind === 'order' ? round(Math.exp(3.5 + rng.gauss() * 0.8), 2) : null,
      });
    }
    return out;
  }

  snapshot() {
    return { sunLon: round(this.sunLon, 2), cities: CITIES };
  }

  control(cmd, t) {
    if (cmd.action !== 'surge') throw new Error('geo supports: surge');
    const c = CITIES.find((x) => x.city === cmd.target) || this.rng.pick(CITIES);
    const seconds = cmd.seconds || 15;
    this.effects.add('surge', c.city, t + seconds);
    return `traffic surge in ${c.city} for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'surge', target: this.rng.pick(CITIES).city, seconds: this.rng.int(10, 20) };
  }
}

// ---------------------------------------------------------------------------
// fleet: many moving entities — the WebGL stress test
// ---------------------------------------------------------------------------
const FLEET_STATUS = { idle: 0, moving: 1, alert: 2 };

class FleetSim {
  constructor(rng, size = 1000) {
    this.name = 'fleet';
    this.hz = 10;
    this.description = `${size} moving entities in a normalized [0,1]x[0,1] world, columnar arrays. Shuttle between hubs; status 0=idle 1=moving 2=alert.`;
    this.rng = rng;
    this.effects = new Effects();
    this.hubs = Array.from({ length: 6 }, (_, i) => ({ id: i, x: 0.1 + rng() * 0.8, y: 0.1 + rng() * 0.8 }));
    this.entities = Array.from({ length: size }, () => ({
      x: rng(),
      y: rng(),
      heading: rng() * Math.PI * 2,
      speed: 0,
      cruise: 0.02 + rng() * 0.03,
      status: FLEET_STATUS.moving,
      hub: rng.int(0, this.hubs.length - 1),
      dwell: 0,
      alertUntil: 0,
    }));
  }

  step(dt, t) {
    const { rng } = this;
    const n = this.entities.length;
    const x = new Array(n);
    const y = new Array(n);
    const heading = new Array(n);
    const speed = new Array(n);
    const status = new Array(n);

    for (let i = 0; i < n; i++) {
      const e = this.entities[i];
      const alert = e.alertUntil > t;
      if (!alert && rng() < 0.00005) e.alertUntil = t + 5 + rng() * 10;

      if (e.status === FLEET_STATUS.idle && !alert) {
        e.dwell -= dt;
        e.speed = Math.max(0, e.speed - dt * 0.05);
        if (e.dwell <= 0) {
          e.status = FLEET_STATUS.moving;
          e.hub = rng.int(0, this.hubs.length - 1);
        }
      } else {
        const hub = this.hubs[e.hub];
        const desired = Math.atan2(hub.y - e.y, hub.x - e.x);
        let diff = desired - e.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        const turnRate = alert ? 6 : 1.5;
        e.heading += clamp(diff, -turnRate * dt, turnRate * dt) + rng.gauss() * (alert ? 0.8 : 0.15) * Math.sqrt(dt);
        const target = alert ? e.cruise * 2 : e.cruise;
        e.speed += (target - e.speed) * Math.min(1, dt * 1.5);
        if (!alert && Math.hypot(hub.x - e.x, hub.y - e.y) < 0.015) {
          e.status = FLEET_STATUS.idle;
          e.dwell = 2 + rng() * 8;
        }
      }
      e.x = clamp(e.x + Math.cos(e.heading) * e.speed * dt, 0, 1);
      e.y = clamp(e.y + Math.sin(e.heading) * e.speed * dt, 0, 1);
      e.heading = Math.atan2(Math.sin(e.heading), Math.cos(e.heading));

      x[i] = round(e.x, 5);
      y[i] = round(e.y, 5);
      heading[i] = round(e.heading, 3);
      speed[i] = round(e.speed, 4);
      status[i] = alert ? FLEET_STATUS.alert : e.status;
    }
    return [{ count: n, x, y, heading, speed, status }];
  }

  snapshot() {
    return { count: this.entities.length, hubs: this.hubs, statusCodes: FLEET_STATUS };
  }

  control(cmd, t) {
    if (cmd.action !== 'alert') throw new Error('fleet supports: alert');
    const count = clamp(cmd.count || 50, 1, this.entities.length);
    const seconds = cmd.seconds || 15;
    for (let i = 0; i < count; i++) this.rng.pick(this.entities).alertUntil = t + seconds;
    return `${count} entities in alert mode for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'alert', count: this.rng.int(10, 80), seconds: this.rng.int(8, 20) };
  }
}

// Binary encoding of a fleet message (see README):
// [uint32 seq][uint32 count] then count * 5 float32 (x, y, heading, speed, status), little-endian
function encodeFleetBinary(env) {
  const d = env.data;
  const buf = Buffer.alloc(8 + d.count * 20);
  buf.writeUInt32LE(env.seq, 0);
  buf.writeUInt32LE(d.count, 4);
  let o = 8;
  for (let i = 0; i < d.count; i++) {
    buf.writeFloatLE(d.x[i], o);
    buf.writeFloatLE(d.y[i], o + 4);
    buf.writeFloatLE(d.heading[i], o + 8);
    buf.writeFloatLE(d.speed[i], o + 12);
    buf.writeFloatLE(d.status[i], o + 16);
    o += 20;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// network: graph topology with link traffic, failures and rerouting
// ---------------------------------------------------------------------------
class NetworkSim {
  constructor(rng) {
    this.name = 'network';
    this.hz = 2;
    this.description = 'Data-center network graph: per-node load and per-link throughput (Gbps). Links flap; traffic reroutes. GET the snapshot for topology.';
    this.rng = rng;
    this.effects = new Effects();
    const nodes = [];
    const edges = [];
    const addEdge = (source, target, capacity) =>
      edges.push({ id: `${source}~${target}`, source, target, capacity, offset: 0.7 + rng() * 0.6, noise: 0 });

    for (let i = 1; i <= 3; i++) nodes.push({ id: `core-${i}`, type: 'core' });
    for (let i = 1; i <= 6; i++) nodes.push({ id: `agg-${i}`, type: 'aggregation' });
    for (let i = 1; i <= 18; i++) nodes.push({ id: `edge-${i}`, type: 'edge' });

    addEdge('core-1', 'core-2', 100);
    addEdge('core-2', 'core-3', 100);
    addEdge('core-1', 'core-3', 100);
    for (let i = 1; i <= 6; i++) {
      addEdge(`agg-${i}`, `core-${((i - 1) % 3) + 1}`, 40);
      addEdge(`agg-${i}`, `core-${(i % 3) + 1}`, 40);
    }
    for (let i = 1; i <= 18; i++) {
      const primary = ((i - 1) % 6) + 1;
      addEdge(`edge-${i}`, `agg-${primary}`, 10);
      if (rng() < 0.4) addEdge(`edge-${i}`, `agg-${(primary % 6) + 1}`, 10);
    }
    this.nodes = nodes;
    this.edges = edges;
  }

  _edgeDown(e) {
    return !!(this.effects.get('down', e.id) || this.effects.get('down', e.source) || this.effects.get('down', e.target));
  }

  step(dt, t) {
    const { rng } = this;
    this.effects.prune(t);
    // Random link flaps (~one every 3 minutes)
    if (rng() < dt / 180) {
      const e = rng.pick(this.edges);
      this.effects.add('down', e.id, t + 5 + rng() * 15);
    }

    const day = dayCycle(t, 150);
    const desired = new Map();
    for (const e of this.edges) {
      e.noise += -e.noise * 0.3 * dt + rng.gauss() * 0.15 * Math.sqrt(dt);
      desired.set(e.id, e.capacity * clamp((0.15 + 0.45 * day) * e.offset + e.noise * 0.2, 0.01, 1));
    }
    // Reroute traffic from dead links onto live links that share an endpoint
    const throughput = new Map(this.edges.map((e) => [e.id, this._edgeDown(e) ? 0 : desired.get(e.id)]));
    for (const dead of this.edges.filter((e) => this._edgeDown(e))) {
      const siblings = this.edges.filter(
        (e) => e !== dead && !this._edgeDown(e) && [e.source, e.target].some((n) => n === dead.source || n === dead.target)
      );
      for (const s of siblings) throughput.set(s.id, throughput.get(s.id) + desired.get(dead.id) / siblings.length);
    }

    const edges = this.edges.map((e) => {
      const down = this._edgeDown(e);
      const tp = throughput.get(e.id);
      const util = tp / e.capacity;
      return {
        id: e.id,
        throughput: round(Math.min(tp, e.capacity), 2),
        utilization: round(Math.min(util, 1), 3),
        packetLoss: round(down ? 1 : Math.max(0, util - 1) * 0.5 + Math.abs(rng.gauss()) * 0.0005, 4),
        status: down ? 'down' : util > 0.9 ? 'congested' : 'up',
      };
    });
    const byId = new Map(edges.map((e) => [e.id, e]));
    const nodes = this.nodes.map((n) => {
      if (this.effects.get('down', n.id)) return { id: n.id, load: 0, status: 'down' };
      const incident = this.edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => byId.get(e.id));
      const live = incident.filter((e) => e.status !== 'down');
      const load = live.length ? live.reduce((a, e) => a + e.utilization, 0) / live.length : 0;
      return { id: n.id, load: round(load, 3), status: load > 0.85 || live.length < incident.length ? 'degraded' : 'up' };
    });
    return [{ nodes, edges }];
  }

  snapshot() {
    return {
      nodes: this.nodes,
      edges: this.edges.map(({ id, source, target, capacity }) => ({ id, source, target, capacity })),
    };
  }

  control(cmd, t) {
    if (cmd.action !== 'outage') throw new Error('network supports: outage');
    const ids = [...this.nodes.map((n) => n.id), ...this.edges.map((e) => e.id)];
    const target = cmd.target || this.rng.pick(this.nodes.filter((n) => n.type !== 'core')).id;
    if (!ids.includes(target)) throw new Error(`unknown node/edge ${target}`);
    const seconds = cmd.seconds || 20;
    this.effects.add('down', target, t + seconds);
    return `${target} down for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'outage', target: this.rng.pick(this.nodes.filter((n) => n.type !== 'core')).id, seconds: this.rng.int(10, 25) };
  }
}

// ---------------------------------------------------------------------------
// logs: high-volume categorical event stream
// ---------------------------------------------------------------------------
const SERVICES = ['gateway', 'auth', 'payments', 'search', 'inventory'];
const LEVELS = [
  ['debug', 0.3],
  ['info', 0.5],
  ['warn', 0.15],
  ['error', 0.05],
];
const TEMPLATES = {
  debug: ['cache lookup key=%k', 'span started op=%o', 'retrying idempotent call op=%o'],
  info: ['GET /api/%o 200', 'POST /api/%o 201', 'user session refreshed', 'job completed op=%o'],
  warn: ['slow query on %o', 'retry 2/3 for %o', 'connection pool at 85%', 'deprecated endpoint /v1/%o'],
  error: ['upstream timeout calling %o', 'POST /api/%o 500', 'deadlock detected in %o', 'circuit breaker open: %o'],
};
const OPS = ['orders', 'users', 'cart', 'checkout', 'catalog', 'tokens', 'refunds'];

class LogsSim {
  constructor(rng) {
    this.name = 'logs';
    this.hz = 20;
    this.description = 'Structured application log lines (~25/s, Poisson) across 5 services with occasional error bursts.';
    this.rng = rng;
    this.effects = new Effects();
    this.rate = 25;
    this.nextId = 1;
  }

  step(dt, t) {
    const { rng } = this;
    this.effects.prune(t);
    const bursting = this.effects.list.filter((e) => e.kind === 'burst');
    const n = rng.poisson(this.rate * dt * (bursting.length ? 2.5 : 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const burst = bursting.length && rng() < 0.6 ? rng.pick(bursting) : null;
      const service = burst ? burst.target : rng.pick(SERVICES);
      const level = burst && rng() < 0.6 ? 'error' : rng.weighted(LEVELS, (l) => l[1])[0];
      const message = rng
        .pick(TEMPLATES[level])
        .replace('%o', rng.pick(OPS))
        .replace('%k', rng.hex(8));
      const base = level === 'error' ? 5.5 : 3.2;
      out.push({
        id: this.nextId++,
        level,
        service,
        message,
        durationMs: round(Math.exp(base + rng.gauss() * 0.7), 1),
        traceId: rng.hex(16),
      });
    }
    return out;
  }

  snapshot() {
    return { services: SERVICES, levels: LEVELS.map((l) => l[0]) };
  }

  control(cmd, t) {
    if (cmd.action !== 'burst') throw new Error('logs supports: burst');
    const target = SERVICES.includes(cmd.target) ? cmd.target : this.rng.pick(SERVICES);
    const seconds = cmd.seconds || 10;
    this.effects.add('burst', target, t + seconds);
    return `error burst from ${target} for ${seconds}s`;
  }

  randomIncident() {
    return { action: 'burst', target: this.rng.pick(SERVICES), seconds: this.rng.int(5, 15) };
  }
}

module.exports = { MetricsSim, TickerSim, GeoSim, FleetSim, NetworkSim, LogsSim, encodeFleetBinary, round };
