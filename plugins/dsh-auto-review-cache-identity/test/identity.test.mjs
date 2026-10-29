// 离线自检：不起 DSH、不进网络，只验识别、身份来源、同步性、配置读取与失败放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as plugin from '../index.js';

const { apply: pluginApply, _internal } = plugin;
const { isReview, resolveIdentity, plan, currentSessionId, settingsOf, SCOPES } = _internal;

const POLICY = [
  'REVIEW_POLICY',
  'You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call.',
  'Return exactly one JSON object and no other text.'
].join('\n');

const json = (value) => JSON.stringify(value, null, 2);

/** 复刻 reviewUserText：四段用两个换行拼接。 */
function reviewText(cwd, action) {
  return [
    'ENVIRONMENT', json({ cwd }),
    'PROJECT_INSTRUCTIONS', json([]),
    'FILTERED_HISTORY', json([]),
    'PENDING_ACTION', json(action)
  ].join('\n\n');
}

/** 复刻 classifyRisk 的 deepFreeze 请求。 */
function reviewCall(cwd, action = { mode: 'native', name: 'read', arguments: '{}' }) {
  const options = {
    provider: 'magpie-responses',
    model: 'gpt-6.1-sol',
    system: POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text: reviewText(cwd, action) }] }],
    temperature: 0,
    signal: new AbortController().signal
  };
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) deepFreeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  return deepFreeze(options);
}

const chatCall = {
  provider: 'magpie-responses',
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: '普通对话' }] }],
  temperature: 1
};

const sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
const identityOf = (scope) => 'auto-review:' + createHash('sha256').update(scope).digest('hex').slice(0, 32);
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 复刻 cosmokit 的 volatile 引用：只有 get()，写走共享协议键。 */
function volatileOf(value) {
  let current = value;
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next) => { current = next; }
  });
}

/** 迷你 cordis：thisArg/事件名/next 的语义与真 runtime 一致，agents 用真 ALS 模拟。 */
function runtime({ adapter, agents = true }) {
  const initiators = new AsyncLocalStorage();
  const hooks = Object.create(null);
  const initiatorCalls = { count: 0 };
  const services = agents
    ? { agents: { currentInitiator: () => { initiatorCalls.count += 1; return initiators.getStore(); } } }
    : {};
  let collector;
  const bucket = (name) => (hooks[name] ??= []);
  const context = {
    initiatorCalls,
    llm: {
      stream: (options) => context.waterfall(context.llm, 'llm/stream', options, () => adapter(options))
    },
    get(name) {
      return services[name];
    },
    waterfall(...args) {
      const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null;
      const name = args.shift();
      const callbacks = bucket(name).map((hook) => hook.callback.bind(thisArg));
      const inner = args.pop();
      const next = () => (callbacks.shift() ?? inner)(...args);
      args.push(next);
      return next();
    },
    on(name, callback, options = {}) {
      const hook = { callback };
      if (options.prepend) bucket(name).unshift(hook);
      else bucket(name).push(hook);
      const dispose = () => {
        const index = bucket(name).indexOf(hook);
        if (index >= 0) bucket(name).splice(index, 1);
      };
      collector?.push(dispose);
      return dispose;
    },
    inject(names, callback) {
      assert.deepEqual(names.filter((name) => name !== 'llm' && name !== 'settings'), []);
      const disposers = [];
      collector = disposers;
      const scope = Object.create(context);
      scope.fiber = { uid: 1 };
      scope.settings = { configure: () => () => {} };
      scope.effect = (fn) => {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      };
      callback(scope);
      collector = undefined;
      return {
        dispose() {
          for (const dispose of disposers.splice(0).reverse()) dispose();
        }
      };
    },
    runAs(agent, operation) {
      return initiators.run(agent, operation);
    },
    logger: { info() {}, warn() {} }
  };
  return context;
}

/** 复刻审查读取流：零到多个 reasoning 块加一个 text 块。 */
async function readDecision(stream) {
  assert.equal(typeof stream.then, 'undefined');
  let text;
  for await (const chunk of stream) {
    if (chunk.type === 'block') text = chunk.text;
    if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop');
  }
  return JSON.parse(text);
}

