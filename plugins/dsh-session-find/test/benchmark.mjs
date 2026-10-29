import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, release } from 'node:os';
import { Worker } from 'node:worker_threads';
import { SearchEngine } from '../src/engine.js';

export const measuredBaseline = {
  measuredAt: '2026-10-29T04:32:14.890Z',
  command: 'node --expose-gc test/benchmark.mjs',
  environment: { node: 'v24.18.0', os: 'Windows 10.0.26100', cpu: 'AMD Ryzen 9 9900X', logicalCpus: 24, ramGiB: 125.651 },
  repetitions: 11,
  concurrentSystemLoad: 'Other integration work was running; these are observed values, not isolated editor comparisons.',
  sparseIgnoreCase: [
    { corpus: 'ASCII', utf8MiB: 10, medianMs: 3.551, p95Ms: 4.121, workerMedianMs: 18.236, workerP95Ms: 33.997, mainImmediateMs: 0.136, maxTimerDriftMs: 8.224 },
    { corpus: 'ASCII', utf8MiB: 50, medianMs: 11.802, p95Ms: 13.363, workerMedianMs: 29.787, workerP95Ms: 36.293, mainImmediateMs: 0.112, maxTimerDriftMs: 32.327 },
    { corpus: 'ASCII', utf8MiB: 100, medianMs: 16.358, p95Ms: 21.595, workerMedianMs: 47.948, workerP95Ms: 113.783, mainImmediateMs: 0.072, maxTimerDriftMs: 7.965 },
    { corpus: 'CJK + emoji + ASCII', utf8MiB: 17.322, utf16MiUnits: 10, medianMs: 1.513, p95Ms: 3.027, workerMedianMs: 15.3, workerP95Ms: 17.814, mainImmediateMs: 0.269, maxTimerDriftMs: 13.893 },
  ],
  memory: { indexBytesAt100kCap: 1200000, foldCacheCharCap: 16777216, textDefaultCharCap: 67108864, defaultTextByteUpperBound: 134217728, observedProcessRssMiB: [128.289, 319.699, 538.555, 578.973], caveat: 'RSS includes source docs, worker, V8 reservations and prior runs; samples are not peaks or browser memory.' },
};

const MiB = 1024 * 1024;
const sizes = (process.env.FIND_BENCH_MIB || '10,50,100').split(',').map(Number).filter(size => size > 0 && size <= 256);
const repetitions = Math.max(3, Math.min(50, Number(process.env.FIND_BENCH_RUNS) || 11));
const blockChars = 64 * 1024;
const workerModule = new URL('../src/worker.js', import.meta.url).href;
const cases = [
  { name: 'literal case-sensitive miss', query: 'not_present_7C1B9E', options: { matchCase: true } },
  { name: 'ASCII ignore-case miss', query: 'not_present_7c1b9e', options: {} },
  { name: 'ASCII ignore-case sparse hit', query: 'needle_42z', options: {} },
  { name: 'ASCII whole-word sparse hit', query: 'needle_42z', options: { wholeWord: true } },
  { name: 'regex sparse hit', query: 'NEEDLE_[0-9]+Z', options: { regex: true } },
  { name: 'dense hit capped at 100k', query: 'alpha', options: {} },
];
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const round = value => Math.round(value * 1000) / 1000;
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [key + 'MiB', round(value / MiB)]));

function dataset(chars, mixed = false) {
  const line = mixed ? '当前会话查询与工具输出 😀 中文推理状态完成， identifierAlpha methodCall UTF16Offsets 正确保留。\n' : 'alpha beta Gamma delta epsilon zeta eta theta iota kappa lambda mu.\n';
  const body = line.repeat(Math.ceil(blockChars / line.length));
  const docs = [];
  let remaining = chars;
  for (let index = 0; remaining > 0; index++) {
    const length = Math.min(blockChars, remaining);
    const marker = `message_${index.toString().padStart(6, '0')} NEEDLE_42Z `;
    docs.push({ id: `${index}:0`, seq: index, part: 0, role: index % 2 ? 'assistant' : 'user', text: (marker + body).slice(0, length) });
    remaining -= length;
  }
  return docs;
}

