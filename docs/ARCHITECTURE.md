# Architecture, design decisions, and viva preparation

This document exists for one reason: at the evaluation you will be questioned
individually, and the marks come from *why* each choice was made, not from the
code compiling. Every section below is a decision with its alternative and the
reason we rejected the alternative.

---

## Part 1 — The decisions

### 1.1 Why two planes instead of one

Everything could have gone over one channel — WebSockets to the server, say.
We split into a **control plane** (gRPC + MQTT, via the server) and a **data
plane** (WebRTC, peer-to-peer) because the two carry traffic with opposite
requirements:

| | Control plane | Data plane |
|---|---|---|
| Volume | A few messages per minute | ~50 packets/second, continuously |
| Latency need | "Soon" is fine | Every millisecond is audible |
| Loss tolerance | None — resend it | Total — a late packet is worthless |
| Ordering | Required | Actively harmful to enforce |
| Topology | Star (via server) | Mesh (direct) |

Anything you build that satisfies one column badly serves the other. The split
is not decoration; it falls out of the requirements.

### 1.2 Why gRPC *and* MQTT, rather than just one

A common exam question. The honest answer is that they solve different
problems and neither can do the other's job cleanly.

**gRPC is request/reply.** `JoinSession` must return *this* peer's ID and the
list of who is already present, to *this* caller, now. Pub/sub has no reply
channel — you would have to invent a correlation ID, publish a request, and
subscribe to a response topic. That is re-implementing RPC, badly.

**MQTT is one-to-many with decoupling.** A tempo change must reach every node,
and the publisher does not know who is listening — nor should it. Doing this
over RPC means the server holds a list of peers and calls each one, which
means it needs a callback address for each, needs to handle each one failing
independently, and needs to re-send to anyone who reconnects. MQTT's retained
messages give the last of those for free.

The decoupling is threefold and worth naming precisely:
- **space** — publishers don't know subscribers' addresses
- **time** — a retained message reaches a subscriber who wasn't running yet
- **flow** — nobody blocks waiting for anybody

### 1.3 Why signalling goes over MQTT

Before two peers can exchange audio they must exchange SDP and ICE candidates
— but they cannot do that over a connection that does not exist yet. Something
already connected has to relay it. That is the whole job of signalling, and
WebRTC deliberately does not specify how you do it.

We reused MQTT rather than inventing a side channel, which makes the point
that signalling is *just message passing*: each node subscribes to
`session/{id}/signal/{its own peer id}`, which is a private mailbox.

Signalling is published **volatile** (`retain: false`) while roster and tempo
are **retained**. That distinction matters: a stale retained offer delivered to
the next node that subscribes would actively corrupt its handshake.

### 1.4 Why the newcomer always offers (the glare problem)

If both peers send an offer simultaneously, both are in `have-local-offer`,
neither can accept the other's, and the handshake deadlocks. This is **glare**.

The standard fix is "perfect negotiation" — designate a polite peer that rolls
back its own offer. We use something simpler and fully deterministic: impose a
**total order** on peers (join time, with peer ID as tie-break) and let the
later arrival always offer.

Both nodes evaluate the identical comparison against the identical roster and
necessarily reach opposite conclusions. Exactly one offer is sent per pair, and
no negotiation is needed to decide who sends it.

> This was a real bug during development. The first version had every node
> offer to every unknown peer in `syncRoster`, so both sides offered, and they
> ended up on two separate connections that could each send but never receive.
> The symptom was "data channel open on both ends, 100% packet loss". Worth
> mentioning if asked about debugging — it is a textbook distributed-systems
> symmetry problem.

### 1.5 Why the timeline is a formula, not a tick stream

The obvious design is: the master broadcasts "beat 1", "beat 2", "beat 3". It
is also badly wrong, for two reasons.

**It puts the network in the critical path of every beat.** Every beat's
timing accuracy becomes a function of that message's delivery jitter. Miss one
and you drop a beat.

**It makes the master indispensable.** Kill it and the music stops instantly.

Publishing an **anchor** `(beat, time, bpm)` instead means every node computes
every future beat locally. The network is involved only when the tempo
*changes*. A two-second network stall produces no musical error at all, and
killing the master costs nothing until somebody wants a tempo change.

This is the single design decision in the project with the highest ratio of
benefit to complexity, and it is the one to lead with if asked "what would you
highlight?".

### 1.6 Why a look-ahead scheduler

`setInterval`/`setTimeout` are accurate to roughly 5–15 ms in a browser, worse
under load. Ten milliseconds of timing error is clearly audible. So we never
*play* anything from a timer.

The timer wakes every 25 ms and hands the audio hardware every beat falling in
the next 150 ms, each with an exact timestamp. The Web Audio clock is
sample-accurate; JavaScript merely queues work ahead of it. This is the
standard "tale of two clocks" pattern, and it is the difference between a
metronome that sounds tight and one that stutters.

