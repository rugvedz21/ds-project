// ---------------------------------------------------------------------------
// link-stats.js -- a MapReduce JOB over recorded telemetry.  (Unit 4: Hadoop)
//
// Input:  telemetry samples, one JSON object per line, as written by the
//         server's telemetry sink. Each sample is one peer's view of its
//         links at one instant.
// Output: per LINK -- p50 / p95 / max one-way delay, mean jitter, mean loss;
//         per PEER -- clock-offset spread and the largest D it computed.
//
// A job is just two pure functions. Everything else -- splitting the input,
// running tasks in parallel, retrying failures, shuffling, sorting -- is the
// framework's job (server/mapreduce.js). That separation is the whole idea of
// MapReduce: the author writes the per-record logic, the framework owns the
// distribution.
// ---------------------------------------------------------------------------

/**
 * map(record, emit): called once per input line.
 *
 * A link is reported by BOTH of its endpoints. Keying it by the sorted pair
 * of peer ids makes the two reports collide in the shuffle and be reduced
 * together -- the key design is where the real thinking in a MapReduce job
 * goes.
 */
export function map(record, emit) {
  if (!record || !record.peerId) return;
  emit('peer:' + record.peerId, {
    name: record.peerName,
    offset: record.clockOffsetMs,
    D: record.commonDeadlineMs,
  });
  for (const [other, l] of Object.entries(record.links || {})) {
    const key = 'link:' + [record.peerId, other].sort().join('~');
    emit(key, { oneWay: l.oneWayMs, jitter: l.jitterMs, loss: l.lossPct });
  }
}

/** reduce(key, values): called once per distinct key, with every value for it. */
export function reduce(key, values) {
  if (key.startsWith('peer:')) {
    const offsets = values.map((v) => v.offset).filter(Number.isFinite);
    return {
      name: values.find((v) => v.name)?.name || '',
      samples: values.length,
      offsetMinMs: round(Math.min(...offsets)),
      offsetMaxMs: round(Math.max(...offsets)),
      maxDMs: round(Math.max(...values.map((v) => v.D || 0))),
    };
  }
  const d = values.map((v) => v.oneWay).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: round(pct(d, 0.5)),
    p95Ms: round(pct(d, 0.95)),
    maxMs: round(d[d.length - 1] || 0),
    meanJitterMs: round(mean(values.map((v) => v.jitter))),
    meanLossPct: round(mean(values.map((v) => v.loss))),
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const mean = (xs) => {
  const f = xs.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
};
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
