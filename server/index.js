// ---------------------------------------------------------------------------
// index.js -- the single server process.
//
// It hosts three things that are logically separate pieces of middleware:
//
//   1. a real gRPC server            (:50051)  -- the RPC control plane
//   2. a gRPC<->JSON transcoding     (:8080)   -- so browsers can reach (1)
//      gateway + static file server
//   3. an MQTT broker                (:1883 TCP, :9001 WebSocket)
//                                              -- the pub/sub event plane
//
// plus three Unit 4 additions that ride on the same process:
//
//   4. the session LEDGER            -- hash-chained log of control decisions
//   5. a FUNCTION RUNTIME  /fn/*     -- runs functions/ the serverless way
//   6. a TELEMETRY SINK + /analytics -- logs telemetry, analysed by MapReduce
//
// Note what the server does NOT host: audio. Once it has relayed the WebRTC
// handshake, media flows peer-to-peer and the server is out of the path.
// This is the "server bootstraps the mesh, then gets out of the way" pattern.
// ---------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import Aedes from 'aedes';
import { createServer as createMqttServer } from 'aedes-server-factory';
import mqtt from 'mqtt';
import { Registry, PEER_TIMEOUT_MS } from './registry.js';
import { makeBlock } from '../web/ledger.js';
import { FunctionRuntime } from './faas.js';
import { runJob } from './mapreduce.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const GRPC_PORT = Number(process.env.GRPC_PORT || 50051);
const MQTT_TCP_PORT = Number(process.env.MQTT_TCP_PORT || 1883);
const MQTT_WS_PORT = Number(process.env.MQTT_WS_PORT || 9001);
// The port BROWSERS should use for the broker. Normally the same as above;
// differs behind a port mapping, e.g. a Kubernetes NodePort (k8s/).
const MQTT_WS_PUBLIC_PORT = Number(process.env.MQTT_WS_PUBLIC_PORT || MQTT_WS_PORT);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const log = (tag, ...rest) =>
  console.log('[' + new Date().toISOString().slice(11, 23) + '] ' + tag, ...rest);

// ===========================================================================
// 1. MQTT broker
// ===========================================================================
// Embedded by default so the project runs with nothing to install. Set
// EMBEDDED_BROKER=0 to run against an external Mosquitto instead (see
// mosquitto/mosquitto.conf) -- the peers cannot tell the difference, because
// both are ordinary MQTT 3.1.1 brokers on the same ports.
const USE_EMBEDDED_BROKER = process.env.EMBEDDED_BROKER !== '0';

if (USE_EMBEDDED_BROKER) {
  const aedes = new Aedes();
  createMqttServer(aedes).listen(MQTT_TCP_PORT, () =>
    log('mqtt', 'embedded TCP broker listening on ' + MQTT_TCP_PORT));
  createMqttServer(aedes, { ws: true }).listen(MQTT_WS_PORT, () =>
    log('mqtt', 'embedded WebSocket broker listening on ' + MQTT_WS_PORT));

  aedes.on('client', (c) => log('mqtt', '+ client ' + c.id));
  aedes.on('clientDisconnect', (c) => log('mqtt', '- client ' + c.id));
} else {
  log('mqtt', 'embedded broker disabled — expecting external Mosquitto on ' +
    MQTT_TCP_PORT + '/' + MQTT_WS_PORT);
}

// The server participates in its own broker as an ordinary MQTT client. It has
// no privileged back door -- this is the same connection a peer would make.
// Where the broker lives. Loopback when embedded; a service name such as
// "broker" when running under Docker Compose, where the container's DNS
// resolves it. The server neither knows nor cares which it gets -- that
// substitutability is the practical benefit of containerising it.
const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';

const bus = mqtt.connect('mqtt://' + MQTT_HOST + ':' + MQTT_TCP_PORT, { clientId: 'session-server' });
bus.on('connect', () => {
  log('mqtt', 'session-server connected to broker');
  // Telemetry sink (see section 6).
  bus.subscribe('session/+/telemetry/+', { qos: 0 });
});

/**
 * Publish a control event.
 *
 * retain=true is load-bearing here: a node that joins late (or reconnects
 * after a crash) is handed the CURRENT tempo, roster, transport and master
 * immediately on subscribe, instead of sitting silent until the next change
 * happens to occur. QoS 1 gives at-least-once delivery, which is what control
 * messages want -- a duplicated tempo update is harmless because applying it
 * is idempotent, whereas a lost one desynchronises the ensemble.
 */
function publish(topic, payload, opts) {
  const { retain = true, qos = 1 } = opts || {};
  bus.publish(topic, JSON.stringify(payload), { retain, qos });
}

