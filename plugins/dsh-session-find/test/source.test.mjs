import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SOURCE_MAX_BYTES,
  DEFAULT_SOURCE_MAX_DOCS,
  DEFAULT_SOURCE_PAGE_SIZE,
  createSessionSource,
  extractSearchDocuments,
} from '../src/source.js';

function event(seq, type, data = {}, surfaceOp = 'append') {
  return { type: 'event', event: { seq, type, data, time: seq, surfaceOp } };
}

function user(seq, text, source = { kind: 'user' }) {
  return event(seq, 'user/message', { source, content: [{ type: 'text', text }] });
}

function assistant(seq, text) {
  return event(seq, 'assistant/message', {
    turn: 2,
    step: 3,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function frame(seq, type = 'turn/start') {
  return event(seq, type, { turn: 2 }, undefined);
}

function page(records, hasMore = false) {
  return { ok: true, value: { records, hasMore } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture(entries, hasMore = false, pageHandler = () => page([]), session = {}) {
  let window = { entries, hasMore, revision: 1, change: { kind: 'replace', entries } };
  let snapshot = { sessionId: 'current', subagent: null, openState: 'open', removed: false, ...session };
  const eventListeners = new Set();
  const sessionListeners = new Set();
  const calls = [];
  const upserts = [];
  const removals = [];
  const statuses = [];
  const docs = new Map();
  const binding = {
    sessionId: 'current',
    eventSource: {
      getSnapshot: () => window,
      subscribe(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    },
    session: {
      getSnapshot: () => snapshot,
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
      loadOlder() { assert.fail('The source must not render older messages.'); },
    },
  };
  const remote = { session: { page(request, signal) {
    calls.push({ request, signal });
    return pageHandler(request, signal, calls.length);
  } } };
  return {
    binding, remote, calls, docs, upserts, removals, statuses, eventListeners, sessionListeners,
    options: {
      binding, remote,
      onUpsert(batch) { upserts.push(batch); for (const doc of batch) docs.set(doc.id, doc); },
      onRemove(ids) { removals.push(ids); for (const id of ids) docs.delete(id); },
      onStatus(status) { statuses.push(status); },
    },
    window() { return window; },
    change(change, nextEntries, nextHasMore = window.hasMore) {
      if (nextEntries === undefined) {
        if (change.kind === 'append') nextEntries = [...window.entries, ...change.entries];
        else if (change.kind === 'prepend') nextEntries = [...change.entries, ...window.entries];
        else if (change.kind === 'replace') nextEntries = change.entries;
        else nextEntries = change.entry ? [...window.entries, change.entry] : window.entries;
      }
      window = { entries: nextEntries, hasMore: nextHasMore, revision: window.revision + 1, change };
      for (const listener of eventListeners) listener();
    },
    session(patch) { snapshot = { ...snapshot, ...patch }; for (const listener of sessionListeners) listener(); },
  };
}

function texts(value) {
  return [...value.docs.values()].map(document => document.text);
}

test('extracts exact UTF-16 text blocks with stable part and reasoning documents', () => {
  const raw = '  中文😀e\u0301\n';
  const entry = event(42, 'assistant/message', {
    turn: 8,
    step: 9,
    message: { content: [
      { type: 'text', text: raw },
      { type: 'image', data: 'base64-secret', text: 'image secret' },
      { type: 'reasoning', text: '思考文本' },
      { type: 'tool-call', name: 'tool', arguments: 'secret', text: 'hidden' },
      { type: 'text', text: '' },
      { type: 'file', text: 'file secret' },
    ] },
    stream: [{ type: 'text-chunks', texts: ['not content'] }],
  });
  assert.deepEqual(extractSearchDocuments(entry), [
    { id: '42:0', seq: 42, part: 0, role: 'assistant', text: raw, turn: 8, step: 9 },
    { id: '42:2', seq: 42, part: 2, role: 'reasoning', text: '思考文本', turn: 8, step: 9 },
  ]);
});

test('human steering is included and injected or compaction replacements are excluded', () => {
  const human = user(1, 'human steering', { kind: 'user', target: 'next-step', rpcId: 'steer' });
  assert.equal(extractSearchDocuments(human)[0].role, 'user');
  assert.equal(extractSearchDocuments(human)[0].text, 'human steering');
  for (const kind of ['system', 'subagent', 'tool', 'continuation', 'team']) {
    assert.deepEqual(extractSearchDocuments(user(2, 'injected', { kind })), []);
  }
  const replacement = assistant(3, 'compaction summary');
  replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 2 };
  assert.deepEqual(extractSearchDocuments(replacement), []);
  const replacementUser = user(4, 'compaction checkpoint');
  replacementUser.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 3 };
  assert.deepEqual(extractSearchDocuments(replacementUser), []);
  assert.deepEqual(extractSearchDocuments(event(5, 'tool/result', { message: { content: [{ type: 'text', text: 'tool secret' }] } })), []);
  assert.deepEqual(extractSearchDocuments(event(6, 'system/message', { message: { content: [{ type: 'text', text: 'system secret' }] } })), []);
});

test('transient and malformed records never enter the index', () => {
  const transient = { ...assistant(1, 'streaming'), type: 'transient' };
  for (const value of [null, {}, transient, event(-1, 'user/message'), event(1.5, 'assistant/message'), user(2, 42)]) {
    assert.deepEqual(extractSearchDocuments(value), []);
  }
  const noSurface = assistant(3, 'missing marker');
  delete noSurface.event.surfaceOp;
  assert.deepEqual(extractSearchDocuments(noSurface), []);
  const wrongUserShape = event(4, 'user/message', { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'wrong shape' }] } });
  assert.deepEqual(extractSearchDocuments(wrongUserShape), []);
});

test('reads cold history through the authorized RPC using a fixed durable cut', async () => {
  const firstPage = deferred();
  const f = fixture([user(6, 'tail user'), assistant(7, 'tail assistant'), frame(8)], true,
    (_request, _signal, call) => call === 1 ? firstPage.promise : page([user(0, 'oldest'), frame(1)], false));
  const source = createSessionSource(f.options);
  const loading = source.start();
  await Promise.resolve();
  assert.deepEqual(f.calls[0].request, {
    address: { kind: 'session', sessionId: 'current' }, throughSeq: 8, beforeSeq: 6, maxMessages: 500,
  });
  f.change({ kind: 'append', entries: [assistant(9, 'live while paging')] });
  firstPage.resolve(page([frame(2), user(3, 'older'), assistant(4, 'older answer'), frame(5)], true));
  await loading;
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.throughSeq, 8);
  assert.equal(f.calls[1].request.beforeSeq, 2);
  assert.deepEqual(new Set(texts(f)), new Set(['tail user', 'tail assistant', 'live while paging', 'older', 'older answer', 'oldest']));
  const status = source.getStatus();
  assert.equal(status.complete, true);
  assert.equal(status.partial, false);
  assert.equal(status.pages, 2);
  assert.equal(status.count, 6);
  assert.equal(status.bytes, texts(f).reduce((sum, text) => sum + text.length * 2, 0));
  assert.equal(status.maxBytes, DEFAULT_SOURCE_MAX_BYTES);
  assert.equal(status.maxDocs, DEFAULT_SOURCE_MAX_DOCS);
  assert.equal(DEFAULT_SOURCE_MAX_DOCS, 100000);
  assert.equal(DEFAULT_SOURCE_PAGE_SIZE, 500);
  source.dispose();
});