### 1.7 Why compensation is applied at the receiver

The delay for peer *j* is `D − d_j`, and only the **receiver** knows `d_j` for
its own link. If we pre-delayed on the sending side we would need a separately
delayed copy of the stream per recipient — exactly the fan-out we avoided by
not using a central mixer.

So we transmit undelayed and let each receiver align what it gets.

### 1.8 Why every node publishes its telemetry

`D` is the max one-way delay **anywhere in the session**, and it must be the
same number on every node — if two nodes compensate to different deadlines,
they align to different targets and the whole scheme collapses.

But a node can only measure its own links. So each publishes its measurements
on `session/{id}/telemetry/{peer}` and each takes the max over the union. This
is a small distributed aggregation, and it is why telemetry is on the bus
rather than being a purely local dashboard feature.

Telemetry uses **QoS 0** while control messages use **QoS 1**: a lost telemetry
sample is replaced one second later, so guaranteed delivery would be wasted
effort. Matching QoS to the value of the message is a deliberate choice, not
an oversight.

### 1.9 Why the impairment is applied at both ends

Emulated delay is a property of a **link**, not of one receiver. Our first
version applied it at one end only — and that quietly broke the `RTT/2`
estimate, because the extra delay landed on only one leg of the round trip.
Measured one-way delay came out at half the injected value, and the
compensation computed from it was wrong by that much.

Publishing the impairment so both endpoints apply it makes the emulated link
**symmetric**, which is precisely the condition `RTT/2` requires. This is a
nice concrete demonstration of a theoretical assumption having teeth.

### 1.10 Why both a physical clock and a logical clock

These answer different questions and neither substitutes for the other.

**Cristian's algorithm** (`clock.js`) answers *"when should I play this
note?"*. That is a question about physical time: the note has to sound at a
particular instant, and being 40 ms off is audible. It needs a real clock.

**The event model** (`events.js`) answers *"did this event cause that one?"*.
That is a question about causality, and physical time cannot answer it —
timestamps from two disagreeing clocks can order events that never influenced
each other, inventing an ordering the system does not possess.

The demonstration is worth rehearsing, and the measured numbers are worth
quoting because they are more interesting than the tidy story:

| Link condition | `mine → theirs` | `CONCURRENT ‖` |
|---|---|---|
| localhost, sub-millisecond | 29 | 21 |
| 150 ms injected | 0 | 59 |

On a fast link the relation **flickers**. Whether the other peer's note lands
before this peer schedules its own is a race between network delivery and the
scheduler's 25 ms tick, and it resolves differently from beat to beat. Add
150 ms and it locks to concurrent, because no message can now cross before
both peers have played.

The flicker is the better teaching point. The causal ordering of two notes is
not a property of the music — it is a property of the timing, and it is the
network that decides. That is precisely why the model refuses to impose a
total order in the first place.

We carry a Lamport scalar and a vector timestamp together, because they differ
in a way worth stating: `a → b` implies `L(a) < L(b)`, but the converse fails,
so a scalar clock can never *detect* concurrency — it only avoids contradicting
causality. Vector clocks give if-and-only-if, at a cost of O(n) per message.
Without vectors the partial order would be described in this document but not
observable in the running system.

### 1.11 What virtualization does and does not buy

Containerising the server and broker (`docker-compose.yml`) gives three
things: **isolation** (its own runtime, unbreakable by the host's Node
version), **reproducibility** (identical bytes on both laptops and the
evaluation machine), and **substitutability** (the server addresses the broker
as the *name* `broker`; what answers to that name is a deployment decision).

The compose setup swaps the embedded Aedes broker for real Mosquitto, and no
peer can tell — a concrete demonstration of the **openness** goal, since the
system is defined by its interfaces rather than its implementations.

Be equally clear about the limits, because it is a likely follow-up:
virtualization changes **nothing** about latency, consistency, or failure
semantics. Every hard problem here — clock disagreement, propagation delay,
partial failure — is exactly as hard inside a container as outside one.
Containers solve packaging, not distribution.

The peers are deliberately **not** containerised. Putting a musician behind a
container network boundary would add a hop and a NAT traversal between
players, which is the opposite of what the system is for. Infrastructure is
containerised; the data plane is left alone.

### 1.12 The delay the ping cannot see (a bug found in testing)

The first version computed `d_j` purely from data-channel pings: RTT/2,
about 1–3 ms on a LAN. But audio does not travel like a ping. Measured on two
laptops, the real budget was:

| Stage | Typical | Seen by the ping? |
|---|---|---|
| Network, one way | 1–3 ms | yes |
| Opus packetisation (one 20 ms frame) | 20 ms | no |
| Receiver jitter buffer | 30–60 ms | no |
| This device's output (driver, OS mixer, speaker) | 10–60 ms; 150 ms+ on Bluetooth | no |

