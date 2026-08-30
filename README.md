# Distributed Latency-Compensated Ensemble Synchronisation

**Distributed Systems — Formative Assessment 1**

A system that lets musicians on separate machines play together over a network,
and stays musically coherent even when the links between them have different
delays.

---

## The problem

Put two musicians on separate laptops and have them play together. Each one
hears their own instrument instantly and the other person's late. If a third
joins on a slower link, every player now hears a *different* arrangement of the
same music. Everyone tries to correct for what they hear, and the ensemble
falls apart.

The naive framing is "make the network faster". That is the wrong target, and
it is not achievable anyway. The real observation is this:

> What destroys an ensemble is not delay. It is **disagreement** about delay.

An orchestra sitting twenty metres from the conductor is about 60 ms late and
perfectly comfortable, because *everyone is late by the same amount*. So this
project does not try to remove delay. It makes everyone equally late, on
purpose, and thereby restores a single shared version of the truth.

---

## Running it

Requires Node.js 18 or newer. Nothing else — no broker to install, no proxy to
configure, and it works with no internet connection.

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:8080**.

### Or with Docker

Runs the same system with a **real Mosquitto broker** in its own container
instead of the embedded one. No peer can tell the difference — which is the
demonstration.

```bash
docker compose up --build
```

> Not verified on this machine — Docker was not installed when these files
> were written, so the compose file and Dockerfile are unrun. `npm start` is
> the tested path.

**One machine, two peers:** open the page in two browser tabs. Create a session
in the first, copy its Session ID into the second, press Join.

**Two laptops on the same Wi-Fi:** run the server on one of them, find its LAN
address with `ipconfig` (something like `192.168.1.7`), and open
`http://192.168.1.7:8080` on both. Everything — the client, the RPC gateway
and the MQTT broker — is served from that one address.

> Audio only starts after you click, because browsers refuse to produce sound
> without a user gesture. This is why the AudioContext is created inside the
> Join handler and not on page load.

---

## Architecture

Two planes, deliberately separated.

```
                    ┌──────────────────────────────────────┐
                    │           SESSION SERVER             │
                    │                                      │
   gRPC ───────────►│  SessionService     :50051  (HTTP/2) │
   (join, tempo,    │  JSON→gRPC gateway  :8080            │
    transport,      │  MQTT broker        :1883 / :9001    │
    clock, beats)   │                                      │
                    │  Holds: roster, tempo, timeline       │
                    │         anchor, timing master        │
                    └───────┬──────────────────────┬───────┘
                            │  CONTROL PLANE       │
                    signalling, roster, tempo, telemetry
                            │                      │
                    ┌───────▼───────┐      ┌───────▼───────┐
                    │    PEER A     │      │    PEER B     │
                    │               │◄────►│               │
                    │ WebRTC audio  │ DATA │ WebRTC audio  │
                    │ DataChannel   │PLANE │ DataChannel   │
                    │ Web Audio mix │      │ Web Audio mix │
                    └───────────────┘      └───────────────┘
                       audio never touches the server
```

The server bootstraps the mesh and then gets out of the way. Once the WebRTC
handshake completes, audio flows directly between peers and the server is no
longer in the media path — which is the entire point, since routing audio
through a central mixer would add a full extra hop of delay to every note.

### Why each piece is where it is

| Concern | Mechanism | Why not the other one |
|---|---|---|
| "Let me in, and tell me who's here" | **gRPC** (request/reply) | The caller needs *this* answer *now*. Pub/sub gives no reply. |
| "Tempo is now 140" | **MQTT** (pub/sub, retained) | One-to-many, and late joiners must learn it. An RPC would need the publisher to know every recipient. |
| WebRTC offer/answer/ICE | **MQTT** | Signalling is just message relay. Peers cannot talk directly until it completes, so something already-connected must carry it. |
| Audio | **WebRTC media** | Continuous, unreliable, latency-critical. Retransmitting late audio makes things worse. |
| Note events, RTT probes | **WebRTC DataChannel** | Tiny and urgent. Unreliable + unordered on purpose. |
| "What time is it?" | **gRPC** (Cristian) | Needs a precise round trip against one authority. |

---

## How the four hard parts work

### 1. Clock synchronisation — Cristian's algorithm

Two laptops' `Date.now()` values differ, and drift. Any plan expressed as
"play at 14:23:07.412" is therefore meaningless across machines.

Each node measures its offset from the server clock:

```
T0 = local time before the request
T1 = local time after the reply
Ts = server clock, read while handling it

offset = Ts + (T1 - T0)/2 - T1
```

We take eight samples and **keep the one with the smallest round trip**, rather
than averaging. A fast round trip has less room to hide asymmetry; averaging
would let one delayed sample poison the estimate. NTP uses the same filter.

*Known limitation:* the `RTT/2` term assumes the outbound and return legs take
equally long. On an asymmetric path that is false, and we cannot detect it from
one endpoint. This is the dominant error source in the whole system, and it is
also why the impairment emulator applies delay at **both** ends of a link —
a one-sided impairment would silently break the assumption.

