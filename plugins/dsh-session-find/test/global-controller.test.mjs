import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalFindController } from '../src/global-controller.js';
import { createGlobalSource } from '../src/global-source.js';
import { createEngineServer } from '../src/worker.js';

const ok = value => ({ ok: true, value });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function message(seq, text, role = 'user', part = 0) {
  const content = [...Array.from({ length: part }, () => ({ type: 'image', data: 'excluded' })), { type: 'text', text }];
  return { type: 'event', event: { seq, type: `${role}/message`, surfaceOp: 'append',
    data: role === 'user' ? { source: { kind: 'user' }, content } : { turn: 7, step: 8, message: { content } },
  } };
}

function workerBridge(hooks = {}) {
  const bridges = [];
  const events = [];
  class Bridge {
    constructor(_workerText, change) {
      this.change = change;
      this.pending = new Map();
      this.nextId = 0;
      this.disposed = false;
      this.docs = new Map();
      this.peakDocs = 0;
      this.peakChars = 0;
      this.server = createEngineServer({ postMessage: data => {
        const copy = structuredClone(data);
        queueMicrotask(() => {
          const pending = this.pending.get(copy.requestId);
          if (!pending) return;
          if (copy.type === 'progress') return;
          this.pending.delete(copy.requestId);
          if (copy.type === 'error') pending.reject(Object.assign(new Error(copy.error.message), { code: copy.error.code }));
          else if (copy.type === 'cancelled') pending.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          else pending.resolve(copy.result ?? copy);
        });
      } });
      bridges.push(this);
    }
    request(type, payload = {}) {
      if (this.disposed) return Promise.reject(Object.assign(new Error('disposed'), { code: 'CANCELLED' }));
      const request = structuredClone({ type, requestId: ++this.nextId, ...payload });
      events.push({ bridge: this, ...request });
      return new Promise((resolve, reject) => {
        this.pending.set(request.requestId, { resolve, reject });
        Promise.resolve().then(() => hooks.beforeReceive?.(request, this)).then(() => {
          if (this.disposed) return;
          this.server.receive(request);
          const stats = this.server.engine.stats();
          this.peakDocs = Math.max(this.peakDocs, stats.docs);
          this.peakChars = Math.max(this.peakChars, stats.chars);
        }).catch(reject);
      });
    }
    async upsert(documents) {
      for (const document of documents) this.docs.set(document.id, document);
      const result = await this.request('upsert', { docs: documents });
      if (result.rejected.length || result.evictedIds.length) throw new Error('Worker rejected documents.');
      return result;
    }
    async remove(ids) {
      for (const id of ids) this.docs.delete(id);
      return this.request('remove', { ids });
    }
    query(query, options) { return this.request('query', { query, options }); }
    page(id, offset, limit) { return this.request('page', { id, offset, limit }); }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const pending of this.pending.values()) pending.reject(Object.assign(new Error('disposed'), { code: 'CANCELLED' }));
      this.pending.clear();
      this.server.dispose();
      this.docs.clear();
    }
  }
  return { Bridge, bridges, events };
}