So compensation was correcting ~2 ms of a ~100 ms problem. Three fixes:

1. **`d_j` now includes the media pipeline.** `mesh.js` reads the receiver's
   jitter-buffer delay from WebRTC's own `getStats()` every second (as a
   per-interval average, so an early burst cannot inflate `D` for the whole
   session) and adds one Opus frame. `D` is the max of *that*.
2. **Clicks are scheduled against when they are heard, not rendered.**
   `audio.js` maps time through `AudioContext.getOutputTimestamp()`, which
   subtracts each device's own output latency. Clock sync made both laptops
   *render* the beat together; this makes them *sound* it together.
3. **The metronome is no longer transmitted.** Every node synthesises the
   same click from the shared timeline, so sending it too only added a
   second, later copy of each beat — an echo. Only instruments and the
   microphone go over the network now.

The viva point: the data channel and the media track share a connection but
not a latency. A measurement is only valid for the path it measured.

---

## Part 2 — Anticipated questions

**"Why not just use a central server to mix the audio?"**
That is an SFU/MCU, and it is what commercial conferencing uses. It scales far
better than a mesh. But it adds a full extra network hop to every note — peer
→ server → peer instead of peer → peer — which directly increases the very
quantity this project exists to minimise. For a small ensemble the mesh wins;
past about five peers the trade reverses.

**"Your mesh is O(n²). Isn't that a flaw?"**
It is a limit, and a deliberate one. Three peers is three connections; five is
ten; ten would be forty-five, which no browser will sustain. We chose the
topology that minimises latency for the size of group this targets, and the
scaling limit is the price. Naming the crossover point is the answer, not
defending the mesh as universally good.

**"What happens if the server dies?"**
Once the mesh is established, audio and note events continue — they never
touched the server. What stops is joining, tempo changes, master succession,
and clock re-synchronisation. Clock drift means quality degrades slowly over
minutes rather than failing immediately. This is graceful degradation, and it
is a consequence of the server being a bootstrapper rather than a relay.

**"What happens if the timing master dies?"**
Nothing audible. The beat keeps advancing because every node holds the anchor
and computes beats locally. After ~6 s of missed heartbeats the server promotes
the longest-serving survivor. Demonstrate this by closing the master's tab.

**"Is your failover the same as leader election?"**
No, and the distinction matters — which is why the project now has both. The
server's succession is deterministic and computed from one copy of the
roster; it works only because everybody asks the same server. The peers also
run a real **Bully** election (§4.2) that needs no server at all. Both use
seniority, so they agree whenever the server is up. Neither is consensus:
under a partition Bully can elect two coordinators, and only repairs that
when the partition heals.

**"How accurate is your clock sync?"**
The dashboard shows the uncertainty bound: half the best observed round trip,
typically 1–3 ms on a LAN. The bound is honest but assumes path symmetry. On an
asymmetric path the true error can exceed it, and we cannot detect that from
one endpoint. NTP handles it with multiple servers and long observation; we
have one server and seconds.

**"Why is packet loss expected on your data channel?"**
The channel is deliberately configured `ordered: false, maxRetransmits: 0`.
For real-time control traffic a message that arrives after its moment has
passed is not merely useless — retransmitting it delays every message behind
it, making the situation worse. We measure loss rather than trying to
eliminate it.

**"Why median RTT instead of average?"**
RTT distributions have a long right tail: one scheduling hiccup produces a
single huge sample. A mean would be dragged upward for seconds afterwards and
would inflate `D` for the whole session. The median ignores it.

**"What is the actual limit of this technique?"**
`D` is a hard latency floor set by the worst link. Past roughly 25–30 ms
players struggle regardless of consistency; past ~50 ms most music is
unplayable. Compensation buys **agreement, not speed**. It makes a marginal
network usable; it cannot rescue a bad one. Being clear about this is more
convincing than overclaiming.

**"You already sync clocks. Why do you also need logical clocks?"**
They answer different questions. Physical time answers *when to play a note* —
a real deadline where 40 ms is audible. Logical time answers *did this event
cause that one* — and physical timestamps cannot answer it, because two
disagreeing clocks will happily order events that never influenced each other.
Demonstrate it: on localhost the panel flickers between ordered and concurrent
(29/21 over 50 samples) because delivery races the scheduler; inject 150 ms and
it locks to `CONCURRENT` (59/59). The network decides the causal structure.

**"Why is virtualization relevant to a distributed system?"**
Isolation, reproducibility, and substitutability — the server names the broker
`broker` and does not care what answers. The compose file swaps embedded Aedes
for real Mosquitto and no peer can tell, which demonstrates openness. But be
clear on the limit: containers change nothing about latency, consistency or
failure semantics. Every hard problem here is exactly as hard inside a
container. Virtualization solves packaging, not distribution.

