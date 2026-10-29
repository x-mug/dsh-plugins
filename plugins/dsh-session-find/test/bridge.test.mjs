import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { SearchWorkerBridge } from '../src/bridge.js';

const workerUrl = new URL('../src/worker.js', import.meta.url).href;

function installWorkerAdapter() {
  const prior = globalThis.Worker;
  const workers = [];
  class BrowserWorkerAdapter {
    constructor() {
      this.native = new NodeWorker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(workerUrl)}).then(({createEngineServer})=>createEngineServer(parentPort));`, { eval: true });
      this.native.on('message', (data) => this.onmessage?.({ data }));
      this.native.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
      workers.push(this);
    }
    postMessage(value) { this.native.postMessage(value); }
    terminate() { return this.native.terminate(); }
  }
  globalThis.Worker = BrowserWorkerAdapter;
  return { workers, restore: () => { globalThis.Worker = prior; } };
}

test('bridge transports real Worker results, pages and incremental changes', async () => {
  const adapter = installWorkerAdapter();
  const bridge = new SearchWorkerBridge('');
  try {
    await bridge.upsert([{ id: '1:0', seq: 1, part: 0, role: 'user', text: '命中 '.repeat(70) }]);
    const result = await bridge.query('命中', {});
    assert.equal(result.total, 70);
    assert.equal(result.items.length, 50);
    const page = await bridge.page(result.id, 50);
    assert.equal(page.items.length, 20);
    await bridge.remove(['1:0']);
    assert.equal((await bridge.query('命中', {})).total, 0);
  } finally { bridge.dispose(); await Promise.all(adapter.workers.map((worker) => worker.terminate())); adapter.restore(); }
});

test('watchdog terminates a pathological regex and restores documents for the next query', async () => {
  const adapter = installWorkerAdapter();
  const changes = [];
  const bridge = new SearchWorkerBridge('', (change) => changes.push(change));
  try {
    await bridge.upsert([{ id: '1:0', seq: 1, part: 0, role: 'user', text: 'a'.repeat(30000) + '!' }]);
    await assert.rejects(bridge.request('query', { query: '(a+)+$', options: { regex: true } }, { timeoutMs: 150 }), { code: 'WORKER_TIMEOUT' });
    assert.equal(adapter.workers.length, 2);
    assert.equal(changes[0].reset, true);
    const result = await bridge.query('!', { matchCase: true });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].offset, 30000);
  } finally { bridge.dispose(); await Promise.all(adapter.workers.map((worker) => worker.terminate())); adapter.restore(); }
});

test('cancelled queries clear their watchdog before a replacement can be affected', async () => {
  const prior = globalThis.Worker;
  let created = 0;
  globalThis.Worker = class { constructor() { created++; } postMessage() {} terminate() {} };
  const bridge = new SearchWorkerBridge('');
  try {
    const pending = bridge.request('query', { query: 'old' }, { timeoutMs: 15 });
    bridge.cancel();
    await assert.rejects(pending, { code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created, 1);
    assert.equal(bridge.pending.size, 0);
  } finally { bridge.dispose(); globalThis.Worker = prior; }
});

test('typing after a running regex terminates its Worker so queued mutations cannot hang', async () => {
  const adapter = installWorkerAdapter();
  const bridge = new SearchWorkerBridge('');
  try {
    await bridge.upsert([{ id: '1:0', seq: 1, part: 0, role: 'user', text: 'a'.repeat(30000) + '!' }]);
    const query = bridge.query('(a+)+$', { regex: true });
    const rejection = assert.rejects(query, { code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.cancel();
    await rejection;
    await bridge.upsert([{ id: '2:0', seq: 2, part: 0, role: 'assistant', text: 'new hit' }]);
    const result = await bridge.query('new hit', {});
    assert.equal(result.total, 1);
    assert.equal(adapter.workers.length, 2);
  } finally { bridge.dispose(); await Promise.all(adapter.workers.map((worker) => worker.terminate())); adapter.restore(); }
});

test('built Worker Blob is valid and auto-starts inside a browser Worker scope', async () => {
  const source = await readFile(new URL('./worker-built.js', import.meta.url), 'utf8');
  const worker = new NodeWorker(`const {parentPort}=require('node:worker_threads'); class WorkerGlobalScope{}; globalThis.WorkerGlobalScope=WorkerGlobalScope; Object.setPrototypeOf(globalThis,WorkerGlobalScope.prototype); globalThis.postMessage=(m)=>parentPort.postMessage(m); globalThis.addEventListener=(type,fn)=>parentPort.on('message',(data)=>fn({data}));\n${source}`, { eval: true });
  try {
    const ready = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(ready.type, 'ready');
  } finally { await worker.terminate(); }
});
