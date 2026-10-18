// ---------------------------------------------------------------------------
// ledger.js -- a hash-chained, replicated session ledger.
// (Unit 4 self-study: blockchain and distributed ledger technologies.)
//
// Shared by the browser, the session server and the serverless function, so
// all three compute hashes with literally the same code.
//
// WHAT IT IS. Every control-plane decision -- session created, peer joined or
// lost, tempo changed, transport started, master changed -- is appended as a
// block:
//
//     block = { index, prevHash, timestampMs, kind, dataJson, hash }
//     hash  = SHA-256(index | prevHash | timestampMs | kind | dataJson)
//
// Each block commits to its predecessor's hash, so altering any historical
// block changes its hash, which breaks the link from every block after it.
// Every peer holds a full replica and re-verifies each block as it arrives.
// Tampering is therefore EVIDENT: it cannot be prevented, but it cannot be
// hidden from anyone holding an honest copy.
//
// WHAT IT IS NOT. A blockchain is three things: a hash chain, replication,
// and a CONSENSUS protocol deciding who may append the next block. We have
// the first two. For the third we have a single appender -- the session
// server -- which is the "ordering service" design of permissioned ledgers
// such as Hyperledger Fabric, not the open, leaderless consensus of Bitcoin
// (proof of work) or Ethereum (proof of stake). That trade is deliberate: our
// participants are known, so we do not pay for Byzantine-tolerant consensus
// among strangers. The honest summary is "tamper-evident replicated log",
// which is also what Certificate Transparency and git are.
// ---------------------------------------------------------------------------

export const GENESIS_PREV = '0'.repeat(64);

async function subtle() {
  // Web Crypto exists only in a SECURE context: HTTPS or localhost. A peer
  // that opens the app as http://192.168.x.x:8080 -- the normal LAN demo --
  // has crypto, but no crypto.subtle. Node < 19 needs the import instead.
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
  if (typeof window === 'undefined') return (await import('node:crypto')).webcrypto.subtle;
  return null;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const s = await subtle();
  const buf = s ? new Uint8Array(await s.digest('SHA-256', bytes)) : sha256(bytes);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Plain-JavaScript SHA-256 (FIPS 180-4), used only where Web Crypto is
// unavailable. Same input bytes, same digest -- so a peer on plain HTTP and a
// peer on localhost verify the chain identically.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(msg) {
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

/**
 * The exact bytes that get hashed. dataJson is hashed as the string it was
 * stored as, never re-serialised, so key order can never change a hash.
 */
export function blockPayload(b) {
  return [b.index, b.prevHash, b.timestampMs, b.kind, b.dataJson].join('|');
}

export async function hashBlock(b) {
  return sha256Hex(blockPayload(b));
}

/** Build the next block on top of `prev` (null for genesis). */
export async function makeBlock(prev, kind, data, timestampMs) {
  const b = {
    index: prev ? prev.index + 1 : 0,
    prevHash: prev ? prev.hash : GENESIS_PREV,
    timestampMs: timestampMs === undefined ? Date.now() : timestampMs,
    kind,
    dataJson: JSON.stringify(data || {}),
  };
  b.hash = await hashBlock(b);
  return b;
}

/**
 * Verify a whole chain. Returns the first broken block, if any, and why.
 * Two distinct failures: a block whose own hash is wrong (its content was
 * edited) and a block whose prevHash does not match its predecessor (a block
 * was inserted, removed or replaced wholesale).
 */
export async function verifyChain(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return { ok: false, height: 0, brokenAt: 0, reason: 'empty chain' };
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.index !== i) return { ok: false, height: blocks.length, brokenAt: i, reason: 'index out of sequence' };
    const expectPrev = i === 0 ? GENESIS_PREV : blocks[i - 1].hash;
    if (b.prevHash !== expectPrev) {
      return { ok: false, height: blocks.length, brokenAt: i, reason: 'prevHash does not link to block ' + (i - 1) };
    }
    if ((await hashBlock(b)) !== b.hash) {
      return { ok: false, height: blocks.length, brokenAt: i, reason: 'content does not match its hash (edited)' };
    }
  }
  return { ok: true, height: blocks.length, brokenAt: -1, head: blocks[blocks.length - 1].hash, reason: '' };
}

/**
 * One peer's replica. Blocks can arrive out of order (the initial fetch over
 * gRPC races live blocks over MQTT), so early arrivals wait in `pending`
 * until the gap before them is filled. Every block is verified against its
 * predecessor before it is accepted.
 */
export class LedgerReplica {
  constructor() {
    this.blocks = [];
    this.pending = new Map(); // index -> block
    this.rejected = 0;
    this._queue = Promise.resolve();
  }

  get height() { return this.blocks.length; }
  get head() { return this.blocks.length ? this.blocks[this.blocks.length - 1].hash : ''; }

  /**
   * Hashing is async, so two blocks arriving together could otherwise both
   * be checked against the same predecessor. Ingests are queued and run one
   * at a time.
   */
  ingest(block) {
    // The catch keeps one failed ingest from poisoning the queue: a rejected
    // promise would otherwise make every later .then() skip, silently.
    this._queue = this._queue.then(() => this._ingest(block)).catch((e) => {
      this.rejected++;
      console.warn('ledger ingest failed', e);
    });
    return this._queue;
  }

  async _ingest(block) {
    if (block.index < this.blocks.length) return;          // duplicate (QoS 1)
    this.pending.set(block.index, block);
    while (this.pending.has(this.blocks.length)) {
      const next = this.pending.get(this.blocks.length);
      this.pending.delete(next.index);
      const prev = this.blocks[this.blocks.length - 1];
      const linkOk = next.prevHash === (prev ? prev.hash : GENESIS_PREV);
      const hashOk = (await hashBlock(next)) === next.hash;
      if (!linkOk || !hashOk) { this.rejected++; continue; }
      this.blocks.push(next);
    }
  }

  async ingestAll(blocks) {
    for (const b of blocks) await this.ingest(b);
  }

  verify() { return verifyChain(this.blocks); }
}