// ===========================================================================
// 2. Registry, wired so every state change fans out over MQTT
// ===========================================================================
const registry = new Registry((sessionId, kind) => {
  const s = registry.sessions.get(sessionId);
  if (!s) return;
  const base = 'session/' + sessionId;
  if (kind === 'roster') publish(base + '/participants', registry.participants(sessionId));
  if (kind === 'tempo') publish(base + '/tempo', { bpm: s.bpm });
  if (kind === 'transport') publish(base + '/transport', s.transport);
  if (kind === 'master') {
    publish(base + '/master', { masterPeerId: s.masterPeerId });
    appendLedger(sessionId, 'master', { masterPeerId: s.masterPeerId });
    log('fault', 'session ' + sessionId + ': timing master -> ' + (s.masterPeerId || '(none)'));
  }
});

// Failure detector loop.
setInterval(() => {
  for (const ev of registry.reapDeadPeers()) {
    log('fault', 'evicted silent peer ' + ev.peer.peerName + ' (' + ev.peer.peerId + ')');
    publish('session/' + ev.sessionId + '/events',
      { kind: 'peer_lost', peerId: ev.peer.peerId, peerName: ev.peer.peerName },
      { retain: false });
    appendLedger(ev.sessionId, 'peer_lost', { peerId: ev.peer.peerId, peerName: ev.peer.peerName });
  }
}, 2000);

// ===========================================================================
// 2b. Session ledger (Unit 4 self-study -- see web/ledger.js)
// ===========================================================================
// The server is the single appender: it decides the order of blocks, every
// peer replicates and verifies them. That is the "ordering service" model of
// permissioned ledgers, chosen because our participants are known -- see the
// header of web/ledger.js for what that does and does not give us.
const ledgers = new Map();      // sessionId -> Block[]
const ledgerQueue = new Map();  // sessionId -> Promise (appends are serialised)

function appendLedger(sessionId, kind, data) {
  // Hashing is async. Without the queue, two appends in the same tick would
  // both build on the same predecessor and fork the chain.
  const prev = ledgerQueue.get(sessionId) || Promise.resolve();
  const next = prev.then(async () => {
    const chain = ledgers.get(sessionId) || [];
    const block = await makeBlock(chain[chain.length - 1] || null, kind, data);
    chain.push(block);
    ledgers.set(sessionId, chain);
    // Volatile, QoS 1: a peer that misses one fetches the chain over gRPC,
    // and replicas reject anything that does not link.
    publish('session/' + sessionId + '/ledger', block, { retain: false });
  }).catch((e) => log('ledger', 'append failed: ' + e.message));
  ledgerQueue.set(sessionId, next);
  return next;
}