test('cold page extraction excludes replacement and nonhuman history content', async () => {
  const replacement = assistant(3, 'summary secret');
  replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 2 };
  const f = fixture([assistant(6, 'latest')], true, () => page([
    user(0, 'original human'), assistant(1, 'original answer'), user(2, 'injected secret', { kind: 'subagent' }),
    replacement, event(4, 'tool/call', { arguments: 'tool secret' }), frame(5),
  ]));
  const source = createSessionSource(f.options);
  await source.start();
  assert.deepEqual(new Set(texts(f)), new Set(['latest', 'original human', 'original answer']));
  source.dispose();
});

test('append prepend and settle-assistant deduplicate durable sequence numbers', async () => {
  const f = fixture([user(0, 'initial')]);
  const source = createSessionSource(f.options);
  await source.start();
  const durable = assistant(2, 'settled text');
  f.change({ kind: 'append', entries: [{ ...assistant(1, 'live text'), type: 'transient' }] });
  f.change({ kind: 'settle-assistant', attemptId: 'one', entry: durable });
  f.change({ kind: 'settle-assistant', attemptId: 'abandoned' });
  f.change({ kind: 'prepend', entries: [user(0, 'initial'), durable] }, undefined, false);
  assert.deepEqual(texts(f), ['initial', 'settled text']);
  assert.equal(source.getStatus().count, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(f.upserts.length, 2);
  source.dispose();
});

test('replace aborts stale paging and rereads all independent history without leaks', async () => {
  const oldPage = deferred();
  const f = fixture([user(5, 'stale tail')], true,
    (_request, _signal, call) => call === 1 ? oldPage.promise : page([user(0, 'new cold history')], false));
  const source = createSessionSource(f.options);
  const initial = source.start();
  await Promise.resolve();
  const oldSignal = f.calls[0].signal;
  f.change({ kind: 'replace', entries: [assistant(8, 'replacement tail')] }, undefined, true);
  await Promise.resolve();
  assert.equal(oldSignal.aborted, true);
  oldPage.resolve(page([user(1, 'stale cold history')], false));
  await initial;
  assert.deepEqual(new Set(texts(f)), new Set(['replacement tail', 'new cold history']));
  assert.ok(f.removals.flat().includes('5:0'));
  assert.equal(f.calls[1].request.throughSeq, 8);
  assert.equal(f.calls[1].request.beforeSeq, 8);
  assert.equal(source.getStatus().reloadReason, 'replace');
  source.dispose();
});

test('dispose aborts in-flight work and detaches all subscriptions', async () => {
  const pending = deferred();
  const f = fixture([user(5, 'tail')], true, () => pending.promise);
  const source = createSessionSource(f.options);
  const loading = source.start();
  await Promise.resolve();
  source.dispose();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.eventListeners.size, 0);
  assert.equal(f.sessionListeners.size, 0);
  assert.equal(f.docs.size, 0);
  pending.resolve(page([user(0, 'must not arrive')]));
  await loading;
  assert.equal(f.docs.size, 0);
  assert.equal(source.getStatus().reason, 'disposed');
  assert.equal(source.getStatus().loading, false);
  f.change({ kind: 'append', entries: [user(9, 'after dispose')] });
  await source.start();
  assert.equal(f.docs.size, 0);
});