**"Which part are you proudest of?"**
The anchor-based timeline (§1.5) — one design decision that simultaneously
removes the network from the per-beat critical path and makes the timing
master non-essential.

---

## Part 3 — Names, identifiers and addresses

Three things that are routinely conflated, made concrete in the UI panel. For
any peer in a session:

| | Example | Properties |
|---|---|---|
| **Name** | `Ana` | Human-readable. Need not be unique — two musicians can both be "Ana". Mutable. |
| **Identifier** | `peer-5-vbsf` | Unique, immutable, never reused. Denotes exactly one peer for that peer's entire lifetime. |
| **Address** | `192.168.1.7:65015` | Where it can currently be reached. Mutable, and may be several at once. |

The distinction has teeth in this system:

- **Everything routes by identifier, never by address.** MQTT topics are
  `session/{id}/signal/{peerId}`; the vector clock is keyed by peer ID; the
  audio graph is keyed by peer ID. A peer that switches from Wi-Fi to Ethernet
  changes address without becoming a different peer, and nothing above the
  transport layer notices.
- **A peer does not have "an address" — it has a set of them.** ICE gathers
  host, server-reflexive and relay candidates, then selects a working *pair*.
  The panel shows the currently selected one, and `host` / `srflx` / `relay`
  tells you which kind won.
- **Names get resolved to addresses, and sometimes back again.** Chrome
  redacts host IPs from `getStats()` to stop pages harvesting your local
  network layout, substituting an mDNS name of the form `<uuid>.local`. So
  there is a naming problem sitting *inside* the addressing layer: the browser
  hands out a name precisely so it need not hand out an address, and that name
  must be resolved before a single packet can flow.
- **Session IDs are identifiers too.** `sess-4-fzuw` is generated server-side
  and never reused, which is why a session can be rejoined after a crash while
  a session *name* like "Jam" could not reliably identify anything.

---

## Part 4 — Unit III: coordination without a coordinator

FA-1 stopped at the *model* of distributed computations: events, the
happened-before order, logical clocks. Unit III is the algorithms built on top
of that model. Every one of them here runs **peer-to-peer**, because the
point of each is to reach agreement without an authority to ask.

### 4.1 Why a second data channel, and why it is reliable and FIFO

The FA-1 data channel is deliberately unreliable and unordered: a late note is
worthless. Every Unit III algorithm assumes the opposite.

| Algorithm | Breaks without… | How |
|---|---|---|
| Ricart–Agrawala | reliability | One lost REPLY and the requester waits forever. |
| Bully | reliability | A lost ANSWER makes a junior think it won. |
| Chandy–Lamport | FIFO | A message that overtakes the marker gets recorded on the wrong side of the cut. |

So each peer link carries a second SCTP channel, `coord`, with the defaults —
reliable and ordered, i.e. TCP-like. Same connection, opposite guarantees,
because the traffic has opposite needs. This is §1.1's argument again at a
smaller scale.

One subtlety had to be handled: the link-impairment emulator delays inbound
messages. A bare `setTimeout` per message would let a later message overtake
an earlier one if the slider were lowered mid-flight, silently breaking FIFO.
`mesh.js` releases each coord message no earlier than the one before it.

### 4.2 Bully election, and why rank = seniority

Bully: on suspecting the coordinator, send ELECTION to every higher-ranked
peer; if none ANSWERs within 1.5 s, announce COORDINATOR; if one does, wait
for its announcement, and restart if none comes. A peer receiving ELECTION
from a junior answers and starts its own election. The highest-ranked live
peer always wins. Worst case O(n²) messages — trivial at n ≤ 5.

**Rank is seniority** (earliest join, peer id as tie-break), chosen for three
reasons:

1. It is the server's succession rule, so the two mechanisms agree whenever
   both are running. There is never a visible "server says X, peers say Y".
2. A newcomer is always the most junior, so joining a session can never move
   the coordinator. Rank by random id and every join could trigger a
   takeover.
3. Seniority is a reasonable proxy for "has the most complete state".

**What the coordinator is for:** with the server dead, nobody can call
`SetTempo`. The coordinator takes over that one job — it re-anchors the
timeline (same arithmetic as `registry.setTempo`) and sends the new anchor
over the mesh. Peers accept anchors only from the node they believe is
coordinator, so tempo changes are still serialised through one node.

**Split brain** is detected, not prevented: if a beacon arrives from a peer
claiming to be coordinator that is not ours, a new election runs and the more
senior one wins. Bully assumes failure detection is accurate; in an
asynchronous network it is not, so a partition can produce two coordinators
until it heals. Prevention needs a majority quorum (Raft, Paxos), which would
also need at least three nodes to be useful.

### 4.3 Beacons versus heartbeats

