// Drives every simulation on its own clock, stamps messages with sequence
// numbers, keeps a short history per stream, and fires random incidents.

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { createRng } = require('./rng');
const sims = require('./sims');

const HISTORY = { default: 1000, fleet: 30, network: 120, metrics: 600 };

class Engine extends EventEmitter {
  constructor({ seed = 42, fleetSize = 1000, autoIncidents = true } = {}) {
    super();
    this.setMaxListeners(0);
    this.rng = createRng(seed);
    this.speed = 1;
    this.paused = false;
    this.t = 0; // simulation clock, seconds
    this.autoIncidents = autoIncidents;
    this.nextIncidentAt = 20;

    const list = [
      new sims.MetricsSim(createRng(seed + 1)),
      new sims.TickerSim(createRng(seed + 2)),
      new sims.GeoSim(createRng(seed + 3)),
      new sims.FleetSim(createRng(seed + 4), fleetSize),
      new sims.NetworkSim(createRng(seed + 5)),
      new sims.LogsSim(createRng(seed + 6)),
    ];
    this.sims = new Map(list.map((s) => [s.name, s]));
    this.streams = [...this.sims.keys(), 'incidents'];
    this.seq = Object.fromEntries(this.streams.map((s) => [s, 0]));
    this.history = Object.fromEntries(this.streams.map((s) => [s, []]));
  }

  start() {
    const now = performance.now();
    this.last = now;
    for (const s of this.sims.values()) s.lastStep = now;
    this.timer = setInterval(() => this._loop(), 10);
  }

  stop() {
    clearInterval(this.timer);
  }

  _loop() {
    const now = performance.now();
    const realDt = (now - this.last) / 1000;
    this.last = now;
    if (this.paused) {
      for (const s of this.sims.values()) s.lastStep = now;
      return;
    }
    this.t += realDt * this.speed;

    for (const sim of this.sims.values()) {
      const elapsed = (now - sim.lastStep) / 1000;
      if (elapsed < 1 / sim.hz) continue;
      sim.lastStep = now;
      // Cap dt so a stalled event loop doesn't teleport everything
      const dt = Math.min(elapsed, 1) * this.speed;
      for (const data of sim.step(dt, this.t)) this.publish(sim.name, data);
    }

    if (this.autoIncidents && this.t >= this.nextIncidentAt) {
      this.nextIncidentAt = this.t + 30 + this.rng() * 40;
      const sim = this.rng.pick([...this.sims.values()]);
      this.control({ stream: sim.name, ...sim.randomIncident(this.t), source: 'auto' });
    }
  }

  publish(stream, data) {
    const env = { type: 'data', stream, seq: ++this.seq[stream], ts: Date.now(), t: sims.round(this.t, 3), data };
    const h = this.history[stream];
    h.push(env);
    const cap = HISTORY[stream] || HISTORY.default;
    if (h.length > cap) h.splice(0, h.length - cap);
    this.emit('message', env);
    return env;
  }

  // Global controls (speed/pause/resume) or a scenario routed to one stream.
  control(cmd) {
    switch (cmd.action) {
      case 'speed': {
        const v = Number(cmd.value);
        if (!(v > 0 && v <= 50)) throw new Error('speed value must be in (0, 50]');
        this.speed = v;
        return { ok: true, summary: `speed set to ${v}x` };
      }
      case 'pause':
        this.paused = true;
        return { ok: true, summary: 'paused' };
      case 'resume':
        this.paused = false;
        return { ok: true, summary: 'resumed' };
      case 'incidents':
        this.autoIncidents = !!cmd.value;
        return { ok: true, summary: `auto incidents ${this.autoIncidents ? 'on' : 'off'}` };
    }
    const sim = this.sims.get(cmd.stream);
    if (!sim) throw new Error(`unknown stream "${cmd.stream}" (or unknown global action "${cmd.action}")`);
    const summary = sim.control(cmd, this.t);
    this.publish('incidents', {
      stream: sim.name,
      action: cmd.action,
      target: cmd.target ?? null,
      summary,
      source: cmd.source || 'manual',
    });
    return { ok: true, summary };
  }

  describe() {
    return this.streams.map((name) => {
      const sim = this.sims.get(name);
      const h = this.history[name];
      return {
        name,
        description: sim
          ? sim.description
          : 'Annotations: every manual or automatic scenario (spike, shock, outage...) as it happens.',
        hz: sim ? sim.hz : null,
        hasSnapshot: !!sim?.snapshot,
        latestSeq: this.seq[name],
        example: name === 'fleet' ? '(large; see README)' : h[h.length - 1] || null,
      };
    });
  }
}

module.exports = { Engine };
