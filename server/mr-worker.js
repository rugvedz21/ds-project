// ---------------------------------------------------------------------------
// mr-worker.js -- one MapReduce TASK, run in its own worker thread.
//
// A worker thread has its own V8 heap and event loop and shares no JavaScript
// state with the coordinator, so it stands in for a Hadoop task container: it
// is handed its input, does its work, reports its output, and exits. Anything
// it needs must be sent to it; anything it produces must be sent back.
// ---------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { phase, jobPath, input, reducers, failRate } = workerData;

// Failure injection, so the framework's re-execution path can be demonstrated
// on demand. Real clusters do not need help with this part.
if (failRate > 0 && Math.random() < failRate) {
  throw new Error('injected task failure (' + phase + ')');
}

const job = await import(pathToFileURL(jobPath).href);

if (phase === 'map') {
  // Partition as we emit: partition = hash(key) mod R. Every map task uses the
  // same function, so all values for one key land at the same reducer no
  // matter which map task produced them -- that is what makes the shuffle
  // correct.
  const partitions = Array.from({ length: reducers }, () => []);
  let pairs = 0;
  const emit = (key, value) => { partitions[hash(key) % reducers].push([key, value]); pairs++; };
  for (const line of input) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    job.map(record, emit);
  }
  parentPort.postMessage({ partitions, pairs });
} else {
  // input is [[key, [values...]], ...], already sorted by key.
  parentPort.postMessage({ results: input.map(([key, values]) => [key, job.reduce(key, values)]) });
}

function hash(s) {
  let h = 2166136261;                       // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
