// ---------------------------------------------------------------------------
// clock.js -- Cristian's algorithm.
//
// The problem: two laptops' Date.now() values can differ by seconds, and they
// drift apart continuously. Any plan expressed in wall-clock time ("play at
// 14:23:07.412") is therefore meaningless across machines.
//
// The fix: estimate this machine's offset from the server clock, and express
// every musical instant in SERVER time. Cristian's algorithm:
//
//     T0 = local time just before the request
//     T1 = local time just after the reply arrives
//     Ts = server's clock, read while handling the request
//
//     RTT    = T1 - T0
//     offset = Ts + RTT/2 - T1        (add to local time to get server time)
//
// The RTT/2 term assumes the outbound and return legs take equally long. That
// assumption is FALSE on an asymmetric path, and it is the dominant source of
// error in this module -- we cannot detect the asymmetry, only mitigate it by
// keeping the sample with the smallest RTT, since a fast round trip has less
// room to hide asymmetry than a slow one.
// ---------------------------------------------------------------------------

import { rpc } from './rpc.js';

export class ClockSync {
  constructor() {
    this.offsetMs = 0;      // add to local Date.now() to obtain server time
    this.uncertaintyMs = Infinity; // +/- bound implied by the best RTT
    this.samples = [];
    this.lastSyncAt = 0;
  }

  /** One Cristian exchange. Returns the sample. */
  async sample() {
    const t0 = Date.now();
    const reply = await rpc.getServerTime({ clientSendMs: t0 });
    const t1 = Date.now();

    const rtt = t1 - t0;
    const offset = reply.serverTimeMs + rtt / 2 - t1;

    const s = { rtt, offset, at: t1 };
    this.samples.push(s);
    if (this.samples.length > 16) this.samples.shift();
    return s;
  }

  /**
   * Take several samples and keep the one with the smallest round trip.
   *
   * This "minimum filter" is the standard trick (NTP does the same): a sample
   * that came back fast spent little time queueing, so its RTT/2 midpoint
   * estimate is the least likely to be skewed. Averaging instead would let
   * one badly-delayed sample poison the result.
   */
  async sync(rounds = 8) {
    const taken = [];
    for (let i = 0; i < rounds; i++) {
      taken.push(await this.sample());
      await new Promise((r) => setTimeout(r, 30));
    }
    const best = taken.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offsetMs = best.offset;
    this.uncertaintyMs = best.rtt / 2;
    this.lastSyncAt = Date.now();
    return { offsetMs: this.offsetMs, uncertaintyMs: this.uncertaintyMs, rounds };
  }

  /** Current time on the SERVER's clock, as estimated by this node. */
  now() {
    return Date.now() + this.offsetMs;
  }

  /** Convert a server-clock instant into this machine's local clock. */
  toLocal(serverMs) {
    return serverMs - this.offsetMs;
  }

  /** Re-sync periodically: crystal drift is slow but it is not zero. */
  startAutoSync(intervalMs = 20000) {
    this.stopAutoSync();
    this._timer = setInterval(() => this.sync(4).catch(() => {}), intervalMs);
  }

  stopAutoSync() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