test('uses the direct subagent address from the current session snapshot', async () => {
  const f = fixture([assistant(5, 'subagent')], true, () => page([]), {
    subagent: { address: { parentSessionId: 'parent', childSessionId: 'current', mode: 'continuable' } },
  });
  const source = createSessionSource(f.options);
  await source.start();
  assert.deepEqual(f.calls[0].request.address, {
    kind: 'subagent', parentSessionId: 'parent', childSessionId: 'current', mode: 'continuable',
  });
  assert.equal(source.getStatus().complete, true);
  source.dispose();
});

test('a binding session mismatch clears indexed content and reports an error', async () => {
  const f = fixture([user(0, 'current only')]);
  const source = createSessionSource(f.options);
  await source.start();
  f.session({ sessionId: 'other' });
  f.change({ kind: 'append', entries: [user(1, 'other session secret')] });
  assert.equal(f.docs.size, 0);
  assert.equal(source.getStatus().errorCode, 'SOURCE_SESSION_MISMATCH');
  assert.equal(source.getStatus().complete, false);
  source.dispose();
});

test('RPC failures retain known documents and expose honest incomplete state', async () => {
  const f = fixture([user(5, 'known')], true, () => ({ ok: false, error: { code: 'gateway/denied', message: 'Not authorized' } }));
  const source = createSessionSource(f.options);
  await source.start();
  assert.deepEqual(texts(f), ['known']);
  assert.equal(source.getStatus().error, 'Not authorized');
  assert.equal(source.getStatus().errorCode, 'gateway/denied');
  assert.equal(source.getStatus().partial, true);
  assert.equal(source.getStatus().complete, false);
  assert.equal(source.getStatus().loading, false);
  source.dispose();
});

