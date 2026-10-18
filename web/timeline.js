// ---------------------------------------------------------------------------
// timeline.js -- the shared musical timeline.
//
// The central idea: the timeline is a FORMULA, not a stream of tick messages.
// The server publishes an anchor -- (anchor_beat, anchor_time, bpm) -- and
// every node computes every beat locally from it:
//
//     beat(t)      = anchor_beat + (t - anchor_time) * bpm / 60000
//     time(beat n) = anchor_time + (n - anchor_beat) * 60000 / bpm
//
// where t is on the SERVER clock (clock.js converts to and from local time).
//
// Two consequences worth stating at the evaluation:
//
//  1. Nothing has to arrive on time for the music to stay in time. A tick
//     stream would put the network in the critical path of every single beat;
//     an anchor puts it in the path only when the tempo changes. If the
//     network stalls for two seconds, every node keeps producing correct
//     beats from the last anchor it holds.
//
//  2. It is why the ensemble survives losing the timing master. The master's
//     only job is to publish anchors. Once an anchor is out, it is no longer
//     needed, so its death costs nothing until somebody wants a tempo change.
//
// Events are named by beat position, never by wall-clock time. "This note
// landed on beat 34.5" means the same thing on every machine; "this note
// landed at 14:23:07.412" does not.
// ---------------------------------------------------------------------------

export class Timeline {
  constructor(clock) {
    this.clock = clock;
    this.transport = { playing: false, anchorBeat: 0, anchorTimeMs: 0, bpm: 100 };
    this.beatsPerBar = 4;
  }

  setTransport(t) {
    this.transport = {
      playing: !!t.playing,
      anchorBeat: Number(t.anchorBeat) || 0,
      anchorTimeMs: Number(t.anchorTimeMs) || 0,
      bpm: Number(t.bpm) || 100,
    };
  }

  get bpm() { return this.transport.bpm; }
  get beatDurationMs() { return 60000 / this.transport.bpm; }

  /** Fractional beat position right now (server clock). */
  currentBeat(atServerMs) {
    const t = atServerMs === undefined ? this.clock.now() : atServerMs;
    const tr = this.transport;
    return tr.anchorBeat + ((t - tr.anchorTimeMs) * tr.bpm) / 60000;
  }

  /** Server-clock instant of an integer beat number. */
  serverTimeOfBeat(n) {
    const tr = this.transport;
    return tr.anchorTimeMs + ((n - tr.anchorBeat) * 60000) / tr.bpm;
  }

  /** Local-clock instant of an integer beat number. */
  localTimeOfBeat(n) {
    return this.clock.toLocal(this.serverTimeOfBeat(n));
  }

  isDownbeat(n) {
    return ((n % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar === 0;
  }
}

/**
 * Look-ahead scheduler.
 *
 * setInterval and setTimeout in a browser are accurate to maybe 5-15 ms, and
 * worse under load -- far too sloppy for musical timing, where 10 ms is
 * audible. The Web Audio clock, by contrast, is sample-accurate.
 *
 * So we never *play* anything from a timer. The timer only wakes up often
 * (every 25 ms) and hands the audio hardware the beats falling inside the
 * next 150 ms, each with an exact timestamp. The audio thread does the
 * timing; JavaScript merely queues the work ahead of it. This is the standard
 * "tale of two clocks" pattern and it is the difference between a metronome
 * that sounds tight and one that visibly stutters.
 */
export class BeatScheduler {
  constructor(timeline, onBeat) {
    this.timeline = timeline;
    this.onBeat = onBeat;          // onBeat(beatNumber, localTimeMs)
    this.lookaheadMs = 150;
    // Extra look-ahead for audio output latency: a beat has to be handed to
    // the audio thread that much EARLIER to come out of the speakers on
    // time. Without it, a Bluetooth device (150 ms+) would have every beat
    // scheduled in the past and dropped.
    this.extraLookaheadMs = 0;
    this.tickMs = 25;
    this.nextBeat = null;
    this._timer = null;
  }

  start() {
    this.stop();
    this.nextBeat = Math.ceil(this.timeline.currentBeat());
    this._timer = setInterval(() => this._tick(), this.tickMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.nextBeat = null;
  }

  /** Called when the anchor changes (tempo edit, transport start). */
  resync() {
    if (this._timer) this.nextBeat = Math.ceil(this.timeline.currentBeat());
  }

  _tick() {
    if (!this.timeline.transport.playing) return;
    const horizonServerMs = this.timeline.clock.now() + this.lookaheadMs + this.extraLookaheadMs;

    // Guard against a pathological loop if the anchor jumps far into the past.
    let guard = 0;
    while (this.timeline.serverTimeOfBeat(this.nextBeat) < horizonServerMs && guard++ < 64) {
      const localMs = this.timeline.localTimeOfBeat(this.nextBeat);
      this.onBeat(this.nextBeat, localMs);
      this.nextBeat++;
    }
    if (guard >= 64) this.resync();
  }
}
