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
No, and the distinction matters. Ours is deterministic succession computed from
shared state — it works because everybody sees the same roster from the same
server. Real leader election (Bully, Raft) tolerates the nodes *disagreeing*
about who is alive. Under a network partition ours could produce two masters —
split brain. That is FA-2 work.

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

## Part 4 — Scope note

FA-1 covers Units 1 and 2 only. The concepts implemented here stop at the
**model** of distributed computations — events, local histories, the
happened-before partial order, and concurrency detection — which is Unit 1
self-study material.

Algorithms built *on top of* that model (leader election, distributed mutual
exclusion, global snapshots, replication and consistency) belong to Units 3
and 4 and are deliberately **not** implemented here. Where the current design
has a known gap that those would close — most obviously that master
succession is deterministic failover rather than true election, and could
split-brain under a partition — the gap is stated honestly in the limitations
rather than papered over.

The same problem statement carries forward to FA-2.
