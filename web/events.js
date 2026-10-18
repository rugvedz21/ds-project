// ---------------------------------------------------------------------------
// events.js -- the model of distributed computations.
//
// (Unit 1 self-study. This is the *model*: events, local histories, and the
// happened-before relation. It is not clock synchronisation -- that is
// clock.js, and it answers a completely different question.)
//
// ===========================================================================
// THE MODEL
// ===========================================================================
//
// A distributed computation is not a sequence of things happening in order.
// There is no global "order" to appeal to: no observer sees the whole system
// at once, and the machines' physical clocks disagree. What actually exists
// is:
//
//   * a set of PROCESSES (here: peers), each with a LOCAL HISTORY -- the
//     totally ordered sequence of events that occurred at that process;
//
//   * three kinds of EVENT: internal (played a note), send, and receive;
//
//   * the HAPPENED-BEFORE relation (written ->), the smallest relation
//     satisfying:
//         1. if a and b are in the same process and a comes first,  a -> b
//         2. if a is send(m) and b is receive(m),                   a -> b
//         3. transitivity: a -> b and b -> c  implies  a -> c
//
// happened-before is a PARTIAL order, not a total one, and that is the entire
// point. Two events a and b with neither a -> b nor b -> a are CONCURRENT
// (a || b): they are causally independent, and no observer can legitimately
// say which came "first". Asking is a meaningless question, not a hard one.
//
// Why this matters here: two musicians on different laptops both play a note.
// Neither heard the other first. Those events are genuinely concurrent, and
// any attempt to order them by wall-clock timestamp invents an ordering the
// system does not actually possess.
//
// ===========================================================================
// TIMESTAMPS
// ===========================================================================
//
// We carry two, because they answer different questions and the contrast is
// the most useful thing in this file.
//
// SCALAR (Lamport) clock L:
//     internal / send : L = L + 1
//     receive(m)      : L = max(L, L_m) + 1
//
//   Guarantees:  a -> b  implies  L(a) < L(b)
//   Does NOT give the converse. L(a) < L(b) tells you nothing on its own --
//   the events may be concurrent. A scalar clock can therefore never detect
//   concurrency; it only avoids contradicting causality.
//
// VECTOR clock V (one counter per process):
//     internal / send : V[self] += 1
//     receive(m)      : V = componentwise max(V, V_m), then V[self] += 1
//
//   Guarantees:  a -> b  if and only if  V(a) <= V(b) componentwise and
//                                        V(a) != V(b)
//
//   The "if and only if" is what buys us concurrency detection, and it is why
//   we carry vectors as well as scalars: without them the partial order above
//   would be described in the report but not observable in the running system.
//
// The cost is that a vector clock is O(n) per message and needs to know the
// process set, whereas a scalar clock is a single integer. That trade is the
// reason both exist.
// ---------------------------------------------------------------------------

export const HB = { BEFORE: '->', AFTER: '<-', CONCURRENT: '||', SAME: '=' };

export class EventModel {
  constructor(selfId) {
    this.selfId = selfId;
    this.lamport = 0;
    this.vector = { [selfId]: 0 };
    this.history = [];   // this process's local history, most recent first
    this.maxHistory = 60;
  }

  _clone(v) { return { ...v }; }

  /** An event with no message attached: we played a note. */
  internal(kind, detail) {
    this.lamport += 1;
    this.vector[this.selfId] = (this.vector[this.selfId] || 0) + 1;
    return this._record('internal', kind, detail);
  }

  /**
   * A send event. Returns the timestamp to attach to the outgoing message --
   * the receiver needs it to maintain the relation across the process
   * boundary, which is rule 2 of happened-before.
   */
  send(kind, detail) {
    this.lamport += 1;
    this.vector[this.selfId] = (this.vector[this.selfId] || 0) + 1;
    const rec = this._record('send', kind, detail);
    return { lamport: rec.lamport, vector: rec.vector };
  }

  /**
   * A receive event. `stamp` is what the sender attached.
   *
   * Taking the componentwise max is the step that actually transfers
   * knowledge between processes: after it, our vector reflects everything the
   * sender knew at the moment it sent, which is exactly the causal past we
   * have just inherited.
   */
  receive(stamp, kind, detail) {
    const theirs = (stamp && stamp.vector) || {};
    for (const [pid, n] of Object.entries(theirs)) {
      this.vector[pid] = Math.max(this.vector[pid] || 0, n);
    }
    this.lamport = Math.max(this.lamport, (stamp && stamp.lamport) || 0) + 1;
    this.vector[this.selfId] = (this.vector[this.selfId] || 0) + 1;

    const rec = this._record('receive', kind, detail);
    // Keep the sender's stamp so the UI can compare the two directly.
    rec.senderStamp = stamp || null;
    return rec;
  }

  /** Make sure a newly-seen process has an entry, so vectors stay comparable. */
  addProcess(peerId) {
    if (this.vector[peerId] === undefined) this.vector[peerId] = 0;
  }

  _record(type, kind, detail) {
    const rec = {
      seq: this.history.length + 1,
      process: this.selfId,
      type,
      kind,
      detail: detail || {},
      lamport: this.lamport,
      vector: this._clone(this.vector),
      wallMs: Date.now(),
    };
    this.history.unshift(rec);
    if (this.history.length > this.maxHistory) this.history.pop();
    return rec;
  }

  /**
   * Compare two vector timestamps and return the happened-before relation.
   *
   * This is the operational definition of the partial order: we are not
   * consulting any clock, only comparing what each event knew about every
   * process at the moment it occurred.
   */
  static compare(va, vb) {
    const keys = new Set([...Object.keys(va || {}), ...Object.keys(vb || {})]);
    let aLessSomewhere = false;
    let bLessSomewhere = false;

    for (const k of keys) {
      const x = va[k] || 0;
      const y = vb[k] || 0;
      if (x < y) aLessSomewhere = true;
      if (y < x) bLessSomewhere = true;
    }

    if (!aLessSomewhere && !bLessSomewhere) return HB.SAME;
    // Strictly dominated in one direction only => causally ordered.
    if (aLessSomewhere && !bLessSomewhere) return HB.BEFORE;
    if (bLessSomewhere && !aLessSomewhere) return HB.AFTER;
    // Each knows something the other does not => neither caused the other.
    return HB.CONCURRENT;
  }

  /** Render a vector as "A:2 B:1" for display. */
  static format(v, nameFn) {
    return Object.entries(v || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pid, n]) => (nameFn ? nameFn(pid) : pid.slice(0, 6)) + ':' + n)
      .join(' ');
  }

  /**
   * Classify the two notes played on the SAME beat by two different peers.
   *
   * This specific pair is chosen because it is the one that makes the point.
   * Both musicians played beat N; neither had heard the other when they did
   * so; therefore neither event caused the other and they are CONCURRENT.
   * Comparing merely the latest events instead would usually find an ordered
   * pair -- true, but uninteresting, since it just reflects that we happened
   * to receive something after sending something.
   *
   * Note the vector we compare against is the SENDER's stamp, not our receive
   * event's vector. Our receive necessarily happened after their send, so
   * comparing receive events could never reveal concurrency.
   */
  latestCrossProcessPair() {
    const received = this.history.find((e) => e.type === 'receive' && e.senderStamp
      && e.detail && e.detail.beat !== undefined);
    if (!received) return null;

    const mine = this.history.find((e) => e.type === 'send'
      && e.detail && e.detail.beat === received.detail.beat);
    if (!mine) return null;

    return {
      mine,
      theirs: received,
      beat: received.detail.beat,
      relation: EventModel.compare(mine.vector, received.senderStamp.vector),
    };
  }
}