/** 造一个插件已加载的 runtime，并留下注入用的观测点。 */
function mounted(settings = { enabled: true, scope: 'session', log: false }) {
  const seen = [];
  const ctx = runtime({
    adapter: (call) => {
      seen.push(call);
      return (async function* chunks() {
        yield { type: 'block', text: '{"risk":"low","decision":"allow"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }
  });
  const handlers = [];
  const originalOn = ctx.on;
  ctx.on = (name, callback, options) => {
    if (name === 'llm/stream') handlers.push(callback);
    return originalOn(name, callback, options);
  };
  const handles = [];
  const originalInject = ctx.inject;
  ctx.inject = (names, callback) => {
    const handle = originalInject(names, callback);
    handles.push(handle);
    return handle;
  };
  pluginApply(ctx, settings);
  return { ctx, seen, handlers, handles };
}

test('recognizes the auto review call', () => {
  assert.equal(isReview(reviewCall('C:/work/a')), true);
});

test('leaves chat, compaction and approve-for-me requests alone', () => {
  assert.equal(isReview(chatCall), false);
  const base = reviewCall('C:/work/a');
  assert.equal(isReview({ ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), false);
  assert.equal(isReview({ ...base, temperature: 1 }), false);
  assert.equal(isReview({ ...base, messages: [] }), false);
  const approval = { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: '>>> APPROVAL REQUEST START\n{}' }] }] };
  assert.equal(isReview(approval), false);
});

test('session scope uses the initiator session and cwd scope uses the environment', () => {
  const call = reviewCall('C:/work/a');
  assert.equal(resolveIdentity(call, 'session', 'session-abc'), identityOf('session-abc'));
  assert.equal(resolveIdentity(call, 'session'), undefined);
  assert.equal(resolveIdentity(call, 'cwd', 'session-abc'), identityOf('C:/work/a'));
  assert.equal(resolveIdentity(call, 'cwd').length <= 64, true);
});

test('the same session keeps one key across different reviews', () => {
  const first = resolveIdentity(reviewCall('C:/work/a', { name: 'read', arguments: '{}' }), 'session', 'session-abc');
  const second = resolveIdentity(reviewCall('C:/work/b', { name: 'write', arguments: '{}' }), 'session', 'session-abc');
  const other = resolveIdentity(reviewCall('C:/work/a'), 'session', 'session-xyz');
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('an unknown scope never injects', () => {
  assert.equal(SCOPES.nope, undefined);
  assert.equal(resolveIdentity(reviewCall('C:/work/a'), 'nope', 'session-abc'), undefined);
});

test('rewrite adds only sessionId and keeps every other field', () => {
  const original = reviewCall('C:/work/a');
  const next = plan(original, { enabled: true, scope: 'session', log: false }, () => 'session-abc');
  assert.equal(original.sessionId, undefined);
  assert.equal(next.sessionId, identityOf('session-abc'));
  assert.equal(next.provider, original.provider);
  assert.equal(next.model, original.model);
  assert.equal(next.temperature, original.temperature);
  assert.equal(next.signal, original.signal);
  assert.equal(next.system, original.system);
  assert.equal(next.messages, original.messages);
  assert.equal(JSON.stringify(next.messages), JSON.stringify(original.messages));
  assert.equal(Object.isFrozen(next), true);
});

test('an existing sessionId is never rewritten by a second instance', () => {
  const settings = { enabled: true, scope: 'session', log: false };
  const once = plan(reviewCall('C:/work/a'), settings, () => 'session-abc');
  assert.equal(plan(once, settings, () => 'session-abc'), undefined);
  assert.equal(plan(once, settings, () => 'session-def'), undefined);
});

test('a configured review route replaces provider and model only', () => {
  const original = reviewCall('C:/work/a');
  const settings = { enabled: true, scope: 'session', log: false, review: { provider: 'magpie', model: 'group/other' } };
  const next = plan(original, settings, () => 'session-abc');
  assert.equal(next.provider, 'magpie');
  assert.equal(next.model, 'group/other');
  assert.equal(next.messages, original.messages);
  assert.equal(next.system, original.system);
});

test('disabled switches and malformed requests pass through', () => {
  const settings = { enabled: true, scope: 'session', log: false };
  assert.equal(plan(reviewCall('C:/work/a'), { ...settings, enabled: false }, () => 'session-abc'), undefined);
  assert.equal(plan(null, settings, () => 'session-abc'), undefined);
  assert.equal(plan({ temperature: 0, system: POLICY, messages: [] }, settings, () => 'session-abc'), undefined);
});

test('volatile config fields are dereferenced before use', () => {
  const config = {
    enabled: volatileOf(true),
    scope: volatileOf('session'),
    reviewProvider: volatileOf('magpie'),
    reviewModel: volatileOf('group/deepseek-flash-1017')
  };
  const settings = settingsOf(config);
  assert.equal(settings.enabled, true);
  assert.equal(settings.scope, 'session');
  assert.deepEqual(settings.review, { provider: 'magpie', model: 'group/deepseek-flash-1017' });
});

test('plain config values still work and an incomplete route is ignored', () => {
  const plainSettings = settingsOf({ enabled: true, scope: 'session', reviewProvider: 'magpie', reviewModel: '' });
  assert.equal(plainSettings.scope, 'session');
  assert.equal(plainSettings.review, undefined);
  assert.equal(settingsOf(undefined).scope, 'session');
  assert.equal(settingsOf(null).enabled, true);
  assert.deepEqual(settingsOf({ review: { provider: 'magpie', model: 'group/x' } }).review, { provider: 'magpie', model: 'group/x' });
});

test('injects a session key inside the initiator scope across awaits', async () => {
  const a = mounted();
  const verdict = await a.ctx.runAs({ session: { id: 'session-abc' } }, async () => {
    await sleep();
    return readDecision(a.ctx.llm.stream(reviewCall('C:/work/a')));
  });
  assert.deepEqual(verdict, { risk: 'low', decision: 'allow' });
  assert.equal(a.seen.length, 1);
  assert.equal(a.seen[0].sessionId, identityOf('session-abc'));
});

test('the same session reuses the key and another session changes it', async () => {
  const a = mounted();
  await a.ctx.runAs({ session: { id: 'session-abc' } }, () => readDecision(a.ctx.llm.stream(reviewCall('C:/work/a'))));
  await a.ctx.runAs({ session: { id: 'session-abc' } }, async () => {
    await sleep();
    return readDecision(a.ctx.llm.stream(reviewCall('C:/work/b')));
  });
  await a.ctx.runAs({ session: { id: 'session-xyz' } }, () => readDecision(a.ctx.llm.stream(reviewCall('C:/work/a'))));
  assert.equal(a.seen[1].sessionId, a.seen[0].sessionId);
  assert.equal(a.seen[2].sessionId, identityOf('session-xyz'));
  assert.notEqual(a.seen[2].sessionId, a.seen[0].sessionId);
});

test('parallel initiator scopes never mix keys', async () => {
  const parallel = mounted();
  await Promise.all([
    parallel.ctx.runAs({ session: { id: 'session-p1' } }, async () => {
      await sleep();
      return readDecision(parallel.ctx.llm.stream(reviewCall('C:/work/p')));
    }),
    parallel.ctx.runAs({ session: { id: 'session-p2' } }, () => readDecision(parallel.ctx.llm.stream(reviewCall('C:/work/p'))))
  ]);
  const keys = parallel.seen.map((call) => call.sessionId).sort();
  assert.deepEqual(keys, [identityOf('session-p1'), identityOf('session-p2')].sort());
});

test('a missing initiator leaves the call untouched and warns once', async () => {
  const misses = mounted();
  const warnings = [];
  misses.ctx.logger.warn = (line) => warnings.push(line);
  await readDecision(misses.ctx.llm.stream(reviewCall('C:/work/a')));
  await readDecision(misses.ctx.llm.stream(reviewCall('C:/work/a')));
  assert.equal(misses.seen[0].sessionId, undefined);
  assert.equal(misses.seen[1].sessionId, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /left untouched/);
});

test('a missing or disposed agents service never throws', () => {
  const missing = runtime({ adapter: () => (async function* empty() {})(), agents: false });
  assert.equal(currentSessionId(missing), undefined);
  const throwing = runtime({ adapter: () => (async function* empty() {})(), agents: false });
  throwing.get = () => ({ currentInitiator() { throw new Error('disposed'); } });
  assert.equal(currentSessionId(throwing), undefined);
});

test('the cwd scope ignores the initiator session', async () => {
  const cwdOnly = mounted({ enabled: true, scope: 'cwd', log: false });
  await cwdOnly.ctx.runAs({ session: { id: 'session-abc' } }, () => readDecision(cwdOnly.ctx.llm.stream(reviewCall('C:/work/a'))));
  assert.equal(cwdOnly.seen[0].sessionId, identityOf('C:/work/a'));
});

test('the llm/stream handler is synchronous and returns a stream', () => {
  const a = mounted();
  assert.equal(a.handlers.length, 1);
  assert.equal(typeof a.handlers[0], 'function');
  const stream = a.ctx.llm.stream(reviewCall('C:/work/a'));
  assert.equal(typeof stream.then, 'undefined');
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
});

test('non-review calls never read the initiator', async () => {
  const cheap = mounted();
  const before = cheap.ctx.initiatorCalls.count;
  await readDecision(cheap.ctx.llm.stream(chatCall));
  const afterChat = cheap.ctx.initiatorCalls.count;
  await cheap.ctx.runAs({ session: { id: 'session-cheap' } }, () => readDecision(cheap.ctx.llm.stream(reviewCall('C:/work/a'))));
  assert.equal(afterChat, before);
  assert.equal(cheap.ctx.initiatorCalls.count, before + 1);
});

test('non-review calls reach the adapter as the same object', () => {
  const plainSeen = [];
  const plain = runtime({
    adapter: (call) => {
      plainSeen.push(call);
      return (async function* chunks() {
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }
  });
  pluginApply(plain, { enabled: true, scope: 'session', log: false });
  const plainStream = plain.llm.stream(chatCall);
  assert.equal(plainSeen[0], chatCall);
  assert.equal(typeof plainStream[Symbol.asyncIterator], 'function');
});

test('an adapter failure still propagates', async () => {
  const boom = runtime({ adapter: () => { throw new Error('adapter down'); } });
  pluginApply(boom, { enabled: true, scope: 'session', log: false });
  await assert.rejects(async () => {
    for await (const chunk of boom.llm.stream(reviewCall('C:/work/a'))) void chunk;
  });
});

test('settings are read per call, so a runtime change applies without remounting', async () => {
  const config = {
    enabled: volatileOf(true),
    scope: volatileOf('session'),
    reviewProvider: volatileOf(''),
    reviewModel: volatileOf('')
  };
  const seen = [];
  const ctx = runtime({
    adapter: (call) => {
      seen.push(call);
      return (async function* chunks() {
        yield { type: 'block', text: '{"risk":"low","decision":"allow"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    }
  });
  pluginApply(ctx, config);
  await ctx.runAs({ session: { id: 'session-live' } }, () => readDecision(ctx.llm.stream(reviewCall('C:/work/a'))));
  assert.equal(seen[0].provider, 'magpie-responses');
  // 设置页保存是 volatile-only：原地写引用，不重新 apply。
  config.reviewProvider[VOLATILE_WRITE]('magpie');
  config.reviewModel[VOLATILE_WRITE]('group/edited-at-runtime');
  await ctx.runAs({ session: { id: 'session-live' } }, () => readDecision(ctx.llm.stream(reviewCall('C:/work/b'))));
  assert.equal(seen[1].provider, 'magpie');
  assert.equal(seen[1].model, 'group/edited-at-runtime');
  assert.equal(seen[1].sessionId, identityOf('session-live'));
});

test('disposing the plugin removes the listener', async () => {
  const off = mounted();
  off.handles.forEach((handle) => handle.dispose());
  await readDecision(off.ctx.llm.stream(reviewCall('C:/work/a')));
  assert.equal(off.seen[0].sessionId, undefined);
});
