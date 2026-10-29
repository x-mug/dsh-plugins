import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalSource, DEFAULT_GLOBAL_BUDGETS } from '../src/global-source.js';
import { SearchEngine } from '../src/engine.js';

const ok = value => ({ ok: true, value });
const denied = () => ({ ok: false, error: { code: 'access/denied', message: 'Access denied.' } });
const event = (seq, text, role = 'user') => ({ type: 'event', event: {
  seq, type: `${role}/message`, surfaceOp: 'append',
  data: role === 'user' ? { source: { kind: 'user' }, content: [{ type: 'text', text }] } : { message: { content: [{ type: 'text', text }] } },
} });
const row = (sessionId, cwd = '/workspace', extra = {}) => ({ sessionId, cwd, ...extra });
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(input = {}) {
  const rows = input.rows ?? [row('one')];
  const logs = input.logs ?? { one: [event(0, 'hello')] };
  let workspace = input.workspace ?? { items: [{ workspaceId: 'w', title: 'Workspace', path: '/workspace', sessionIds: rows.map(item => item.sessionId) }], archivedSessionIds: [] };
  const calls = [];
  const batches = [];
  const statuses = [];
  const remote = { session: {
    async list(request, signal) { calls.push({ method: 'list', request, signal }); return input.list ? input.list(request, signal) : ok({ items: rows }); },
    async projections(request, signal) {
      calls.push({ method: 'projections', request, signal });
      return input.projections ? input.projections(request, signal) : ok({ kind: 'sequenced', asOfSeq: logs[request.sessionId].length - 1, values: { title: `Title ${request.sessionId}` } });
    },
    async page(request, signal) {
      calls.push({ method: 'page', request, signal });
      if (input.page) return input.page(request, signal);
      const log = logs[request.address.sessionId];
      const end = request.beforeSeq ?? request.throughSeq + 1;
      const start = Math.max(0, end - request.maxMessages);
      return ok({ records: log.slice(start, end), hasMore: start > 0 });
    },
  } };
  const source = createGlobalSource({ remote, getWorkspaceSnapshot: () => workspace,
    onBatch: async batch => { batches.push(batch); return input.onBatch?.(batch); },
    onStatus: status => { statuses.push(status); input.onStatus?.(status); }, budgets: input.budgets,
  });
  return { source, calls, batches, statuses, setWorkspace(value) { workspace = value; } };
}

test('scans authorized ordinary sessions across every workspace with stable identities', async () => {
  const f = fixture({ rows: [row('one'), row('two', '/second'), row('child', '/workspace', { origin: 'subagent' }), { sessionId: 'no-cwd' }],
    logs: { one: [event(0, 'one needle')], two: [event(0, 'two needle', 'assistant')] },
    workspace: { items: [{ workspaceId: 'a', title: 'A', sessionIds: ['one'] }, { workspaceId: 'b', title: 'B', sessionIds: ['two'] }], archivedSessionIds: [] },
  });
  const state = await f.source.run();
  assert.equal(state.state, 'complete');
  assert.equal(state.scannedSessions, 2);
  assert.equal(state.documents, 2);
  assert.deepEqual(f.batches.map(batch => [batch.session.title, batch.session.workspace, batch.documents[0].sessionId]), [['Title one', 'A', 'one'], ['Title two', 'B', 'two']]);
  assert.notEqual(f.batches[0].documents[0].id, f.batches[1].documents[0].id);
  assert.deepEqual(f.calls.filter(call => call.method === 'page').map(call => call.request.address), [{ kind: 'session', sessionId: 'one' }, { kind: 'session', sessionId: 'two' }]);
  assert.equal(JSON.stringify(f.source.getSnapshot()).includes('needle'), false);
});