// ===========================================================================
// 3. gRPC service implementation
// ===========================================================================
const packageDef = protoLoader.loadSync(path.join(ROOT, 'proto', 'session.proto'), {
  keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).ensemble;

const ok = (cb, value) => cb(null, value);
const fail = (cb, err) =>
  cb({ code: grpc.status.FAILED_PRECONDITION, message: String((err && err.message) || err) });

// The address browsers should use for the broker. Derived from the incoming
// HTTP request so that a second laptop connecting over the LAN is told that
// laptop-reachable address rather than a useless 127.0.0.1.
let advertisedHost = '127.0.0.1';

const impl = {
  CreateSession(call, cb) {
    try {
      const s = registry.createSession({
        displayName: call.request.displayName,
        bpm: call.request.bpm,
        beatsPerBar: call.request.beatsPerBar,
      });
      log('rpc', 'CreateSession -> ' + s.sessionId + ' @ ' + s.bpm + ' BPM');
      appendLedger(s.sessionId, 'created', {
        displayName: s.displayName, bpm: s.bpm, beatsPerBar: s.beatsPerBar,
      });
      ok(cb, registry.info(s.sessionId));
    } catch (e) { fail(cb, e); }
  },

  JoinSession(call, cb) {
    try {
      const r = registry.join(call.request.sessionId, {
        peerName: call.request.peerName,
        instrument: call.request.instrument,
      });
      log('rpc', 'JoinSession ' + call.request.sessionId + ' <- ' + r.peer.peerName);
      appendLedger(call.request.sessionId, 'join', {
        peerId: r.peer.peerId, peerName: r.peer.peerName,
        becameMaster: r.session.masterPeerId === r.peer.peerId,
      });
      ok(cb, {
        peerId: r.peer.peerId,
        session: registry.info(call.request.sessionId),
        // Peers already present. The NEWCOMER sends the WebRTC offers; the
        // incumbents answer. Fixing the direction like this means two nodes
        // can never both offer at once, so we never hit glare.
        existingPeers: r.existing.map((p) => ({
          peerId: p.peerId, peerName: p.peerName, instrument: p.instrument,
          armed: p.armed, isMaster: false, joinedAtMs: p.joinedAtMs,
        })),
        mqttWsUrl: 'ws://' + advertisedHost + ':' + MQTT_WS_PUBLIC_PORT,
      });
    } catch (e) { fail(cb, e); }
  },

  LeaveSession(call, cb) {
    if (registry.sessions.get(call.request.sessionId)?.peers.has(call.request.peerId)) {
      appendLedger(call.request.sessionId, 'leave', { peerId: call.request.peerId });
    }
    registry.leave(call.request.sessionId, call.request.peerId);
    log('rpc', 'LeaveSession ' + call.request.peerId);
    ok(cb, { ok: true, message: 'left' });
  },

  ListParticipants(call, cb) {
    try { ok(cb, { participants: registry.participants(call.request.sessionId) }); }
    catch (e) { fail(cb, e); }
  },

  SetTempo(call, cb) {
    try {
      registry.setTempo(call.request.sessionId, call.request.bpm);
      log('rpc', 'SetTempo ' + call.request.sessionId + ' -> ' + call.request.bpm + ' BPM');
      appendLedger(call.request.sessionId, 'tempo', { bpm: call.request.bpm, byPeerId: call.request.peerId });
      ok(cb, { ok: true, message: 'tempo ' + call.request.bpm });
    } catch (e) { fail(cb, e); }
  },

  ArmTrack(call, cb) {
    try {
      registry.arm(call.request.sessionId, call.request.peerId, call.request.armed);
      ok(cb, { ok: true, message: call.request.armed ? 'armed' : 'disarmed' });
    } catch (e) { fail(cb, e); }
  },

  SetTransport(call, cb) {
    try {
      const t = registry.setTransport(call.request.sessionId, call.request.playing);
      log('rpc', 'SetTransport ' + call.request.sessionId + ' playing=' + call.request.playing);
      appendLedger(call.request.sessionId, 'transport', { playing: call.request.playing, byPeerId: call.request.peerId });
      ok(cb, t);
    } catch (e) { fail(cb, e); }
  },

  // Cristian's algorithm, server half. Deliberately does the absolute minimum
  // between reading the clock and returning, so the instant we report sits as
  // close as possible to the midpoint of the round trip -- which is exactly
  // the assumption the client's estimate rests on.
  GetServerTime(call, cb) {
    ok(cb, { clientSendMs: call.request.clientSendMs, serverTimeMs: Date.now() });
  },

  Heartbeat(call, cb) {
    const master = registry.heartbeat(call.request.sessionId, call.request.peerId);
    ok(cb, { alive: true, masterPeerId: master });
  },

  async GetLedger(call, cb) {
    const sid = call.request.sessionId;
    if (!ledgers.has(sid)) return fail(cb, 'no ledger for session: ' + sid);
    // Wait for in-flight appends so the reply is a complete prefix.
    await ledgerQueue.get(sid);
    ok(cb, { blocks: ledgers.get(sid) });
  },
};

const grpcServer = new grpc.Server();
grpcServer.addService(proto.SessionService.service, impl);
let grpcReady = false;
grpcServer.bindAsync('0.0.0.0:' + GRPC_PORT, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) { console.error('gRPC bind failed', err); process.exit(1); }
  grpcReady = true;
  log('grpc', 'SessionService listening on ' + port + ' (HTTP/2, protobuf)');
});