function fixture(t, options = {}) {
  const logs = options.logs ?? { current: [message(0, 'needle current')] };
  const ids = Object.keys(logs);
  const calls = [];
  const sources = [];
  const selections = [];
  const worker = workerBridge(options.workerHooks);
  let workspaces = options.workspaces ?? { items: ids.map(id => ({ workspaceId: `w-${id}`, title: `Workspace ${id}`, sessionIds: [id] })), archivedSessionIds: [] };
  const ctx = {
    workspaces: { list: { getSnapshot: () => workspaces } },
    remote: { session: {
      list(request, signal) {
        calls.push({ method: 'list', request, signal });
        return options.list?.(request, signal) ?? ok({ items: ids.map(sessionId => ({ sessionId, cwd: `/cwd/${sessionId}` })) });
      },
      projections(request, signal) {
        calls.push({ method: 'projections', request, signal });
        return ok({ kind: 'sequenced', asOfSeq: logs[request.sessionId].length - 1, values: { title: `Title ${request.sessionId}` } });
      },
      page(request, signal) {
        calls.push({ method: 'page', request, signal });
        const custom = options.page?.(request, signal);
        if (custom !== undefined) return custom;
        const end = request.beforeSeq ?? request.throughSeq + 1;
        const start = Math.max(0, end - request.maxMessages);
        return ok({ records: logs[request.address.sessionId].slice(start, end), hasMore: start > 0 });
      },
    } },
  };
  const controller = new GlobalFindController({ ctx, workerText: '', Bridge: worker.Bridge,
    maxResults: options.maxResults ?? 5000,
    createSource(callbacks) {
      const source = createGlobalSource({ ...callbacks, budgets: options.budgets });
      sources.push({ source, callbacks });
      return source;
    },
    onSelect(hit, query, searchOptions) {
      selections.push({ hit, query, options: searchOptions });
      return options.onSelect?.(hit, query, searchOptions);
    },
  });
  controller.start();
  t.after(() => controller.dispose());
  return { controller, ctx, ...worker, calls, sources, selections,
    setWorkspaces(value) { workspaces = value; },
    getWorkspaces() { return workspaces; },
    async search(query = 'needle') {
      controller.setQuery(query);
      clearTimeout(controller.timer);
      return controller.search(controller.revision);
    },
  };
}

function summary(controller) {
  return { state: controller.getSnapshot().source.state, total: controller.getSnapshot().result?.total, busy: controller.getSnapshot().busy };
}

test('real Worker protocol drains result pages, caps the combined set and releases page bodies', async t => {
  const f = fixture(t, { logs: { first: [message(0, 'needle '.repeat(70))], second: [message(0, 'needle '.repeat(70))], unscanned: [message(0, 'needle')] }, maxResults: 83 });
  await f.search();
  const state = f.controller.getSnapshot();
  assert.equal(state.busy, false);
  assert.equal(state.result.total, 83);
  assert.equal(state.result.items.length, 50);
  assert.equal(state.result.truncated, true);
  assert.equal(state.source.state, 'incomplete');
  assert.equal(state.source.reason, 'result-limit');
  assert.deepEqual(f.events.filter(event => event.type === 'query').map(event => [event.options.maxMatches, event.options.limit]), [[83, 50], [13, 50]]);
  assert.deepEqual(f.events.filter(event => event.type === 'page').map(event => [event.offset, event.limit]), [[50, 50]]);
  assert.deepEqual(f.calls.filter(call => call.method === 'page').map(call => call.request.address.sessionId), ['first', 'second']);
  assert.equal(f.events.filter(event => event.type === 'remove').length, 2);
  assert.equal(f.bridges[0].peakDocs, 1);
  assert.equal(f.bridges[0].server.engine.stats().chars, 0);
  assert.equal(f.bridges[0].disposed, true);
  f.controller.page(50);
  assert.equal(f.controller.getSnapshot().result.items.length, 33);
  assert.deepEqual(f.controller.getSnapshot().result.items.slice(20).map(hit => hit.sessionId), Array(13).fill('second'));
  assert.deepEqual(f.controller.getSnapshot().result.items.map(hit => hit.ordinal), Array.from({ length: 33 }, (_, index) => index + 50));
  f.controller.page(9999);
  assert.equal(f.controller.getSnapshot().pageOffset, 50);
  f.controller.page(-1);
  assert.equal(f.controller.getSnapshot().pageOffset, 0);
});

