import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchEngine, createSearchEngine, FindError } from '../src/engine.js';
import { createEngineServer } from '../src/worker.js';
import { MessageChannel } from 'node:worker_threads';

const doc = (text, extra = {}) => ({ id: 'a', seq: 1, part: 0, role: 'assistant', text, ...extra });
const search = (text, query, options = {}) => {
  const engine = new SearchEngine();
  engine.upsert([doc(text)]);
  return engine.searchSync(query, options);
};

function rpcServer(options) {
  const { port1, port2 } = new MessageChannel();
  const responses = [];
  const waiters = [];
  port1.on('message', message => {
    responses.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (!waiters[index].predicate(message)) continue;
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const server = createEngineServer(port2, options);
  const wait = predicate => {
    const old = responses.find(predicate);
    if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Worker reply timed out.')), 3000) };
      waiters.push(waiter);
    });
  };
  return {
    server, responses, send: message => port1.postMessage(message), wait,
    close() { server.dispose(); port1.close(); port2.close(); },
  };
}

test('literal indexOf semantics are non-overlapping and preserve UTF-16 offsets', () => {
  const result = search('😀你好😀你好 aaa aaaa', '你好', { matchCase: true });
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => [item.offset, item.length]), [[2, 2], [6, 2]]);
  assert.equal(result.items[0].snippet.slice(result.items[0].matchStart, result.items[0].matchEnd), '你好');
  assert.equal(search('aaaa', 'aa', { matchCase: true }).total, 2);
});

test('ignore-case preserves original offsets through dotted I and supplementary text', () => {
  const result = search('İ😀ABC abc Ä ä K K s ſ', 'abc');
  assert.deepEqual(result.items.map(item => item.offset), [3, 7]);
  assert.deepEqual(search('İiI', 'i').items.map(item => item.offset), [1, 2]);
  assert.equal(search('Ää', 'ä').total, 2);
  assert.deepEqual(search('KK', 'k').items.map(item => item.offset), [0, 1]);
  assert.equal(search('sſ', 's').total, 2);
  assert.deepEqual(search('𐐀 𐐨', '𐐨').items.map(item => item.offset), [0, 3]);
  assert.equal(search('SSß', 'ss').total, 1);
  assert.equal(search('abc ABC', 'ABC', { matchCase: true }).total, 1);
});

test('literal metacharacters are escaped on Unicode ignore-case fallback', () => {
  assert.equal(search('中.a[?] A[?]', '.a[?]').total, 1);
  assert.equal(search('中 $x +x \\x', '$x').total, 1);
});

test('wholeWord uses Unicode letters, numbers and underscore on both sides', () => {
  const result = search('cat _cat cat2 中cat cat中 😀cat😀 cat-cat', 'cat', { wholeWord: true });
  assert.deepEqual(result.items.map(item => item.offset), [0, 26, 32, 36]);
  assert.equal(search('𐐀cat cat𐐀 cat', 'cat', { wholeWord: true }).total, 1);
  assert.equal(search('中文 中文字 _中文 中文_ 😀中文😀', '中文', { wholeWord: true }).total, 2);
});

