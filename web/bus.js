// ---------------------------------------------------------------------------
// bus.js -- Message-Oriented Communication over MQTT.
//
// This is the event plane. Where rpc.js is "ask one question, get one answer",
// this is "announce something, and whoever cares will hear it". The two are
// complementary and the split is deliberate:
//
//   RPC  is synchronous, point-to-point, and the caller waits.
//   MOM  is asynchronous, one-to-many, and the publisher does not know or
//        care who is listening -- publishers and subscribers are decoupled
//        in space (no addresses), in time (retained messages), and in flow
//        (nobody blocks).
//
// Topic map for a session:
//
//   session/{id}/participants     retained   roster, published by the server
//   session/{id}/tempo            retained   current BPM
//   session/{id}/transport        retained   play/stop + timeline anchor
//   session/{id}/master           retained   current timing master
//   session/{id}/impair/{link}    retained   emulated link delay, both ends
//   session/{id}/events           volatile   peer_lost and similar notices
//   session/{id}/telemetry/{peer} volatile   per-node RTT / jitter / loss
//   session/{id}/signal/{peer}    volatile   WebRTC SDP offers/answers + ICE
//   session/{id}/ledger           volatile   new ledger blocks (QoS 1)
//
// The retained flag on the first five is what lets a node that joins late --
// or that crashed and came back -- learn the current state of the world the
// instant it subscribes, instead of sitting silent until something next
// happens to change.
// ---------------------------------------------------------------------------

export class Bus {
  constructor() {
    this.client = null;
    this.sessionId = null;
    this.handlers = new Map(); // topic pattern -> [fn]
    this.stats = { published: 0, received: 0 };
  }

  connect(wsUrl, clientId) {
    return new Promise((resolve, reject) => {
      // mqtt.js is served from /vendor/mqtt.js out of node_modules, so this
      // page has no external dependencies and runs with no internet at all.
      this.client = window.mqtt.connect(wsUrl, {
        clientId,
        clean: true,
        reconnectPeriod: 1500,
        connectTimeout: 8000,
      });

      this.client.on('connect', () => resolve(this));
      this.client.on('error', (e) => reject(e));

      this.client.on('message', (topic, payload) => {
        this.stats.received++;
        let msg;
        try { msg = JSON.parse(payload.toString()); }
        catch { return; }

        for (const [pattern, fns] of this.handlers) {
          if (matches(pattern, topic)) fns.forEach((fn) => fn(msg, topic));
        }
      });
    });
  }

  /** Subscribe and register a handler. QoS 1 by default: at-least-once. */
  on(topic, fn, qos = 1) {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, []);
      this.client.subscribe(topic, { qos });
    }
    this.handlers.get(topic).push(fn);
    return this;
  }

  publish(topic, payload, opts) {
    const { retain = false, qos = 1 } = opts || {};
    this.stats.published++;
    this.client.publish(topic, JSON.stringify(payload), { retain, qos });
  }

  close() {
    if (this.client) this.client.end(true);
  }
}

/** MQTT wildcard match: '+' is one level, '#' is the rest. */
function matches(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (p[i] === '+') { if (t[i] === undefined) return false; continue; }
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
