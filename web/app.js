// ---------------------------------------------------------------------------
// app.js -- wiring. Brings the four planes together in one node:
//
//   rpc.js      gRPC control plane    (request/reply: join, tempo, transport)
//   bus.js      MQTT event plane      (pub/sub: roster, tempo, signalling)
//   mesh.js     WebRTC data plane     (peer-to-peer audio + note events)
//   clock.js    Cristian clock sync   (a shared notion of "when")
//   timeline.js the musical timeline  (an anchor formula, not a tick stream)
//   audio.js    Web Audio + latency compensation
// ---------------------------------------------------------------------------

import { rpc } from './rpc.js';
import { Bus } from './bus.js';
import { ClockSync } from './clock.js';
import { Timeline, BeatScheduler } from './timeline.js';
import { AudioEngine, pitchForPeer } from './audio.js';
import { Mesh } from './mesh.js';
import { EventModel, HB } from './events.js';

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  peerId: null,
  peerName: null,
  masterPeerId: null,
  participants: [],
  armed: false,
  myPitch: 440,
  telemetry: new Map(), // peerId -> latest reported telemetry
};

const clock = new ClockSync();
const timeline = new Timeline(clock);
const audio = new AudioEngine();
const bus = new Bus();
let mesh = null;
let scheduler = null;
let events = null;      // EventModel -- created once we know our peer id
let addressBook = {};   // peerId -> live ICE address

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
function log(tag, msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  line.innerHTML = '<span class="tag">' + t + ' [' + tag + ']</span> ' +
    '<span class="' + cls + '">' + msg + '</span>';
  el.prepend(line);
  while (el.children.length > 200) el.lastChild.remove();
}

function badge(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'badge' + (cls ? ' ' + cls : '');
}

// ---------------------------------------------------------------------------
// join / create
// ---------------------------------------------------------------------------
$('btnCreate').onclick = async () => {
  try {
    const s = await rpc.createSession({
      displayName: 'Jam',
      bpm: Number($('fBpm').value),
      beatsPerBar: Number($('fBar').value),
    });
    $('fSession').value = s.sessionId;
    log('rpc', 'created session ' + s.sessionId);
    await join(s.sessionId);
  } catch (e) { log('rpc', e.message, 'bad'); alert(e.message); }
};

$('btnJoin').onclick = async () => {
  const sid = $('fSession').value.trim();
  if (!sid) return alert('Enter a session ID, or create a new session.');
  try { await join(sid); }
  catch (e) { log('rpc', e.message, 'bad'); alert(e.message); }
};

