// ---------------------------------------------------------------------------
// snapshot.js -- Chandy-Lamport global state recording.  (Unit 3)
//
// THE PROBLEM. "What is the state of the ensemble right now?" has no direct
// answer: no node can read the others' memory at one instant, and there is no
// shared instant to read it at. Asking every node "send me your state" gives
// a mix of states taken at different moments, and messages in flight between
// them are simply missing. The result can describe a world that never
// existed -- e.g. a REPLY that was received but, in the collected states,
// never sent.
//
// Chandy-Lamport records a CONSISTENT CUT instead: a set of local states plus
// the messages in transit on each channel, such that every message recorded
// as received was also recorded as sent. It is not a photo of one instant --
// it is a state the system COULD have been in, which is the strongest thing
// an asynchronous system can offer.
//
// ALGORITHM (Chandy & Lamport, 1985). Requires FIFO, reliable channels, which
// is exactly why it runs on the coord channel and not the lossy ctrl one.
//
//   Initiator: record own state, send MARKER on every outgoing channel,
//              start recording every incoming channel.
//
//   On MARKER over channel c:
//     first marker seen?  record own state; channel c is EMPTY; send MARKER
//                         on every outgoing channel; record all OTHER
//                         incoming channels.
//     otherwise           stop recording c. Its state = the messages that
//                         arrived on it since we recorded our own state.
//
//   Done when a marker has arrived on every incoming channel.
//
// Why FIFO matters: the marker separates "sent before the sender's snapshot"
// from "sent after". If a channel could reorder, a post-snapshot message
// could overtake the marker and be recorded as in-transit, producing an
// inconsistent cut. mesh.js preserves FIFO even under emulated delay for this
// reason.
//
// Each node then ships its piece to the initiator, which assembles the global
// state. Snapshots carry an id, so several initiators can run them at once.
//
// What gets recorded as "in transit" in practice is mostly beacons and RA
// messages -- and if you push a link's impairment to 300 ms first, you will
// see several of them caught on that channel. That is the channel state the
// naive approach would have lost.
// ---------------------------------------------------------------------------

const COLLECT_TIMEOUT_MS = 6000;

export class Snapshotter {
  /**
   * @param {object} o
   * @param {string} o.selfId
   * @param {import('./mesh.js').Mesh} o.mesh
   * @param {()=>object} o.captureLocal  returns this node's local state
   * @param {(kind:string, msg:string, cls?:string)=>void} o.log
   * @param {(global:object)=>void} o.onComplete  called on the initiator
   */
  constructor({ selfId, mesh, captureLocal, log, onComplete }) {
    this.selfId = selfId;
    this.mesh = mesh;
    this.captureLocal = captureLocal;
    this.log = log || (() => {});
    this.onComplete = onComplete || (() => {});

    this.active = new Map();     // snapshot id -> per-node recording
    this.collecting = new Map(); // snapshot id -> initiator's assembly
    this._n = 0;
  }

  start() {
    this.mesh.on('coord', ({ peerId, msg }) => this._onMessage(peerId, msg));
  }

  initiate() {
    const id = this.selfId + '#' + (++this._n);
    const participants = [this.selfId, ...this.mesh.coordPeers()];
    const assembly = { id, participants, startedAt: performance.now(), pieces: new Map() };
    assembly.timer = setTimeout(() => this._finishCollect(id, true), COLLECT_TIMEOUT_MS);
    this.collecting.set(id, assembly);
    this.log('snap', 'initiating snapshot ' + id + ' across ' + participants.length + ' node(s)');
    this._recordLocal(id, this.selfId, null);
    return id;
  }

  // -------------------------------------------------------------------------

  _recordLocal(id, initiator, markerFrom) {
    const rec = {
      id,
      initiator,
      local: this.captureLocal(),
      channels: {},              // peerId -> messages recorded in transit
      recording: new Set(),
    };
    for (const p of this.mesh.coordPeers()) {
      // The channel the first marker arrived on is empty by definition.
      if (p !== markerFrom) {
        rec.recording.add(p);
        rec.channels[p] = [];
      } else {
        rec.channels[p] = [];
      }
    }
    this.active.set(id, rec);
    this.mesh.broadcastCoord({ t: 'marker', id, initiator });
    this._maybeDone(rec);
  }

  _onMessage(from, msg) {
    if (msg.t === 'marker') {
      const rec = this.active.get(msg.id);
      if (!rec) {
        this._recordLocal(msg.id, msg.initiator, from);
      } else {
        rec.recording.delete(from);
        this._maybeDone(rec);
      }
      return;
    }
    if (msg.t === 'snap_piece') {
      this._collect(msg);
      return;
    }

    // Any other message on a channel still being recorded was in transit
    // across the cut.
    for (const rec of this.active.values()) {
      if (rec.recording.has(from)) rec.channels[from].push(summarise(msg));
    }
  }

  _maybeDone(rec) {
    if (rec.recording.size) return;
    this.active.delete(rec.id);
    const piece = { t: 'snap_piece', id: rec.id, from: this.selfId, local: rec.local, channels: rec.channels };
    if (rec.initiator === this.selfId) this._collect(piece);
    else this.mesh.sendCoord(rec.initiator, piece);
  }

