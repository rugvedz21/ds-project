// ---------------------------------------------------------------------------
// audio.js -- Web Audio graph, click synthesis, and latency compensation.
//
// ===========================================================================
// THE COMPENSATION ALGORITHM  (the intellectual core of this project)
// ===========================================================================
//
// The problem. Say A->B takes 15 ms and A->C takes 40 ms. Each player hears
// their own instrument instantly and everyone else's late, by a DIFFERENT
// amount. So no two musicians hear the same arrangement of the music. Each
// one hears themselves early relative to the others, tries to correct for it
// by dragging, and the ensemble spirals apart. Nobody is playing badly; the
// network has simply given every player a different version of the truth.
//
// The insight. What ruins an ensemble is not delay -- it is DISAGREEMENT
// about delay. An orchestra sitting 20 m from the conductor is 60 ms late and
// perfectly happy, because everyone is late by the same amount. So we do not
// try to make the network faster. We make everyone equally late.
//
// The algorithm. Let d_j be the one-way delay from peer j, and
//
//     D = max over ALL links in the session of d_j
//
// D is the common deadline: the ensemble's worst link. Then at every node:
//
//     delay applied to my OWN monitor       = D
//     delay applied to audio FROM peer j    = D - d_j
//
// Peer j's sound already spent d_j in flight, so we hold it a further
// (D - d_j) and it lands exactly D after it was played. My own sound never
// travelled, so it waits the full D. The result: every sound produced at beat
// B is heard by EVERY listener -- including the player who made it -- at
// exactly t(B) + D. One deadline, globally agreed.
//
// The trade. Nobody hears themselves instantly any more; everybody hears
// themselves D late. That is a real cost and it feels strange to play
// through. We pay it because a common, uniform delay is something musicians
// can adapt to, while an inconsistent one is something they cannot.
//
// The limit. D is a hard latency floor and it is set by the worst link in the
// session. Past roughly 25-30 ms, players start to struggle regardless of how
// consistent the delay is; past ~50 ms it is unplayable for most music. So
// this technique makes a marginal network usable -- it cannot rescue a bad
// one. Compensation buys agreement, not speed.
// ===========================================================================