async function join(sessionId) {
  // The click that triggered this is the user gesture browsers require before
  // an AudioContext is allowed to make sound. Initialising here rather than on
  // page load is what stops the context from starting in 'suspended' state.
  await audio.init();

  // ---- 1. gRPC: join, and find out who is already here --------------------
  const reply = await rpc.joinSession({
    sessionId,
    peerName: $('fName').value.trim() || 'Musician',
    instrument: $('fInst').value.trim() || 'click',
  });

  state.sessionId = sessionId;
  state.peerId = reply.peerId;
  state.peerName = $('fName').value.trim() || 'Musician';
  state.masterPeerId = reply.session.masterPeerId;
  state.myPitch = pitchForPeer(reply.peerId);
  events = new EventModel(reply.peerId);

  timeline.beatsPerBar = reply.session.beatsPerBar || 4;
  timeline.setTransport(reply.session.transport);
  badge('bRpc', 'gRPC ok', 'on');
  log('rpc', 'joined as ' + state.peerName + ' (' + state.peerId + ')');

  // ---- 2. Cristian: establish a shared notion of "when" -------------------
  const sync = await clock.sync(8);
  clock.startAutoSync(20000);
  badge('bClock', 'clock ±' + sync.uncertaintyMs.toFixed(0) + 'ms', 'on');
  log('clock', 'offset ' + sync.offsetMs.toFixed(1) + ' ms, uncertainty ±' +
    sync.uncertaintyMs.toFixed(1) + ' ms (' + sync.rounds + ' rounds, best RTT kept)');

  // ---- 3. MQTT: subscribe to the session's event topics -------------------
  const cfg = await (await fetch('/config')).json();
  await bus.connect(cfg.mqttWsUrl || reply.mqttWsUrl, 'peer-' + state.peerId);
  badge('bMqtt', 'MQTT ok', 'on');
  log('mqtt', 'connected to broker at ' + (cfg.mqttWsUrl || reply.mqttWsUrl));

  const base = 'session/' + sessionId;

  bus.on(base + '/participants', (list) => {
    state.participants = list;
    // Vector clocks are only comparable if every process has an entry, so a
    // newly-seen peer must be added before any event is stamped against it.
    for (const p of list) events.addProcess(p.peerId);
    renderPeers();
    if (mesh) mesh.syncRoster(list);
    log('mqtt', 'roster: ' + list.map((p) => p.peerName).join(', '));
  });

  bus.on(base + '/tempo', (m) => {
    $('fTempo').value = m.bpm;
    $('lTempo').textContent = m.bpm;
    log('mqtt', 'tempo -> ' + m.bpm + ' BPM (retained, QoS 1)');
  });

  bus.on(base + '/transport', (t) => {
    timeline.setTransport(t);
    if (scheduler) scheduler.resync();
    $('btnPlay').textContent = t.playing ? 'Stop' : 'Start';
    $('btnPlay').classList.toggle('active', t.playing);
    log('mqtt', 'transport playing=' + t.playing + ' anchor beat ' +
      t.anchorBeat.toFixed(2) + ' @ ' + Math.round(t.anchorTimeMs));
  });

  bus.on(base + '/master', (m) => {
    state.masterPeerId = m.masterPeerId;
    $('sMaster').textContent = nameOf(m.masterPeerId) || '(none)';
    log('fault', 'timing master is now ' + (nameOf(m.masterPeerId) || 'nobody') +
      ' — the ensemble keeps playing either way, because the timeline is an ' +
      'anchor formula rather than a tick stream', 'warn');
  });

  bus.on(base + '/events', (e) => {
    if (e.kind === 'peer_lost') log('fault', 'peer lost: ' + e.peerName +
      ' (missed heartbeats — crash-stop failure detection)', 'bad');
  });

  // Emulated link impairment. Delay is a property of a LINK, not of one
  // receiver, so both endpoints must apply it -- otherwise the extra delay
  // lands on only one leg of the round trip, RTT/2 silently underestimates the
  // true one-way delay by half the impairment, and the compensation computed
  // from it is wrong by that much. Publishing it makes the emulated link
  // symmetric, which is the condition RTT/2 actually requires.
  bus.on(base + '/impair/+', (m) => {
    if (m.a === state.peerId) audio.setImpairment(m.b, m.ms);
    else if (m.b === state.peerId) audio.setImpairment(m.a, m.ms);
    else return;
    const other = m.a === state.peerId ? m.b : m.a;
    const el = document.querySelector('input[data-peer="' + other + '"]');
    if (el) el.value = m.ms;
    const lbl = $('im-' + other);
    if (lbl) lbl.textContent = m.ms + ' ms';
  });

  // Every node publishes its own link measurements so that every node can
  // compute the SAME D. Without this each node would only know its own links
  // and they would compensate to different deadlines.
  bus.on(base + '/telemetry/+', (t) => {
    if (t.peerId === state.peerId) return;
    state.telemetry.set(t.peerId, t);
    const reported = [];
    for (const entry of state.telemetry.values()) {
      for (const v of Object.values(entry.links || {})) reported.push(v.oneWayMs);
    }
    audio.setPeerReportedDelays(reported);
  });

  // ---- 4. WebRTC mesh -----------------------------------------------------
  mesh = new Mesh({
    selfId: state.peerId,
    sessionId,
    bus,
    audio,
    onEvent: onMeshEvent,
  });
  mesh.start();

  // Offer to everyone already present. The newcomer always offers, so two
  // nodes can never offer to each other simultaneously (no glare).
  for (const p of reply.existingPeers) mesh.connectTo(p.peerId, true);
  log('mesh', 'offering to ' + reply.existingPeers.length + ' existing peer(s)');

  // ---- 5. Beat scheduler --------------------------------------------------
  scheduler = new BeatScheduler(timeline, onBeat);
  scheduler.start();

  // ---- 6. Periodic tasks --------------------------------------------------
  setInterval(heartbeat, 2000);
  setInterval(publishTelemetry, 1000);
  setInterval(renderDashboard, 100);
  setInterval(renderEventModel, 250);
  // getStats() is comparatively expensive and addresses rarely change, so
  // this polls far more slowly than the rest of the dashboard.
  setInterval(refreshAddresses, 3000);

  // Exposed for the browser console -- handy during a demo when somebody asks
  // "show me the actual measured RTT" or "what is D right now".
  window.ensemble = { state, clock, timeline, audio, bus, mesh, rpc, events, EventModel };

  $('joinView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  $('sSid').textContent = sessionId;
  $('sMe').textContent = state.peerName + ' · ' + Math.round(state.myPitch) + ' Hz';
  $('sMaster').textContent = nameOf(state.masterPeerId) || '(none)';
}

// ---------------------------------------------------------------------------
// beat callback -- the only place sound is produced
// ---------------------------------------------------------------------------
function onBeat(beatNumber, localMs) {
  audio.metronomeClick(localMs, timeline.isDownbeat(beatNumber));

  // If armed, this node also plays its own voice and announces the event to
  // its peers over the data channels. The announcement carries a BEAT NUMBER,
  // not a timestamp -- a beat number means the same thing on every machine.
  if (state.armed) {
    audio.instrumentBlip(localMs, state.myPitch);
    // Playing the note and announcing it are the same occurrence, so this is
    // one SEND event in the model rather than an internal event followed by a
    // send. The returned stamp travels with the message: it is what lets the
    // receiver establish send -> receive, which is rule 2 of happened-before.
    const stamp = events.send('note', { beat: beatNumber });
    if (mesh) {
      mesh.broadcastNote({ beat: beatNumber, pitch: state.myPitch, peerId: state.peerId, stamp });
    }
  }
  flashBeat(beatNumber);
}

function onMeshEvent(kind, data) {
  if (kind === 'dc_open') log('mesh', 'data channel open to ' + nameOf(data.peerId));
  if (kind === 'peer_audio') log('mesh', 'receiving audio from ' + nameOf(data.peerId) +
    ' — peer-to-peer, the server is not in this path');
  if (kind === 'peer_state') {
    const cls = data.state === 'connected' ? '' : data.state === 'failed' ? 'bad' : 'warn';
    log('mesh', nameOf(data.peerId) + ' connection ' + data.state, cls);
  }
  if (kind === 'peer_gone') log('mesh', 'disconnected from ' + nameOf(data.peerId), 'warn');
  if (kind === 'note') {
    // A RECEIVE event. Merging the sender's vector here is what transfers
    // causal knowledge across the process boundary: afterwards our vector
    // reflects everything the sender knew when it sent.
    events.receive(data.note.stamp, 'note', { beat: data.note.beat, from: data.peerId });

    // The peer's actual sound arrives as WebRTC audio and is compensated in
    // the audio graph. This message is the low-latency *notification* of the
    // same event, used for the dashboard and for beat-accuracy measurement.
    const drift = data.note.beat - timeline.currentBeat();
    if (Math.abs(drift) > 0.5) {
      log('sync', nameOf(data.peerId) + ' note for beat ' + data.note.beat +
        ' arrived ' + drift.toFixed(2) + ' beats out of position', 'warn');
    }
  }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
$('fTempo').oninput = (e) => { $('lTempo').textContent = e.target.value; };
$('fTempo').onchange = async (e) => {
  try {
    await rpc.setTempo({ sessionId: state.sessionId, peerId: state.peerId, bpm: Number(e.target.value) });
    log('rpc', 'SetTempo ' + e.target.value + ' — fans out to every node over MQTT');
  } catch (err) { log('rpc', err.message, 'bad'); }
};

$('btnPlay').onclick = async () => {
  const nowPlaying = !timeline.transport.playing;
  try {
    await rpc.setTransport({ sessionId: state.sessionId, peerId: state.peerId, playing: nowPlaying });
    if (scheduler) scheduler.resync();
  } catch (err) { log('rpc', err.message, 'bad'); }
};

$('btnArm').onclick = async () => {
  state.armed = !state.armed;
  $('btnArm').classList.toggle('active', state.armed);
  $('btnArm').textContent = state.armed ? 'Track armed' : 'Arm my track';
  try { await rpc.armTrack({ sessionId: state.sessionId, peerId: state.peerId, armed: state.armed }); }
  catch (err) { log('rpc', err.message, 'bad'); }
};

$('btnComp').onclick = () => {
  const on = !audio.compensationEnabled;
  audio.setCompensation(on);
  $('btnComp').textContent = 'Compensation: ' + (on ? 'ON' : 'OFF');
  $('btnComp').classList.toggle('active', on);
  log('comp', on
    ? 'compensation ON — every node aligns to the common deadline D'
    : 'compensation OFF — each node now hears a differently skewed mix', on ? '' : 'warn');
};

$('btnLeave').onclick = async () => {
  try { await rpc.leaveSession({ sessionId: state.sessionId, peerId: state.peerId }); } catch {}
  if (mesh) mesh.stop();
  if (scheduler) scheduler.stop();
  bus.close();
  location.reload();
};

$('fVol').oninput = (e) => audio.setMasterVolume(Number(e.target.value) / 100);

$('btnMic').onclick = async () => {
  try {
    await audio.enableMic();
    $('btnMic').textContent = 'Microphone on';
    $('btnMic').classList.add('active');
    $('btnMic').disabled = true;
    $('btnMonitor').disabled = false;
    log('audio', 'microphone captured and mixed into the outbound stream');
  } catch (e) { log('audio', 'microphone denied: ' + e.message, 'bad'); }
};

$('btnMonitor').onclick = () => {
  const on = !audio.monitorMic;
  audio.setMicMonitor(on);
  $('btnMonitor').classList.toggle('active', on);
  $('btnMonitor').textContent = on ? 'Monitoring (use headphones)' : 'Monitor mic';
};

// ---------------------------------------------------------------------------
// periodic
// ---------------------------------------------------------------------------
async function heartbeat() {
  try {
    const r = await rpc.heartbeat({ sessionId: state.sessionId, peerId: state.peerId });
    if (r.masterPeerId && r.masterPeerId !== state.masterPeerId) {
      state.masterPeerId = r.masterPeerId;
      $('sMaster').textContent = nameOf(r.masterPeerId) || '(none)';
    }
  } catch (e) {
    badge('bRpc', 'gRPC down', 'off');
    log('rpc', 'heartbeat failed — session server unreachable. Audio continues: ' +
      'the mesh does not depend on it once established.', 'bad');
  }
}

function publishTelemetry() {
  if (!mesh) return;
  const links = {};
  for (const s of mesh.stats()) {
    links[s.peerId] = {
      rttMs: round(s.rttMs), jitterMs: round(s.jitterMs),
      oneWayMs: round(s.oneWayMs), lossPct: round(s.lossPct),
    };
  }
  bus.publish('session/' + state.sessionId + '/telemetry/' + state.peerId, {
    peerId: state.peerId,
    peerName: state.peerName,
    links,
    clockOffsetMs: round(clock.offsetMs),
    beat: round(timeline.currentBeat()),
    commonDeadlineMs: round(audio.commonDeadlineMs),
  }, { retain: false, qos: 0 }); // QoS 0: telemetry is disposable, a fresh
                                 // sample follows in one second regardless.
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function nameOf(peerId) {
  if (peerId === state.peerId) return state.peerName + ' (you)';
  const p = state.participants.find((x) => x.peerId === peerId);
  return p ? p.peerName : peerId ? peerId.slice(0, 9) : '';
}

const round = (v) => Math.round((Number(v) || 0) * 10) / 10;

function renderPeers() {
  const others = state.participants.filter((p) => p.peerId !== state.peerId);
  const host = $('impairList');
  if (!others.length) {
    host.innerHTML = '<p class="hint" style="margin:0">No peers connected yet.</p>';
    return;
  }
  host.innerHTML = others.map((p) => (
    '<div class="peer-ctl">' +
      '<div class="name"><b>' + esc(p.peerName) + '</b>' +
      '<span id="im-' + p.peerId + '">0 ms</span></div>' +
      '<input type="range" min="0" max="300" value="' +
        audio.getImpairment(p.peerId) + '" data-peer="' + p.peerId + '" />' +
    '</div>'
  )).join('');

  host.querySelectorAll('input[type=range]').forEach((el) => {
    el.oninput = () => {
      const ms = Number(el.value);
      const other = el.dataset.peer;
      const lbl = $('im-' + other);
      if (lbl) lbl.textContent = ms + ' ms';
      // Announce the impairment for the whole link rather than applying it
      // locally: the retained message reaches both endpoints (including this
      // one, via our own subscription) so the emulated link stays symmetric.
      // Topic key is the peer-id pair in sorted order, so both ends name the
      // same link and neither can create a duplicate for the reverse
      // direction.
      const linkKey = [state.peerId, other].sort().join('~');
      bus.publish('session/' + state.sessionId + '/impair/' + linkKey,
        { a: state.peerId, b: other, ms }, { retain: true, qos: 1 });
    };
    el.onchange = () => log('netem', 'injected ' + el.value +
      ' ms on the link to ' + nameOf(el.dataset.peer) +
      ' (applied at BOTH ends — a symmetric link)', 'warn');
  });
}

function renderDashboard() {
  // timeline
  const beat = timeline.currentBeat();
  $('sBeat').textContent = timeline.transport.playing ? beat.toFixed(2) : 'stopped';
  $('sBar').textContent = timeline.transport.playing
    ? (Math.floor(beat / timeline.beatsPerBar) + 1) + ':' +
      (Math.floor(beat % timeline.beatsPerBar) + 1)
    : '—';
  $('sOffset').textContent = clock.offsetMs.toFixed(1) + ' ms';
  $('sUncert').textContent = '± ' + (clock.uncertaintyMs === Infinity ? '—' : clock.uncertaintyMs.toFixed(1) + ' ms');

  // compensation
  const snap = audio.snapshot();
  $('sD').textContent = snap.commonDeadlineMs + ' ms';
  $('sMon').textContent = snap.commonDeadlineMs + ' ms';

  // peers
  if (!mesh) return;
  const rows = mesh.stats();
  badge('bMesh', 'mesh ' + rows.filter((r) => r.state === 'connected').length + '/' + rows.length,
    rows.length && rows.every((r) => r.state === 'connected') ? 'on' : '');

  const tbody = $('peerRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--dim)">no peers yet</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const c = snap.peers[r.peerId] || {};
    const col = r.state === 'connected' ? 'var(--good)' : r.state === 'failed' ? 'var(--bad)' : 'var(--warn)';
    return '<tr>' +
      '<td>' + esc(nameOf(r.peerId)) + '</td>' +
      '<td style="color:var(--dim)">' + r.peerId.slice(0, 11) + '</td>' +
      '<td style="color:' + col + '">' + r.state + '</td>' +
      '<td class="num">' + r.rttMs.toFixed(1) + '</td>' +
      '<td class="num">' + r.oneWayMs.toFixed(1) + '</td>' +
      '<td class="num">' + r.jitterMs.toFixed(1) + '</td>' +
      '<td class="num">' + r.lossPct.toFixed(0) + '%</td>' +
      '<td class="num" style="color:' + (r.impairMs ? 'var(--warn)' : 'var(--dim)') + '">' + r.impairMs + '</td>' +
      '<td class="num" style="color:var(--accent)">' + (c.compMs || 0) + '</td>' +
    '</tr>';
  }).join('');
}

const shortName = (pid) => {
  if (pid === state.peerId) return state.peerName;
  const p = state.participants.find((x) => x.peerId === pid);
  return p ? p.peerName : pid.slice(0, 6);
};

function renderEventModel() {
  if (!events) return;
  $('sLamport').textContent = events.lamport;
  $('sVector').textContent = EventModel.format(events.vector, shortName) || '—';

  const pair = events.latestCrossProcessPair();
  const relEl = $('sRelation');
  if (!pair) {
    relEl.textContent = '—';
    relEl.style.color = 'var(--fg)';
  } else {
    const symbol = {
      '->': 'mine → theirs',
      '<-': 'theirs → mine',
      '||': 'CONCURRENT ‖',
      '=': 'identical',
    }[pair.relation];
    relEl.textContent = 'beat ' + pair.beat + ': ' + symbol;
    // Concurrency is the interesting case, so make it visually obvious: it is
    // the one that proves the order is partial rather than total.
    relEl.style.color = pair.relation === HB.CONCURRENT ? 'var(--warn)' : 'var(--accent)';
  }

  const tbody = $('eventRows');
  const rows = events.history.slice(0, 8);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--dim)">no events yet</td></tr>';
    return;
  }
  const typeColour = { send: 'var(--accent2)', receive: 'var(--accent)', internal: 'var(--dim)' };
  tbody.innerHTML = rows.map((e) => (
    '<tr>' +
      '<td style="color:var(--dim)">' + e.seq + '</td>' +
      '<td style="color:' + (typeColour[e.type] || 'var(--fg)') + '">' + e.type + '</td>' +
      '<td>' + esc(e.kind) + (e.detail.beat !== undefined ? ' beat ' + e.detail.beat : '') +
        (e.detail.from ? ' from ' + esc(shortName(e.detail.from)) : '') + '</td>' +
      '<td class="num">' + e.lamport + '</td>' +
      '<td style="color:var(--dim)">' + esc(EventModel.format(e.vector, shortName)) + '</td>' +
    '</tr>'
  )).join('');
}

