// ---------------------------------------------------------------------------
// mesh.js -- the peer-to-peer data plane.
//
// Every node opens an RTCPeerConnection to every other node: a full mesh, so
// n musicians means n(n-1)/2 connections and each node maintains n-1 of them.
// That is O(n^2) and it is the reason this design targets small ensembles
// (3-5). We chose it anyway because the alternative -- routing audio through
// a central mixer (an SFU/MCU) -- would put the server back in the media path
// and add a full extra hop of delay to every note, which is precisely the
// quantity this whole project exists to minimise.
//
// Each connection carries two things:
//
//   * a MEDIA track     -- continuous audio, stream-oriented communication.
//                          Unreliable and unordered by design: a late audio
//                          packet is worthless, so retransmitting it would
//                          make things worse, not better.
//
//   * a DATA CHANNEL    -- tiny urgent messages (note-on events, RTT probes),
//                          configured unreliable/unordered for the same
//                          reason. This is P2P messaging.
//
// SIGNALLING. Before two peers can talk directly they must exchange SDP and
// ICE candidates, and they cannot do that over a connection that does not
// exist yet. Something already-connected must relay it -- that is the whole
// job of signalling. We relay over MQTT rather than inventing a side channel,
// which is a nice demonstration that signalling is just message passing:
// topic session/{id}/signal/{peerId}, with each node subscribed to its own.
//
// GLARE. If both peers send an offer simultaneously the handshake deadlocks.
// We avoid it structurally: JoinSession tells the newcomer who is already
// present, and the NEWCOMER always offers while incumbents always answer. The
// direction is therefore never ambiguous and glare cannot arise.
// ---------------------------------------------------------------------------