Both are periodic "I'm alive" messages; the difference is who listens. The
gRPC heartbeat goes to the server, which decides who is dead for everyone.
Beacons go peer-to-peer, and each peer decides for itself. That is weaker —
two peers may disagree about a third — but it is the only option that still
works when the server is down, and Bully is designed to tolerate the
disagreement. A beacon also carries a sequence number and whether its sender
believes itself coordinator, which is how split brain is noticed.

Thresholds: beacon 1 s, suspect after 3.5 s. Shorter detects faster but
suspects more live peers during a CPU or network hiccup; a false suspicion
here is cheap (an extra election), unlike a false eviction by the server.

### 4.4 Ricart–Agrawala, and why the shared resource is the "solo floor"

**The resource.** Mutual exclusion needs a genuinely shared thing with no
natural owner. In a distributed multimedia system that is *floor control* —
who may speak in a conference, who holds the whiteboard. Here: who may solo.
The soloist's voice plays an octave up and louder, which makes a safety
violation audible rather than a line in a log.

**The algorithm.** To enter, stamp a REQUEST with the Lamport clock and send
it to every peer; enter when every peer has replied. A peer receiving a
request replies at once unless it holds the floor, or wants it with an older
`(timestamp, id)`, in which case it defers until it releases.

**Why this one** over the alternatives:

| | Messages per entry | Single point of failure | Notes |
|---|---|---|---|
| Central coordinator | 3 | the coordinator | Simple; but we would need election first, and the server is exactly what we are avoiding. |
| Token ring | 1 to ∞ | the token | Token loss needs detection and regeneration — an election in disguise. |
| **Ricart–Agrawala** | **2(n−1)** | **none for the decision** | Uses the Lamport clock FA-1 already built. |

Its weakness is the mirror image of its strength: every peer is needed, so a
crashed peer that never replies blocks everyone. We stop waiting for a peer
only when the mesh drops it — correct for crash-stop, wrong for a peer that is
slow but alive.

**Membership changes.** RA assumes a fixed set of processes; ours changes as
people join. If a peer's channel opens while we are waiting, we send it our
request too and wait for its reply. Either our request reaches it first (and
pushes its Lamport clock past ours, so it ranks after us), or its request
reached us first and it legitimately ranks before us. Exactly one of us defers.

**Using the shared Lamport clock** means mutex messages are ordinary send and
receive events, so they appear in the happened-before table alongside the
notes — the same clock orders both.

### 4.5 Self-study: Lodha–Kshemkalyani's fair algorithm

Lodha and Kshemkalyani (2000) start from the same idea as Ricart–Agrawala —
REQUEST to everyone, priority by `(timestamp, id)` — and target its cost under
**concurrent** requests. In outline, each site keeps a local queue of the
concurrent requests it has seen. When requests are concurrent, a site can
infer permissions from the requests themselves rather than needing a separate
REPLY from every site, and a site leaving the critical section sends a FLUSH
to the next site in priority order rather than replies to all. The message
cost falls from RA's fixed 2(N−1) to between N−1 and 2(N−1), depending on how
much concurrency there is.

**Fair** means requests are granted in timestamp order. RA already has that
property; LK keeps it while saving messages. For this project the saving is
small — at n ≤ 5, RA costs at most 8 messages per solo — so RA's simplicity
wins. LK would earn its complexity in a larger group with frequent contention.

### 4.6 Self-study: Knapp's classification of deadlock detection

Knapp (1987) classified distributed deadlock detection into four families,
all of which look for a cycle in a **wait-for graph** (WFG) that no single
node can see whole:

| Class | Idea | Classic example |
|---|---|---|
| Path-pushing | Nodes send their local WFG paths to each other until one sees a cycle. | Obermarck |
| Edge-chasing | A *probe* follows wait-for edges; a probe returning to its sender proves a cycle. | Chandy–Misra–Haas (AND model) |
| Diffusing computation | A query spreads through the WFG; replies echo back only if every path is blocked. | Chandy–Misra–Haas (OR model) |
| Global state detection | Take a consistent snapshot, then look for a cycle in it. | Bracha–Toueg; Kshemkalyani–Singhal |

The project implements the fourth class. Each snapshot (§4.7) records whom
every node is waiting on for an RA REPLY, assembles the global WFG, and
checks it for a cycle. It **requires** the snapshot to be consistent: on an
arbitrary cut you can see an edge that had already gone next to one that had
not appeared yet, and report a *phantom deadlock*.

The check never fires, and that is the point to make at the viva. RA cannot
deadlock: every wait points from a younger request to an older one in a total
order, and a total order has no cycles. The detector demonstrates the
technique; the algorithm makes it unnecessary.

### 4.7 Chandy–Lamport snapshot

Covered in detail in `web/snapshot.js`. The points to make:

- **A consistent cut, not an instant.** Recorded beat positions differ
  between nodes — they recorded at different real moments. What is guaranteed
  is that no message is recorded as received but not sent.
- **Channel state is what the naive approach loses.** Raise one link to
  300 ms and snapshot: beacons and RA messages appear as *in transit* on that
  channel. "Ask everyone for their state" would have lost them.
- **Global predicates** are what a snapshot is for: at most one floor
  holder, every node agrees on the coordinator, the tempo and the ledger head,
  and the wait-for graph is acyclic. These are stable or safety properties —
  things you can only check against a whole, consistent global state.

---

## Part 5 — Unit IV: emerging distributed paradigms

### 5.1 Kubernetes (`k8s/`)

The manifests run the same two containers as Compose. The idea to take from
Kubernetes is **declarative desired state plus a control loop**: you declare
"one server, one broker, these probes", and controllers continuously compare
that with reality and act on the difference — restarting crashed containers,
withholding traffic until readiness passes, rescheduling when a node dies.
Compose starts things once; Kubernetes keeps them in the declared state.

Decisions worth defending:

- **Separate liveness and readiness.** `/healthz` answers "is the process
  wedged?"; `/readyz` answers "is gRPC bound *and* the broker reachable?". If
  the broker goes down, the server is not *ready* (route no traffic to it) but
  is still *live* (do not restart it). Conflating the two would restart a
  healthy server over a broker outage — which fixes nothing and loses every
  session.
- **`replicas: 1` with `strategy: Recreate`.** The registry lives in memory.
  Two replicas behind a Service would each hold half the sessions, and a peer
  load-balanced between them would join on one, heartbeat to the other, and
  be evicted. Even a rolling update briefly does this. Scaling out needs the
  state moved to shared storage, or routing pinned by session id — and
  session id is a natural partition key, because sessions share nothing (§5.8).
- **Service names are names, not addresses.** The server reaches the broker
  as `broker`, resolved by cluster DNS — Part 3's distinction again, now
  enforced by the platform.
- **Peers are not in the cluster.** Same argument as §1.11: they are the data
  plane, and putting a cluster network between musicians adds delay.

### 5.2 Serverless (`server/faas.js`, `functions/`)

"Serverless" means the developer no longer manages servers, not that there
are none. The runtime reproduces the three properties that define the model,
so each can be shown rather than described:

1. **Stateless invocation.** `fetch(request) → response`. The report function
   is handed the whole ledger in the request; it has no database and no
   memory of previous calls. That is what lets a platform run zero, one or a
   thousand copies without coordination — and it is why the ledger being
   self-verifying matters: the function can trust data from an untrusted
   caller only because it can check it.
2. **Cold and warm starts.** The first call loads the code; later calls reuse
   the instance. The response headers say which, and the UI shows it.
   Module-level state *survives* warm calls (the invocation counter goes 1,
   2, 3…) — exactly why real state must never live there: another instance
   would have a different count.
3. **Scale to zero.** After 60 s idle the instance is discarded. Zero idle
   cost, at the price of the next caller paying the cold start: the central
   economic trade of serverless.

The function is written to the Cloudflare Workers signature, so it deploys
there unchanged (`functions/wrangler.toml`). What a real platform adds:
isolation per instance (V8 isolates on Workers, Firecracker micro-VMs on
Lambda), many instances in parallel under load, and per-millisecond billing.

**Why not make the whole server serverless?** Because the control plane is
stateful (the registry) and long-lived (WebSocket connections to the
broker, a gRPC server). Serverless suits short, stateless, bursty work — like
a report — and the project uses it exactly there.

### 5.3 Apache Hadoop / MapReduce (`server/mapreduce.js`)

Telemetry is used two ways. **Live**, it drives compensation: each sample
matters for about a second (stream processing). **At rest** — appended to
`data/telemetry/*.jsonl` — it answers questions no single sample can: "what
was the p95 delay on each link across the whole rehearsal?" That second kind
is batch processing, which is where Hadoop sits.

The framework does split → map (parallel worker threads) → shuffle
(hash-partitioned, sorted) → reduce (parallel). The job is two pure
functions in `analytics/link-stats.js`.

Two points carry the explanation:

- **The key design is the real work.** Both ends of a link report it. Keying
  by the *sorted* peer pair makes both reports collide in the shuffle and be
  reduced together.
- **Fault tolerance by re-execution.** Map and reduce are deterministic
  functions of their input, so a failed task is simply run again — anywhere,
  with no checkpoint and no coordination. Inject 30 % failures and the answer
  does not change. This property, more than parallelism, is why MapReduce
  succeeded on clusters of unreliable machines.

What is missing compared with Hadoop: HDFS and data locality (§5.4), YARN
scheduling across machines, speculative execution of stragglers, and spilling
the shuffle to disk.