test('paging that does not move backwards is rejected', async t => {
  for (const invalid of [page([], true), page([user(5, 'overlap')], true), page([user(2, 'a'), user(1, 'b')], true), { records: [], hasMore: false }]) {
    await t.test(JSON.stringify(invalid), async () => {
      const f = fixture([user(5, 'known')], true, () => invalid);
      const source = createSessionSource(f.options);
      await source.start();
      assert.equal(f.calls.length, 1);
      assert.equal(source.getStatus().complete, false);
      assert.equal(source.getStatus().partial, true);
      assert.match(source.getStatus().errorCode, /^SOURCE_PAGE_/);
      source.dispose();
    });
  }
});

test('the UTF-16 budget excludes an entire oversized message and marks partial', async () => {
  const f = fixture([user(5, '😀')], true, () => page([user(0, 'abcd')]));
  const source = createSessionSource({ ...f.options, maxBytes: 10 });
  await source.start();
  assert.deepEqual(texts(f), ['😀']);
  assert.equal(source.getStatus().bytes, 4);
  assert.equal(source.getStatus().partial, true);
  assert.equal(source.getStatus().complete, false);
  assert.equal(source.getStatus().errorCode, 'SOURCE_MEMORY_LIMIT');
  assert.equal(source.getStatus().reason, 'memory-limit');
  assert.equal(f.calls[0].signal.aborted, true);
  source.dispose();
});

test('an oversized current window avoids cold-history RPC and remains responsive to settled additions', async () => {
  const f = fixture([user(5, 'abcdef')], true);
  const source = createSessionSource({ ...f.options, maxBytes: 4 });
  await source.start();
  assert.equal(f.calls.length, 0);
  assert.equal(source.getStatus().errorCode, 'SOURCE_MEMORY_LIMIT');
  f.change({ kind: 'settle-assistant', attemptId: 'settled', entry: assistant(6, 'ok') });
  assert.deepEqual(texts(f), ['ok']);
  assert.equal(source.getStatus().partial, true);
  source.dispose();
});

test('a cold empty window waits for an open session instead of claiming a complete index', async () => {
  const f = fixture([], false, () => page([]), { openState: 'cold' });
  const source = createSessionSource(f.options);
  await source.start();
  assert.equal(source.getStatus().reason, 'waiting-for-session');
  assert.equal(source.getStatus().loading, true);
  assert.equal(source.getStatus().complete, false);
  f.session({ openState: 'open' });
  await source.start();
  assert.equal(source.getStatus().complete, true);
  assert.equal(f.calls.length, 0);
  source.dispose();
});

test('refresh and large callback batches preserve the public source contract', async () => {
  const entries = Array.from({ length: 1002 }, (_, seq) => user(seq, 'a'));
  const f = fixture(entries);
  const source = createSessionSource(f.options);
  await Promise.all([source.start(), source.start()]);
  assert.equal(source.getStatus().count, 1002);
  assert.deepEqual(f.upserts.map(batch => batch.length), [500, 500, 2]);
  await source.refresh();
  assert.equal(source.getStatus().count, 1002);
  assert.deepEqual(f.removals.map(batch => batch.length), [500, 500, 2]);
  const status = source.getStatus();
  status.count = -1;
  assert.equal(source.getStatus().count, 1002);
  source.dispose();
});

test('aborting a nonresponsive RPC releases start without waiting for its response', async () => {
  const pending = deferred();
  const f = fixture([user(5, 'tail')], true, () => pending.promise);
  const source = createSessionSource(f.options);
  const loading = source.start();
  await Promise.resolve();
  source.dispose();
  await loading;
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(source.getStatus().reason, 'disposed');
  pending.reject(new Error('late rejected transport'));
  await Promise.resolve();
});

test('a reconnect after a completed index restores independent cold pages', async () => {
  const f = fixture([user(5, 'tail')], true, () => page([user(0, 'cold')], false));
  const source = createSessionSource(f.options);
  await source.start();
  assert.deepEqual(new Set(texts(f)), new Set(['tail', 'cold']));
  f.change({ kind: 'replace', entries: [user(5, 'tail'), assistant(6, 'reconnected')] }, undefined, true);
  await source.start();
  assert.deepEqual(new Set(texts(f)), new Set(['tail', 'cold', 'reconnected']));
  assert.equal(source.getStatus().reloadReason, 'replace');
  assert.equal(source.getStatus().complete, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.throughSeq, 6);
  source.dispose();
});