function renderNaming() {
  const tbody = $('nameRows');
  const all = state.participants;
  if (!all.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--dim)">no peers yet</td></tr>';
    return;
  }
  tbody.innerHTML = all.map((p) => {
    const isMe = p.peerId === state.peerId;
    const addr = addressBook[p.peerId];
    const addrText = isMe ? '(this node)' : addr ? addr.remote : 'resolving…';
    const candText = isMe ? '—' : addr ? addr.type + '/' + addr.protocol : '—';
    return '<tr>' +
      '<td>' + esc(p.peerName) + (isMe ? ' <span style="color:var(--dim)">(you)</span>' : '') + '</td>' +
      '<td style="color:var(--accent2)">' + p.peerId + '</td>' +
      '<td style="color:var(--accent)">' + esc(addrText) + '</td>' +
      '<td style="color:var(--dim)">' + esc(candText) + '</td>' +
    '</tr>';
  }).join('');
}

async function refreshAddresses() {
  if (!mesh) return;
  try { addressBook = await mesh.addresses(); } catch {}
  renderNaming();
}

// beat strip
let stripBuilt = 0;
function flashBeat(beatNumber) {
  const n = timeline.beatsPerBar;
  const strip = $('beatStrip');
  if (stripBuilt !== n) {
    strip.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'beat-dot';
      d.textContent = i + 1;
      strip.appendChild(d);
    }
    stripBuilt = n;
  }
  const idx = ((beatNumber % n) + n) % n;
  const dot = strip.children[idx];
  if (!dot) return;
  // Light the dot when the beat actually sounds -- which is D later than the
  // beat instant, because the monitor path is delayed. Matching the visual to
  // the audible keeps the display honest about what compensation is doing.
  setTimeout(() => {
    dot.classList.add(idx === 0 ? 'down' : 'hit');
    setTimeout(() => dot.classList.remove('hit', 'down'), 90);
  }, Math.max(0, timeline.localTimeOfBeat(beatNumber) - Date.now() + audio.commonDeadlineMs));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.addEventListener('beforeunload', () => {
  if (state.sessionId) {
    navigator.sendBeacon('/rpc/LeaveSession',
      new Blob([JSON.stringify({ sessionId: state.sessionId, peerId: state.peerId })],
        { type: 'application/json' }));
  }
});