const CLICK_HZ = { downbeat: 1600, beat: 900 };
const MAX_DELAY_S = 2.0; // DelayNode ceiling; also our clamp on D

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;

    this.compensationEnabled = true;
    this.commonDeadlineMs = 0;   // D
    this.myOneWayMs = new Map(); // peerId -> network one-way delay (RTT/2)
    this.mediaDelayMs = new Map(); // peerId -> WebRTC audio pipeline delay

    this.peers = new Map();      // peerId -> { impair, comp, gain, source }
    this.micStream = null;
    this.monitorMic = false;
  }

  // -------------------------------------------------------------------------
  // Graph construction
  //
  //   metronomeBus ─► localMonitorDelay (D) ─► masterGain ─► speakers
  //   clickBus ──┬──► localMonitorDelay (D)
  //              └──► outboundGain ─► streamDest ─► WebRTC (sent UNdelayed:
  //                                                 the receiver compensates)
  //
  // The metronome is deliberately NOT transmitted. Every node already
  // synthesises the identical click from the shared timeline, so sending it
  // as well only produced a second, later copy of every beat from each peer:
  // an echo. Only what is genuinely unique to a player -- its instrument and
  // its microphone -- goes over the network.
  //
  //   remote j ─► impairDelay_j ─► compDelay_j (D - d_j) ─► masterGain
  //
  // Sending our audio undelayed is deliberate. Delay belongs at the receiver,
  // because only the receiver knows d_j for its own link. If we pre-delayed on
  // the sending side we would need a different copy of the stream per
  // recipient, which is exactly what we are trying to avoid.
  // -------------------------------------------------------------------------
  async init() {
    if (this.ready) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await this.ctx.resume();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;
    this.masterGain.connect(this.ctx.destination);

    this.localMonitorDelay = this.ctx.createDelay(MAX_DELAY_S);
    this.localMonitorDelay.delayTime.value = 0;
    this.localMonitorDelay.connect(this.masterGain);

    this.clickBus = this.ctx.createGain();
    this.clickBus.gain.value = 1.0;
    this.clickBus.connect(this.localMonitorDelay);

    this.metronomeBus = this.ctx.createGain();
    this.metronomeBus.gain.value = 1.0;
    this.metronomeBus.connect(this.localMonitorDelay);

    // Everything we transmit is mixed here and captured as a MediaStream.
    this.outboundGain = this.ctx.createGain();
    this.outboundGain.gain.value = 1.0;
    this.streamDest = this.ctx.createMediaStreamDestination();
    this.outboundGain.connect(this.streamDest);
    this.clickBus.connect(this.outboundGain);

    this.ready = true;
    return this;
  }

  get outboundStream() { return this.streamDest.stream; }

  /**
   * How long after the audio graph renders a sample it actually leaves the
   * speakers: driver buffers, the OS mixer, the device itself. Typically
   * 10-50 ms on built-in speakers and 150 ms or more over Bluetooth -- and,
   * crucially, DIFFERENT on every machine.
   */
  get outputLatencyMs() {
    if (!this.ready) return 0;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  /**
   * Map an instant on the Date.now() timeline to the AudioContext time at
   * which a sound must be scheduled so that it is HEARD at that instant.
   *
   * getOutputTimestamp() pairs "the context time now coming out of the
   * speakers" with "the performance.now() instant it does so". Bridging
   * through that pair, rather than through ctx.currentTime, does two things:
   *
   *   1. it subtracts this device's output latency, so two laptops with
   *      different sound hardware still sound the same beat at the same
   *      moment -- without it, clock sync aligns when the beat is RENDERED,
   *      not when it is HEARD;
   *   2. it avoids currentTime's coarseness: currentTime only advances once
   *      per audio callback (often ~10 ms on Windows), which added a random
   *      error of up to one callback to every scheduled click.
   */
  audioTimeFor(localMs) {
    const perfMs = performance.now() + (localMs - Date.now());
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    // Fallback: currentTime, corrected by the reported output latency.
    return this.ctx.currentTime + (perfMs - performance.now()) / 1000 - this.outputLatencyMs / 1000;
  }

  // -------------------------------------------------------------------------
  // Click / blip synthesis
  // -------------------------------------------------------------------------

  /**
   * Schedule a percussive blip at an exact local time.
   *
   * localMs is on the Date.now() timeline; the audio clock is ctx.currentTime.
   * We re-derive the bridge between them on every call rather than caching an
   * epoch, because the two clocks drift apart slowly over a long session.
   */
  scheduleBlip(localMs, { freq = 880, gain = 0.5, durMs = 55, bus = null } = {}) {
    if (!this.ready) return;
    const when = this.audioTimeFor(localMs);
    // Already past: the audio thread cannot play in the past, so drop it
    // rather than let it fire late and out of place.
    if (when < this.ctx.currentTime) return;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'square';

    // Short exponential decay -- a click with a sharp transient, so timing
    // error is easy to hear. A soft pad would hide exactly what we want to
    // demonstrate.
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(gain, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + durMs / 1000);

    osc.connect(env).connect(bus || this.clickBus);
    osc.start(when);
    osc.stop(when + durMs / 1000 + 0.02);
  }

  metronomeClick(localMs, isDownbeat) {
    this.scheduleBlip(localMs, {
      freq: isDownbeat ? CLICK_HZ.downbeat : CLICK_HZ.beat,
      gain: isDownbeat ? 0.55 : 0.3,
      durMs: isDownbeat ? 60 : 40,
      bus: this.metronomeBus,   // local only -- see the graph comment above
    });
  }

  /** This node's own instrument voice -- pitch derived from the peer id so
   *  each musician is audibly distinguishable in the mix. */
  instrumentBlip(localMs, pitchHz) {
    this.scheduleBlip(localMs, { freq: pitchHz, gain: 0.42, durMs: 110 });
  }

  // -------------------------------------------------------------------------
  // Remote peers
  // -------------------------------------------------------------------------
  attachRemoteStream(peerId, stream) {
    if (!this.ready) return;
    const existing = this.peers.get(peerId);
    if (existing && existing.source) { try { existing.source.disconnect(); } catch {} }

    const source = this.ctx.createMediaStreamSource(stream);

    // Network impairment emulation. tc/netem does not exist on Windows, so we
    // emulate the link here instead. Applied at the RECEIVER, which is also
    // where the matching delay is applied to this peer's DataChannel traffic
    // -- so the measured RTT rises by the same amount, and the emulation stays
    // self-consistent instead of being a cosmetic slider.
    const impair = this.ctx.createDelay(MAX_DELAY_S);
    impair.delayTime.value = 0;

    // The compensation delay: (D - d_j).
    const comp = this.ctx.createDelay(MAX_DELAY_S);
    comp.delayTime.value = 0;

    const gain = this.ctx.createGain();
    gain.gain.value = 1.0;

    source.connect(impair).connect(comp).connect(gain).connect(this.masterGain);

    // Chrome will not pull audio from a WebRTC MediaStream unless it is also
    // attached to a media element somewhere. Muted, so it cannot double up
    // with our own graph -- a well-known Web Audio + WebRTC gotcha.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    sink.play().catch(() => {});

    this.peers.set(peerId, { source, impair, comp, gain, sink, impairMs: 0 });
    this.recompute();
  }

  detachPeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try { p.source.disconnect(); p.sink.srcObject = null; } catch {}
    this.peers.delete(peerId);
    this.myOneWayMs.delete(peerId);
    this.mediaDelayMs.delete(peerId);
    this.recompute();
  }

  /** Emulated extra network delay on the link from this peer. */
  setImpairment(peerId, ms) {
    const p = this.peers.get(peerId);
    if (p) {
      p.impairMs = ms;
      p.impair.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.02);
    }
    this.recompute();
  }

  getImpairment(peerId) {
    const p = this.peers.get(peerId);
    return p ? p.impairMs : 0;
  }

  /** Record this node's measured one-way delay to a peer (RTT/2). */
  setOneWay(peerId, ms) {
    this.myOneWayMs.set(peerId, ms);
    this.recompute();
  }

  /**
   * The part of a peer's audio delay the network ping cannot see: encoding
   * into 20 ms Opus frames on the sender, and the receiver's jitter buffer,
   * which deliberately holds packets back to smooth out arrival-time jitter.
   * Together these are usually far larger than the network delay on a LAN,
   * so leaving them out made compensation align audio that had not arrived
   * yet. Measured by mesh.js from WebRTC's own statistics.
   */
  setMediaDelay(peerId, ms) {
    this.mediaDelayMs.set(peerId, ms);
    this.recompute();
  }

  /** d_j for AUDIO: network one-way delay plus the media pipeline. */
  audioDelayMs(peerId) {
    return (this.myOneWayMs.get(peerId) || 0) + (this.mediaDelayMs.get(peerId) || 0);
  }

  /**
   * D must be the same number on every node, or they align to different
   * deadlines and the whole scheme collapses. Each node can only measure its
   * OWN links, so every node publishes its measurements over MQTT telemetry
   * and we take the max across the union -- the worst link anywhere in the
   * session, not merely the worst link we personally observe.
   */
  setPeerReportedDelays(list) {
    this._reported = list || [];
    this.recompute();
  }

  recompute() {
    if (!this.ready) return;

    const mine = [...this.myOneWayMs.keys()].map((id) => this.audioDelayMs(id));
    const theirs = this._reported || [];
    const all = mine.concat(theirs).filter((v) => Number.isFinite(v) && v >= 0);

    const D = this.compensationEnabled
      ? Math.min(all.length ? Math.max(...all) : 0, MAX_DELAY_S * 1000 - 50)
      : 0;
    this.commonDeadlineMs = D;

    const t = this.ctx.currentTime;
    // Ramp rather than jump: an abrupt delayTime change on a live signal
    // produces an audible click, and D moves whenever RTT is re-measured.
    this.localMonitorDelay.delayTime.setTargetAtTime(D / 1000, t, 0.05);

    for (const [peerId, p] of this.peers) {
      const dj = this.audioDelayMs(peerId);
      // Clamp at 0: a peer whose measured delay somehow exceeds D cannot be
      // given negative delay -- we cannot un-delay audio that already arrived.
      const compMs = this.compensationEnabled ? Math.max(0, D - dj) : 0;
      p.comp.delayTime.setTargetAtTime(compMs / 1000, t, 0.05);
      p.compMs = compMs;
    }
  }

  setCompensation(on) {
    this.compensationEnabled = on;
    this.recompute();
  }

  // -------------------------------------------------------------------------
  // Microphone (optional -- the click track is the primary demo)
  // -------------------------------------------------------------------------
  async enableMic() {
    if (this.micStream) return this.micStream;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three defeat a music signal: AGC pumps, noise suppression eats
        // quiet passages, and echo cancellation will actively fight the
        // compensation delay by treating the delayed monitor as an echo.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const src = this.ctx.createMediaStreamSource(this.micStream);
    src.connect(this.outboundGain);

    this.micMonitorGain = this.ctx.createGain();
    this.micMonitorGain.gain.value = 0; // off by default: speakers will howl
    src.connect(this.micMonitorGain).connect(this.localMonitorDelay);

    return this.micStream;
  }

  setMicMonitor(on) {
    this.monitorMic = on;
    if (this.micMonitorGain) {
      this.micMonitorGain.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.05);
    }
  }

  setMasterVolume(v) {
    if (this.ready) this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  snapshot() {
    const per = {};
    for (const [id, p] of this.peers) {
      per[id] = {
        impairMs: p.impairMs || 0,
        compMs: Math.round(p.compMs || 0),
        oneWayMs: Math.round(this.myOneWayMs.get(id) || 0),
        mediaMs: Math.round(this.mediaDelayMs.get(id) || 0),
        audioMs: Math.round(this.audioDelayMs(id)),
      };
    }
    return {
      enabled: this.compensationEnabled,
      commonDeadlineMs: Math.round(this.commonDeadlineMs),
      peers: per,
    };
  }
}

/** Deterministic pitch per peer, so each musician is identifiable by ear. */
export function pitchForPeer(peerId) {
  const scale = [261.6, 329.6, 392.0, 440.0, 523.3, 659.3, 784.0];
  let h = 0;
  for (const ch of peerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return scale[h % scale.length];
}
