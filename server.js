// Faux real-time data service.
// Transports: WebSocket (/ws), Server-Sent Events (/sse), REST (/api/*).
// Zero dependencies — run with `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Engine } = require('./lib/engine');
const { handleUpgrade } = require('./lib/ws');
const { encodeFleetBinary } = require('./lib/sims');

const PORT = Number(process.env.PORT) || 8080;
const engine = new Engine({
  seed: Number(process.env.SEED) || 42,
  fleetSize: Number(process.env.FLEET_SIZE) || 1000,
  autoIncidents: process.env.AUTO_INCIDENTS !== '0',
});

const MAX_BUFFERED = 4 * 1024 * 1024; // drop frames for slow clients past this
const clients = new Set();
let nextClientId = 1;

// Serialize each message once, no matter how many clients receive it
const jsonCache = new WeakMap();
const binCache = new WeakMap();
const toJson = (env) => {
  let s = jsonCache.get(env);
  if (!s) jsonCache.set(env, (s = JSON.stringify(env)));
  return s;
};
const toBin = (env) => {
  let b = binCache.get(env);
  if (!b) binCache.set(env, (b = encodeFleetBinary(env)));
  return b;
};

function parseStreams(list) {
  const wanted = (Array.isArray(list) ? list : String(list || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (wanted.includes('*')) return engine.streams.slice();
  const bad = wanted.filter((s) => !engine.streams.includes(s));
  if (bad.length) throw new Error(`unknown stream(s): ${bad.join(', ')}`);
  return wanted;
}

// --- delivery ---------------------------------------------------------------

function deliver(client, env) {
  if (!client.subs.has(env.stream)) return;
  if (client.dropRate && Math.random() < client.dropRate) return client.stats.dropped++;
  if (client.bufferedAmount() > MAX_BUFFERED) return client.stats.dropped++;
  const send = () => {
    client.stats.sent++;
    client.send(env);
  };
  if (client.jitterMs) setTimeout(send, Math.random() * client.jitterMs);
  else send();
}

engine.on('message', (env) => {
  for (const c of clients) deliver(c, env);
});

// --- WebSocket ----------------------------------------------------------------

function onWsConnection(ws, req) {
  const client = {
    id: nextClientId++,
    kind: 'ws',
    subs: new Set(),
    binary: false,
    jitterMs: 0,
    dropRate: 0,
    stats: { sent: 0, dropped: 0 },
    bufferedAmount: () => ws.bufferedAmount,
    send: (env) => {
      if (client.binary && env.stream === 'fleet') ws.sendBinary(toBin(env));
      else ws.sendText(toJson(env));
    },
  };
  clients.add(client);
  const reply = (obj) => ws.sendText(JSON.stringify(obj));
  reply({ type: 'welcome', clientId: client.id, streams: engine.streams, t: engine.t, speed: engine.speed });

  ws.on('message', (text, isBinary) => {
    if (isBinary) return reply({ type: 'error', error: 'send JSON text frames' });
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return reply({ type: 'error', error: 'invalid JSON' });
    }
    try {
      switch (msg.type) {
        case 'subscribe': {
          const streams = parseStreams(msg.streams);
          streams.forEach((s) => client.subs.add(s));
          if ('binary' in msg) client.binary = !!msg.binary;
          if ('jitterMs' in msg) client.jitterMs = Math.max(0, Number(msg.jitterMs) || 0);
          if ('dropRate' in msg) client.dropRate = Math.min(1, Math.max(0, Number(msg.dropRate) || 0));
          reply({ type: 'subscribed', streams: [...client.subs] });
          // Optional backfill so charts don't start empty
          const replay = Math.max(0, Number(msg.replay) || 0);
          if (replay) for (const s of streams) for (const env of engine.history[s].slice(-replay)) client.send(env);
          break;
        }
        case 'unsubscribe': {
          parseStreams(msg.streams).forEach((s) => client.subs.delete(s));
          reply({ type: 'subscribed', streams: [...client.subs] });
          break;
        }
        case 'control':
          reply({ type: 'control', id: msg.id, ...engine.control(msg) });
          break;
        case 'ping':
          reply({ type: 'pong', id: msg.id, ts: Date.now() });
          break;
        default:
          reply({ type: 'error', error: `unknown message type "${msg.type}"` });
      }
    } catch (err) {
      reply({ type: 'error', id: msg.id, error: err.message });
    }
  });
  ws.on('close', () => clients.delete(client));
}

// --- SSE ----------------------------------------------------------------------

function onSse(req, res, url) {
  let subs;
  try {
    subs = parseStreams(url.searchParams.get('streams') || '*');
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n');
  const client = {
    id: nextClientId++,
    kind: 'sse',
    subs: new Set(subs),
    jitterMs: Number(url.searchParams.get('jitterMs')) || 0,
    dropRate: Number(url.searchParams.get('dropRate')) || 0,
    stats: { sent: 0, dropped: 0 },
    bufferedAmount: () => res.writableLength,
    // `event:` is the stream name, so the browser can use es.addEventListener('metrics', ...)
    send: (env) => res.write(`id: ${env.stream}:${env.seq}\nevent: ${env.stream}\ndata: ${toJson(env)}\n\n`),
  };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

// --- REST ---------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
  });
}

async function onRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    if (url.pathname === '/sse') return onSse(req, res, url);

    if (parts[0] === 'api') {
      const [, resource, name] = parts;
      if (resource === 'streams' && req.method === 'GET') return sendJson(res, 200, engine.describe());

      if (resource === 'history' && req.method === 'GET') {
        const h = engine.history[name];
        if (!h) return sendJson(res, 404, { error: `unknown stream "${name}"` });
        const since = Number(url.searchParams.get('since')) || 0;
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, h.length);
        return sendJson(res, 200, h.filter((e) => e.seq > since).slice(-limit));
      }

      if (resource === 'snapshot' && req.method === 'GET') {
        const sim = engine.sims.get(name);
        if (!sim) return sendJson(res, 404, { error: `no snapshot for "${name}"` });
        return sendJson(res, 200, { stream: name, seq: engine.seq[name], t: engine.t, data: sim.snapshot() });
      }

      if (resource === 'control' && req.method === 'POST') {
        const cmd = await readBody(req);
        return sendJson(res, 200, engine.control(cmd));
      }

      if (resource === 'status' && req.method === 'GET') {
        return sendJson(res, 200, {
          t: engine.t,
          speed: engine.speed,
          paused: engine.paused,
          autoIncidents: engine.autoIncidents,
          clients: [...clients].map((c) => ({ id: c.id, kind: c.kind, streams: [...c.subs], ...c.stats })),
        });
      }
    }
    sendJson(res, 404, { error: 'not found', see: '/api/streams' });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

const server = http.createServer(onRequest);
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  handleUpgrade(req, socket, (ws) => onWsConnection(ws, req));
});

engine.start();
server.listen(PORT, () => {
  console.log(`Faux real-time data service on http://localhost:${PORT}`);
  console.log(`  Inspector  http://localhost:${PORT}/`);
  console.log(`  WebSocket  ws://localhost:${PORT}/ws`);
  console.log(`  SSE        http://localhost:${PORT}/sse?streams=metrics,logs`);
  console.log(`  REST       http://localhost:${PORT}/api/streams`);
  console.log(`Streams: ${engine.streams.join(', ')}`);
});