test('each RPC page is consumed and removed before the next page while metadata stays attached', async t => {
  const f = fixture(t, { logs: { alpha: [message(0, 'needle alpha', 'assistant', 2), message(1, 'no hit'), message(2, 'needle tail')], beta: [message(0, 'needle beta', 'assistant', 2)] }, budgets: { pageSize: 1 },
    workerHooks: { beforeReceive(request, bridge) {
      if (request.type === 'upsert') assert.equal(bridge.server.engine.stats().docs, 0);
    } },
  });
  await f.search();
  assert.deepEqual(summary(f.controller), { state: 'complete', total: 3, busy: false });
  assert.equal(f.bridges[0].peakDocs, 1);
  assert.equal(f.events.filter(event => event.type === 'upsert').length, 4);
  assert.equal(f.events.filter(event => event.type === 'remove').length, 4);
  const hits = f.controller.getSnapshot().result.items;
  assert.deepEqual(hits.map(hit => [hit.sessionId, hit.title, hit.workspace, hit.seq, hit.part, hit.snippet]), [
    ['alpha', 'Title alpha', 'Workspace alpha', 2, 0, 'needle tail'],
    ['alpha', 'Title alpha', 'Workspace alpha', 0, 2, 'needle alpha'],
    ['beta', 'Title beta', 'Workspace beta', 0, 2, 'needle beta'],
  ]);
  assert.notEqual(hits[1].docId, hits[2].docId);
  assert.equal(hits[1].turn, 7);
  assert.equal(hits[2].step, 8);
});

test('page and memory budgets preserve partial results without claiming the corpus is complete', async t => {
  for (const budgets of [{ pageSize: 1, maxPages: 1 }, { pageSize: 1, maxBytes: 'needle tail'.length * 2 }]) {
    const f = fixture(t, { logs: { current: [message(0, 'needle first'), message(1, 'needle tail')] }, budgets });
    await f.search();
    const state = f.controller.getSnapshot();
    assert.equal(state.result.total, 1);
    assert.equal(state.result.items[0].snippet, 'needle tail');
    assert.equal(state.source.state, 'incomplete');
    assert.equal(state.source.complete, false);
    assert.equal(state.busy, false);
    assert.equal(f.bridges[0].server.engine.stats().chars, 0);
  }
});

test('options are executed by the Worker and selection retains the exact current-session coordinates', async t => {
  const f = fixture(t, { logs: { current: [message(0, 'needleX needle', 'assistant', 1)], other: [message(0, 'NEEDLE')] } });
  f.controller.toggle('wholeWord');
  clearTimeout(f.controller.timer);
  f.controller.toggle('matchCase');
  clearTimeout(f.controller.timer);
  await f.search();
  assert.equal(f.controller.getSnapshot().result.total, 1);
  await f.controller.select(0);
  assert.equal(f.selections.length, 1);
  const { hit, query, options } = f.selections[0];
  assert.equal(query, 'needle');
  assert.equal(options.wholeWord, true);
  assert.equal(options.matchCase, true);
  assert.equal(hit.sessionId, 'current');
  assert.equal(hit.seq, 0);
  assert.equal(hit.part, 1);
  assert.equal(hit.offset, 8);
  assert.equal(hit.matchedText, 'needle');
});

test('superseded pending RPC and stale source or Worker callbacks cannot change the replacement result', async t => {
  const gate = deferred();
  const entered = deferred();
  let first = true;
  const f = fixture(t, { page(request, signal) {
    if (first) { first = false; entered.resolve(signal); return gate.promise; }
  } });
  const oldSearch = f.search('old');
  const oldSignal = await entered.promise;
  await f.search('needle');
  await oldSearch;
  assert.equal(oldSignal.aborted, true);
  const latest = f.controller.getSnapshot();
  const newBridge = f.bridges[1];
  f.sources[0].callbacks.onStatus({ state: 'failed', error: 'stale source', documents: 999 });
  f.bridges[0].change({ error: 'stale Worker' });
  const response = await f.sources[0].callbacks.onBatch({ session: { sessionId: 'stale' }, documents: [{ id: 'stale', seq: 0, part: 0, role: 'user', text: 'old' }], signal: new AbortController().signal });
  assert.equal(response.stop, true);
  gate.resolve(ok({ records: [message(0, 'old')], hasMore: false }));
  await Promise.resolve();
  assert.equal(f.controller.getSnapshot(), latest);
  assert.equal(f.controller.getSnapshot().result.items[0].sessionId, 'current');
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.events.filter(event => event.bridge === newBridge && event.type === 'remove').length, 1);
  assert.equal(f.bridges[0].disposed, true);
});