### 5.4 Distributed file systems (discussed, not built)

HDFS is the other half of Hadoop: a **NameNode** holds the metadata (which
blocks make up which file, and where they are), and **DataNodes** hold large
blocks (128 MB by default), each replicated three times. Files are
write-once, read-many. Computation moves to the blocks rather than blocks to
the computation — *data locality*.

Contrast with NFS, which presents a remote disk with close-to-POSIX
semantics, and AFS, which caches whole files at the client and uses
callbacks for consistency. HDFS gives up POSIX semantics (no in-place
writes) to get throughput and fault tolerance on cheap disks.

Where it would fit this project: **recorded takes**. A per-peer audio
recording is large, written once, read many times, and produced on the
peers. The natural design is HDFS-shaped: the session server as NameNode
(block map only, never the audio), the peers as DataNodes storing and
replicating blocks over the mesh. It was left out to keep scope honest — it
is a substantial system, and the telemetry log already demonstrates the
batch side of Hadoop.

### 5.5 Distributed object-based systems

RMI and CORBA make a remote **object** look local: an interface definition
(IDL), a client-side **proxy** (stub), a server-side **skeleton**, and an
**object reference** that can be passed around and is resolved to a live
object.

The project's mapping:

| Concept | Here |
|---|---|
| IDL | `proto/session.proto` |
| Client proxy | `web/rpc.js` — a remote call looks like a local function |
| Skeleton | the gRPC server stubs generated from the `.proto` |
| Object reference | the **session id**: an opaque handle naming one remote session |

gRPC is **service**-oriented, not object-oriented, and the difference is
worth knowing: there is no remote object lifecycle, no passing objects by
reference, and no distributed garbage collection. A session id only *acts*
like a reference, and the server reclaims sessions itself when the last peer
leaves. We chose the service model because distributed object lifecycles
(leases, distributed GC) are a significant source of complexity, and a
session needs none of it.

### 5.6 Distributed web-based systems

The client *is* a distributed web application, and the browser's sandbox
shaped the architecture more than any other single constraint:

- No raw TCP or UDP → MQTT must run over **WebSockets** (port 9001).
- No HTTP/2 trailers → gRPC needs a **gateway** (§"Proving the RPC layer").
- Peer-to-peer requires **WebRTC**, with its own signalling and ICE.
- Audio needs a **user gesture** before it may start.

The HTTP side is classic web architecture: static content (the client),
dynamic content (the gateway, `/fn/*`, `/analytics/*`), stateless request
handling with all session state behind it. Every piece of the browser client
is fetched from one origin, which is why the LAN demo needs only one address.

### 5.7 Case studies, mapped onto this system

**AWS.** Nearly every component has a managed equivalent: API Gateway ≈ the
JSON→gRPC gateway; Lambda ≈ `/fn/*`; **AWS IoT Core** is a managed MQTT
broker (with MQTT over WebSockets, as browsers need); EKS ≈ `k8s/`; EMR is
managed Hadoop. The lesson is that the hard parts — the compensation
algorithm, the anchor timeline — are not things a cloud provides. Managed
services take over *operations*, not *design*.

**Cloudflare.** Two direct connections. First, Workers run functions in V8
**isolates** rather than containers or VMs, which makes cold starts close to
zero — the exact cost §5.2 makes visible. Second, its anycast edge network
puts compute physically near users, and its WebRTC product offers TURN relays
for peers that cannot connect directly. For this project TURN is the
relevant piece: our mesh relies on peers reaching each other, which fails
across some NATs.

**Megaport.** Network-as-a-Service: software-defined **private
interconnects** between data centres and cloud regions, provisioned on
demand, bypassing the public internet. It speaks to this project's central
limit: compensation buys *agreement, not speed*, and `D` is set by the worst
link. A private path does not beat the speed of light, but it is far more
**consistent** — lower jitter and loss than the public internet — and jitter
is the one thing a fixed `D` cannot absorb. For two fixed studios, that is
the honest fix the software cannot provide.

**Apache Hadoop** — §5.3 and §5.4. **Kubernetes** — §5.1.

### 5.8 Self-study: distributed database trade-offs, applied

CAP says that during a network **P**artition a replicated store must give up
either **C**onsistency or **A**vailability. PACELC adds the everyday case:
**E**lse, with no partition, you still trade **L**atency against
**C**onsistency. Every piece of state in this system has made one of those
choices, mostly implicitly. Making them explicit is the exercise:

| State | Where it lives | Choice | Why |
|---|---|---|---|
| Session registry (roster, tempo, transport) | one server, in memory | **CP** (trivially: one copy) | Unavailable when the server is down — which is why §4.2 exists. |
| Timeline anchor | replicated to every node | **AP / EL** | Read locally on every beat — latency is everything. Staleness is harmless because it is a formula. |
| Common deadline `D` | computed by every node from telemetry | **AP / EL**, eventually consistent | Briefly disagreeing on `D` costs a few ms of misalignment; blocking would cost the music. |
| Coordinator (Bully) | each node's view | **AP** | Under partition each side elects its own and keeps working — split brain, repaired after. |
| Solo floor (RA) | the protocol | **CP** | Under partition a request waits rather than risk two soloists. Safety over liveness. |
| Ledger replicas | every peer | single writer, async replication | Reads always available locally; writes need the ordering node. Replicas converge, and tampering is detectable. |
| Retained MQTT state | the broker | **CP** (one broker) | A late joiner gets the latest value, or nothing if the broker is gone. |

The pattern: state on the **audio path** chose availability and low latency,
because a late answer is a wrong answer in music. State that guards a
**safety property** chose consistency. That rule of thumb — decide per piece
of data, not per system — is the practical content of CAP.

Scaling the registry out (§5.1) would be **sharding by session id**: sessions
share no state, so each could live on a different node with no cross-shard
transactions at all. Workloads with a natural partition key like that are
the easy case for a distributed database.

### 5.9 Self-study: blockchain and distributed ledgers

See the header of `web/ledger.js`. In short: a blockchain is **a hash
chain + replication + consensus on who appends**. We have the first two.
Appends are ordered by one node (the server), as in permissioned ledgers
like Hyperledger Fabric's ordering service, rather than by proof of work or
proof of stake. That is the right choice when participants are known, and
the wrong one among strangers.

| | Our ledger | Bitcoin-style |
|---|---|---|
| Who may append | the server | anyone who wins proof of work |
| Tolerates | crash faults; detects tampering | Byzantine faults among strangers |
| Cost | one SHA-256 per block | enormous, deliberately |
| Finality | immediate | probabilistic (wait for confirmations) |

Honest limit: a malicious server could show different chains to different
peers (a fork). Peers publish their head hash in telemetry, so they would see
it — detection, not prevention. Preventing it needs the peers to agree on
each block: consensus, which is what proof of work, proof of stake and BFT
protocols each buy at their own price.

---

## Part 6 — Anticipated questions, Units III and IV

**"Why Ricart–Agrawala and not a central lock server?"**
A central lock costs 3 messages and is simpler — but the coordinator is a
single point of failure, and the whole point of Unit III here is to agree
without one. RA costs 2(n−1) messages and has no single node whose loss
corrupts the decision. Its weakness: every node is needed, so one crashed
peer blocks everyone until the mesh drops it.

**"Can your mutual exclusion deadlock?"**
No. Waits always point from a younger request to an older one in the
`(Lamport time, id)` total order, and a total order has no cycles. The
snapshot checks the global wait-for graph anyway — that is Knapp's
global-state detection class, and it only works because the cut is
consistent.

**"Why is the snapshot not taken at one instant?"**
Because there is no shared instant to take it at. Chandy–Lamport gives a
consistent cut — a state the system could have passed through. Beat
positions in the snapshot differ for exactly that reason.

**"What if two peers start an election at the same time?"**
Both send ELECTION upward; the senior one answers the junior and carries on.
Elections may overlap, but the most senior live peer wins every one of them,
so they converge on the same answer.

**"Is this a blockchain?"**
It is two-thirds of one: a hash chain, replicated and verified everywhere.
The missing third is consensus on who appends — we use a single ordering
node, as permissioned ledgers do. Tampering is evident, not impossible.

**"Why is your serverless function stateless? Wouldn't caching help?"**
The platform may run any number of instances, or none, and route each call
to any of them. State kept in an instance is invisible to the others and
vanishes at scale-to-zero. The invocation counter in the function shows
exactly that leaking through on warm calls.

**"Why only one replica in Kubernetes?"**
The registry is in memory. Two replicas would split sessions between them,
and a peer whose heartbeat reached the "wrong" replica would be evicted.
The fix is sharding by session id or moving state to a shared store — the
manifest says this rather than hiding it.

**"How does MapReduce recover from a failed task?"**
It runs it again. Map and reduce are deterministic functions of their input,
so re-execution gives the same result and nothing else in the job needs to
know. Inject failures in the UI to watch it.

---

## Part 7 — Scope note

FA-1 covered Units 1 and 2. This version adds Units III and IV. What is
deliberately **not** built, with the reason:

- **Consensus (Raft/Paxos).** Bully plus split-brain repair is the Unit III
  material; a quorum protocol is a step beyond it.
- **A distributed file system.** Discussed in §5.4, with where it would fit.
- **Real cloud deployment.** `k8s/` and `functions/wrangler.toml` are written
  for real platforms but have not been deployed; the local runtime and
  MapReduce framework are what was tested.

Each gap is stated rather than papered over, in the same spirit as the FA-1
limitations.