const RTC_CONFIG = {
  // On a LAN or on one machine, host candidates are enough and no STUN is
  // needed -- which matters, because the demo must work with no internet.
  // The STUN entry is a harmless best-effort addition for other networks.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const PING_INTERVAL_MS = 250;
const RTT_WINDOW = 20;

export class Mesh {
  constructor({ selfId, sessionId, bus, audio, onEvent }) {
    this.selfId = selfId;
    this.sessionId = sessionId;
    this.bus = bus;
    this.audio = audio;
    this.onEvent = onEvent || (() => {});
    this.peers = new Map(); // peerId -> PeerLink
    this._pingTimer = null;
  }

  start() {
    // Our personal signalling mailbox.
    this.bus.on('session/' + this.sessionId + '/signal/' + this.selfId, (msg) => {
      this._handleSignal(msg).catch((e) => console.warn('signal error', e));
    });
    this._pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS);
  }

  stop() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  _signal(toPeerId, payload) {
    // Volatile, QoS 1: signalling must arrive, but a stale retained offer
    // would be actively harmful to the next node that subscribes.
    this.bus.publish(
      'session/' + this.sessionId + '/signal/' + toPeerId,
      { from: this.selfId, ...payload },
      { retain: false, qos: 1 },
    );
  }

  /**
   * Reconcile the mesh against the roster: connect to new peers, drop gone ones.
   *
   * Only ONE side of each pair may offer, or both send an offer at the same
   * time and the handshake deadlocks (glare). We break the symmetry with a
   * total order over peers -- join time, with the peer id as tie-break -- and
   * the later arrival always offers. Both nodes evaluate the same comparison
   * on the same roster and necessarily reach opposite conclusions, so exactly
   * one offer is sent per pair, with no negotiation needed to decide who.
   */
  syncRoster(participants) {
    const me = participants.find((p) => p.peerId === this.selfId);
    const live = new Set(participants.map((p) => p.peerId));
    live.delete(this.selfId);

    for (const p of participants) {
      if (p.peerId === this.selfId || this.peers.has(p.peerId)) continue;
      if (me && this.shouldOffer(me, p)) this.connectTo(p.peerId, true);
      // Otherwise we are the incumbent: stay passive and answer their offer.
    }
    for (const id of [...this.peers.keys()]) {
      if (!live.has(id)) this.removePeer(id);
    }
  }

  shouldOffer(me, other) {
    if (me.joinedAtMs !== other.joinedAtMs) return me.joinedAtMs > other.joinedAtMs;
    return me.peerId > other.peerId;
  }

  connectTo(peerId, asOfferer) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    const link = new PeerLink(this, peerId);
    this.peers.set(peerId, link);
    link.init(asOfferer);
    this.onEvent('peer_connecting', { peerId });
    return link;
  }

  removePeer(peerId) {
    const link = this.peers.get(peerId);
    if (!link) return;
    link.close();
    this.peers.delete(peerId);
    this.audio.detachPeer(peerId);
    this.onEvent('peer_gone', { peerId });
  }

  async _handleSignal(msg) {
    const from = msg.from;
    if (!from || from === this.selfId) return;

    let link = this.peers.get(from);
    if (!link) {
      // An offer from a peer we have not set up yet: we are the incumbent,
      // so we answer rather than offer.
      link = this.connectTo(from, false);
    }
    await link.handleSignal(msg);
  }

  _pingAll() {
    for (const link of this.peers.values()) link.sendPing();
  }

  /** Broadcast a note event to every peer over the data channels. */
  broadcastNote(note) {
    for (const link of this.peers.values()) link.send({ t: 'note', ...note });
  }

  /**
   * The ADDRESS each peer is currently reachable at, read from the live ICE
   * candidate pair. Distinct from the peer's identifier: the identifier is
   * assigned once and never changes, whereas this can change underneath it
   * (ICE restart, switching from Wi-Fi to Ethernet) without the peer becoming
   * a different peer. See docs/ARCHITECTURE.md Part 3.
   */
  async addresses() {
    const out = {};
    for (const [peerId, link] of this.peers) {
      out[peerId] = await link.address();
    }
    return out;
  }

  stats() {
    const out = [];
    for (const [peerId, l] of this.peers) {
      out.push({
        peerId,
        state: l.pc ? l.pc.connectionState : 'new',
        iceState: l.pc ? l.pc.iceConnectionState : 'new',
        rttMs: l.rttMs,
        jitterMs: l.jitterMs,
        oneWayMs: l.oneWayMs,
        lossPct: l.lossPct,
        dcOpen: l.dc && l.dc.readyState === 'open',
        impairMs: this.audio.getImpairment(peerId),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// One link to one peer.
// ---------------------------------------------------------------------------
class PeerLink {
  constructor(mesh, peerId) {
    this.mesh = mesh;
    this.peerId = peerId;
    this.pc = null;
    this.dc = null;

    this.rttMs = 0;
    this.jitterMs = 0;
    this.oneWayMs = 0;
    this.lossPct = 0;

    this._samples = [];
    this._pingSeq = 0;
    this._sent = 0;
    this._recv = 0;
    this._lost = 0;
    this._pending = new Map(); // seq -> send time
    this._remoteCandidates = new Map(); // port -> { address, type, protocol }
  }

  init(asOfferer) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    // Send our outbound mix (metronome + own instrument + optional mic).
    for (const track of this.mesh.audio.outboundStream.getAudioTracks()) {
      pc.addTrack(track, this.mesh.audio.outboundStream);
    }

    pc.ontrack = (ev) => {
      this.mesh.audio.attachRemoteStream(this.peerId, ev.streams[0]);
      this.mesh.onEvent('peer_audio', { peerId: this.peerId });
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.mesh._signal(this.peerId, { kind: 'ice', data: ev.candidate });
    };

    pc.onconnectionstatechange = () => {
      this.mesh.onEvent('peer_state', { peerId: this.peerId, state: pc.connectionState });
      if (pc.connectionState === 'failed') this.mesh.removePeer(this.peerId);
    };

    if (asOfferer) {
      // maxRetransmits:0 + ordered:false => unreliable, unordered. Correct for
      // real-time control traffic: a note-on that arrives after its moment has
      // passed is not just useless, it is wrong, and holding up the messages
      // behind it while we retransmit it makes everything later still.
      this.dc = pc.createDataChannel('ctrl', { ordered: false, maxRetransmits: 0 });
      this._wireDataChannel(this.dc);
      this._makeOffer();
    } else {
      pc.ondatachannel = (ev) => { this.dc = ev.channel; this._wireDataChannel(this.dc); };
    }
  }

  async _makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.mesh._signal(this.peerId, { kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
  }

  async handleSignal(msg) {
    const pc = this.pc;
    if (msg.kind === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.mesh._signal(this.peerId, { kind: 'answer', data: { type: answer.type, sdp: answer.sdp } });
    } else if (msg.kind === 'answer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      }
    } else if (msg.kind === 'ice') {
      this._noteCandidate(msg.data && msg.data.candidate);
      // ICE candidates routinely arrive before the remote description is set.
      // Failing here is normal and harmless -- the connection still forms from
      // the candidates that do land.
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.data)); } catch {}
    }
  }

  _wireDataChannel(dc) {
    dc.onopen = () => this.mesh.onEvent('dc_open', { peerId: this.peerId });
    dc.onclose = () => this.mesh.onEvent('dc_close', { peerId: this.peerId });
    dc.onmessage = (ev) => {
      // Emulated network delay is applied to received control traffic as well
      // as to received audio, so a ping/pong genuinely takes longer when the
      // link is impaired. The measured RTT therefore reflects the impairment
      // instead of being a display-only number.
      const impair = this.mesh.audio.getImpairment(this.peerId);
      const deliver = () => this._onMessage(ev.data);
      if (impair > 0) setTimeout(deliver, impair); else deliver();
    };
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'ping') {
      // Echo immediately, carrying the original stamp untouched. Any time we
      // spend here would be misread by the sender as network delay.
      this.send({ t: 'pong', seq: msg.seq, ts: msg.ts });
      return;
    }

    if (msg.t === 'pong') {
      const sentAt = this._pending.get(msg.seq);
      if (sentAt === undefined) return;
      this._pending.delete(msg.seq);
      this._recv++;
      this._recordRtt(performance.now() - sentAt);
      return;
    }

    if (msg.t === 'note') {
      this.mesh.onEvent('note', { peerId: this.peerId, note: msg });
    }
  }

  _recordRtt(rtt) {
    this._samples.push(rtt);
    if (this._samples.length > RTT_WINDOW) this._samples.shift();

    // Median, not mean: RTT distributions have a long right tail (a single
    // scheduling hiccup produces one huge sample) and the median ignores it
    // where an average would be dragged upward for seconds afterwards.
    const sorted = [...this._samples].sort((a, b) => a - b);
    this.rttMs = sorted[Math.floor(sorted.length / 2)];

    // Jitter = mean absolute deviation of consecutive samples, which is the
    // same notion RFC 3550 uses for RTP. It matters here because jitter, not
    // raw delay, is what a fixed compensation delay cannot absorb.
    let acc = 0;
    for (let i = 1; i < this._samples.length; i++) {
      acc += Math.abs(this._samples[i] - this._samples[i - 1]);
    }
    this.jitterMs = this._samples.length > 1 ? acc / (this._samples.length - 1) : 0;

    // The RTT/2 assumption. It is exactly true only on a symmetric path, and
    // real paths are often not symmetric. We state it rather than hide it:
    // this is the largest known source of error in the compensation figure.
    this.oneWayMs = this.rttMs / 2;

    this.mesh.audio.setOneWay(this.peerId, this.oneWayMs);
  }

  sendPing() {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const seq = ++this._pingSeq;
    this._sent++;
    this._pending.set(seq, performance.now());
    this.send({ t: 'ping', seq, ts: Date.now() });

    // Anything unanswered after 2 s is counted lost. On an unreliable data
    // channel loss is expected, not exceptional -- we measure it rather than
    // trying to eliminate it.
    //
    // Loss is computed over *settled* probes only: a ping still legitimately
    // in flight is neither delivered nor lost yet, and counting it against the
    // total would report phantom loss that merely tracks the probe rate.
    const cutoff = performance.now() - 2000;
    for (const [s, at] of this._pending) {
      if (at < cutoff) { this._pending.delete(s); this._lost++; }
    }
    const settled = this._recv + this._lost;
    this.lossPct = settled > 0 ? (100 * this._lost) / settled : 0;
  }

  send(obj) {
    if (this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(obj)); } catch {}
    }
  }

  /**
   * Remember the address carried in a raw ICE candidate line.
   *
   * Chrome redacts host IP addresses from getStats() to stop pages harvesting
   * the user's local network layout, and substitutes an mDNS name of the form
   * <uuid>.local. That substitution is itself a naming problem in miniature:
   * the browser hands out a NAME precisely so it does not have to hand out an
   * ADDRESS, and the name has to be resolved before any packet can be sent.
   *
   * Candidate line format (SDP):
   *   candidate:<foundation> <component> <proto> <pri> <ADDR> <PORT> typ <TYPE> ...
   */
  _noteCandidate(line) {
    if (typeof line !== 'string') return;
    const f = line.split(' ');
    if (f.length < 8) return;
    this._remoteCandidates.set(Number(f[5]), { address: f[4], type: f[7], protocol: f[2] });
  }

  /**
   * Resolve this peer's current transport address from ICE statistics.
   *
   * ICE gathers several candidate addresses per peer (host, server-reflexive,
   * relay) and picks one pair that works. So a peer does not have "an
   * address" -- it has a set of them, one of which is currently selected.
   */
  async address() {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
          if (!pair || (r.bytesReceived || 0) >= (pair.bytesReceived || 0)) pair = r;
        }
      });
      if (!pair) return null;

      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);

      // Fall back to the mDNS name from the raw candidate line when getStats
      // has redacted the IP.
      const fromLine = remote ? this._remoteCandidates.get(remote.port) : null;
      const remoteAddr = (remote && remote.address)
        || (fromLine && fromLine.address)
        || '(redacted)';

      return {
        local: local ? (local.address || '(redacted)') + ':' + local.port : '?',
        remote: remoteAddr + ':' + (remote ? remote.port : '?'),
        // host = same network, srflx = discovered via STUN, relay = via TURN
        type: remote ? remote.candidateType : '?',
        protocol: remote ? remote.protocol : '?',
      };
    } catch { return null; }
  }

  close() {
    try { if (this.dc) this.dc.close(); } catch {}
    try { if (this.pc) this.pc.close(); } catch {}
  }
}
