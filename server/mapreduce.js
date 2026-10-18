// ---------------------------------------------------------------------------
// mapreduce.js -- a small MapReduce framework.  (Unit 4: Apache Hadoop)
//
// Hadoop is two things: HDFS, a distributed file system that stores data as
// replicated blocks across many machines, and the MapReduce engine that ships
// computation to where those blocks live. This file is the second part, at
// the scale of one machine with worker threads standing in for cluster nodes:
//
//   1. SPLIT    the input into S splits (Hadoop: one per HDFS block).
//   2. MAP      run one map task per split, in parallel. Each emits
//               (key, value) pairs, already partitioned into R buckets by
//               hash(key) mod R.
//   3. SHUFFLE  for each reducer r, gather bucket r from every map task,
//               group values by key, and sort by key.
//   4. REDUCE   run R reduce tasks in parallel, one per partition.
//
// FAULT TOLERANCE is the part worth dwelling on, because it is why MapReduce
// won. Map and reduce are deterministic functions of their input, so a failed
// task is simply RE-EXECUTED -- on any worker, with no coordination and no
// checkpoint. Nothing else in the job needs to know. Pass failRate (CLI
// --fail-rate, or ?failRate= on /analytics) to watch it happen.
//
// What is missing compared to Hadoop, deliberately: HDFS and data locality
// (our input is one local file, so there is no "move compute to data"), YARN
// scheduling across machines, speculative execution of stragglers, and
// spilling to disk when the shuffle outgrows memory.
//
// CLI:  node server/mapreduce.js data/telemetry/<session>.jsonl
//         [--splits 4] [--reducers 2] [--fail-rate 0.3]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'mr-worker.js');
const MAX_ATTEMPTS = 4;

export async function runJob({ jobPath, inputFiles, splits = 4, reducers = 2, failRate = 0 }) {
  splits = clampInt(splits, 1, 32);
  reducers = clampInt(reducers, 1, 16);
  failRate = Math.min(Math.max(Number(failRate) || 0, 0), 0.9);
  const t0 = performance.now();
  const stats = { splits, reducers, mapTasks: 0, reduceTasks: 0, retries: 0, failures: [] };

  // ---- 1. split ------------------------------------------------------------
  const lines = inputFiles.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
  stats.records = lines.length;
  const size = Math.ceil(lines.length / splits) || 1;
  const inputSplits = [];
  for (let i = 0; i < lines.length; i += size) inputSplits.push(lines.slice(i, i + size));

  // ---- 2. map ----------------------------------------------------------------
  const tMap = performance.now();
  const mapOut = await Promise.all(inputSplits.map((input, i) =>
    runTask({ phase: 'map', jobPath, input, reducers, failRate }, 'map-' + i, stats)));
  stats.mapTasks = mapOut.length;
  stats.intermediatePairs = mapOut.reduce((n, m) => n + m.pairs, 0);
  stats.mapMs = round(performance.now() - tMap);

  // ---- 3. shuffle + sort ------------------------------------------------------
  const tShuffle = performance.now();
  const partitions = [];
  for (let r = 0; r < reducers; r++) {
    const groups = new Map();
    for (const m of mapOut) {
      for (const [k, v] of m.partitions[r]) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(v);
      }
    }
    partitions.push([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  stats.distinctKeys = partitions.reduce((n, p) => n + p.length, 0);
  stats.shuffleMs = round(performance.now() - tShuffle);

  // ---- 4. reduce ---------------------------------------------------------------
  const tReduce = performance.now();
  const nonEmpty = partitions.map((p, r) => [p, r]).filter(([p]) => p.length);
  const reduceOut = await Promise.all(nonEmpty.map(([input, r]) =>
    runTask({ phase: 'reduce', jobPath, input, reducers, failRate }, 'reduce-' + r, stats)));
  stats.reduceTasks = reduceOut.length;
  stats.reduceMs = round(performance.now() - tReduce);

  const results = Object.fromEntries(reduceOut.flatMap((r) => r.results));
  stats.totalMs = round(performance.now() - t0);
  return { results, stats };
}

/** Run one task in a fresh worker; on failure, re-execute it. */
async function runTask(data, label, stats) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const w = new Worker(WORKER, { workerData: data });
        w.once('message', resolve);
        w.once('error', reject);
        w.once('exit', (code) => { if (code !== 0) reject(new Error(label + ' exited with ' + code)); });
      });
    } catch (e) {
      stats.failures.push(label + ' attempt ' + attempt + ': ' + e.message);
      if (attempt >= MAX_ATTEMPTS) throw new Error(label + ' failed ' + attempt + ' times; job aborted');
      stats.retries++;
    }
  }
}

const round = (v) => Math.round(v * 10) / 10;
function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args.splice(i, 2)[1] : dflt;
  };
  const splits = flag('splits', 4);
  const reducers = flag('reducers', 2);
  const failRate = flag('fail-rate', 0);
  const files = args.length ? args : (() => {
    const dir = path.join(__dirname, '..', 'data', 'telemetry');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
  })();
  if (!files.length) {
    console.error('no input. Run a session first (telemetry is logged to data/telemetry/), or pass a .jsonl file.');
    process.exit(1);
  }

  const { results, stats } = await runJob({
    jobPath: path.join(__dirname, '..', 'analytics', 'link-stats.js'),
    inputFiles: files, splits, reducers, failRate,
  });

  console.log('\ninput    ' + files.length + ' file(s), ' + stats.records + ' records');
  console.log('map      ' + stats.mapTasks + ' tasks -> ' + stats.intermediatePairs + ' pairs   (' + stats.mapMs + ' ms)');
  console.log('shuffle  ' + stats.distinctKeys + ' keys across ' + stats.reducers + ' partitions   (' + stats.shuffleMs + ' ms)');
  console.log('reduce   ' + stats.reduceTasks + ' tasks   (' + stats.reduceMs + ' ms)');
  console.log('retries  ' + stats.retries + (stats.failures.length ? '\n  ' + stats.failures.join('\n  ') : ''));
  console.log('total    ' + stats.totalMs + ' ms\n');

  const names = {};
  for (const [k, v] of Object.entries(results)) if (k.startsWith('peer:')) names[k.slice(5)] = v.name;
  const nm = (id) => names[id] || id.slice(0, 9);
  console.log('LINK                        samples   p50    p95    max   jitter  loss%');
  for (const [k, v] of Object.entries(results)) {
    if (!k.startsWith('link:')) continue;
    const [a, b] = k.slice(5).split('~');
    console.log((nm(a) + ' ~ ' + nm(b)).padEnd(26) + String(v.samples).padStart(8) +
      String(v.p50Ms).padStart(7) + String(v.p95Ms).padStart(7) + String(v.maxMs).padStart(7) +
      String(v.meanJitterMs).padStart(8) + String(v.meanLossPct).padStart(7));
  }
  console.log('\nPEER                        samples  offset range (ms)   max D');
  for (const [k, v] of Object.entries(results)) {
    if (!k.startsWith('peer:')) continue;
    console.log(nm(k.slice(5)).padEnd(26) + String(v.samples).padStart(8) +
      ('  ' + v.offsetMinMs + ' .. ' + v.offsetMaxMs).padEnd(20) + String(v.maxDMs).padStart(8));
  }
}