→ `web/clock.js`

### 2. The shared timeline — an anchor, not a tick stream

The timeline is a **formula**, not a stream of tick messages. The server
publishes `(anchor_beat, anchor_time, bpm)` and every node computes every beat
locally:

```
beat(t)      = anchor_beat + (t - anchor_time) × bpm / 60000
time(beat n) = anchor_time + (n - anchor_beat) × 60000 / bpm
```

where `t` is on the **server** clock, which Cristian's algorithm maps onto the
local clock.

Two consequences worth stating at the evaluation:

- **Nothing has to arrive on time for the music to stay in time.** A tick
  stream would put the network in the critical path of every single beat. An
  anchor puts it there only when the tempo changes. If the network stalls for
  two seconds, every node keeps producing correct beats from the anchor it
  already holds.
- **It is why losing the timing master costs nothing.** The master's only job
  is publishing anchors. Once an anchor is out, it is not needed again until
  somebody changes tempo.

Events are named by **beat position**, never wall-clock time. "This note landed
on beat 34.5" means the same thing on every machine.

Beats are scheduled with a 25 ms look-ahead loop that hands the audio hardware
everything due in the next 150 ms, each with an exact timestamp. `setTimeout`
is accurate to maybe 5–15 ms — far too sloppy when 10 ms is audible — but the
Web Audio clock is sample-accurate. JavaScript queues; the audio thread times.

→ `web/timeline.js`

### 3. Latency compensation — the core of the project

Let `d_j` be the one-way delay from peer *j*, and

```
D = max over ALL links in the session of d_j
```

`D` is the **common deadline**: the ensemble's worst link. Then at every node:

```
delay on my OWN monitoring    = D
delay on audio FROM peer j    = D − d_j
```

Peer *j*'s sound already spent `d_j` in flight, so we hold it a further
`D − d_j`. My own sound never travelled, so it waits the full `D`. Every sound
produced on beat *B* is then heard by **every** listener — including the player
who produced it — at exactly `t(B) + D`.

One deadline. Everyone hears the same arrangement.

Crucially, `D` must be **identical on every node**, or they align to different
deadlines and the scheme collapses. Each node can only measure its own links,
so every node publishes its measurements on
`session/{id}/telemetry/{peer}` and each takes the max over the union.

**The trade:** nobody hears themselves instantly any more. That is a real cost
and it feels strange to play through. We pay it because a uniform delay is
something musicians adapt to and an inconsistent one is not.

**The limit:** `D` is a hard latency floor set by the worst link in the
session. Past roughly 25–30 ms players begin to struggle regardless of how
consistent the delay is; past ~50 ms most music is unplayable. Compensation
buys **agreement, not speed** — it makes a marginal network usable and cannot
rescue a bad one.

→ `web/audio.js`

### 4. Fault tolerance

- **Failure detection** is crash-stop with a timeout: peers heartbeat over gRPC
  every 2 s, and the server evicts anyone silent for 6 s. This is necessarily
  imperfect — in an asynchronous network a slow peer is indistinguishable from
  a dead one — so we accept false positives and let peers rejoin.
- **Master succession** is deterministic: the longest-serving survivor. Every
  node could compute the same answer from the same roster, so there is nothing
  to disagree about and no election messages are needed.
- **The session survives the master's death** because of the anchor design
  above. Kill the master mid-performance and the beat keeps advancing.
- **The session survives the server's death** too, once established: the mesh
  is direct, so audio and note events continue. What stops working is joining,
  tempo changes, and re-synchronisation.

*Honest limit:* this is failover, not consensus. A network partition could
leave two halves each promoting their own master — split brain. Proper leader
election is FA-2 work.

→ `server/registry.js`

---

## Demo script

1. **Two peers join.** Show the roster appearing on both screens. Point out
   the participant list arrived over MQTT while the join itself was gRPC.
2. **Press Start.** Both metronomes lock together — the shared timeline.
3. **Arm both tracks.** Each node plays its own pitch; you hear an ensemble.
4. **Break it.** Drag one peer's impairment slider to 150 ms with
   **compensation OFF**. The ensemble audibly falls apart. Show RTT rising on
   the dashboard in real time.
5. **Fix it.** Turn compensation **ON**. It re-locks. Show `D` on screen and
   the applied `D − d_j` per peer.
6. **Change tempo** from the *other* laptop. Both metronomes shift — MQTT
   fan-out.
7. **Kill the timing master** (close its tab without leaving cleanly). After
   ~6 s the survivor is promoted, and the beat never stops. Explain why:
   the timeline is an anchor formula, not a tick stream.
8. **Show the dashboard**: per-peer RTT, one-way delay, jitter, loss, injected
   delay, applied compensation, clock offset and uncertainty.