  _collect(piece) {
    const a = this.collecting.get(piece.id);
    if (!a) return;
    a.pieces.set(piece.from, piece);
    if (a.participants.every((p) => a.pieces.has(p))) this._finishCollect(piece.id, false);
  }

  _finishCollect(id, timedOut) {
    const a = this.collecting.get(id);
    if (!a) return;
    clearTimeout(a.timer);
    this.collecting.delete(id);

    const nodes = [...a.pieces.values()].map((p) => ({ peerId: p.from, ...p.local }));
    const channels = [];
    for (const p of a.pieces.values()) {
      for (const [src, msgs] of Object.entries(p.channels)) {
        // Recorded at the RECEIVER, so the channel is src -> p.from.
        channels.push({ from: src, to: p.from, messages: msgs });
      }
    }
    const missing = a.participants.filter((p) => !a.pieces.has(p));
    if (timedOut) this.log('snap', 'snapshot ' + id + ' timed out waiting for ' + missing.length + ' node(s)', 'warn');
    this.onComplete({
      id,
      tookMs: Math.round(performance.now() - a.startedAt),
      nodes,
      channels,
      missing,
      checks: consistencyChecks(nodes),
    });
  }
}

/** Keep the channel-state display readable: type plus the salient field. */
function summarise(msg) {
  if (msg.t === 'beacon') return 'beacon #' + msg.seq;
  if (msg.t === 'ra_request') return 'REQUEST ts=' + msg.ts;
  if (msg.t === 'ra_reply') return 'REPLY';
  if (msg.t === 'floor') return 'floor→' + (msg.holder ? msg.holder.slice(0, 9) : 'free');
  if (msg.t === 'anchor') return 'anchor ' + Math.round(msg.transport.bpm) + ' BPM';
  return String(msg.t).toUpperCase();
}

/**
 * Global predicates evaluated over the recorded cut. These are the questions
 * you can only ask of a consistent global state.
 */
function consistencyChecks(nodes) {
  const agree = (key) => new Set(nodes.map((n) => JSON.stringify(n[key]))).size <= 1;
  const holders = nodes.filter((n) => n.floor === 'HELD').length;
  const beats = nodes.filter((n) => n.playing).map((n) => n.beat);
  const cycle = waitForCycle(nodes);
  return [
    { name: 'At most one node holds the solo floor (mutual exclusion safety)', ok: holders <= 1, detail: holders + ' holder(s)' },
    {
      name: 'Wait-for graph is acyclic (no deadlock — Knapp: global-state detection)',
      ok: !cycle,
      detail: cycle ? 'cycle: ' + cycle.join(' → ') : countEdges(nodes) + ' wait-for edge(s)',
    },
    { name: 'All nodes agree on the coordinator', ok: agree('coordinator'), detail: '' },
    { name: 'All nodes agree on tempo', ok: agree('bpm'), detail: '' },
    { name: 'All ledger replicas have the same head', ok: agree('ledgerHead'), detail: '' },
    {
      name: 'Recorded beat positions (not simultaneous — a cut is not an instant)',
      ok: true,
      detail: beats.length > 1 ? 'spread ' + (Math.max(...beats) - Math.min(...beats)).toFixed(2) + ' beats' : 'n/a',
    },
  ];
}

/**
 * Deadlock detection over the cut. Each node recorded whom it was waiting on
 * (a Ricart-Agrawala REPLY it had not yet received); together those edges
 * form the global WAIT-FOR GRAPH, and a deadlock is exactly a cycle in it.
 *
 * This is Knapp's fourth class of distributed deadlock detection: take a
 * consistent global state, then look for a cycle in it. It only works
 * because the state is consistent -- on an inconsistent cut you can see an
 * edge that had already gone away next to one that had not yet appeared,
 * and report a "phantom" deadlock that never existed.
 *
 * Ricart-Agrawala itself cannot deadlock: every wait points from a younger
 * request to an older one in the (Lamport ts, id) total order, and an order
 * has no cycles. The check is here to SHOW that, not because it can fire.
 */
function waitForCycle(nodes) {
  const edges = new Map(nodes.map((n) => [n.peerId, n.waitsFor || []]));
  const state = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
  const stack = [];
  const visit = (v) => {
    state.set(v, 1);
    stack.push(v);
    for (const w of edges.get(v) || []) {
      if (state.get(w) === 1) return [...stack.slice(stack.indexOf(w)), w];
      if (!state.has(w)) { const c = visit(w); if (c) return c; }
    }
    stack.pop();
    state.set(v, 2);
    return null;
  };
  for (const v of edges.keys()) {
    if (!state.has(v)) { const c = visit(v); if (c) return c.map((id) => nodes.find((n) => n.peerId === id)?.name || id); }
  }
  return null;
}

const countEdges = (nodes) => nodes.reduce((k, n) => k + (n.waitsFor || []).length, 0);