// ===========================================================================
// 4. gRPC <-> JSON transcoding gateway
//
// Browsers cannot speak gRPC: it requires HTTP/2 trailers, which no browser
// exposes to JavaScript. The standard answer is a proxy that transcodes --
// Envoy's grpc_json_transcoder, grpc-web, Connect. We implement that same
// idea in-process: POST /rpc/<Method> with a JSON body becomes a real gRPC
// call over the loopback through a real client stub built from the .proto.
//
// So the browser genuinely invokes the gRPC service, via a gateway, exactly
// as it would in production. grpcurl hits the identical service directly.
// ===========================================================================
const gwClient = new proto.SessionService(
  '127.0.0.1:' + GRPC_PORT, grpc.credentials.createInsecure());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Serve the mqtt.js browser bundle straight out of node_modules so the page
  // has zero external dependencies and works with no internet at all.
  const file = rel.startsWith('/vendor/mqtt.js')
    ? path.join(ROOT, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js')
    : path.join(ROOT, 'web', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  advertisedHost = url.hostname;

  if (url.pathname.startsWith('/rpc/')) {
    const method = url.pathname.slice(5);
    if (typeof gwClient[method] !== 'function') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown method ' + method }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let request;
      try { request = body ? JSON.parse(body) : {}; }
      catch { res.writeHead(400).end('bad json'); return; }

      gwClient[method](request, (err, reply) => {
        res.writeHead(err ? 400 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(err ? { error: err.details || err.message } : reply));
      });
    });
    return;
  }

  // Kubernetes probes (k8s/server.yaml). Two different questions:
  //   liveness  -- is the process wedged? If not, leave it alone.
  //   readiness -- can it do useful work? Not until gRPC is bound AND the
  //                broker is reachable; until then, send it no traffic.
  // Conflating them is a classic mistake: a broker outage would fail a
  // liveness check and Kubernetes would restart a perfectly healthy server,
  // which cannot fix the broker and drops every session's state.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (url.pathname === '/readyz') {
    const ready = grpcReady && bus.connected;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ready, grpc: grpcReady, broker: bus.connected }));
  }

  if (url.pathname.startsWith('/fn/')) {
    functions.handle(url.pathname.slice(4), req, res, url);
    return;
  }

  if (url.pathname.startsWith('/analytics/')) {
    runAnalytics(url.pathname.slice(11), url, res);
    return;
  }

  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      mqttWsUrl: 'ws://' + url.hostname + ':' + MQTT_WS_PUBLIC_PORT,
      grpcPort: GRPC_PORT,
      peerTimeoutMs: PEER_TIMEOUT_MS,
    }));
  }

  serveStatic(res, url.pathname);
});

// ===========================================================================
// 5. Function runtime (Unit 4 -- serverless architectures, see faas.js)
// ===========================================================================
const functions = new FunctionRuntime({
  dir: path.join(ROOT, 'functions'),
  idleMs: Number(process.env.FAAS_IDLE_MS || 60000),
  log,
});

// ===========================================================================
// 6. Telemetry sink + batch analytics (Unit 4 -- Hadoop / MapReduce)
// ===========================================================================
// Every telemetry sample peers publish is appended, one JSON object per line,
// to data/telemetry/<sessionId>.jsonl. Live telemetry drives compensation
// (stream processing: each sample matters for about one second). The log is
// the same data at rest, for questions no single sample can answer -- "what
// was the p95 delay on each link over the whole rehearsal?" That split
// between online and batch processing is exactly where Hadoop sits.
const SESSION_ID_RE = /^sess-[a-z0-9-]+$/;
const telemetryDir = path.join(DATA_DIR, 'telemetry');
fs.mkdirSync(telemetryDir, { recursive: true });

bus.on('message', (topic, payload) => {
  const parts = topic.split('/');
  if (parts[0] !== 'session' || parts[2] !== 'telemetry' || !SESSION_ID_RE.test(parts[1])) return;
  let sample;
  try { sample = JSON.parse(payload.toString()); } catch { return; }
  sample.receivedAtMs = Date.now();
  fs.appendFile(path.join(telemetryDir, parts[1] + '.jsonl'), JSON.stringify(sample) + '\n', () => {});
});

async function runAnalytics(sessionId, url, res) {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!SESSION_ID_RE.test(sessionId)) return send(400, { error: 'bad session id' });
  const file = path.join(telemetryDir, sessionId + '.jsonl');
  if (!fs.existsSync(file)) return send(404, { error: 'no telemetry recorded for ' + sessionId });
  try {
    const out = await runJob({
      jobPath: path.join(ROOT, 'analytics', 'link-stats.js'),
      inputFiles: [file],
      splits: Number(url.searchParams.get('splits') || 4),
      reducers: Number(url.searchParams.get('reducers') || 2),
      failRate: Number(url.searchParams.get('failRate') || 0),
    });
    log('mapreduce', sessionId + ': ' + out.stats.records + ' records, ' +
      out.stats.mapTasks + ' map + ' + out.stats.reduceTasks + ' reduce tasks, ' +
      out.stats.retries + ' retried, ' + out.stats.totalMs + ' ms');
    send(200, out);
  } catch (e) {
    send(500, { error: e.message });
  }
}

httpServer.listen(HTTP_PORT, () => {
  log('http', 'client + gRPC/JSON gateway on http://localhost:' + HTTP_PORT);
  console.log('');
  console.log('  Distributed Latency-Compensated Ensemble Synchronisation');
  console.log('  ------------------------------------------------------------');
  console.log('  open    http://localhost:' + HTTP_PORT);
  console.log('  gRPC    127.0.0.1:' + GRPC_PORT + '   (grpcurl works against this)');
  console.log('  MQTT    tcp 127.0.0.1:' + MQTT_TCP_PORT + '   ws 127.0.0.1:' + MQTT_WS_PORT);
  console.log('');
});

process.on('SIGINT', () => { log('sys', 'shutting down'); process.exit(0); });
