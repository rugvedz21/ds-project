// ---------------------------------------------------------------------------
// registry.js -- authoritative session state for the control plane.
//
// This is the ONLY globally shared mutable state in the system. Everything
// else (audio, note events, RTT measurements) is peer-local by design, which
// is what keeps the data plane fully decentralised.
// ---------------------------------------------------------------------------

const DEFAULT_BPM = 100;
const DEFAULT_BEATS_PER_BAR = 4;

// A peer that has not sent a Heartbeat within this window is presumed dead.
// Deliberately generous: a false positive would evict a live musician.
// Overridable because some Chromium builds block the page for several seconds
// while constructing each RTCPeerConnection, which can starve a joining
// peer's first heartbeat past the default.
export const PEER_TIMEOUT_MS = Number(process.env.PEER_TIMEOUT_MS || 6000);

let seq = 0;
const nextId = (prefix) => `${prefix}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export class Registry {
  constructor(onEvent) {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    // Called as onEvent(sessionId, kind) whenever state changes in a way the
    // rest of the cluster needs to hear about. The server wires this to MQTT.
    this.onEvent = onEvent || (() => {});
  }

  createSession({ displayName, bpm, beatsPerBar }) {
    const id = nextId('sess');
    const session = {
      sessionId: id,
      displayName: displayName || `Session ${id.slice(5, 9)}`,
      bpm: bpm > 0 ? bpm : DEFAULT_BPM,
      beatsPerBar: beatsPerBar > 0 ? beatsPerBar : DEFAULT_BEATS_PER_BAR,
      masterPeerId: '',
      createdAtMs: Date.now(),
      peers: new Map(),
      transport: {
        playing: false,
        anchorBeat: 0,
        anchorTimeMs: Date.now(),
        bpm: bpm > 0 ? bpm : DEFAULT_BPM,
      },
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no such session: ${sessionId}`);
    return s;
  }

  join(sessionId, { peerName, instrument }) {
    const s = this.get(sessionId);
    const peerId = nextId('peer');
    const peer = {
      peerId,
      peerName: peerName || 'anonymous',
      instrument: instrument || 'click',
      armed: false,
      joinedAtMs: Date.now(),
      lastSeenMs: Date.now(),
    };
    // The peers already present -- captured BEFORE inserting the newcomer,
    // because the newcomer is the one who must send the WebRTC offers.
    const existing = [...s.peers.values()];
    s.peers.set(peerId, peer);

    // First peer in becomes the timing master. Simple and deterministic.
    // The peers also run a real Bully election among themselves
    // (web/election.js) using the same seniority rule, so the two agree while
    // this server is up -- and the peers can still pick a leader when it
    // is not.
    if (!s.masterPeerId) s.masterPeerId = peerId;

    this.onEvent(sessionId, 'roster');
    return { peer, existing, session: s };
  }

  leave(sessionId, peerId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.peers.delete(peerId);
    if (s.masterPeerId === peerId) this.promoteMaster(s);
    this.onEvent(sessionId, 'roster');
    if (s.peers.size === 0) this.sessions.delete(sessionId);
  }

  // Deterministic successor: the longest-serving surviving peer. Every node
  // could compute this identically from the roster, which is precisely why
  // it is safe -- there is nothing to disagree about.
  promoteMaster(s) {
    const survivors = [...s.peers.values()].sort((a, b) => a.joinedAtMs - b.joinedAtMs);
    const previous = s.masterPeerId;
    s.masterPeerId = survivors.length ? survivors[0].peerId : '';
    if (previous !== s.masterPeerId) this.onEvent(s.sessionId, 'master');
    return s.masterPeerId;
  }

  setTempo(sessionId, bpm) {
    const s = this.get(sessionId);
    if (!(bpm >= 20 && bpm <= 300)) throw new Error('bpm out of range (20-300)');

    // Re-anchor the timeline at the current instant so the tempo change does
    // not retroactively move beats that have already been played. Everything
    // before now keeps its old mapping; everything after uses the new rate.
    const now = Date.now();
    s.transport.anchorBeat = beatAt(s.transport, now);
    s.transport.anchorTimeMs = now;
    s.transport.bpm = bpm;
    s.bpm = bpm;

    this.onEvent(sessionId, 'tempo');
    this.onEvent(sessionId, 'transport');
  }

  setTransport(sessionId, playing) {
    const s = this.get(sessionId);
    const now = Date.now();
    if (playing && !s.transport.playing) {
      // Start two beats in the future so every node -- including one on a
      // slow link -- has time to receive the message and schedule beat 0
      // before it arrives. Without this lead-in, distant nodes join late.
      const leadInBeats = 2;
      s.transport.anchorBeat = 0;
      s.transport.anchorTimeMs = now + (leadInBeats * 60000) / s.transport.bpm;
    } else if (!playing) {
      s.transport.anchorBeat = 0;
      s.transport.anchorTimeMs = now;
    }
    s.transport.playing = playing;
    this.onEvent(sessionId, 'transport');
    return s.transport;
  }

  arm(sessionId, peerId, armed) {
    const s = this.get(sessionId);
    const p = s.peers.get(peerId);
    if (!p) throw new Error(`no such peer: ${peerId}`);
    p.armed = armed;
    this.onEvent(sessionId, 'roster');
  }

  heartbeat(sessionId, peerId) {
    const s = this.sessions.get(sessionId);
    const p = s?.peers.get(peerId);
    if (p) p.lastSeenMs = Date.now();
    return s?.masterPeerId || '';
  }

  // Failure detector. Crash-stop model with a timeout -- the only kind of
  // failure detection available in an asynchronous network, and necessarily
  // imperfect (a peer that is merely slow is indistinguishable from one that
  // is dead). We accept false positives and let the peer rejoin.
  reapDeadPeers() {
    const now = Date.now();
    const evicted = [];
    for (const s of this.sessions.values()) {
      for (const p of [...s.peers.values()]) {
        if (now - p.lastSeenMs > PEER_TIMEOUT_MS) {
          s.peers.delete(p.peerId);
          evicted.push({ sessionId: s.sessionId, peer: p });
          if (s.masterPeerId === p.peerId) this.promoteMaster(s);
        }
      }
      if (evicted.some((e) => e.sessionId === s.sessionId)) this.onEvent(s.sessionId, 'roster');
      if (s.peers.size === 0) this.sessions.delete(s.sessionId);
    }
    return evicted;
  }

  participants(sessionId) {
    const s = this.get(sessionId);
    return [...s.peers.values()].map((p) => ({
      peerId: p.peerId,
      peerName: p.peerName,
      instrument: p.instrument,
      armed: p.armed,
      isMaster: p.peerId === s.masterPeerId,
      joinedAtMs: p.joinedAtMs,
    }));
  }

  info(sessionId) {
    const s = this.get(sessionId);
    return {
      sessionId: s.sessionId,
      displayName: s.displayName,
      bpm: s.bpm,
      beatsPerBar: s.beatsPerBar,
      masterPeerId: s.masterPeerId,
      createdAtMs: s.createdAtMs,
      transport: s.transport,
    };
  }
}

// beat(t) = anchor_beat + (t - anchor_time) * bpm / 60000
export function beatAt(transport, tMs) {
  return transport.anchorBeat + ((tMs - transport.anchorTimeMs) * transport.bpm) / 60000;
}