test('streams bounded pages to the existing engine without joining session bodies', async () => {
  const engine = new SearchEngine();
  const hits = [];
  const f = fixture({ rows: [row('one'), row('two')], logs: { one: [event(0, 'needle one'), event(1, 'irrelevant'), event(2, 'needle tail')], two: [event(0, 'needle two')] },
    budgets: { pageSize: 1 },
    async onBatch(batch) {
      engine.upsert(batch.documents);
      const result = await engine.query('needle');
      for (const hit of result.items) hits.push({ ...hit, sessionId: batch.session.sessionId });
      engine.remove(batch.documents.map(document => document.id));
      assert.equal(engine.stats().chars, 0);
    },
  });
  const state = await f.source.run();
  assert.equal(state.complete, true);
  assert.deepEqual(hits.map(hit => [hit.sessionId, hit.seq, hit.part, hit.snippet]), [['one', 2, 0, 'needle tail'], ['one', 0, 0, 'needle one'], ['two', 0, 0, 'needle two']]);
  const pages = f.calls.filter(call => call.method === 'page');
  assert.deepEqual(pages.slice(0, 3).map(call => [call.request.throughSeq, call.request.beforeSeq]), [[2, undefined], [2, 2], [2, 1]]);
});

test('defaults to ordinary unarchived and can explicitly include archives', async () => {
  const f = fixture({ rows: [row('one'), row('archived')], logs: { one: [event(0, 'visible')], archived: [event(0, 'archived')] },
    workspace: { items: [], archivedSessionIds: ['archived'] },
  });
  assert.equal((await f.source.run()).sessionsTotal, 1);
  assert.deepEqual(f.batches.map(batch => batch.session.sessionId), ['one']);
  f.batches.length = 0;
  assert.equal((await f.source.run({ includeArchived: true })).complete, true);
  assert.deepEqual(f.batches.map(batch => batch.session.archived), [false, true]);
});

test('archive changes during an RPC prevent delivery and mark the catalog incomplete', async () => {
  let f;
  f = fixture({ page() { f.setWorkspace({ items: [], archivedSessionIds: ['one'] }); return ok({ records: [event(0, 'private')], hasMore: false }); } });
  const state = await f.source.run();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.reason, 'catalog-changed');
  assert.equal(state.skippedSessions, 1);
  assert.equal(f.batches.length, 0);
});

test('archive changes while extraction yields are checked again before delivery', async () => {
  let reads = 0;
  const remote = { session: {
    list: () => ok({ items: [row('one')] }),
    projections: () => ok({ kind: 'sequenced', asOfSeq: 0, values: {} }),
    page: () => ok({ records: [event(0, 'hidden')], hasMore: false }),
  } };
  const batches = [];
  const source = createGlobalSource({ remote, onBatch: batch => batches.push(batch), getWorkspaceSnapshot() {
    reads += 1;
    return { items: [], archivedSessionIds: reads >= 4 ? ['one'] : [] };
  } });
  const state = await source.run();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.skippedSessions, 1);
  assert.equal(batches.length, 0);
});

test('authorization failures stay incomplete and do not contaminate other session results', async () => {
  const f = fixture({ rows: [row('denied'), row('one')], logs: { one: [event(0, 'allowed')] },
    projections: request => request.sessionId === 'denied' ? denied() : ok({ kind: 'sequenced', asOfSeq: 0, values: {} }),
  });
  const state = await f.source.run();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.failedSessions, 1);
  assert.equal(state.errors[0].sessionId, 'denied');
  assert.deepEqual(f.batches.map(batch => batch.session.sessionId), ['one']);
  const deniedPage = fixture({ page: denied });
  assert.equal((await deniedPage.source.run()).state, 'incomplete');
  assert.equal(deniedPage.batches.length, 0);
  const deniedList = fixture({ list: denied });
  assert.equal((await deniedList.source.run()).state, 'failed');
  assert.equal(deniedList.calls.length, 1);
});

test('missing or migration-only projection cursor never declares complete history', async () => {
  for (const projection of [null, { kind: 'migration-required', values: { title: 'cached' } }, { kind: 'sequenced', asOfSeq: -0 }]) {
    const f = fixture({ projections: () => ok(projection) });
    const state = await f.source.run();
    assert.equal(state.state, 'incomplete');
    assert.equal(state.errors[0].code, 'GLOBAL_CURSOR_UNAVAILABLE');
    assert.equal(f.calls.some(call => call.method === 'page'), false);
  }
});