test('replacing a query during result pagination cannot append or remove the new generation', async t => {
  const gate = deferred();
  const entered = deferred();
  let held = false;
  const f = fixture(t, { logs: { current: [message(0, 'needle '.repeat(75))] }, workerHooks: { beforeReceive(request) {
    if (request.type === 'page' && !held) { held = true; entered.resolve(); return gate.promise; }
  } } });
  const old = f.search();
  await entered.promise;
  await f.search('absent');
  await old;
  const result = f.controller.getSnapshot();
  gate.resolve();
  await Promise.resolve();
  assert.equal(f.controller.getSnapshot(), result);
  assert.equal(result.result.total, 0);
  assert.equal(result.source.state, 'complete');
  assert.equal(f.bridges[0].disposed, true);
  assert.equal(f.bridges[0].server.engine.stats().chars, 0);
  assert.equal(f.events.filter(event => event.bridge === f.bridges[1] && event.type === 'remove').length, 1);
});

test('cancel during Worker matching releases its bodies and permits a clean new generation', async t => {
  const gate = deferred();
  const entered = deferred();
  let held = false;
  const f = fixture(t, { workerHooks: { beforeReceive(request) {
    if (request.type === 'query' && !held) { held = true; entered.resolve(); return gate.promise; }
  } } });
  const first = f.search();
  await entered.promise;
  f.controller.cancel();
  await first;
  assert.equal(f.controller.getSnapshot().source.state, 'cancelled');
  assert.equal(f.controller.getSnapshot().busy, false);
  assert.equal(f.bridges[0].disposed, true);
  assert.equal(f.bridges[0].server.engine.stats().chars, 0);
  await f.search();
  const result = f.controller.getSnapshot();
  gate.resolve();
  await Promise.resolve();
  assert.equal(f.controller.getSnapshot(), result);
  assert.equal(result.result.total, 1);
  assert.equal(f.events.filter(event => event.bridge === f.bridges[1] && event.type === 'remove').length, 1);
});

test('options changes cancel an executing search and affect only the replacement Worker query', async t => {
  const gate = deferred();
  const entered = deferred();
  let held = false;
  const f = fixture(t, { logs: { current: [message(0, 'NEEDLE needle')] }, workerHooks: { beforeReceive(request) {
    if (request.type === 'query' && !held) { held = true; entered.resolve(); return gate.promise; }
  } } });
  const old = f.search();
  await entered.promise;
  f.controller.toggle('matchCase');
  clearTimeout(f.controller.timer);
  await f.controller.search(f.controller.revision);
  await old;
  gate.resolve();
  assert.equal(f.controller.getSnapshot().result.total, 1);
  assert.equal(f.controller.getSnapshot().result.items[0].offset, 7);
  assert.deepEqual(f.events.filter(event => event.type === 'query').map(event => event.options.matchCase), [false, true]);
});

test('invalid regex is a visible terminal failure with no retained Worker documents', async t => {
  const f = fixture(t);
  f.controller.toggle('regex');
  clearTimeout(f.controller.timer);
  await f.search('[');
  const state = f.controller.getSnapshot();
  assert.equal(state.source.state, 'failed');
  assert.equal(state.busy, false);
  assert.match(state.error, /regular expression|unterminated/i);
  assert.equal(f.events.filter(event => event.type === 'remove').length, 1);
  assert.equal(f.bridges[0].server.engine.stats().chars, 0);
});

