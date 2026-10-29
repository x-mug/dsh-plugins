import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { createGlobalSource } from '../src/global-source.js';

const ok = value => ({ ok: true, value });
const message = text => ({ type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } });
const workspaces = () => ({ items: [], archivedSessionIds: [] });

test('host entry registers no additional transport or unauthenticated corpus service', () => {
  const ctx = new Proxy({}, { get(target, key) { assert.fail(`Host entry accessed ${String(key)}.`); } });
  assert.equal(apply(ctx), undefined);
});

test('the existing authenticated RPC catalog is the sole session-address authority', async () => {
  const addresses = [];
  const projections = [];
  const batches = [];
  const remote = { session: {
    list(request, signal) {
      assert.deepEqual(request, {});
      assert.equal(signal instanceof AbortSignal, true);
      return ok({ items: [{ sessionId: 'visible', cwd: '/work' }, { sessionId: 'ordinary-fork', parentSessionId: 'hidden-parent', cwd: '/other' }, { sessionId: 'child', cwd: '/work', origin: 'subagent' }] });
    },
    projections(request) { projections.push(request.sessionId); return ok({ kind: 'sequenced', asOfSeq: 0, values: { title: 'Visible' } }); },
    page(request, signal) {
      assert.equal(signal instanceof AbortSignal, true);
      assert.equal('query' in request, false);
      assert.equal('regex' in request, false);
      assert.deepEqual(Object.keys(request.address).sort(), ['kind', 'sessionId']);
      addresses.push(request.address);
      return ok({ records: [message(request.address.sessionId)], hasMore: false });
    },
    follow() { assert.fail('Global search must not follow or activate a cold session.'); },
    search() { assert.fail('Matching remains in the browser Worker.'); },
  } };
  const source = createGlobalSource({ remote, getWorkspaceSnapshot: workspaces, onBatch: batch => batches.push(batch) });
  assert.equal((await source.run()).complete, true);
  assert.deepEqual(projections, ['visible', 'ordinary-fork']);
  assert.deepEqual(addresses, [{ kind: 'session', sessionId: 'visible' }, { kind: 'session', sessionId: 'ordinary-fork' }]);
  assert.deepEqual(batches.map(batch => batch.session.sessionId), ['visible', 'ordinary-fork']);
  source.dispose();
});

test('authorization recheck on each body page prevents a revoked session from delivery', async () => {
  let pageCalls = 0;
  const batches = [];
  const remote = { session: {
    list: () => ok({ items: [{ sessionId: 'revoked', cwd: '/work' }] }),
    projections: () => ok({ kind: 'sequenced', asOfSeq: 0, values: { title: 'Revoked' } }),
    page(request) {
      pageCalls += 1;
      assert.equal(request.address.sessionId, 'revoked');
      return { ok: false, error: { code: 'access/denied', message: 'Session access revoked.' } };
    },
  } };
  const source = createGlobalSource({ remote, getWorkspaceSnapshot: workspaces, onBatch: batch => batches.push(batch) });
  const state = await source.run();
  assert.equal(pageCalls, 1);
  assert.equal(state.state, 'incomplete');
  assert.equal(state.failedSessions, 1);
  assert.equal(state.errors[0].code, 'access/denied');
  assert.equal(batches.length, 0);
});

test('malformed catalogs fail without attempting caller-supplied or implicit addresses', async () => {
  for (const value of [null, {}, { items: [{ sessionId: 'dup', cwd: '/work' }, { sessionId: 'dup', cwd: '/work' }] }]) {
    const source = createGlobalSource({ getWorkspaceSnapshot: workspaces, onBatch() {}, remote: { session: {
      list: () => ok(value),
      projections() { assert.fail('Malformed catalog reached projections.'); },
      page() { assert.fail('Malformed catalog reached history.'); },
    } } });
    const state = await source.run();
    assert.equal(state.state, 'failed');
    assert.equal(state.errors[0].code, 'GLOBAL_LIST_INVALID');
  }
});
