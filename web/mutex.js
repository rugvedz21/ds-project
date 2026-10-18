// ---------------------------------------------------------------------------
// mutex.js -- Ricart-Agrawala distributed mutual exclusion.  (Unit 3)
//
// THE SHARED RESOURCE is the SOLO FLOOR: at most one musician may solo at a
// time. This is "floor control", the textbook mutual-exclusion problem of
// distributed multimedia systems (who may talk in a conference, who holds the
// whiteboard pen). There is no server involved: the peers agree among
// themselves, over the reliable coord channel.
//
// ALGORITHM (Ricart & Agrawala, 1981)
//
//   To enter: state = WANTED, stamp the request with the Lamport clock, send
//             REQUEST(ts, me) to every other peer, and wait for a REPLY from
//             each of them. Then state = HELD.
//
//   On REQUEST(ts_j, j):
//       if state == HELD, or state == WANTED and (my_ts, me) < (ts_j, j):
//           DEFER the reply (queue it)
//       else
//           REPLY immediately
//
//   To leave: state = RELEASED, send every deferred REPLY.
//
// (ts, id) pairs are totally ordered -- Lamport time, peer id as tie-break --
// so for any two competing requests every node agrees which came "first".
// That agreement is the whole trick, and it is why this module uses the SAME
// Lamport clock as events.js: requests and replies are ordinary send/receive
// events and appear in the happened-before table.
//
// Cost: 2(n-1) messages per entry, no coordinator, no single point of
// failure for the decision. The weakness is the mirror image: every peer is a
// point of failure, because a crashed peer never replies. We handle that the
// only way available -- when the mesh drops a peer, we stop waiting for it --
// which is correct for crash-stop but not for a peer that is merely slow.
//
// MEMBERSHIP CHANGE. RA assumes a fixed process set; ours is not. If a peer's
// coord channel opens while we are WANTED, we send it our request too and wait
// for its reply. That is what makes a newcomer safe: either our request
// reaches it first (pushing its Lamport clock past ours, so it ranks after
// us), or its request reached us first and it legitimately ranks before us.
// Either way exactly one of us defers to the other.
// ---------------------------------------------------------------------------

export const CS = { RELEASED: 'RELEASED', WANTED: 'WANTED', HELD: 'HELD' };

export class RicartAgrawala {
  /**
   * @param {object} o
   * @param {string} o.selfId
   * @param {import('./mesh.js').Mesh} o.mesh
   * @param {import('./events.js').EventModel} o.events  shared Lamport clock
   * @param {(kind:string, msg:string, cls?:string)=>void} o.log
   * @param {()=>void} o.onChange
   */
  constructor({ selfId, mesh, events, log, onChange }) {
    this.selfId = selfId;
    this.mesh = mesh;
    this.events = events;
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});

    this.state = CS.RELEASED;
    this.requestTs = null;        // Lamport time of our outstanding request
    this.awaiting = new Set();    // peers whose REPLY we still need
    this.deferred = new Set();    // peers we owe a REPLY once we release
    this.holder = '';             // who holds the floor, as far as we know
    this.messages = 0;            // REQUEST + REPLY messages sent by this node
    this.lastEntryMessages = 0;   // messages exchanged for the last entry
  }

  start() {
    this.mesh.on('coord', ({ peerId, msg }) => this._onMessage(peerId, msg));
    this.mesh.on('coord_open', ({ peerId }) => {
      if (this.state === CS.WANTED) {
        this.awaiting.add(peerId);
        this._sendRequest(peerId);
      }
    });
    this.mesh.on('peer_gone', ({ peerId }) => {
      this.deferred.delete(peerId);
      if (this.holder === peerId) this.holder = '';
      if (this.awaiting.delete(peerId)) {
        this.log('mutex', 'stopped waiting for a peer that left (crash-stop assumption)', 'warn');
        this._maybeEnter();
      }
      this.onChange();
    });
  }

  request() {
    if (this.state !== CS.RELEASED) return;
    this.state = CS.WANTED;
    // Ticking the shared Lamport clock here, as a send event, is what gives
    // the request its place in the total order.
    const stamp = this.events.send('cs_request', {});
    this.requestTs = stamp.lamport;
    this._stamp = stamp;
    this._entryStart = this.messages;
    this.awaiting = new Set(this.mesh.coordPeers());
    for (const p of this.awaiting) this._sendRequest(p);
    this.log('mutex', 'REQUEST floor at Lamport ' + this.requestTs + ' → waiting for ' +
      this.awaiting.size + ' REPLY');
    this.onChange();
    this._maybeEnter();
  }

  release() {
    if (this.state !== CS.HELD) return;
    this.state = CS.RELEASED;
    this.requestTs = null;
    this.holder = '';
    const owed = [...this.deferred];
    this.deferred.clear();
    for (const p of owed) this._reply(p);
    // Informational only -- NOT part of the algorithm, which needs no
    // announcement. It lets other screens show who is soloing.
    this.mesh.broadcastCoord({ t: 'floor', holder: '' });
    this.log('mutex', 'released floor — sent ' + owed.length + ' deferred REPLY');
    this.onChange();
  }

  // -------------------------------------------------------------------------

  _sendRequest(peerId) {
    if (this.mesh.sendCoord(peerId, { t: 'ra_request', ts: this.requestTs, stamp: this._stamp })) {
      this.messages++;
    }
  }

  _reply(peerId) {
    const stamp = this.events.send('cs_reply', { to: peerId });
    if (this.mesh.sendCoord(peerId, { t: 'ra_reply', stamp })) this.messages++;
  }

  /** (ts, id) total order: true if OUR request outranks theirs. */
  _weGoFirst(theirTs, theirId) {
    if (this.requestTs !== theirTs) return this.requestTs < theirTs;
    return this.selfId < theirId;
  }

  _maybeEnter() {
    if (this.state !== CS.WANTED || this.awaiting.size) return;
    this.state = CS.HELD;
    this.holder = this.selfId;
    this.lastEntryMessages = this.messages - this._entryStart;
    this.mesh.broadcastCoord({ t: 'floor', holder: this.selfId });
    this.log('mutex', 'ENTERED critical section — you hold the solo floor (' +
      this.lastEntryMessages + ' messages sent for this entry)');
    this.onChange();
  }

  _onMessage(from, msg) {
    if (msg.t === 'ra_request') {
      this.events.receive(msg.stamp, 'cs_request', { from });
      const defer = this.state === CS.HELD ||
        (this.state === CS.WANTED && this._weGoFirst(msg.ts, from));
      if (defer) {
        this.deferred.add(from);
        this.log('mutex', 'DEFERRED reply to a request at Lamport ' + msg.ts +
          (this.state === CS.HELD ? ' (we hold the floor)' : ' (our request is older)'));
      } else {
        this._reply(from);
      }
      this.onChange();
    } else if (msg.t === 'ra_reply') {
      this.events.receive(msg.stamp, 'cs_reply', { from });
      if (this.awaiting.delete(from)) this._maybeEnter();
      this.onChange();
    } else if (msg.t === 'floor') {
      if (this.state !== CS.HELD) this.holder = msg.holder;
      this.onChange();
    }
  }
}