9. **Show the happened-before panel.** On a sub-millisecond link the relation
   *flickers* between `mine → theirs` and `CONCURRENT ‖` — measured over 50
   samples it came out 29 ordered / 21 concurrent. That flicker is the
   demonstration: whether one peer's note arrives before the other schedules
   its own is a genuine race, so the causal ordering is a property of the
   *timing*, not of the music. Now inject 150 ms — it locks to `CONCURRENT ‖`
   (59/59 samples), because neither peer can possibly have heard the other
   before playing. **The causal structure of the computation is determined by
   the network**, and you can show it changing live.
10. **Show the naming panel.** Same peer, three different things: a *name*
    that is human-readable and changeable, an *identifier* that is unique and
    immutable, and an *address* that can change underneath it. Note that
    Chrome redacts host IPs and substitutes an mDNS `.local` name — a naming
    problem inside the addressing layer.

### Proving the RPC layer is real gRPC

The browser reaches the service through a JSON transcoding gateway (browsers
cannot speak gRPC — it needs HTTP/2 trailers, which no browser exposes to
JavaScript; this is the same reason Envoy's `grpc_json_transcoder` and grpc-web
exist). The service underneath is genuine gRPC, and you can hit it directly:

```bash
grpcurl -plaintext -import-path proto -proto session.proto -d "{\"displayName\":\"Jam\",\"bpm\":120}" localhost:50051 ensemble.SessionService/CreateSession
```

### Watching the MQTT traffic

```bash
mosquitto_sub -h localhost -t "session/#" -v
```

---

## Syllabus mapping

| Concept | Where |
|---|---|
| **Unit 1** — Types of distributed systems | Hybrid: centralised control plane + decentralised P2P data plane |
| Architectures | `docs/ARCHITECTURE.md`; client-server for control, full mesh for media |
| Design issues | Transparency, scalability (O(n²) mesh — stated, not hidden), openness, fault tolerance |
| Middleware | gRPC and MQTT *are* the middleware layer |
| Distributed multimedia systems | Real-time audio with QoS constraints — the whole project |
| *Self-study:* Model of Distributed Computations | Events, local histories, happened-before, concurrency — `web/events.js`, live panel in the UI |
| *Self-study:* Role of Virtualization | `Dockerfile`, `docker-compose.yml` — containerised server + real Mosquitto |
| **Unit 2** — Fundamentals of communication | Two planes, chosen per traffic type |
| Remote Procedure Call | `proto/session.proto`, `server/index.js`, `web/rpc.js` |
| Message-Oriented Communication | MQTT, QoS 1, retained messages — `web/bus.js` |
| Stream-Oriented Communication | WebRTC media tracks, jitter, playout buffering — `web/audio.js` |
| P2P messaging | Full mesh + DataChannel — `web/mesh.js` |
| WebRTC | Offer/answer/ICE relayed over MQTT — `web/mesh.js` |
| *Self-study:* Names, identifiers, addresses | Live panel resolving each peer's name → identifier → ICE address — `web/mesh.js` `address()` |
| *Self-study:* Fault tolerance | Heartbeats, crash-stop detection, master succession |

---

## Files

```
proto/session.proto      the RPC contract
server/index.js          gRPC server + JSON gateway + MQTT broker + static
server/registry.js       session state, failure detection, master succession
web/rpc.js               gRPC client stub
web/bus.js               MQTT pub/sub wrapper
web/clock.js             Cristian's algorithm
web/timeline.js          beat maths + look-ahead scheduler
web/audio.js             Web Audio graph + latency compensation
web/mesh.js              WebRTC full mesh, signalling, RTT, address resolution
web/events.js            event model: happened-before, Lamport + vector clocks
web/app.js               wiring + dashboard
mosquitto/mosquitto.conf optional external broker config (local)
mosquitto/*.docker.conf  same, with container paths
Dockerfile               containerised session server
docker-compose.yml       server + real Mosquitto, two containers
docs/ARCHITECTURE.md     design decisions, limitations, viva preparation
```

`window.ensemble` is exposed in the browser console (`state`, `clock`,
`timeline`, `audio`, `mesh`) — useful if an examiner asks to see a raw number.

---

## Known limitations

Stated deliberately: every one of these is a design trade rather than an
oversight, and being able to explain them is worth more than pretending they
do not exist.

1. **Full mesh is O(n²).** Practical to about 5 peers. An SFU would scale
   further but would add a hop of delay, defeating the purpose.
2. **`RTT/2` assumes a symmetric path.** Not always true, undetectable from one
   endpoint, and the largest error source in the compensation figure.
3. **The impairment emulator has a measurement bias.** Audio delay uses a
   sample-accurate `DelayNode`; control-path delay uses `setTimeout`, which
   overshoots by a few ms per hop. So measured `D` reads slightly *high*.
   Over-estimating is the safe direction — compensation clamps at zero and
   everyone simply waits a hair longer.
4. **Failover is not consensus.** A partition could produce split brain.
5. **No authentication.** Any client can join any session or publish any
   topic. A real deployment needs per-peer credentials and topic ACLs.
6. **Jitter is not fully absorbed.** `D` is a fixed delay; a link whose delay
   *varies* needs an adaptive buffer, which trades latency for smoothness.