test('strict page cursor proof catches gaps, omitted tail, empty progress and false hasMore', async () => {
  const cases = [
    { records: [event(0, 'a'), event(2, 'c')], hasMore: false },
    { records: [event(0, 'a'), event(1, 'b')], hasMore: false },
    { records: [], hasMore: true },
    { records: [event(1, 'b'), event(2, 'c')], hasMore: false },
    { records: [event(0, 'a'), event(1, 'b'), event(2, 'c')], hasMore: true },
  ];
  for (const value of cases) {
    const f = fixture({ projections: () => ok({ kind: 'sequenced', asOfSeq: 2, values: {} }), page: () => ok(value) });
    const state = await f.source.run();
    assert.equal(state.state, 'incomplete');
    assert.equal(state.errors[0].code, 'GLOBAL_PAGE_GAP');
    assert.equal(f.batches.length, 0);
  }
});

test('empty sessions require an explicit empty zero-boundary page', async () => {
  const f = fixture({ logs: { one: [] } });
  assert.equal((await f.source.run()).complete, true);
  assert.equal(f.batches.length, 0);
  assert.equal(f.calls.at(-1).request.throughSeq, -1);
});

test('cancellation aborts pending RPC promptly and ignores late delivery', async () => {
  const pending = deferred();
  const entered = deferred();
  const f = fixture({ page(request, signal) { entered.resolve(signal); return pending.promise; } });
  const run = f.source.run();
  const signal = await entered.promise;
  f.source.cancel();
  const state = await run;
  assert.equal(signal.aborted, true);
  assert.equal(state.state, 'cancelled');
  pending.resolve(ok({ records: [event(0, 'late')], hasMore: false }));
  await Promise.resolve();
  assert.equal(f.batches.length, 0);
  assert.equal(f.source.getSnapshot().state, 'cancelled');
});

test('cancellation while the Worker consumes a page stops subsequent delivery', async () => {
  const pending = deferred();
  const entered = deferred();
  const f = fixture({ logs: { one: [event(0, 'first'), event(1, 'tail')] }, budgets: { pageSize: 1 },
    onBatch(batch) { entered.resolve(batch.signal); return pending.promise; },
  });
  const run = f.source.run();
  const signal = await entered.promise;
  f.source.cancel();
  assert.equal((await run).state, 'cancelled');
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.filter(call => call.method === 'page').length, 1);
  pending.resolve();
  await Promise.resolve();
  assert.equal(f.batches.length, 1);
  assert.equal(f.source.getSnapshot().state, 'cancelled');
});

test('external abort and supersession cannot publish old run status over a new run', async () => {
  const pending = deferred();
  const entered = deferred();
  let calls = 0;
  const f = fixture({ page() { calls += 1; if (calls === 1) { entered.resolve(); return pending.promise; } return ok({ records: [event(0, 'new')], hasMore: false }); } });
  const old = f.source.run();
  await entered.promise;
  const next = await f.source.run();
  assert.equal(next.runId, 2);
  assert.equal((await old).state, 'cancelled');
  assert.equal(f.source.getSnapshot().runId, 2);
  pending.resolve(ok({ records: [event(0, 'old')], hasMore: false }));
  assert.deepEqual(f.batches.map(batch => batch.documents[0].text), ['new']);
  const abort = new AbortController();
  abort.abort();
  assert.equal((await f.source.run({ signal: abort.signal })).state, 'cancelled');
});

test('onBatch backpressure prevents fetching another page until consumption finishes', async () => {
  const pending = deferred();
  const entered = deferred();
  let held = false;
  const f = fixture({ logs: { one: [event(0, 'a'), event(1, 'b')] }, budgets: { pageSize: 1 },
    onBatch() { if (!held) { held = true; entered.resolve(); return pending.promise; } },
  });
  const run = f.source.run();
  await entered.promise;
  assert.equal(f.calls.filter(call => call.method === 'page').length, 1);
  pending.resolve();
  assert.equal((await run).complete, true);
  assert.equal(f.calls.filter(call => call.method === 'page').length, 2);
});