test('a live subagent address revision aborts its old page before publishing new content', async () => {
  const pending = deferred();
  const f = fixture([user(5, 'tail')], true,
    (_request, _signal, call) => call === 1 ? pending.promise : page([user(0, 'cold')]), {
      subagent: { address: { parentSessionId: 'parent', childSessionId: 'current', mode: 'unknown' } },
    });
  const source = createSessionSource(f.options);
  const loading = source.start();
  await Promise.resolve();
  f.session({ subagent: { address: { parentSessionId: 'parent', childSessionId: 'current', mode: 'continuable' } } });
  await loading;
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls[1].request.address.mode, 'continuable');
  assert.deepEqual(new Set(texts(f)), new Set(['tail', 'cold']));
  pending.resolve(page([user(1, 'stale')]));
  await Promise.resolve();
  assert.equal(texts(f).includes('stale'), false);
  source.dispose();
});

test('document budget stops cold paging and stays partial across incremental updates', async () => {
  const f = fixture([user(5, 'tail')], true, () => page([user(0, 'cold one'), assistant(1, 'cold two')], true));
  const source = createSessionSource({ ...f.options, maxDocs: 2 });
  await source.start();
  assert.deepEqual(texts(f), ['tail', 'cold one']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(source.getStatus().maxDocs, 2);
  assert.equal(source.getStatus().count, 2);
  assert.equal(source.getStatus().errorCode, 'SOURCE_DOCUMENT_LIMIT');
  assert.equal(source.getStatus().reason, 'document-limit');
  assert.equal(source.getStatus().loading, false);
  assert.equal(source.getStatus().partial, true);
  assert.equal(source.getStatus().complete, false);
  f.change({ kind: 'prepend', entries: [user(0, 'cold one')] }, undefined, false);
  f.change({ kind: 'append', entries: [frame(6)] });
  f.change({ kind: 'settle-assistant', attemptId: 'late', entry: assistant(7, 'late answer') });
  assert.equal(source.getStatus().errorCode, 'SOURCE_DOCUMENT_LIMIT');
  assert.equal(source.getStatus().partial, true);
  assert.equal(source.getStatus().complete, false);
  assert.deepEqual(texts(f), ['tail', 'cold one']);
  source.dispose();
});

test('document budget keeps messages atomic and refresh resets the partial state', async () => {
  const tooManyParts = assistant(0, 'first');
  tooManyParts.event.data.message.content.push({ type: 'reasoning', text: 'second' });
  const f = fixture([tooManyParts], true);
  const source = createSessionSource({ ...f.options, maxDocs: 1 });
  await source.start();
  assert.equal(f.docs.size, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(source.getStatus().errorCode, 'SOURCE_DOCUMENT_LIMIT');
  f.change({ kind: 'append', entries: [user(1, 'single document')] });
  assert.deepEqual(texts(f), ['single document']);
  assert.equal(source.getStatus().partial, true);
  assert.equal(source.getStatus().errorCode, 'SOURCE_DOCUMENT_LIMIT');
  f.change({ kind: 'replace', entries: [user(1, 'single document')] }, undefined, false);
  await source.start();
  assert.equal(source.getStatus().complete, true);
  assert.equal(source.getStatus().partial, false);
  assert.equal(source.getStatus().errorCode, null);
  source.dispose();
});

test('source validates configuration before subscribing or invoking RPC', () => {
  const f = fixture([]);
  for (const patch of [{ maxBytes: -1 }, { maxBytes: 0.5 }, { maxDocs: 0 }, { maxDocs: 1.5 }, { pageSize: 0 }, { pageSize: 501 }, { remote: {} }, { binding: {} }]) {
    assert.throws(() => createSessionSource({ ...f.options, ...patch }), TypeError);
  }
  assert.equal(f.eventListeners.size, 0);
  assert.equal(f.calls.length, 0);
});
