import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionFindController } from '../src/controller.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(t, reveal = async () => ({ precise: true })) {
  const bridges = [];
  const sources = [];
  const reveals = [];
  let mounted = 's1';
  let activeBinding;
  class Bridge {
    constructor(_text, change) { this.docs = new Map(); this.change = change; this.pages = []; this.queries = []; bridges.push(this); }
    async upsert(docs) { for (const doc of docs) this.docs.set(doc.id, doc); }
    async remove(ids) { for (const id of ids) this.docs.delete(id); }
    cancel() {}
    dispose() { this.disposed = true; }
    query(query, options) { const operation = deferred(); this.queries.push({ query, options, ...operation }); return operation.promise; }
    async page(id, offset, limit) { this.pages.push({ id, offset, limit }); return this.pageResult?.(id, offset, limit) ?? { items: [], offset }; }
  }
  const binding = { sessionId: 's1', session: { getSnapshot: () => ({ sessionId: 's1' }) } };
  activeBinding = binding;
  const ctx = { remote: {}, sessions: { binding: () => activeBinding }, sidebarRight: { mounted: { getSnapshot: () => mounted } } };
  const controller = new SessionFindController({ ctx, binding, Bridge, workerText: '', createSource(callbacks) {
    const source = { callbacks, async start() {}, async refresh() {}, dispose() {} };
    sources.push(source);
    return source;
  }, async reveal(options) { reveals.push(options); return reveal(options); } });
  controller.start();
  clearTimeout(controller.timer);
  controller.publish({ source: { loading: false, complete: true } });
  t.after(() => controller.stop());
  return { controller, bridges, sources, reveals, binding, switchSession: () => { mounted = 's2'; }, replaceBinding: () => { activeBinding = { ...binding }; } };
}
function hit(overrides = {}) {
  return { docId: '5:0', seq: 5, part: 0, role: 'assistant', offset: 7, length: 6, matchedText: 'needle', ordinal: 0, ...overrides };
}
function resultFixture(fixture, items = [hit()], total = items.length) {
  const bridge = fixture.bridges.at(-1);
  for (const item of items) bridge.docs.set(item.docId, { id: item.docId, seq: item.seq, part: item.part, role: item.role, text: 'needle needle needle' });
  fixture.controller.publish({ result: { id: 1, total, items }, busy: false });
  return bridge;
}

test('setQuery accepts only supported boolean options without changing Worker API', async (t) => {
  const { controller, bridges } = fixture(t);
  controller.setQuery('needle', { regex: true, matchCase: true, wholeWord: false, includeReasoning: true, unexpected: true });
  clearTimeout(controller.timer);
  const query = controller.search(controller.revision);
  await flush();
  assert.deepEqual(bridges[0].queries[0].options, { regex: true, matchCase: true, wholeWord: false, includeReasoning: true });
  bridges[0].queries[0].resolve({ id: 1, total: 0, items: [] });
  await query;
  assert.equal(controller.getSnapshot().result.id, 1);
});

test('forwards verified source document and aborts old navigation on query change', async (t) => {
  const held = deferred();
  const setup = fixture(t, () => held.promise);
  const bridge = resultFixture(setup);
  const selecting = setup.controller.select(0);
  await flush();
  assert.equal(setup.reveals[0].sourceDocument, bridge.docs.get('5:0'));
  assert.equal(setup.reveals[0].highlightOwner, setup.controller);
  setup.controller.setQuery('new');
  clearTimeout(setup.controller.timer);
  assert.equal(setup.reveals[0].signal.aborted, true);
  assert.equal(setup.reveals[0].isCurrent(), false);
  held.resolve({ precise: false, notice: 'stale' });
  assert.equal(await selecting, false);
  assert.equal(setup.controller.getSnapshot().notice, null);
  assert.equal(setup.controller.getSnapshot().navigating, false);
});

test('closing and reopening ignores all stale Worker and source callbacks', async (t) => {
  const setup = fixture(t);
  const oldBridge = setup.bridges[0];
  const start = deferred();
  setup.sources[0].start = () => start.promise;
  setup.controller.stop();
  setup.controller.start();
  clearTimeout(setup.controller.timer);
  oldBridge.change({ error: 'old error', reset: true });
  setup.sources[0].callbacks.onStatus({ error: 'stale source' });
  setup.sources[0].callbacks.onUpsert([{ id: 'old', text: 'stale' }]);
  setup.sources[1].callbacks.onUpsert([{ id: 'new', text: 'fresh' }]);
  clearTimeout(setup.controller.timer);
  await setup.controller.mutationQueue;
  assert.equal(setup.controller.getSnapshot().error, null);
  assert.notEqual(setup.controller.getSnapshot().source.error, 'stale source');
  assert.deepEqual([...setup.bridges[1].docs.keys()], ['new']);
  assert.equal(oldBridge.disposed, true);
});

test('obsolete source start rejection cannot replace a new session lifecycle status', async (t) => {
  const setup = fixture(t);
  const deferredStart = deferred();
  setup.controller.stop();
  setup.controller.createSource = () => ({ start: () => deferredStart.promise, dispose() {} });
  setup.controller.start();
  clearTimeout(setup.controller.timer);
  setup.controller.stop();
  setup.controller.createSource = () => ({ start: async () => {}, dispose() {} });
  setup.controller.start();
  clearTimeout(setup.controller.timer);
  deferredStart.reject(new Error('old source failed'));
  await flush();
  assert.notEqual(setup.controller.getSnapshot().error, 'old source failed');
});