test('total memory and per-batch budgets stop scans with incrementally delivered documents', async () => {
  for (const budgets of [{ maxBytes: 2 }, { maxBatchBytes: 2 }]) {
    const f = fixture({ logs: { one: [event(0, 'a'), event(1, 'b')] }, budgets });
    const state = await f.source.run();
    assert.equal(state.state, 'incomplete');
    assert.equal(state.bytes, 2);
    assert.equal(state.documents, 1);
    assert.equal(state.scannedSessions, 0);
    assert.equal(state.currentSessionId, 'one');
    assert.equal(state.throughSeq, 1);
    assert.equal(state.beforeSeq, 0);
    assert.equal(f.batches[0].documents.length, 1);
    assert.match(state.reason, /memory-limit/u);
    assert.equal(f.source.getSnapshot().bytes, 2);
  }
});

test('document, page, session and consumer limits remain explicit', async () => {
  const docs = fixture({ logs: { one: [event(0, 'a'), event(1, 'b')] }, budgets: { maxDocuments: 1 } });
  assert.equal((await docs.source.run()).reason, 'document-limit');
  const pages = fixture({ logs: { one: [event(0, 'a'), event(1, 'b')] }, budgets: { maxPages: 1, pageSize: 1 } });
  assert.equal((await pages.source.run()).reason, 'page-limit');
  const sessions = fixture({ rows: [row('one'), row('two')], logs: { one: [event(0, 'a')], two: [event(0, 'b')] }, budgets: { maxSessions: 1 } });
  const state = await sessions.source.run();
  assert.equal(state.reason, 'session-limit');
  assert.equal(state.sessionsTotal, 2);
  assert.equal(state.scannedSessions, 1);
  const consumer = fixture({ onBatch: () => ({ stop: true, reason: 'result-limit' }) });
  assert.equal((await consumer.source.run()).reason, 'result-limit');
});

test('snapshot copies cannot change live counters or retained error details', async () => {
  const f = fixture({ page: denied });
  await f.source.run();
  const state = f.source.getSnapshot();
  state.errors[0].message = 'changed';
  state.errors.push({ message: 'added' });
  state.bytes = 999;
  assert.equal(f.source.getSnapshot().errors.length, 1);
  assert.equal(f.source.getSnapshot().errors[0].message, 'Access denied.');
  assert.equal(f.source.getSnapshot().bytes, 0);
});

test('error delivery is bounded even when many authorized sessions fail', async () => {
  const f = fixture({ rows: Array.from({ length: 25 }, (_, index) => row(`denied-${index}`)), projections: denied });
  const state = await f.source.run();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.failedSessions, 25);
  assert.equal(state.errors.length, 20);
  assert.equal(state.omittedErrors, 5);
});

test('dispose aborts pending work and forbids another run', async () => {
  const entered = deferred();
  const f = fixture({ page() { entered.resolve(); return new Promise(() => {}); } });
  const run = f.source.run();
  await entered.promise;
  f.source.dispose();
  assert.equal((await run).state, 'cancelled');
  assert.equal(f.source.getSnapshot().reason, 'disposed');
  await assert.rejects(f.source.run(), /disposed/u);
});

test('oversized event pages and callback failures are visible', async () => {
  const events = fixture({ logs: { one: [event(0, 'a'), event(1, 'b')] }, budgets: { maxPageEvents: 1 } });
  assert.equal((await events.source.run()).errors[0].code, 'GLOBAL_PAGE_EVENT_LIMIT');
  const callback = fixture({ onBatch() { throw new Error('Worker timeout'); } });
  const state = await callback.source.run();
  assert.equal(state.state, 'failed');
  assert.equal(state.errors[0].code, 'GLOBAL_CONSUMER_FAILED');
});

test('time budget aborts ignored RPC promises without starting further work', async () => {
  const f = fixture({ list: () => new Promise(() => {}), budgets: { maxElapsedMs: 5 } });
  const state = await f.source.run();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.reason, 'time-limit');
  assert.equal(f.calls[0].signal.aborted, true);
});

test('unknown archive state fails closed and budget validation is strict', async () => {
  const f = fixture({ workspace: { items: [] } });
  assert.equal((await f.source.run()).state, 'failed');
  assert.equal(f.calls.length, 0);
  assert.equal(DEFAULT_GLOBAL_BUDGETS.maxBytes, 128 * 1024 * 1024);
  for (const budgets of [{ maxBytes: -1 }, { pageSize: 501 }, { unknown: 1 }]) assert.throws(() => fixture({ budgets }), TypeError);
});
