# Distributed Systems — All the Theory, in Plain Words

Every topic from Units 1–4. Each one has:
**What it is** → **How it works** → **Example** → **In my project** → **One line for the exam**.

Read it top to bottom once. Then revise using only the "Exam line" at the end of each topic.

---

# UNIT 1 — Introduction to Distributed Systems

## 1.1 Definition

**What it is:** A distributed system is *many independent computers that work together and look to the user like one single system.* (Tanenbaum's definition.)

Two key ideas:
- The computers are **independent**: each has its own CPU, memory and clock.
- They cooperate by **sending messages over a network** — there is no shared memory.

**Example:** Google Search is thousands of machines, but you see one search box.

**In my project:** Two or three laptops plus a server behave as **one music band**.

**Exam line:** "A distributed system is a collection of autonomous computers, connected by a network, that appears to its users as a single coherent system."

---

## 1.2 Goals of a distributed system

There are four classic goals:

1. **Resource sharing** — let users share data, files, printers, computing power.
2. **Transparency** — *hide* the fact that the system is distributed. Types of transparency:
   | Type | Hides… |
   |---|---|
   | Access | how data is accessed (local vs remote looks the same) |
   | Location | where a resource physically is |
   | Migration / Relocation | that a resource moved |
   | Replication | that there are several copies |
   | Concurrency | that others are using it at the same time |
   | Failure | that something failed and recovered |
3. **Openness** — use standard interfaces so parts from different vendors can work together and be replaced.
4. **Scalability** — keep working well as the system grows. Three kinds: **size** (more users), **geographic** (users far apart), **administrative** (many organisations).

**In my project:**
- Transparency: an RPC call looks like a normal function call.
- Openness: the MQTT broker can be swapped (Aedes ↔ Mosquitto) and nothing notices.
- Scalability: honestly limited — the peer mesh grows as n², so it works up to ~5 people.

**Exam line:** "The goals are resource sharing, transparency, openness and scalability."

---

## 1.3 Types of distributed systems

1. **Distributed computing systems** — for heavy computation.
   - *Cluster:* identical machines in one room (a supercomputer).
   - *Grid:* different machines from different organisations.
   - *Cloud:* rented computing on demand (AWS, Azure).
2. **Distributed information systems** — for business data.
   - Transaction processing (banks), enterprise application integration.
3. **Distributed pervasive systems** — small devices everywhere.
   - Mobile systems, sensor networks, smart homes.

**In my project:** A **hybrid real-time multimedia system** — centralised control (server) + decentralised data (peer-to-peer audio).

**Exam line:** "Computing systems, information systems, and pervasive systems."

---

## 1.4 Architectures

**Architectural styles** (how software parts are organised):
- **Layered** — each layer uses the one below (like the network stack).
- **Object-based** — objects call each other's methods remotely.
- **Resource-based (REST)** — everything is a resource with a URL.
- **Event-based / publish-subscribe** — parts send events; whoever is interested receives them.

**System architectures** (where those parts run):
- **Centralised / client-server** — clients ask, a server answers.
- **Decentralised / peer-to-peer (P2P)** — every node is equal, both client and server.
  - *Structured P2P:* nodes organised by a rule (e.g. a DHT like Chord).
  - *Unstructured P2P:* nodes connect randomly; search by flooding.
- **Hybrid** — a mix (e.g. BitTorrent: a tracker server + P2P downloading).

**In my project:** All three together:
- **Client-server** → gRPC (join, tempo).
- **Publish-subscribe** → MQTT (broadcasting tempo, roster).
- **Peer-to-peer** → WebRTC (audio goes laptop-to-laptop).

**Exam line:** "Mine is a hybrid architecture: client-server for control, publish-subscribe for events, and peer-to-peer for media."

---

## 1.5 Design issues (challenges)

Things you must think about when building any distributed system:

| Issue | Meaning | In my project |
|---|---|---|
| **Heterogeneity** | different hardware, OS, languages | different laptops, browsers |
| **Openness** | can it be extended / parts swapped? | broker is swappable |
| **Security** | confidentiality, integrity, authentication | none — stated as a limitation |
| **Scalability** | works when it grows? | mesh is O(n²), ~5 peers |
| **Failure handling** | detect, mask, recover from failures | heartbeats, election |
| **Concurrency** | many users at once | simultaneous notes, mutex |
| **Transparency** | hide distribution | RPC looks local |
| **Quality of Service** | timing, reliability guarantees | latency & jitter for audio |

There are also the famous **8 fallacies** (wrong assumptions) of distributed computing: the network is reliable, latency is zero, bandwidth is infinite, the network is secure, topology doesn't change, there is one administrator, transport cost is zero, the network is homogeneous. My whole project exists because **latency is not zero**.

**Exam line:** "Heterogeneity, openness, security, scalability, failure handling, concurrency, transparency and QoS."

---

## 1.6 Middleware

**What it is:** Software that sits **between the application and the operating system/network**. It hides the messy networking details and gives the app simple services.

```
   Application
   ─────────────
   MIDDLEWARE      ← RPC, message queues, pub-sub, CORBA, RMI
   ─────────────
   OS + Network
```

**Examples:** RPC systems (gRPC), message brokers (MQTT, RabbitMQ, Kafka), CORBA, Java RMI.

**In my project:** **gRPC, MQTT and WebRTC are my middleware.** My app code never opens raw sockets.

**Exam line:** "Middleware is a software layer between applications and the OS that hides heterogeneity and distribution."

---

## 1.7 Distributed multimedia systems

**What it is:** Systems that send **continuous media** — audio and video — between computers in real time. (Video calls, live streaming, online music.)

Why it's hard: normal data (a file) can arrive late and still be correct. **Audio that arrives late is useless.** So we care about **Quality of Service (QoS)**:

| QoS parameter | Meaning |
|---|---|
| **Bandwidth** | how much data per second |
| **Latency (delay)** | how long a packet takes to arrive |
| **Jitter** | how much the delay *varies* — the enemy of smooth audio |
| **Loss** | how many packets are lost |

Key techniques:
- **Playout (jitter) buffer** — hold packets briefly so they can be played at a steady rate.
- **Synchronisation** — *intra-stream* (keep one stream's timing smooth) and *inter-stream* (keep several streams in step, like lip-sync between video and audio).

**In my project:** This **is** the project. The latency-compensation algorithm is **inter-stream synchronisation**: every musician's audio is delayed so all arrive at the same common deadline D.

**Exam line:** "Multimedia systems carry continuous media with strict QoS — latency, jitter, loss — and need stream synchronisation."

---

## 1.8 Self-study: Model of distributed computations

**What it is:** A simple mathematical way to describe what happens in a distributed system.

- A **process** = one running program (one laptop).
- Each process does **events**. Three kinds:
  - **internal** event (does something locally),
  - **send** event (sends a message),
  - **receive** event (receives a message).
- The **local history** = the list of events in one process, in order.
- There is **no global clock**, so we can't say exactly when everything happened.

The **happened-before** relation (→), defined by Lamport:
1. If a and b are in the same process and a came first → **a → b**.
2. If a = send(m) and b = receive(m) → **a → b**.
3. If a → b and b → c → **a → c** (transitive).

If neither a → b nor b → a, then a and b are **concurrent** (a ‖ b) — neither could have affected the other.

**Example:** Ana and Ben both play a note at the same moment on different laptops. Neither heard the other first, so the two notes are **concurrent**.

**In my project:** The happened-before panel shows events and whether two notes are ordered or **CONCURRENT ‖**.

**Exam line:** "A distributed computation is a partial order of events defined by happened-before; events not ordered are concurrent."

---

## 1.9 Self-study: Role of virtualization

**What it is:** Running a "fake" computer (or isolated environment) on top of a real one.

Two types:
- **Virtual machines (VMs)** — a **hypervisor** runs full operating systems side by side. Heavy but very isolated.
  - Type 1 hypervisor runs on bare hardware (VMware ESXi). Type 2 runs inside an OS (VirtualBox).
- **Containers** (Docker) — share the host's OS kernel, isolate only the app. Light and fast.

Why distributed systems use it:
- **Isolation** — one service can't break another.
- **Portability / reproducibility** — runs the same everywhere.
- **Easy scaling & migration** — start more copies, move them between machines.
- **Consolidation** — many services on one physical server (cloud computing relies on this).

**In my project:** The server runs in a **Docker container**, and a real Mosquitto broker runs in another (`docker-compose.yml`).

**Exam line:** "Virtualization gives isolation, portability and easy scaling; containers are lighter than VMs because they share the OS kernel."

---

# UNIT 2 — Communication

## 2.1 Fundamentals of communication

Computers communicate using **protocols** arranged in **layers** (OSI model: physical, data link, network, transport, session, presentation, application). Each layer uses the one below.

Important transport protocols:
- **TCP** — reliable, ordered, connection-based (slow to recover from loss).
- **UDP** — unreliable, unordered, fast (good for real-time audio).

**Types of communication** (very common exam question):

| | Meaning | Example |
|---|---|---|
| **Persistent** | message is **stored** until the receiver gets it (receiver can be offline) | email, message queue |
| **Transient** | message is **lost** if the receiver isn't running right now | a phone call, plain RPC |
| **Synchronous** | sender **waits** (blocks) for a response | RPC |
| **Asynchronous** | sender **continues** immediately | publish to a queue |

**In my project:**
- gRPC = **synchronous + transient**.
- MQTT with retained messages = **asynchronous + persistent**.
- Audio = unreliable on purpose (like UDP).

**Exam line:** "Communication can be persistent or transient, and synchronous or asynchronous."

---

## 2.2 Remote Procedure Call (RPC)

**What it is:** Calling a function **on another computer** as if it were a normal local function.

**How it works (the steps):**
```
Client program  →  calls  addUser("Ana")          (looks local!)
Client STUB     →  packs arguments into a message  (MARSHALLING)
Network         →  sends the message
Server STUB     →  unpacks the arguments          (UNMARSHALLING)
Server          →  runs the real function
…the result travels back the same way
```

Key terms:
- **Stub** — auto-generated code that does the packing/unpacking.
- **Marshalling** — turning arguments into bytes to send.
- **IDL (Interface Definition Language)** — a file that describes the functions, so stubs can be generated for any language.
- **Binding** — how the client finds the server.

**Failure semantics** (what happens if the network fails?):
- *At-least-once* — retry until success (may run twice).
- *At-most-once* — never runs twice (may not run at all).
- *Exactly-once* — ideal, but generally impossible to guarantee.

**Where transparency leaks:** a local call can't fail because the network broke — a remote one can.

**In my project:** **gRPC**. The IDL is `proto/session.proto`. Functions: JoinSession, SetTempo, Heartbeat, GetServerTime, GetLedger. Browsers can't speak gRPC directly, so a **gateway** converts JSON → gRPC.

**Exam line:** "RPC makes a remote call look local, using stubs that marshal parameters, generated from an IDL."

---

## 2.3 Message-Oriented Communication (MOM)

**What it is:** Instead of calling a function and waiting, you **send a message** to a middleman (a **broker** or **queue**) and carry on. Receivers get it whenever they're ready.

Two patterns:
- **Message queue** — point-to-point; one sender, one receiver takes each message.
- **Publish-subscribe (pub-sub)** — senders **publish** to a **topic**; everyone **subscribed** to that topic gets a copy.

Why it's useful — **decoupling** in three ways:
- **Space** — sender doesn't know who receives.
- **Time** — receiver doesn't have to be online at the same time.
- **Flow** — nobody waits for anybody.

**MQTT** (the protocol I use):
- Topics like `session/abc/tempo`, with wildcards `+` (one level) and `#` (everything below).
- **QoS levels:** 0 = at most once (may lose), 1 = at least once (may duplicate), 2 = exactly once.
- **Retained message** — the broker keeps the last message on a topic and gives it to anyone who subscribes later.

**In my project:** MQTT carries the roster, tempo, start/stop, WebRTC signalling and telemetry. Tempo is **retained** so a late joiner instantly knows the tempo. Control uses **QoS 1**, telemetry **QoS 0**.

**Exam line:** "MOM decouples sender and receiver in space, time and flow; pub-sub delivers each message to all subscribers of a topic."

---

## 2.4 Stream-Oriented Communication

**What it is:** Sending **continuous data** (audio/video) where **timing matters**, not just correctness.

**Transmission modes:**
| Mode | Guarantee |
|---|---|
| Asynchronous | data arrives in order, no timing guarantee |
| Synchronous | there is a **maximum** delay |
| **Isochronous** | both **maximum and minimum** delay — i.e. steady timing (needed for audio/video) |

**QoS for streams:** bit rate, maximum delay, maximum jitter, maximum loss.

**Techniques:**
- **Buffering** at the receiver to smooth jitter.
- **Forward error correction / interleaving** to survive lost packets.
- **Stream synchronisation** — keep multiple streams aligned (lip-sync).

**In my project:** Audio streams over WebRTC. I measure the **jitter buffer delay** and include it in the compensation, and the latency-compensation algorithm is stream synchronisation across all musicians.

**Exam line:** "Continuous media need isochronous transmission — bounded minimum and maximum delay — plus buffering and stream synchronisation."

---

## 2.5 Peer-to-Peer (P2P) Messaging

**What it is:** Computers talk **directly to each other** with no central server in the middle. Every node is both client and server.

- **Unstructured P2P** — random connections, find things by **flooding** (asking everyone).
- **Structured P2P** — organised by a rule, e.g. a **DHT (Distributed Hash Table)** like Chord, so lookup takes O(log n) steps.
- **Super-peers** — some stronger peers act as mini-servers.

Advantages: no single point of failure, no server bottleneck, lower delay.
Disadvantages: harder to manage, NAT/firewall problems, security.

**In my project:** A **full mesh** — every laptop connects directly to every other one. Audio never touches the server (that would add an extra hop of delay). Number of connections = n(n−1)/2, so it's practical for about 5 peers.

**Exam line:** "In P2P every node is equal and communicates directly; my full mesh removes the server from the media path."

---

## 2.6 WebRTC

**What it is:** **Web Real-Time Communication** — a browser technology for **direct peer-to-peer audio, video and data**.

Three main parts:
- **getUserMedia** — access microphone/camera.
- **RTCPeerConnection** — the connection to another peer (carries audio/video).
- **RTCDataChannel** — sends any data peer-to-peer.

**How two browsers connect:**
1. **Signalling** — they must exchange connection info first. WebRTC does **not** define how; you use any channel (I use MQTT).
2. **SDP offer/answer** — Peer A sends an *offer* (what codecs, what media); Peer B replies with an *answer*.
3. **ICE (Interactive Connectivity Establishment)** — find a network path. Candidate types:
   - **host** — the computer's own local IP.
   - **srflx** (server reflexive) — public IP discovered through a **STUN** server.
   - **relay** — goes through a **TURN** server when direct connection is impossible.
4. Connection opens; everything is **encrypted** (DTLS/SRTP).

**Glare** — if both peers send an offer at the same time, they deadlock. I avoid it: **the newcomer always sends the offer**.

**In my project:** Audio tracks + **two data channels**: one unreliable/unordered (notes — late notes are useless), one reliable/ordered (Unit 3 algorithms).

**Exam line:** "WebRTC gives browser P2P media; peers exchange SDP offer/answer via signalling and find a path with ICE using STUN and TURN."

---

## 2.7 Self-study: Names, Identifiers and Addresses

Three different things:

| | What it is | Example | Properties |
|---|---|---|---|
| **Name** | human-friendly label | "Ana", `google.com` | can repeat, can change |
| **Identifier** | unique label for exactly one thing | `peer-3-x7k2` | unique, never changes, never reused |
| **Address** | where it can be reached right now | `192.168.0.5:5000` | can change |

**Name resolution** = turning a name into an address.
- **Flat naming** (just an ID): broadcasting, forwarding pointers, home-based approach, DHT.
- **Structured naming**: a hierarchy like **DNS** (`www.example.com`). Resolution can be *iterative* (client asks each server) or *recursive* (server asks for you).
- **Attribute-based naming**: find by properties (LDAP directories).

**In my project:** A live panel shows all three for each peer. Everything routes by **identifier**, never by address — so if a laptop switches Wi-Fi, it's still the same peer. Chrome hides IPs behind `.local` names (mDNS) — a naming problem inside addressing.

**Exam line:** "A name is for humans, an identifier uniquely and permanently names one entity, and an address is where it can currently be reached."

---

## 2.8 Self-study: Fault Tolerance

**Basic terms:**
- **Fault** → the cause (a bug, a cut cable).
- **Error** → wrong state caused by the fault.
- **Failure** → the system doesn't do what it should.

**Dependability** has four parts: **availability** (ready right now), **reliability** (runs without failing over time), **safety** (failures don't cause disaster), **maintainability** (easy to repair).

**Fault types:** transient (once), intermittent (comes and goes), permanent.

**Failure models** (from easiest to hardest):
| Model | What goes wrong |
|---|---|
| Crash | the process stops |
| Omission | messages are lost |
| Timing | response too slow |
| Response | wrong answer |
| **Byzantine (arbitrary)** | anything, even lying |

**Redundancy** is the main tool: *information* (extra bits, checksums), *time* (retry), *physical* (extra hardware, e.g. **TMR** — triple modular redundancy with voting).

To survive **k** faulty processes: **k+1** if they just crash, **2k+1** if they can lie (Byzantine, with voting) — and **3k+1** for Byzantine agreement.

**Failure detection:** send **heartbeats**; if none arrives within a **timeout**, suspect a crash. In an asynchronous network a slow process looks the same as a dead one, so detection can be wrong.

**In my project:** heartbeats every 2 s, eviction after 6 s (crash-stop), automatic master succession; if the server dies, audio keeps playing (**graceful degradation**). Unit 3 adds beacons and election.

**Exam line:** "Fault tolerance uses redundancy and failure detection; a slow process cannot be told apart from a crashed one in an asynchronous system."

---

# UNIT 3 — Synchronization

## 3.1 Why we need clock synchronization

Every computer has its own clock (a quartz crystal). Clocks are never perfect:
- **Clock skew** = the difference between two clocks right now.
- **Clock drift** = clocks run at slightly different speeds, so the difference grows over time.

Example: `make` decides what to recompile by comparing file times. If two machines' clocks disagree, it can make the wrong choice. In my project, if laptops disagree on the time, they play beat 1 at different moments.

Two solutions:
- **Physical clock sync** — make the actual times agree (Cristian, Berkeley, NTP).
- **Logical clocks** — forget real time; just agree on the **order** of events (Lamport, vector).

---

## 3.2 Cristian's algorithm (physical clock sync)

**Idea:** Ask a **time server** what time it is, and correct for the travel time.

**Steps:**
```
1. Client notes its time T0, sends "what time is it?"
2. Server replies with its time Ts
3. Client receives at its time T1
4. Round-trip time  RTT = T1 − T0
5. Server time NOW ≈ Ts + RTT/2
```
Offset to apply = `Ts + RTT/2 − T1`.

**Why RTT/2?** We assume the message took the same time going and coming back.
**Weakness:** if the path is not symmetric, there's an error we can't detect.
**Improvement:** take several samples and use the one with the **smallest RTT** (least room for error).

**Example:** T0 = 100, T1 = 120 (RTT = 20), Ts = 500 → true time ≈ 500 + 10 = 510. The client thinks it's 120, so its offset is +390.

**In my project:** Each laptop does this with the server, 8 times, keeping the fastest round trip (`web/clock.js`).

**Exam line:** "Cristian's algorithm sets the time to Ts + RTT/2, assuming symmetric delay; it needs a single time server."

---

## 3.3 Berkeley algorithm (physical clock sync)

**Idea:** No machine has the "correct" time — so **average** them.

**Steps:**
1. A **master** (time daemon) asks every machine for its time.
2. It computes the **average** (ignoring outliers, and correcting for travel time).
3. It tells every machine **how much to adjust** (+5, −3, …), not the absolute time.

Used when there is no accurate time source (no UTC receiver). Everyone agrees, even if they're all slightly wrong.

**Exam line:** "Berkeley polls all clocks, averages them, and sends each machine an adjustment — agreement, not accuracy."

---

## 3.4 NTP — Network Time Protocol

Used on the real internet. Servers are arranged in **strata**:
- **Stratum 0** = atomic clock / GPS.
- **Stratum 1** = servers directly connected to it.
- **Stratum 2** = sync from stratum 1, and so on.

Uses four timestamps (T1 send, T2 server receive, T3 server send, T4 client receive):
- Offset θ = ((T2 − T1) + (T3 − T4)) / 2
- Delay δ = (T4 − T1) − (T3 − T2)

Picks the sample with the smallest delay (same trick as my Cristian implementation).

**Rule for all clock sync:** never make a clock jump **backwards** — slow it down gradually instead.

---

## 3.5 Logical clocks & Lamport's algorithm

**Idea (Lamport, 1978):** We often don't need the real time — only the **order** of events. So use counters instead of clocks.

**Rules — each process keeps a counter L:**
1. Before every event (internal or send): **L = L + 1**.
2. When sending a message, **attach L** to it.
3. When receiving a message with timestamp Lm: **L = max(L, Lm) + 1**.

**Example (two processes):**
```
P1:  a(1) ──send──┐          c(3)
                  ↓
P2:       b(1)   recv: max(1,1)+1 = 2    d(3)
```

**Guarantee:** if a → b then L(a) < L(b).
**But NOT the reverse:** L(a) < L(b) does **not** mean a happened before b — they might be concurrent. **Lamport clocks cannot detect concurrency.**

**Total order:** break ties using the process ID → (L, processID). Now every event has a unique position, which is used for things like **totally ordered multicast** and mutual exclusion.

**In my project:** Every note has a Lamport timestamp, and the mutual exclusion algorithm uses (Lamport time, peer id) to decide whose request is older.

**Exam line:** "Lamport clocks: increment on each event, take max+1 on receive. a→b implies L(a)<L(b), but not the converse."

---

## 3.6 Vector clocks (vector algorithm)

**Problem:** Lamport clocks can't tell if two events are concurrent.
**Solution:** Each process keeps a **vector** — one counter for **every** process.

**Rules — process i has vector V (size n):**
1. Before every event: **V[i] = V[i] + 1**.
2. When sending, attach the whole vector.
3. On receive with vector Vm: **V[k] = max(V[k], Vm[k]) for every k**, then **V[i] = V[i] + 1**.

**Comparing two vectors:**
- V(a) ≤ V(b) in **every** position (and not equal) → **a → b**.
- V(b) ≤ V(a) in every position → **b → a**.
- Otherwise (each is bigger somewhere) → **a ‖ b, concurrent**.

**Example:** a = [2,0] and b = [0,1] → a is bigger in position 1, b is bigger in position 2 → **concurrent**.

**Guarantee:** a → b **if and only if** V(a) < V(b). Vector clocks **can** detect concurrency.
**Cost:** each message carries n numbers instead of one.
**Used for:** **causally ordered multicast** (deliver a message only after everything that caused it).

**In my project:** The panel shows "CONCURRENT ‖" when two musicians play the same beat without hearing each other.

**Exam line:** "Vector clocks keep one counter per process; a→b if and only if V(a)<V(b), so they detect concurrency, at O(n) cost per message."

---

## 3.7 Global state & Chandy–Lamport snapshot

**What is global state?** The state of **all processes** plus **all messages currently travelling** in the network.

**Why it's hard:** There is no global clock — you can't freeze every computer at the same instant.

**Cut:** A line through the timeline of every process, saying "record state here".
- **Consistent cut:** if the cut includes receiving a message, it must also include sending it. (You can't have an effect without its cause.)
- **Inconsistent cut:** shows a message received that was never sent — impossible.

**Uses of global state:** detecting **deadlock**, detecting **termination**, **garbage collection**, **checkpointing** for recovery.

**Chandy–Lamport algorithm (1985).**
Assumption: channels are **FIFO** (messages arrive in the order sent) and **reliable** (no loss).

Uses a special message called a **MARKER**.

1. **Initiator:** records its own state, then sends a MARKER on **every** outgoing channel.
2. **When a process receives a MARKER for the first time:**
   - records its own state,
   - marks the channel the marker came on as **empty**,
   - sends MARKERs on all its outgoing channels,
   - starts **recording** messages arriving on all its other incoming channels.
3. **When it receives a MARKER on a channel it is recording:** stops recording that channel. The recorded messages = **that channel's state** (messages in transit).
4. Done when every process has received a marker on every incoming channel.

**Why FIFO is needed:** the marker separates "before the snapshot" from "after". If a later message overtook the marker, it would be recorded wrongly.

**Important:** The result is **consistent**, not **simultaneous** — it is a state the system *could* have been in.

**In my project:** The *Take global snapshot* button. It records each laptop's beat, tempo, Lamport clock, leader and mutex state, plus the messages in transit, and checks rules like "only one soloist" and "no deadlock". It runs on a special **reliable, ordered** channel because the algorithm needs FIFO.

**Exam line:** "Chandy–Lamport records a consistent global state using markers over FIFO channels; channel state is the messages received after recording local state and before the marker."

---

## 3.8 Election algorithms

**Why:** Many systems need one **coordinator** (leader). When it crashes, the others must choose a new one — and all must agree on who.

**Assumption:** every process has a unique **priority / ID**. The **highest live process** should win.

### Bully algorithm (Garcia-Molina)
1. Process P notices the coordinator is dead.
2. P sends **ELECTION** to every process with a **higher** ID.
3. If nobody answers → **P wins**, sends **COORDINATOR** to everyone.
4. If a higher process answers (**OK / ANSWER**) → P stops; that process takes over the election.
5. Any process receiving ELECTION from a lower one replies OK and starts its own election.

The biggest one always "bullies" its way to the top.
**Messages:** worst case **O(n²)** (when the lowest starts it); best case n−1.

### Ring algorithm
1. Processes are arranged in a logical **ring**.
2. The process that notices the failure sends an **ELECTION** message around the ring, containing its ID.
3. Each process **adds its own ID** and passes it on (skipping dead ones).
4. When the message comes back to the starter, the **highest ID in the list** is the coordinator.
5. A **COORDINATOR** message goes around the ring once more to tell everyone.

**Messages:** about 2n per election.

### Comparison
| | Bully | Ring |
|---|---|---|
| Messages | O(n²) worst | O(n) (~2n) |
| Speed | fast when the highest notices | always goes round the whole ring |
| Needs | everyone can contact everyone | a ring structure |

**Problem in real networks — split brain:** if the network splits into two halves, each half elects its own leader. Bully/Ring can't prevent this; you need a **majority quorum** (Raft, Paxos).

**In my project:** **Bully**, run peer-to-peer. Priority = **who joined first**. If you close the leader's tab, the others re-elect within ~6 s. If the server dies, the elected leader takes over tempo changes.

**Exam line:** "In Bully, a process sends ELECTION to higher IDs and wins if none answer; the highest live process always becomes coordinator."

---

## 3.9 Mutual exclusion algorithms

**Why:** When several processes want a shared resource (a file, a printer), only **one at a time** may use it. The protected code is the **critical section (CS)**.

**Requirements:**
- **Safety** — at most one process in the CS at a time.
- **Liveness** — no deadlock, no starvation (everyone eventually gets in).
- **Fairness** — requests are served in order.

### A. Centralized algorithm
A **coordinator** grants permission: REQUEST → GRANT → RELEASE.
- **3 messages** per entry. Simple and fair.
- Weakness: the coordinator is a **single point of failure** and a bottleneck.

### B. Lamport's mutual exclusion
Every process keeps a **queue** of requests ordered by Lamport timestamp.
1. To enter: broadcast REQUEST(ts) to everyone, add it to your own queue.
2. On receiving a REQUEST: add it to your queue, reply with REPLY.
3. Enter the CS when **your request is at the head of your queue** and you've received a message with a later timestamp from **everyone**.
4. On exit: broadcast RELEASE; everyone removes your request.
- **3(N−1) messages** per entry.

### C. Ricart–Agrawala (an improvement on Lamport's)
1. To enter: send REQUEST(timestamp, id) to **all** others.
2. On receiving a REQUEST, a process:
   - replies **OK immediately** if it is not interested;
   - **defers** (queues) the reply if it is **in** the CS;
   - if it also **wants** the CS, compares timestamps: the **older (smaller) request wins** — if its own is older it defers, otherwise it replies.
3. Enter the CS when you have an OK from **everyone**.
4. On exit: send all the deferred OKs.
- **2(N−1) messages** per entry (no RELEASE message needed).
- No deadlock, no starvation.
- Weakness: if **any** process crashes, nobody gets in (every process is a point of failure).

### D. Token ring algorithm
Processes in a logical ring pass a **token**; only the holder may enter the CS.
- 1 to ∞ messages per entry. Simple.
- Weakness: if the token is **lost**, it must be detected and regenerated.

### E. Maekawa's algorithm (quorum-based)
Each process asks only a **subset (quorum)** of about **√N** processes; any two quorums overlap.
- About **3√N messages**. Fewer messages, but it **can deadlock** without extra fixes.

### F. Suzuki–Kasami (token broadcast)
Broadcast a request for the token; the holder sends it. **N messages**, or 0 if you already hold the token.

### Comparison table
| Algorithm | Messages per entry | Problem |
|---|---|---|
| Centralized | 3 | single point of failure |
| Lamport | 3(N−1) | many messages |
| **Ricart–Agrawala** | **2(N−1)** | any crash blocks everyone |
| Token ring | 1 to ∞ | lost token |
| Maekawa | ~3√N | possible deadlock |
| Suzuki–Kasami | N or 0 | token management |

**In my project:** **Ricart–Agrawala** protects the "**solo floor**" — only one musician may solo at a time. The soloist plays an octave higher, so a violation would be **audible**.

**Exam line:** "Ricart–Agrawala: request everyone, enter after N−1 replies; defer replies if you're inside or your request is older; 2(N−1) messages."

---

## 3.10 Beacon protocol

**What it is:** A **beacon** is a small message a node **broadcasts periodically** to say "I'm here" (and often "here's my info / my time").

Uses:
- **Failure detection** — if a node's beacons stop for longer than a timeout, it is **suspected** to have failed.
- **Discovery** — new nodes learn who is around by hearing beacons.
- **Time sync in wireless networks** — in Wi-Fi (IEEE 802.11) the access point sends beacon frames containing a **timestamp**, and stations adjust their clocks to it. In wireless sensor networks, a reference node broadcasts a beacon and receivers sync to the moment they received it (Reference Broadcast Synchronization).

**Trade-off:** beacon more often → faster detection, but more traffic and more false alarms.

**Heartbeat vs beacon:** a heartbeat usually goes **to a central monitor**; beacons are **broadcast to everyone**, so each node decides for itself.

**In my project:** Every laptop sends a beacon to every other laptop **once per second**. After **3.5 s** of silence a peer is *suspected*, which triggers a Bully election.

**Exam line:** "Beacons are periodic broadcasts used for presence, failure detection and (in wireless) time synchronisation; missing beacons beyond a timeout make a node suspected."

---

## 3.11 Self-study: Lodha and Kshemkalyani's fair mutual exclusion

**What it is:** An improvement on Ricart–Agrawala (2000).

- Same basic idea: send a timestamped REQUEST to everyone; priority = (timestamp, id).
- **Fair** = requests are granted in **timestamp order** (the oldest request goes first).
- The improvement: when several processes request **at the same time** (concurrently), a process can treat the other requests it receives as **implicit permission**, so it doesn't need a separate REPLY from each of them. Each site keeps a **local request queue** of concurrent requests. On leaving the CS, a site sends a **FLUSH** message to the next site in priority order instead of replying to everyone.
- **Messages:** between **N−1** and **2(N−1)** per entry — fewer than RA when requests overlap.

**In my project:** I use Ricart–Agrawala; LK is compared in the docs. With 5 users RA costs at most 8 messages, so LK's extra complexity isn't worth it — it pays off in large groups with heavy contention.

**Exam line:** "LK is a fair, RA-based algorithm that uses concurrent requests as implicit replies, reducing messages to between N−1 and 2(N−1)."

---

## 3.12 Self-study: Deadlock & Knapp's classification

**Deadlock:** a group of processes each **waiting for another in the group**, so none can proceed.

**Wait-for graph (WFG):** draw an arrow P1 → P2 if P1 is waiting for P2. **A cycle in the graph = deadlock.**

In a distributed system, no single computer can see the whole graph — so detection needs messages. Danger: **phantom deadlock** — reporting a deadlock that doesn't really exist, because you saw parts of the graph at different times.

**Knapp's classification (1987) — four classes of distributed deadlock detection:**

| Class | How it works | Example algorithm |
|---|---|---|
| **1. Path-pushing** | nodes send their part of the WFG (paths) to each other until one sees a cycle | Obermarck |
| **2. Edge-chasing** | send a **probe** message along the wait-for edges; if it comes back to the sender → cycle → deadlock | Chandy–Misra–Haas (AND model) |
| **3. Diffusing computation** | a query spreads out through the graph; replies come back only if everything is blocked | Chandy–Misra–Haas (OR model) |
| **4. Global state detection** | take a **consistent snapshot**, then look for a cycle in it | Bracha–Toueg, Kshemkalyani–Singhal |

**In my project:** **Class 4 is implemented.** Each Chandy–Lamport snapshot builds the wait-for graph from the mutex waits and checks for a cycle. It never finds one — because Ricart–Agrawala **can't deadlock** (requests are totally ordered by timestamp, and a total order has no cycles).

**Exam line:** "Knapp's four classes are path-pushing, edge-chasing, diffusing computation and global-state detection; all search for cycles in a distributed wait-for graph."

---

# UNIT 4 — Emerging Distributed Paradigms

## 4.1 Distributed object-based systems

**What it is:** Extending object-oriented programming across the network — you call methods on an **object that lives on another computer**.

Key parts:
- **Interface / IDL** — describes the object's methods.
- **Proxy (stub)** — local object on the client that looks like the real one and forwards calls.
- **Skeleton** — on the server, receives calls and invokes the real object.
- **Object reference** — a handle that identifies a remote object (can be passed around).

**Examples:** **Java RMI**, **CORBA** (uses an ORB — Object Request Broker), DCOM.

Extra issues: object lifetime, passing objects by reference vs by value, **distributed garbage collection**.

**In my project:** Similar ideas — IDL = `session.proto`, proxy = `rpc.js`, object reference = **session ID**. But gRPC is **service-based**, not truly object-based (no remote objects, no distributed garbage collection).

**Exam line:** "Distributed object systems like RMI and CORBA use proxies, skeletons and object references to invoke methods on remote objects."

---

## 4.2 Distributed web-based systems

**What it is:** Distributed systems built on **web technology**: browsers, HTTP, web servers.

Key ideas:
- **HTTP** — request/response, **stateless** (each request is independent; state is kept with cookies, sessions, or on the server).
- **Multi-tier architecture** — browser (presentation) → web/app server (logic) → database (data).
- **Web services** — REST (resources + URLs), SOAP.
- **Scaling the web** — caching, **CDNs** (Content Delivery Networks), load balancers, replication.
- Modern additions — **WebSockets** (two-way connection), **WebRTC** (P2P).

**In my project:** The whole client is a web app. Browser limits shaped the design: no raw TCP → MQTT over **WebSockets**; no HTTP/2 trailers → a **gateway** in front of gRPC; P2P → **WebRTC**.

**Exam line:** "Web-based distributed systems use HTTP's stateless request/response model, multi-tier servers, and scale with caching, CDNs and replication."

---

## 4.3 Distributed file systems (DFS)

**What it is:** A file system where files are stored on **many machines** but look like **one file system** to users.

Goals: transparency, performance, fault tolerance (replication), consistency.

**Examples:**
- **NFS (Network File System)** — a remote disk that looks local; client sends operations to the server (remote access model).
- **AFS (Andrew File System)** — the client **caches whole files**; the server sends **callbacks** when a file changes (upload/download model).
- **HDFS (Hadoop Distributed File System)** —
  - **NameNode** = master, stores **metadata** (which blocks make up which file and where they are).
  - **DataNodes** = store the actual **blocks** (128 MB each).
  - Each block is **replicated 3 times** on different machines.
  - Files are **write-once, read-many**.
  - **Data locality** — move computation to the data instead of moving data.
- Google File System (GFS) — the design HDFS is based on.

**In my project:** Not built — discussed. Recorded audio takes would fit HDFS: the server as NameNode, laptops as DataNodes.

**Exam line:** "A DFS makes files on many machines look like one file system; HDFS uses a NameNode for metadata and replicated blocks on DataNodes."

---

## 4.4 Serverless architectures

**What it is:** You write **functions**, and the cloud runs them **only when called**. You don't manage servers at all. Also called **FaaS (Function-as-a-Service)**.

**Key properties:**
- **Event-driven** — a function runs in response to an event (an HTTP request, a file upload).
- **Stateless** — the function remembers nothing between calls; state goes in a database.
- **Auto-scaling** — 0 to thousands of copies automatically.
- **Scale to zero** — no requests → no instances → no cost.
- **Pay per use** — billed per millisecond of execution.

**Cold start vs warm start:**
- **Cold start** — first call: the platform must load your code → slower.
- **Warm start** — the instance is reused → fast.

**Good for:** short, stateless, bursty jobs. **Bad for:** long-running processes, persistent connections, heavy state.

**Examples:** AWS Lambda, Cloudflare Workers, Azure Functions, Google Cloud Functions.

**In my project:** `functions/session-report.js` runs on a mini FaaS runtime. The first call shows **COLD**, the next **warm**, and after 60 s idle it **scales to zero**.

**Exam line:** "Serverless runs stateless functions on demand, auto-scaling to zero; the trade-off is cold-start latency."

---

## 4.5 Case study: AWS (Amazon Web Services)

The biggest cloud provider. Key services:
| Category | Service |
|---|---|
| Compute | **EC2** (virtual machines), **Lambda** (serverless) |
| Storage | **S3** (object storage), EBS (disks) |
| Database | **DynamoDB** (NoSQL), RDS (SQL) |
| Containers | **ECS**, **EKS** (Kubernetes) |
| Networking | VPC, **CloudFront** (CDN), Route 53 (DNS) |
| Messaging | SQS (queues), SNS (pub-sub), **IoT Core** (MQTT) |
| Big data | **EMR** (managed Hadoop) |

Concepts: **regions** and **availability zones** (separate data centres for fault tolerance), elasticity, pay-as-you-go.

**Mapping to my project:** API Gateway ≈ my gateway, Lambda ≈ my function, IoT Core ≈ my MQTT broker, EKS ≈ my Kubernetes, EMR ≈ my MapReduce.

**Exam line:** "AWS offers elastic compute, storage and managed services across regions and availability zones; nearly every part of my project has an AWS equivalent."

---

## 4.6 Case study: Cloudflare

A global **edge network** that sits in front of websites.
- **CDN** — caches content in data centres close to users.
- **Anycast** — the same IP address is served from many locations; your request goes to the nearest one.
- **DDoS protection**, DNS, security.
- **Cloudflare Workers** — serverless functions at the edge, running in lightweight **V8 isolates** instead of containers/VMs → near-zero cold starts.
- Real-time services including **TURN** relays for WebRTC.

**Mapping to my project:** My serverless function uses the Workers format. TURN would help my mesh connect peers behind strict NATs.

**Exam line:** "Cloudflare is an anycast edge network providing CDN, security and edge serverless computing with V8 isolates."

---

## 4.7 Case study: Megaport

**What it is:** **Network-as-a-Service (NaaS)** — **software-defined, private connections** between data centres, clouds (AWS, Azure, Google) and offices, set up on demand through a portal.
- Bypasses the **public internet** → more predictable performance, **lower latency and jitter**, better security.
- Elastic — change bandwidth on demand.
- Multi-cloud connectivity.

**Mapping to my project:** My compensation fixes *disagreement* about delay, but not delay itself. A private link gives **lower jitter**, which my fixed delay can't absorb. For two fixed studios, that's the network solution software can't provide.

**Exam line:** "Megaport provides on-demand private software-defined interconnection between clouds and data centres, avoiding the public internet."

---

## 4.8 Case study: Apache Hadoop

An open-source framework for **storing and processing huge data** on clusters of cheap machines.

Main components:
- **HDFS** — distributed storage (see 4.3).
- **YARN** — resource manager / job scheduler.
- **MapReduce** — the programming model.

**MapReduce steps:**
```
Input → SPLIT into chunks
      → MAP:     each chunk → (key, value) pairs        (in parallel)
      → SHUFFLE: group all values with the same key     (sort + send)
      → REDUCE:  combine each key's values → result     (in parallel)
```
**Word-count example:** Map turns "a b a" into (a,1),(b,1),(a,1); shuffle groups a:[1,1], b:[1]; Reduce gives a=2, b=1.

**Fault tolerance:** if a task fails, it is simply **re-executed** on another machine (map and reduce are deterministic). **Data locality:** run tasks where the data blocks are.

**In my project:** `server/mapreduce.js` — splits telemetry, runs map tasks in parallel worker threads, shuffles by link, reduces to per-link p50/p95 delay. You can inject failures and watch tasks re-run.

**Exam line:** "Hadoop = HDFS + YARN + MapReduce; map emits key-value pairs, shuffle groups them by key, reduce aggregates; failed tasks are re-executed."

---

## 4.9 Case study: Kubernetes

**What it is:** A system that **automatically runs and manages containers** across many machines (container orchestration). Originally from Google.

**Key idea — declarative desired state:** you write *what you want* in YAML ("run 3 copies of this"), and Kubernetes' **control loop** keeps reality matching it — restarting crashed containers, rescheduling them if a machine dies.

**Main objects:**
| Object | Meaning |
|---|---|
| **Pod** | smallest unit; one or more containers |
| **Deployment** | keeps N copies of a pod running; handles updates |
| **Service** | a stable name/IP that load-balances to pods |
| **ConfigMap / Secret** | configuration / passwords |
| **Node** | a machine in the cluster |
| **Namespace** | a group of objects |

**Architecture:** a **control plane** (API server, scheduler, controller manager, **etcd** database) and **worker nodes** (kubelet, kube-proxy).

**Probes:**
- **Liveness probe** — "is it alive?" If not → restart it.
- **Readiness probe** — "is it ready for traffic?" If not → don't send it requests.

Features: self-healing, auto-scaling, rolling updates, service discovery.

**In my project:** `k8s/` contains the broker and server Deployments + Services, with liveness and readiness probes. Only 1 server replica, because session state is in memory.

**Exam line:** "Kubernetes orchestrates containers by continuously reconciling actual state with declared desired state; pods, deployments and services are its core objects."

---

## 4.10 Self-study: Blockchain and distributed ledger technology

**Distributed ledger:** a database (a record book) that is **copied across many nodes**, with no single owner.

**Blockchain** — a type of ledger where data is stored in **blocks**, each containing the **hash of the previous block**:
```
[Block 0] ← [Block 1: prevHash = hash(B0)] ← [Block 2: prevHash = hash(B1)]
```
Change any old block → its hash changes → every later block's link breaks → **tampering is detected**.

**Three ingredients:**
1. **Hash chain** — makes it tamper-evident.
2. **Replication** — everyone has a copy.
3. **Consensus** — rules for who adds the next block:
   - **Proof of Work (PoW)** — solve a hard puzzle (Bitcoin). Very costly in energy.
   - **Proof of Stake (PoS)** — chosen based on coins staked (Ethereum).
   - **BFT protocols (PBFT)** — voting among known nodes.

**Types:** **public / permissionless** (anyone can join — Bitcoin) vs **private / permissioned** (known members — Hyperledger Fabric).

**Properties:** immutability, transparency, decentralisation. **Drawbacks:** slow, energy-hungry (PoW), hard to scale.

**In my project:** Every event (join, tempo change…) is a block chained with SHA-256; every laptop keeps and verifies a copy; *Tamper* breaks the chain visibly. It has the hash chain and replication, but the **server alone** orders blocks (permissioned style, like Hyperledger Fabric's ordering service) — no Proof of Work. It's **tamper-evident, not tamper-proof**.

**Exam line:** "A blockchain is a replicated, hash-chained ledger with a consensus mechanism; changing one block breaks every later link."

---

## 4.11 Self-study: Trade-offs in distributed databases

### CAP theorem (Brewer)
A distributed database can guarantee only **two of three** when a network failure happens:
- **C — Consistency:** every read gets the latest write.
- **A — Availability:** every request gets a response.
- **P — Partition tolerance:** keeps working even if the network splits.

Network partitions **will** happen, so in practice you choose between:
- **CP** — stay consistent, refuse some requests during a split (e.g. HBase, MongoDB by default, banking systems).
- **AP** — stay available, possibly return old data (e.g. Cassandra, DynamoDB).

### PACELC (extends CAP)
**If Partition → choose A or C; Else (normal operation) → choose Latency or Consistency.**
Even without failures, stronger consistency costs time.

### Consistency models
- **Strong consistency** — everyone sees the same data instantly.
- **Eventual consistency** — copies become the same *eventually*.
- Others: causal, read-your-writes, sequential.

### ACID vs BASE
- **ACID** (traditional SQL): Atomicity, Consistency, Isolation, Durability.
- **BASE** (NoSQL): Basically Available, Soft state, Eventually consistent.

### Other trade-offs
- **Replication** — synchronous (safe, slow) vs asynchronous (fast, may lose data).
- **Sharding / partitioning** — split data across machines by a key (scales, but cross-shard queries are hard).
- **SQL vs NoSQL** — structure and transactions vs scale and flexibility.

**In my project:**
| Data | Choice | Why |
|---|---|---|
| Beat timeline, delay D | Availability + low latency | late = wrong note |
| Solo floor (mutex) | Consistency | better to wait than have two soloists |
| Leader (Bully) | Availability | each side keeps working, fixes later |
| Server registry | Consistency (one copy) | unavailable if server dies |

**Exam line:** "CAP says during a partition you choose consistency or availability; PACELC adds the latency vs consistency trade-off in normal operation."

---

# One-page quick revision

| Topic | Remember this |
|---|---|
| Distributed system | independent computers that look like one |
| Goals | sharing, transparency, openness, scalability |
| Middleware | layer between app and OS (RPC, MQTT) |
| Multimedia | latency, jitter, loss; stream sync |
| Happened-before | same process / send→receive / transitive |
| Virtualization | VMs (hypervisor) vs containers (shared kernel) |
| Persistent vs transient | stored vs lost if receiver offline |
| Sync vs async | wait vs don't wait |
| RPC | stub, marshalling, IDL |
| MOM / pub-sub | decoupled in space, time, flow; MQTT QoS 0/1/2 |
| Streams | isochronous = min + max delay |
| P2P | no server; structured (DHT) vs unstructured |
| WebRTC | signalling, SDP offer/answer, ICE, STUN, TURN |
| Name / ID / address | label / unique forever / location now |
| Fault tolerance | crash, omission, timing, Byzantine; k+1 / 2k+1 |
| Cristian | Ts + RTT/2 |
| Berkeley | average all clocks |
| NTP | strata; smallest delay sample |
| Lamport | +1 per event, max+1 on receive; no concurrency detection |
| Vector | one counter per process; detects concurrency |
| Chandy–Lamport | markers, FIFO, consistent cut |
| Bully | ELECTION to higher IDs; O(n²) |
| Ring | pass ID list around ring; ~2n |
| Ricart–Agrawala | 2(N−1); defer if inside or older |
| Lamport mutex | 3(N−1) |
| Centralized mutex | 3 |
| Token ring | lost token problem |
| Maekawa | √N quorums |
| Beacon | periodic "I'm here"; timeout = suspected |
| Lodha–Kshemkalyani | N−1 to 2(N−1); fair |
| Knapp | path-pushing, edge-chasing, diffusing, global state |
| Object-based | RMI/CORBA, proxy, skeleton, reference |
| Web-based | stateless HTTP, multi-tier, CDN |
| DFS | NFS, AFS, HDFS (NameNode/DataNode) |
| Serverless | stateless, cold/warm, scale to zero |
| AWS | EC2, S3, Lambda, regions/AZs |
| Cloudflare | anycast edge, CDN, Workers |
| Megaport | private on-demand interconnects (NaaS) |
| Hadoop | HDFS + YARN + MapReduce |
| Kubernetes | desired state, pods, services, probes |
| Blockchain | hash chain + replication + consensus |
| CAP | pick C or A during a partition |
