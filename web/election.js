// ---------------------------------------------------------------------------
// election.js -- beacon failure detection + Bully leader election, run by the
// peers themselves over the reliable coord channel.  (Unit 3)
//
// WHY THIS EXISTS when the server already names a timing master: the
// server's succession rule is deterministic failover computed from ONE copy of
// the roster. It needs the server alive, and it cannot handle the nodes
// disagreeing about who is alive. Election is what you need when there is no
// single authority to ask. Concretely: kill the session server and this still
// picks a coordinator, and that coordinator is what lets the ensemble keep
// changing tempo without the server (see app.js, coordinatorSetTempo).
//
// ---------------------------------------------------------------------------
// BEACONS (failure detection)
// ---------------------------------------------------------------------------
// Every node sends a small beacon to every peer once per second. A peer whose
// beacon has not arrived for SUSPECT_MS is SUSPECTED. This is the peer-to-peer
// version of the gRPC heartbeat: same idea, but nobody in the middle, so it
// keeps working when the server does not.
//
// "Suspected", not "dead": in an asynchronous network a slow peer and a
// crashed peer look identical from outside. The detector is therefore allowed
// to be wrong, and the election below is written to survive that.
//
// ---------------------------------------------------------------------------
// BULLY ALGORITHM (Garcia-Molina, 1982)
// ---------------------------------------------------------------------------
// Every process has a fixed priority. When P notices the coordinator is gone:
//
//   1. P sends ELECTION to every process with HIGHER priority.
//   2. If none answers within ANSWER_TIMEOUT_MS, P wins: it broadcasts
//      COORDINATOR to everyone.
//   3. If any answers (ANSWER), P stands down and waits for a COORDINATOR. If
//      none arrives within COORD_TIMEOUT_MS the answerer must have died too,
//      so P starts again.
//   4. A process receiving ELECTION from a lower one replies ANSWER and starts
//      its own election -- that is the "bullying".
//
// The highest-priority live process always wins. Cost is O(n^2) messages in
// the worst case (the lowest process starts it), which is fine for n <= 5.
//
// PRIORITY = seniority: earliest join time wins, peer id breaks ties. This is
// the same rule the server uses for succession, on purpose: while the server
// is up the two mechanisms agree, so there is never a visible conflict between
// "timing master" and "elected coordinator". It also means a newcomer is
// always the LOWEST priority and can never bully its way into the job, so
// joining a session never moves the coordinator.
//
// SPLIT BRAIN. If a partition heals and two coordinators exist, the first
// beacon from a rival coordinator triggers a fresh election, and the higher of
// the two wins. That is detection and repair after the fact, not prevention --
// Bully assumes reliable failure detection, which an asynchronous network
// cannot provide. Preventing split brain outright needs a quorum (Raft, Paxos).
// ---------------------------------------------------------------------------

const BEACON_MS = 1000;
const SUSPECT_MS = 3500;
const ANSWER_TIMEOUT_MS = 1500;
const COORD_TIMEOUT_MS = 4000;

