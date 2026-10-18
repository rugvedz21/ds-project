// ---------------------------------------------------------------------------
// faas.js -- a minimal Function-as-a-Service runtime.  (Unit 4: serverless)
//
// "Serverless" does not mean no servers. It means the DEVELOPER stops
// managing them: you hand the platform a function, and the platform decides
// when an instance of it exists. Three properties define the model, and this
// runtime reproduces each one so they can be observed rather than described:
//
//   1. STATELESS INVOCATION. A function is `fetch(request) -> response`.
//      Anything it needs arrives in the request; nothing it computes survives
//      to the next call except by accident. functions/session-report.js is
//      given the whole ledger in the body for exactly this reason.
//
//   2. COLD vs WARM STARTS. The first call loads the code (here: a fresh
//      module import) before it can run -- a cold start. Later calls reuse the
//      loaded instance -- warm. Every response says which it got, in the
//      x-faas-cold / x-faas-init-ms headers, and the UI shows it.
//
//   3. SCALE TO ZERO. An instance idle for idleMs is discarded, so an unused
//      function costs nothing -- and the next caller pays the cold start
//      again. That trade (zero idle cost vs first-request latency) is the
//      central economic fact of serverless.
//
// The function signature is the Web-standard one Cloudflare Workers use
// (`export default { fetch(request, env) }`), so functions/ deploys there
// unchanged; on AWS Lambda the same body would sit behind a small adapter.
//
// What this runtime does NOT do, and a real platform does: run each instance
// in its own isolate or micro-VM (Workers use V8 isolates, Lambda uses
// Firecracker), run many instances in parallel under load, and bill per
// millisecond. Here every function shares the server's process -- which is
// also why it is a teaching tool and not a security boundary.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME_RE = /^[a-z0-9-]+$/;
const MAX_BODY = 4 * 1024 * 1024;

export class FunctionRuntime {
  constructor({ dir, idleMs = 60000, log }) {
    this.dir = dir;
    this.idleMs = idleMs;
    this.log = log || (() => {});
    this.instances = new Map(); // name -> { handler, loadedAt, lastUsed, invocations }
    this.stats = new Map();     // name -> { cold, warm }
    setInterval(() => this._reap(), Math.min(idleMs, 10000)).unref();
  }

  async invoke(name, request) {
    if (!NAME_RE.test(name)) throw Object.assign(new Error('bad function name'), { status: 400 });
    const file = path.join(this.dir, name + '.js');
    if (!fs.existsSync(file)) throw Object.assign(new Error('no such function: ' + name), { status: 404 });

    let inst = this.instances.get(name);
    const cold = !inst;
    let initMs = 0;
    if (cold) {
      const t0 = performance.now();
      // The query string defeats Node's module cache, so a cold start really
      // does load and evaluate the code again, as a fresh instance would.
      const mod = await import(pathToFileURL(file).href + '?instance=' + Date.now());
      initMs = performance.now() - t0;
      inst = { handler: mod.default, loadedAt: Date.now(), lastUsed: 0, invocations: 0 };
      this.instances.set(name, inst);
      this.log('faas', name + ': COLD start, instance created in ' + initMs.toFixed(1) + ' ms');
    }

    const st = this.stats.get(name) || { cold: 0, warm: 0 };
    st[cold ? 'cold' : 'warm']++;
    this.stats.set(name, st);

    inst.lastUsed = Date.now();
    inst.invocations++;
    const t1 = performance.now();
    const response = await inst.handler.fetch(request, { RUNTIME: 'ensemble-local-faas' });
    const durationMs = performance.now() - t1;
    return { response, cold, initMs, durationMs, instanceInvocations: inst.invocations };
  }

  /** Adapt a Node http request to a Web Request, invoke, and write back. */
  async handle(name, req, res, url) {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const request = new Request(url.href, { method: req.method, headers: req.headers, body });
      const r = await this.invoke(name, request);

      const headers = Object.fromEntries(r.response.headers.entries());
      headers['x-faas-cold'] = String(r.cold);
      headers['x-faas-init-ms'] = r.initMs.toFixed(1);
      headers['x-faas-duration-ms'] = r.durationMs.toFixed(1);
      headers['x-faas-instance-invocations'] = String(r.instanceInvocations);
      headers['access-control-expose-headers'] = 'x-faas-cold, x-faas-init-ms, x-faas-duration-ms, x-faas-instance-invocations';
      res.writeHead(r.response.status, headers);
      res.end(Buffer.from(await r.response.arrayBuffer()));
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  _reap() {
    const now = Date.now();
    for (const [name, inst] of this.instances) {
      if (now - inst.lastUsed > this.idleMs) {
        this.instances.delete(name);
        this.log('faas', name + ': idle ' + Math.round((now - inst.lastUsed) / 1000) +
          ' s after ' + inst.invocations + ' invocation(s) — scaled to zero');
      }
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