test('new selection cancels older reveal and preserves only the new fallback notice', async (t) => {
  const first = deferred();
  const setup = fixture(t, (options) => options.hit.ordinal === 0 ? first.promise : Promise.resolve({ precise: false, notice: 'second fallback' }));
  resultFixture(setup, [hit(), hit({ ordinal: 1, offset: 14 })]);
  const old = setup.controller.select(0);
  await flush();
  assert.equal(await setup.controller.select(1), true);
  assert.equal(setup.reveals[0].signal.aborted, true);
  first.resolve({ precise: false, notice: 'old fallback' });
  await old;
  assert.equal(setup.controller.getSnapshot().notice, 'second fallback');
  assert.equal(setup.controller.getSnapshot().active, 1);
});

test('switched session or replaced binding invalidates pending reveal and pagination', async (t) => {
  const held = deferred();
  const setup = fixture(t, () => held.promise);
  const bridge = resultFixture(setup);
  const reveal = setup.controller.select(0);
  await flush();
  setup.switchSession();
  assert.equal(setup.reveals[0].isCurrent(), false);
  held.resolve({ precise: true });
  assert.equal(await reveal, false);
  assert.equal(setup.controller.getSnapshot().navigating, false);
  assert.equal(await setup.controller.select(0), false);
  assert.equal(bridge.pages.length, 0);
  const other = fixture(t);
  resultFixture(other);
  other.replaceBinding();
  assert.equal(await other.controller.select(0), false);
  assert.equal(other.reveals.length, 0);
});

test('missing or changed source identity never invokes navigation', async (t) => {
  const setup = fixture(t);
  const bridge = resultFixture(setup);
  bridge.docs.get('5:0').part = 2;
  assert.equal(await setup.controller.select(0), false);
  assert.equal(setup.reveals.length, 0);
  assert.match(setup.controller.getSnapshot().error, /来源已改变/);
});

test('stale matched text never invokes navigation even when document identity matches', async (t) => {
  const setup = fixture(t);
  const bridge = resultFixture(setup);
  bridge.docs.get('5:0').text = 'needle changed needle';
  assert.equal(await setup.controller.select(0), false);
  assert.equal(setup.reveals.length, 0);
  assert.match(setup.controller.getSnapshot().error, /命中文字已改变/);
});

test('source selection cancels an existing reveal even when no replacement hit exists', async (t) => {
  const held = deferred();
  const setup = fixture(t, () => held.promise);
  resultFixture(setup);
  const selecting = setup.controller.select(0);
  await flush();
  assert.equal(await setup.controller.selectSource(hit({ offset: 14 })), false);
  assert.equal(setup.controller.getSnapshot().navigating, false);
  held.resolve({ precise: true });
  assert.equal(await selecting, false);
  assert.match(setup.controller.getSnapshot().notice, /没有相同来源/);
});

test('source selection ignores foreign global docId and ordinal and locates local coordinates', async (t) => {
  const setup = fixture(t);
  const local = hit({ docId: 'local-5:0', ordinal: 61 });
  const bridge = resultFixture(setup, [], 100);
  bridge.docs.set(local.docId, { id: local.docId, seq: 5, part: 0, role: 'assistant', text: 'needle needle' });
  bridge.pageResult = async (_id, offset) => ({ items: offset === 50 ? [local] : [], offset });
  assert.equal(await setup.controller.selectSource({ ...local, sessionId: 's1', docId: 'foreign-global-id', ordinal: 999 }), true);
  assert.equal(setup.reveals[0].hit.docId, local.docId);
  assert.equal(setup.controller.getSnapshot().active, 61);
  assert.deepEqual(bridge.pages.map((page) => page.offset), [50]);
});

test('source selection reports wrong-session, unfinished indexing and result budget limits', async (t) => {
  const setup = fixture(t);
  resultFixture(setup, []);
  assert.equal(await setup.controller.selectSource({ ...hit(), sessionId: 'wrong' }), false);
  assert.match(setup.controller.getSnapshot().notice, /当前会话不一致/);
  setup.controller.publish({ source: { loading: true }, result: null });
  assert.equal(await setup.controller.selectSource(hit()), false);
  assert.match(setup.controller.getSnapshot().notice, /仍在索引或查询/);
  setup.controller.publish({ source: { loading: false, partial: true }, result: { id: 1, total: 0, items: [], truncated: true } });
  assert.equal(await setup.controller.selectSource(hit()), false);
  assert.match(setup.controller.getSnapshot().notice, /达到限额/);
});

test('source selection cancels outstanding pages on new input without stale notices', async (t) => {
  const setup = fixture(t);
  const bridge = resultFixture(setup, [], 100);
  const page = deferred();
  bridge.pageResult = () => page.promise;
  const selecting = setup.controller.selectSource(hit());
  await flush();
  setup.controller.setQuery('different');
  clearTimeout(setup.controller.timer);
  page.resolve({ items: [hit({ ordinal: 60 })], offset: 50 });
  assert.equal(await selecting, false);
  assert.equal(setup.reveals.length, 0);
  assert.equal(setup.controller.getSnapshot().notice, null);
});

test('reversed page completions keep the latest user-requested page', async (t) => {
  const setup = fixture(t);
  const bridge = resultFixture(setup, [], 150);
  const first = deferred();
  const second = deferred();
  bridge.pageResult = (_id, offset) => offset === 50 ? first.promise : second.promise;
  const p1 = setup.controller.page(50);
  const p2 = setup.controller.page(100);
  second.resolve({ items: [hit({ ordinal: 100 })], offset: 100 });
  await p2;
  first.resolve({ items: [hit({ ordinal: 50 })], offset: 50 });
  await p1;
  assert.equal(setup.controller.getSnapshot().pageOffset, 100);
});