test('zero-width regex advances one UTF-16 unit and completes at end', () => {
  const result = search('😀a', '(?=)', { regex: true });
  assert.equal(result.total, 4);
  assert.deepEqual(result.items.map(item => [item.offset, item.length]), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.equal(search('a\nb', '^|$', { regex: true }).total, 2);
  assert.equal(search('a1 a2', 'a\\d', { regex: true }).total, 2);
});

test('invalid regex is a structured error and empty query returns no hits', () => {
  assert.throws(() => search('hello', '[', { regex: true }), error => error instanceof FindError && error.code === 'INVALID_REGEX');
  assert.equal(search('hello', '').total, 0);
  assert.throws(() => search('hello', 'a'.repeat(16385)), { code: 'QUERY_LIMIT' });
});

test('reasoning defaults off and stable order is seq then part', () => {
  const engine = createSearchEngine();
  engine.upsert([
    doc('hit', { id: '2', seq: 2 }),
    doc('hit', { id: 'r', seq: 1, part: 0, role: 'reasoning' }),
    doc('hit', { id: '1b', seq: 1, part: 2, turn: 't', step: 3 }),
    doc('hit', { id: '1a', seq: 1, part: 1 }),
    doc('hit', { id: '1c', seq: 1, part: 2 }),
  ]);
  assert.deepEqual(engine.searchSync('hit').items.map(item => item.id), ['1a', '1b', '1c', '2']);
  const result = engine.searchSync('hit', { includeReasoning: true });
  assert.deepEqual(result.items.map(item => item.id), ['r', '1a', '1b', '1c', '2']);
  assert.equal(result.items[2].part, 2);
  assert.equal(result.items[2].turn, 't');
  assert.equal(result.items[2].step, 3);
});

test('page stores only compact hits and includes global ordinal and per-doc occurrence', () => {
  const engine = new SearchEngine({ maxMatches: 1000 });
  engine.upsert([doc('x '.repeat(123)), doc('x '.repeat(77), { id: 'b', seq: 2 })]);
  const result = engine.searchSync('x');
  assert.equal(result.total, 200);
  assert.equal(result.items.length, 50);
  const page = engine.page(result.id, { offset: 120, limit: 8 });
  assert.deepEqual(page.items.map(item => item.ordinal), [120, 121, 122, 123, 124, 125, 126, 127]);
  assert.deepEqual(page.items.map(item => item.occurrence), [120, 121, 122, 0, 1, 2, 3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(engine.page(result.id, { offset: 199, limit: 10000 }).items.length, 1);
  assert.equal(engine.page(result.id, { offset: 200 }).items.length, 0);
  assert.equal(engine.stats().resultIndexBytes, 12000);
});

test('match cap detects overflow and distinguishes an exact cap count', () => {
  const engine = new SearchEngine({ maxMatches: 4 });
  engine.upsert([doc('x x x x x')]);
  const result = engine.searchSync('x');
  assert.equal(result.total, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedReason, 'match-limit');
  assert.equal(result.items.length, 4);
  engine.upsert([doc('x x x x')]);
  assert.equal(engine.searchSync('x').truncated, false);
});

test('incremental replacement removes old hits, invalidates pages and releases folded cache', () => {
  const engine = new SearchEngine({ foldCacheChars: 100 });
  engine.upsert([doc('ABC ABC')]);
  const old = engine.searchSync('abc');
  assert.equal(old.total, 2);
  assert.equal(engine.stats().foldedChars, 7);
  engine.upsert([doc('x')]);
  assert.equal(engine.stats().foldedChars, 0);
  assert.throws(() => engine.page(old.id), { code: 'STALE_RESULT' });
  assert.equal(engine.searchSync('abc').total, 0);
  assert.equal(engine.remove(['a']).removed, 1);
  assert.equal(engine.stats().chars, 0);
  engine.reset([doc('reset')]);
  assert.equal(engine.searchSync('reset').total, 1);
  engine.clear();
  assert.equal(engine.stats().docs, 0);
  assert.equal(engine.stats().resultMatches, 0);
});

test('memory budget rejects atomically per-document and permits explicit eviction', () => {
  const engine = new SearchEngine({ maxTotalChars: 8, maxDocs: 2, foldCacheChars: 4 });
  engine.upsert([doc('aaaa'), doc('bbbb', { id: 'b', seq: 2 })]);
  const rejected = engine.upsert([doc('12345')]);
  assert.deepEqual(rejected.rejected, [{ id: 'a', code: 'TEXT_LIMIT' }]);
  assert.equal(engine.searchSync('aaaa').total, 1);
  engine.searchSync('bbbb');
  assert.ok(engine.stats().foldedChars <= 4);
  assert.equal(engine.upsert([doc('', { id: 'c' })]).rejected[0].code, 'DOCUMENT_LIMIT');
  assert.equal(engine.stats().estimatedTextBytes, 16);
  const evict = new SearchEngine({ maxTotalChars: 8, overflowPolicy: 'evict' });
  evict.upsert([doc('aaaa'), doc('bbbb', { id: 'b', seq: 2 })]);
  assert.deepEqual(evict.upsert([doc('cc', { id: 'c', seq: 3 })]).evictedIds, ['a']);
  assert.equal(evict.stats().chars, 6);
});

test('long literals match across block boundaries without duplicates', () => {
  const engine = new SearchEngine({ blockChars: 1024, foldCacheChars: 0 });
  engine.upsert([doc('x'.repeat(1022) + 'AbCd' + 'x'.repeat(1020) + 'AbCd')]);
  assert.deepEqual(engine.searchSync('abcd').items.map(item => item.offset), [1022, 2046]);
  assert.deepEqual(engine.searchSync('AbCd', { matchCase: true }).items.map(item => item.offset), [1022, 2046]);
  engine.upsert([doc('中'.repeat(1023) + 'İABC' + '😀'.repeat(2000))]);
  assert.deepEqual(engine.searchSync('abc').items.map(item => item.offset), [1024]);
});

test('randomized Unicode literal scan equals an independent whole-document RegExp oracle', () => {
  let seed = 0x5eed;
  const next = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = ['A', 'a', 'B', 'b', '中', '文', '😀', 'İ', 'ı', 'ſ', 's', 'K', 'K', '𐐀', '𐐨', ' ', '_', '2', '.', '[', 'ͅ', 'ι'];
  const engine = new SearchEngine({ blockChars: 1024, foldCacheChars: 0, maxMatches: 10000 });
  for (let round = 0; round < 50; round++) {
    let text = '';
    for (let index = 0; index < 3000; index++) text += alphabet[next(alphabet.length)];
    const points = [...text];
    const at = next(points.length - 8);
    const needle = round % 2 ? points.slice(at, at + 1 + next(8)).join('') : alphabet[next(alphabet.length)];
    engine.upsert([doc(text)]);
    const result = engine.searchSync(needle);
    const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const expected = [...text.matchAll(expression)].map(match => [match.index, match[0].length]);
    const actual = [];
    for (let offset = 0; offset < result.total; offset += 200) actual.push(...engine.page(result.id, { offset, limit: 200 }).items.map(item => [item.offset, item.length]));
    assert.deepEqual(actual, expected, `round ${round} query ${JSON.stringify(needle)}`);
  }
});

test('snippet payload remains bounded for huge regex matches and surrogate boundaries', () => {
  const result = search('😀' + 'x'.repeat(10000) + '😀', 'x+', { regex: true, maxSnippetLength: 64 });
  assert.equal(result.items[0].offset, 2);
  assert.equal(result.items[0].length, 10000);
  assert.equal(result.items[0].matchTruncated, true);
  assert.ok(result.items[0].snippet.length <= 64);
  assert.ok(result.items[0].matchedText.length <= 64);
  const zero = search('😀x', '(?=)', { regex: true, contextChars: 0 }).items[1];
  assert.equal(zero.offset, 1);
  assert.equal(zero.snippet, '😀');
  assert.equal(zero.matchStart, 1);
  assert.equal(zero.matchEnd, 1);
});

test('cooperative queries cancel latest-wins and mutations cancel running work', async () => {
  const engine = new SearchEngine({ blockChars: 1024, stepBudgetMs: 1, maxTotalChars: 16 * 1024 * 1024 });
  engine.upsert([doc('a'.repeat(12 * 1024 * 1024))]);
  const first = engine.query('absent', { matchCase: true });
  const second = engine.query('aaaa', { matchCase: true, maxMatches: 3 });
  await assert.rejects(first, { code: 'SUPERSEDED' });
  assert.equal((await second).total, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.query('absent', {}, { signal: controller.signal }), { code: 'CANCELLED' });
  const job = engine.createJob('absent', { matchCase: true });
  engine.upsert([doc('replacement')]);
  assert.equal(job.cancelled, true);
  assert.equal(job.reason, 'mutation');
});

test('worker protocol supports reset/query/page/error and bounds result payload', async () => {
  const rpc = rpcServer({ maxMatches: 500 });
  try {
    await rpc.wait(message => message.type === 'ready');
    rpc.send({ type: 'reset', requestId: 1, docs: [doc('hit '.repeat(300))] });
    assert.equal((await rpc.wait(message => message.requestId === 1)).added, 1);
    rpc.send({ type: 'query', requestId: 2, query: 'hit' });
    const { result } = await rpc.wait(message => message.requestId === 2 && message.type === 'result');
    assert.equal(result.total, 300);
    assert.equal(result.items.length, 50);
    rpc.send({ type: 'page', requestId: 3, id: result.id, offset: 299, limit: 1 });
    assert.equal((await rpc.wait(message => message.requestId === 3)).result.items[0].ordinal, 299);
    rpc.send({ type: 'query', requestId: 4, query: '[', options: { regex: true } });
    assert.equal((await rpc.wait(message => message.requestId === 4)).error.code, 'INVALID_REGEX');
    rpc.send({ type: 'upsert', requestId: 5, docs: [doc('new')] });
    await rpc.wait(message => message.requestId === 5);
    rpc.send({ type: 'page', requestId: 6, id: result.id });
    assert.equal((await rpc.wait(message => message.requestId === 6)).error.code, 'STALE_RESULT');
  } finally { rpc.close(); }
});

test('worker latest-wins cancels before old query can publish and explicit cancel acks', async () => {
  const rpc = rpcServer({ blockChars: 1024, stepBudgetMs: 1 });
  try {
    rpc.send({ type: 'upsert', requestId: 1, docs: [doc('a'.repeat(8 * 1024 * 1024))] });
    await rpc.wait(message => message.requestId === 1);
    rpc.send({ type: 'query', requestId: 2, query: 'absent', options: { matchCase: true } });
    rpc.send({ type: 'query', requestId: 3, query: 'aaa', options: { matchCase: true, maxMatches: 2 } });
    assert.equal((await rpc.wait(message => message.requestId === 2)).reason, 'superseded');
    assert.equal((await rpc.wait(message => message.requestId === 3 && message.type === 'result')).result.total, 2);
    assert.equal(rpc.responses.some(message => message.requestId === 2 && message.type === 'result'), false);
    rpc.send({ type: 'query', requestId: 4, query: 'absent' });
    rpc.send({ type: 'cancel', requestId: 5 });
    assert.equal((await rpc.wait(message => message.requestId === 4)).reason, 'cancelled');
    assert.equal((await rpc.wait(message => message.requestId === 5)).type, 'ack');
  } finally { rpc.close(); }
});
