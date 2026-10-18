// ---------------------------------------------------------------------------
// session-report -- a serverless function.  (Unit 4: serverless)
//
//   POST /fn/session-report     body: { "blocks": [ ...ledger blocks... ] }
//
// Verifies a session ledger's hash chain and summarises what happened in the
// session: who joined and left, every tempo change, who was master when.
//
// Written to the Web-standard fetch signature Cloudflare Workers use, so this
// file deploys there unchanged (see wrangler.toml). Locally it is run by
// server/faas.js, which reproduces cold starts and scale-to-zero.
//
// Note what it does NOT do: look anything up. It has no database handle, no
// session registry, no memory of previous calls. The caller sends the whole
// ledger. That is the stateless contract that lets a platform run zero, one
// or a thousand copies of this function without them ever needing to agree
// on anything -- and it is why the ledger being self-verifying matters: the
// function can trust the data it was handed only because it can check it.
// ---------------------------------------------------------------------------

import { verifyChain } from '../web/ledger.js';

// Module scope runs once per INSTANCE, i.e. once per cold start. Counting
// here makes warm reuse visible -- and shows why you must never keep real
// state here: a different instance would have a different count.
const instanceStartedAt = Date.now();
let invocationsOnThisInstance = 0;

export default {
  async fetch(request, env) {
    invocationsOnThisInstance++;
    if (request.method !== 'POST') return json({ error: 'POST a ledger: { "blocks": [...] }' }, 405);

    let blocks;
    try { ({ blocks } = await request.json()); } catch { return json({ error: 'body is not JSON' }, 400); }
    if (!Array.isArray(blocks)) return json({ error: 'missing "blocks" array' }, 400);

    const integrity = await verifyChain(blocks);
    // Only summarise the prefix that verified: anything after a break is
    // unauthenticated and could say anything.
    const trusted = integrity.ok ? blocks : blocks.slice(0, Math.max(0, integrity.brokenAt));

    return json({
      integrity,
      summary: summarise(trusted),
      runtime: {
        platform: (env && env.RUNTIME) || 'unknown',
        instanceAgeMs: Date.now() - instanceStartedAt,
        invocationsOnThisInstance,
      },
    });
  },
};

function summarise(blocks) {
  const names = new Map();
  const people = [];
  const tempo = [];
  const masters = [];
  let starts = 0;
  let session = null;

  for (const b of blocks) {
    let d = {};
    try { d = JSON.parse(b.dataJson); } catch {}
    if (b.kind === 'created') session = { ...d, createdAtMs: b.timestampMs };
    if (b.kind === 'join') {
      names.set(d.peerId, d.peerName);
      people.push({ atMs: b.timestampMs, event: 'joined', who: d.peerName });
      if (d.becameMaster) masters.push({ atMs: b.timestampMs, who: d.peerName });
    }
    if (b.kind === 'leave') people.push({ atMs: b.timestampMs, event: 'left', who: names.get(d.peerId) || d.peerId });
    if (b.kind === 'peer_lost') people.push({ atMs: b.timestampMs, event: 'lost (missed heartbeats)', who: d.peerName });
    if (b.kind === 'tempo') tempo.push({ atMs: b.timestampMs, bpm: d.bpm, by: names.get(d.byPeerId) || d.byPeerId });
    if (b.kind === 'transport' && d.playing) starts++;
    if (b.kind === 'master') masters.push({ atMs: b.timestampMs, who: names.get(d.masterPeerId) || d.masterPeerId || '(none)' });
  }

  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return {
    session,
    blocks: blocks.length,
    spanMs: first && last ? last.timestampMs - first.timestampMs : 0,
    participants: names.size,
    people,
    tempoChanges: tempo,
    timesStarted: starts,
    masterHistory: masters,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