function workerRpc() {
  const worker = new Worker(`const {parentPort} = require('node:worker_threads'); import(${JSON.stringify(workerModule)}).then(({createEngineServer}) => createEngineServer(parentPort));`, { eval: true });
  let next = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  worker.on('message', message => {
    if (message.type === 'ready') readyResolve(message);
    if (message.type === 'progress') return;
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    clearTimeout(waiter.timeout);
    if (message.type === 'error') waiter.reject(Object.assign(new Error(message.error.message), message.error));
    else waiter.resolve(message);
  });
  worker.on('error', error => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(error); }
    pending.clear();
  });
  return {
    worker, ready,
    call(type, fields = {}) {
      const requestId = ++next;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Benchmark ${type} timeout.`)); }, 20000);
        pending.set(requestId, { resolve, reject, timeout });
        worker.postMessage({ type, requestId, ...fields });
      });
    },
  };
}

const report = {
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: round(totalmem() / 1024 ** 3) },
  methodology: {
    payload: 'ASCII input bytes; each source character is one byte, while conservative engine text accounting is two bytes per UTF-16 unit.',
    engine: 'single-thread searchSync, one warmup then repeated queries; result count + first 50 snippets, page ordinal 100k cap; 16Mi-unit folded cache.',
    worker: 'one Node worker_threads worker; same server source as browser Blob Worker; query promises include worker scheduling and transport.',
    responsiveness: 'setImmediate callback latency on main thread while worker query is in flight; maximum observed 2ms interval drift during that query.',
    memory: 'process.memoryUsage samples are observations, not browser peak memory; native/browser overhead is not measured.',
    repetitions,
  },
  datasets: [],
};

const scenarios = [...sizes.map(size => ({ size, mixed: false })), { size: 10, mixed: true }];
for (const { size, mixed } of scenarios) {
  const bytes = Math.round(size * MiB);
  globalThis.gc?.();
  const before = memory();
  const docs = dataset(bytes, mixed);
  const options = { maxTotalChars: bytes + 1024, foldCacheChars: 16 * MiB, maxMatches: 100000 };
  const engine = new SearchEngine(options);
  const start = performance.now();
  const ingestion = engine.upsert(docs);
  const entry = { corpus: mixed ? 'mixed CJK + emoji + ASCII identifiers' : 'ASCII', targetMiUnits: size, payloadUtf8MiB: round(docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.text), 0) / MiB), utf16Chars: bytes, conservativeTextMiB: bytes * 2 / MiB, docs: docs.length, ingestMs: round(performance.now() - start), rejected: ingestion.rejected.length, cases: [], memoryBefore: before };
  const specs = mixed ? [
    { name: 'CJK literal miss', query: '不存在的词组', options: {} },
    { name: 'mixed ASCII ignore-case sparse hit', query: 'needle_42z', options: {} },
    { name: 'mixed ASCII case-sensitive sparse hit', query: 'NEEDLE_42Z', options: { matchCase: true } },
    { name: 'CJK literal dense capped', query: '当前会话', options: {} },
  ] : cases;
  for (const spec of specs) {
    let result;
    const coldStart = performance.now();
    result = engine.searchSync(spec.query, spec.options);
    const coldMs = performance.now() - coldStart;
    const elapsed = [];
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const queryStart = performance.now();
      result = engine.searchSync(spec.query, spec.options);
      elapsed.push(performance.now() - queryStart);
    }
    const pageStart = performance.now();
    const page = engine.page(result.id, { offset: Math.max(0, result.total - 50), limit: 50 });
    entry.cases.push({ name: spec.name, coldMs: round(coldMs), medianMs: round(quantile(elapsed, 0.5)), p95Ms: round(quantile(elapsed, 0.95)), lastPageMs: round(performance.now() - pageStart), total: result.total, truncated: result.truncated, returnedItems: result.items.length, pageBytes: Buffer.byteLength(JSON.stringify(page)) });
  }
  entry.engineStats = engine.stats();
  entry.memoryAfterQueries = memory();
  engine.clear();
  globalThis.gc?.();
  const rpc = workerRpc();
  try {
    await rpc.ready;
    const initStart = performance.now();
    const ack = await rpc.call('reset', { docs, options });
    entry.workerResetMs = round(performance.now() - initStart);
    if (ack.rejected.length) throw new Error('Worker rejected benchmark documents.');
    await rpc.call('query', { query: 'needle_42z' });
    const workerTimes = [];
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const queryStart = performance.now();
      await rpc.call('query', { query: 'needle_42z' });
      workerTimes.push(performance.now() - queryStart);
    }
    let previous = performance.now();
    let maxTimerDrift = 0;
    const interval = setInterval(() => {
      const current = performance.now();
      maxTimerDrift = Math.max(maxTimerDrift, current - previous - 2);
      previous = current;
    }, 2);
    const queryStart = performance.now();
    const running = rpc.call('query', { query: 'not_present_7c1b9e' });
    const postStart = performance.now();
    await new Promise(resolve => setImmediate(resolve));
    const callbackMs = performance.now() - postStart;
    await running;
    clearInterval(interval);
    entry.worker = { sparseMedianMs: round(quantile(workerTimes, 0.5)), sparseP95Ms: round(quantile(workerTimes, 0.95)), responsiveQueryMs: round(performance.now() - queryStart), mainImmediateMs: round(callbackMs), mainMaxTimerDriftMs: round(maxTimerDrift) };
    entry.memoryWithWorker = memory();
  } finally { await rpc.worker.terminate(); }
  report.datasets.push(entry);
  console.log(JSON.stringify(entry));
}
console.log('FIND_BENCHMARK_REPORT');
console.log(JSON.stringify(report, null, 2));