export class Election {
  /**
   * @param {object} o
   * @param {string} o.selfId
   * @param {import('./mesh.js').Mesh} o.mesh
   * @param {(peerId:string)=>number} o.joinedAtOf  seniority source (roster)
   * @param {(kind:string, msg:string, cls?:string)=>void} o.log
   * @param {(coordinatorId:string)=>void} o.onChange
   */
  constructor({ selfId, mesh, joinedAtOf, log, onChange }) {
    this.selfId = selfId;
    this.mesh = mesh;
    this.joinedAtOf = joinedAtOf;
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});

    this.coordinator = '';
    this.phase = 'idle';            // idle | waiting-answer | waiting-coordinator
    this.lastBeacon = new Map();    // peerId -> performance.now() of last beacon
    this.elections = 0;             // elections this node has started
    this.sent = { beacon: 0, election: 0, answer: 0, coordinator: 0 };
    this._timer = null;
    this._pending = null;
    this._beaconSeq = 0;
  }

  start() {
    this.mesh.on('coord', ({ peerId, msg }) => this._onMessage(peerId, msg));
    this.mesh.on('coord_open', ({ peerId }) => {
      this.lastBeacon.set(peerId, performance.now());
      // Tell the newcomer who is in charge straight away rather than making
      // it wait for an election to find out.
      if (this.isCoordinator()) this._send(peerId, 'coordinator');
    });
    this.mesh.on('peer_gone', ({ peerId }) => {
      this.lastBeacon.delete(peerId);
      if (peerId === this.coordinator) this.startElection('coordinator link closed');
    });
    this._beaconTimer = setInterval(() => this._beat(), BEACON_MS);

    // A process that (re)starts holds an election -- the standard Bully rule.
    // Delayed slightly so the coord channels to existing peers can open first;
    // with nobody reachable we would otherwise always elect ourselves.
    this._schedule('joined the session', 2500);
  }

  stop() {
    clearInterval(this._beaconTimer);
    clearTimeout(this._timer);
    clearTimeout(this._pending);
  }

  isCoordinator() { return this.coordinator === this.selfId; }

  /** Higher priority = joined earlier; peer id breaks a tie. */
  outranks(a, b) {
    const ja = this.joinedAtOf(a);
    const jb = this.joinedAtOf(b);
    if (ja !== jb) return ja < jb;
    return a < b;
  }

  /** Per-peer liveness, for the dashboard. */
  liveness() {
    const now = performance.now();
    return this.mesh.coordPeers().map((peerId) => {
      const seen = this.lastBeacon.get(peerId);
      const ageMs = seen === undefined ? Infinity : now - seen;
      return { peerId, ageMs, suspected: ageMs > SUSPECT_MS };
    });
  }

  startElection(reason) {
    if (this.phase !== 'idle') return;   // one election at a time per node
    clearTimeout(this._pending);
    this.elections++;

    const higher = this.mesh.coordPeers().filter((p) => this.outranks(p, this.selfId));
    this.log('elect', 'starting election (' + reason + ') — sending ELECTION to ' +
      higher.length + ' higher-priority peer(s)', 'warn');

    if (!higher.length) { this._becomeCoordinator(); return; }

    this.phase = 'waiting-answer';
    for (const p of higher) this._send(p, 'election');
    this._timer = setTimeout(() => {
      // Nobody senior answered: they are all down, so the job is ours.
      if (this.phase === 'waiting-answer') this._becomeCoordinator();
    }, ANSWER_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------

  _schedule(reason, ms) {
    clearTimeout(this._pending);
    this._pending = setTimeout(() => this.startElection(reason), ms);
  }

  _send(peerId, t, extra) {
    if (this.mesh.sendCoord(peerId, { t, ...extra })) this.sent[t]++;
  }

  _becomeCoordinator() {
    clearTimeout(this._timer);
    this.phase = 'idle';
    const changed = this.coordinator !== this.selfId;
    this.coordinator = this.selfId;
    for (const p of this.mesh.coordPeers()) this._send(p, 'coordinator');
    if (changed) {
      this.log('elect', 'elected coordinator — no higher-priority peer answered');
      this.onChange(this.coordinator);
    }
  }

  _beat() {
    const iAmCoordinator = this.isCoordinator();
    const seq = ++this._beaconSeq;
    for (const p of this.mesh.coordPeers()) this._send(p, 'beacon', { seq, iAmCoordinator });

    // Is the coordinator still there?
    if (this.coordinator && !iAmCoordinator && this.phase === 'idle') {
      const seen = this.lastBeacon.get(this.coordinator);
      if (seen === undefined || performance.now() - seen > SUSPECT_MS) {
        this.log('elect', 'no beacon from coordinator for ' + (SUSPECT_MS / 1000) +
          ' s — suspecting it has failed', 'bad');
        this.startElection('coordinator silent');
      }
    }
  }

  _onMessage(from, msg) {
    switch (msg.t) {
      case 'beacon':
        this.lastBeacon.set(from, performance.now());
        // A rival claims to be coordinator: two exist, e.g. after a healed
        // partition. Re-run the election so exactly one survives.
        if (msg.iAmCoordinator && from !== this.coordinator && this.phase === 'idle') {
          this.startElection('rival coordinator detected (split brain)');
        }
        break;

      case 'election':
        if (this.outranks(this.selfId, from)) {
          this._send(from, 'answer');
          this.startElection('ELECTION received from a lower-priority peer');
        }
        break;

      case 'answer':
        if (this.phase === 'waiting-answer') {
          clearTimeout(this._timer);
          this.phase = 'waiting-coordinator';
          this._timer = setTimeout(() => {
            if (this.phase !== 'waiting-coordinator') return;
            this.phase = 'idle';
            this.startElection('ANSWER received but no COORDINATOR followed');
          }, COORD_TIMEOUT_MS);
        }
        break;

      case 'coordinator':
        if (this.outranks(this.selfId, from)) {
          // A junior has claimed the job while we are alive: bully it.
          this.phase = 'idle';
          this.startElection('lower-priority peer claimed coordinator');
          break;
        }
        clearTimeout(this._timer);
        this.phase = 'idle';
        if (this.coordinator !== from) {
          this.coordinator = from;
          this.onChange(from);
        }
        break;
    }
  }
}