test('archived results are searchable by explicit choice and cannot be selected until restored', async t => {
  const f = fixture(t, { logs: { current: [message(0, 'needle current')], archived: [message(0, 'needle archived')] }, workspaces: { items: [], archivedSessionIds: ['archived'] } });
  await f.search();
  assert.deepEqual(f.controller.getSnapshot().result.items.map(hit => hit.sessionId), ['current']);
  f.controller.toggleArchived();
  clearTimeout(f.controller.timer);
  await f.controller.search(f.controller.revision);
  assert.equal(f.controller.getSnapshot().result.total, 2);
  await f.controller.select(1);
  assert.equal(f.selections.length, 0);
  assert.match(f.controller.getSnapshot().notice, /归档/);
  await f.controller.select(0);
  assert.equal(f.selections.length, 1);
  assert.equal(f.selections[0].hit.sessionId, 'current');
});

test('selection checks current archive membership when a session is archived after scanning', async t => {
  const f = fixture(t);
  await f.search();
  f.setWorkspaces({ ...f.getWorkspaces(), archivedSessionIds: ['current'] });
  await f.controller.select(0);
  assert.equal(f.selections.length, 0);
  assert.match(f.controller.getSnapshot().notice, /归档/);
});

test('restoring a previously archived result permits selection without another body scan', async t => {
  const f = fixture(t, { logs: { archived: [message(0, 'needle')] }, workspaces: { items: [], archivedSessionIds: ['archived'] } });
  f.controller.toggleArchived();
  clearTimeout(f.controller.timer);
  await f.search();
  assert.equal(f.controller.getSnapshot().result.items[0].archived, true);
  f.setWorkspaces({ items: [], archivedSessionIds: [] });
  await f.controller.select(0);
  assert.equal(f.selections.length, 1);
  assert.equal(f.selections[0].hit.sessionId, 'archived');
});

test('a failed selection in the current generation surfaces its error', async t => {
  const f = fixture(t, { onSelect: () => Promise.reject(new Error('Cannot open session.')) });
  await f.search();
  await f.controller.select(0);
  assert.equal(f.controller.getSnapshot().error, 'Cannot open session.');
});

test('a delayed selection error is ignored after same-query options change', async t => {
  const gate = deferred();
  const f = fixture(t, { onSelect: () => gate.promise });
  await f.search();
  const selection = f.controller.select(0);
  f.controller.toggle('matchCase');
  clearTimeout(f.controller.timer);
  await f.controller.search(f.controller.revision);
  gate.reject(new Error('Old option navigation failed.'));
  await selection;
  assert.equal(f.controller.getSnapshot().query, 'needle');
  assert.equal(f.controller.getSnapshot().options.matchCase, true);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('cancel invalidates an outstanding selection without publishing its delayed error', async t => {
  const gate = deferred();
  const f = fixture(t, { onSelect: () => gate.promise });
  await f.search();
  const selection = f.controller.select(0);
  f.controller.cancel();
  gate.reject(new Error('Cancelled navigation failed.'));
  await selection;
  assert.equal(f.controller.getSnapshot().error, null);
});

test('a delayed selection failure cannot overwrite a newer selected result', async t => {
  const gate = deferred();
  const f = fixture(t, { logs: { current: [message(0, 'needle needle')] }, onSelect: hit => hit.ordinal === 0 ? gate.promise : undefined });
  await f.search();
  const first = f.controller.select(0);
  await f.controller.select(1);
  gate.reject(new Error('Old selection failed.'));
  await first;
  assert.equal(f.controller.getSnapshot().active, 1);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('a delayed selection failure cannot overwrite the state of a replacement query', async t => {
  const gate = deferred();
  const f = fixture(t, { onSelect: () => gate.promise });
  await f.search();
  const selection = f.controller.select(0);
  await f.search('different');
  gate.reject(new Error('Old navigation failed.'));
  await selection;
  assert.equal(f.controller.getSnapshot().query, 'different');
  assert.equal(f.controller.getSnapshot().error, null);
});
