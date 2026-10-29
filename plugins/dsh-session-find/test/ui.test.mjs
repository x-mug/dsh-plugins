import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const uiText = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
const uiBody = uiText.replace(/^import[^\n]*\n/gm, '').replace('export function createFindPlugin', 'function createFindPlugin');
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function fixture(t, { priority = false, publishOnSelection = false, source = uiBody, onOpenTab } = {}) {
  const locals = new Map();
  const timers = new Map();
  const timerDelays = new Map();
  const bindings = new Map(['a', 'b'].map(sessionId => [sessionId, { sessionId }]));
  const bodies = new Set();
  const mountedListeners = new Set();
  const cleanups = [];
  const calls = { starts: [], stops: [], delivered: [], selected: [], opened: [] };
  let mounted = 'a';
  let nextTimer = 0;
  let hooks;
  let SearchBody;
  let global;
  let command;
  let disposed = false;
  class Store {
    listeners = new Set();
    getSnapshot = () => this.state;
    subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    publish(patch) { this.state = { ...this.state, ...patch }; for (const listener of [...this.listeners]) listener(); }
    start() { if (this.started) return; this.started = true; calls.starts.push(this.id); }
    stop() { if (!this.started) return; this.started = false; calls.stops.push(this.id); }
    open() { this.publish({ focus: this.state.focus + 1 }); }
    toggle(key) { this.publish({ options: { ...this.state.options, [key]: !this.state.options[key] } }); }
    move() {}
    page() {}
  }
  class LocalController extends Store {
    constructor({ binding }) {
      super(); this.id = binding.sessionId; this.binding = binding;
      this.state = { query: '', options: {}, focus: 0, source: { loading: false }, result: null, busy: false };
      locals.set(this.id, this);
    }
    start() { const wasStarted = this.started; super.start(); if (!wasStarted) this.publish({ source: { loading: true }, busy: Boolean(this.state.query), result: null }); }
    stop() { super.stop(); this.publish({ source: { loading: false }, busy: false, result: null }); }
    setQuery(query, options) { this.publish({ query, options: options ?? this.state.options, busy: Boolean(query), result: null }); calls.delivered.push({ sessionId: this.id, query }); }
    selectSource(hit) { calls.selected.push({ sessionId: this.id, hit }); if (publishOnSelection) this.publish({ navigating: true, active: 0 }); }
    finish() { this.publish({ source: { loading: false, complete: true }, busy: false, result: { total: 1, items: [] } }); }
    refresh() { this.start(); }
  }
  class GlobalController extends Store {
    constructor(options) {
      super(); global = this; this.id = 'global'; this.api = options;
      this.state = { query: '', options: { matchCase: false, wholeWord: false, regex: false, includeReasoning: false }, includeArchived: false, focus: 0, source: { loading: false }, result: { total: 1, items: [] }, busy: false };
    }
    setQuery(query) { this.publish({ query }); }
    toggleArchived() { this.publish({ includeArchived: !this.state.includeArchived }); }
    cancel() { this.publish({ busy: false }); }
    stop() { super.stop(); this.cancel(); }
    refresh() {}
    dispose() { this.stop(); this.listeners.clear(); }
  }
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) }; },
    useState(initial) {
      const owner = hooks; const index = owner.cursor++;
      owner.cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      const cell = owner.cells[index];
      return [cell.value, value => { const next = typeof value === 'function' ? value(cell.value) : value; if (!Object.is(next, cell.value)) { if (priority) { cell.pending = next; cell.hasPending = true; } else cell.value = next; owner.dirty = true; } }];
    },
    useMemo(create, deps) {
      const index = hooks.cursor++; const old = hooks.cells[index];
      if (!old || !sameDeps(old.deps, deps)) hooks.cells[index] = { value: create(), deps };
      return hooks.cells[index].value;
    },
    useRef(value) { return React.useMemo(() => ({ current: value }), []); },
    useSyncExternalStore(subscribe, snapshot) {
      const owner = hooks; const index = owner.cursor++; const old = owner.cells[index];
      if (!old || old.subscribe !== subscribe) {
        old?.cleanup?.();
        owner.cells[index] = { subscribe, cleanup: subscribe(() => { owner.dirty = true; owner.sync = true; }) };
      }
      return snapshot();
    },
    useEffect(create, deps) {
      const index = hooks.cursor++; const old = hooks.cells[index];
      if (!old || !sameDeps(old.deps, deps)) hooks.effects.push({ index, create, deps });
    },
  };
  const createPlugin = new Function('SearchWorkerBridge', 'SessionFindController', 'createSessionSource', 'revealHit', 'clearFindHighlight', 'GlobalFindController', 'installFindKeyboard', 'setTimeout', 'clearTimeout', source + '\nreturn createFindPlugin;')(
    {}, LocalController, () => {}, () => {}, () => {}, GlobalController, () => {},
    (callback, delay) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); return id; }, id => { timers.delete(id); timerDelays.delete(id); },
  );
  createPlugin({ React, workerText: '', css: '', dictionaries: {} }).apply({
    effect(create) { const cleanup = create(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    locale: { register: () => () => {}, bind: () => key => key },
    sessions: { binding: id => bindings.get(id) },
    sidebarRight: { mounted: { getSnapshot: () => mounted, subscribe(listener) { mountedListeners.add(listener); return () => mountedListeners.delete(listener); } }, openTab(kind) { calls.opened.push({ sessionId: mounted, kind }); onOpenTab?.(kind, mounted); } },
    sidebarRightTabs: { register: () => () => {} }, uiWorkspace: { openSession(sessionId) { calls.opened.push({ sessionId, kind: 'session' }); } },
    slots: { inject: (_name, create) => create(), register(spec, component) { if (spec.name === 'sidebar.right.pane.tab') SearchBody = component; return () => {}; } },
    shortcuts: { register(spec) { command = spec; return () => {}; } },
  });
  function mount(sessionId = mounted) {
    const state = { cursor: 0, cells: [], effects: [], dirty: true, active: true, visible: true, tree: null };
    const body = {
      flush() {
        let renders = 0;
        while (state.active && state.dirty) {
          assert.ok(++renders <= 30, 'UI effect loop must settle.');
          if (priority && !state.sync) for (const cell of state.cells) if (cell?.hasPending) { cell.value = cell.pending; cell.hasPending = false; }
          state.sync = false;
          state.dirty = false; state.cursor = 0; state.effects = []; hooks = state;
          state.tree = SearchBody({ sessionId, useTabInfo: () => ({ tab: { visible: state.visible, actions: { close: () => body.visible(false) } } }) });
          hooks = null;
          for (const effect of state.effects) state.cells[effect.index]?.cleanup?.();
          for (const effect of state.effects) state.cells[effect.index] = { deps: effect.deps, cleanup: effect.create() };
          if (priority && state.cells.some(cell => cell?.hasPending)) state.dirty = true;
        }
      },
      visible(value) { state.visible = value; state.dirty = true; body.flush(); },
      find(predicate) { const visit = node => typeof node === 'object' && node ? predicate(node) ? node : node.children?.map(visit).find(Boolean) : undefined; return visit(state.tree); },
      click(label) { const button = body.find(node => node.type === 'button' && node.children?.includes(label)); assert.ok(button, `Button ${label} exists.`); button.props.onClick(); body.flush(); },
      edit(value) { body.find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value } }); body.flush(); },
      unmount() { if (!state.active) return; state.active = false; for (const cell of [...state.cells].reverse()) cell?.cleanup?.(); bodies.delete(body); },
      get scope() { return state.cells[0]?.value; },
      get local() { return locals.get(sessionId); },
    };
    bodies.add(body); body.flush(); return body;
  }
  function dispose() {
    if (disposed) return; disposed = true;
    for (const body of [...bodies]) body.unmount();
    for (const cleanup of cleanups.reverse()) cleanup();
  }
  t.after(dispose);
  return {
    calls, timers, timerDelays, bindings, locals, mount, dispose,
    fire(delay) { const entry = [...timers].find(([id]) => timerDelays.get(id) === delay); assert.ok(entry, `A ${delay}ms timer exists.`); const [id, callback] = entry; timers.delete(id); timerDelays.delete(id); callback(); return callback; },
    get global() { return global; },
    get command() { return command; },
    mounted(sessionId) { mounted = sessionId; for (const listener of [...mountedListeners]) listener(); },
    select(sessionId, query = global.state.query) { return global.api.onSelect({ sessionId, seq: 0, part: 0, role: 'user', offset: 0, length: query.length }, query, global.state.options); },
  };
}

function globalBody(f) {
  const body = f.mount('a'); body.edit('needle'); body.click('allScope');
  assert.equal(body.scope, 'all'); assert.equal(body.local.started, false);
  return body;
}

test('new query, options and archive state invalidate a delayed target handoff', async t => {
  for (const variant of ['query', 'options', 'archive', 'UI query', 'UI cancel', 'UI close', 'UI refresh']) {
    await t.test(variant, async t => {
      const f = fixture(t); const body = globalBody(f);
      await f.select('b');
      assert.equal(f.timers.size, 1);
      if (variant === 'query') f.global.setQuery('new');
      else if (variant === 'options') f.global.toggle('regex');
      else if (variant === 'archive') f.global.toggleArchived();
      else if (variant === 'UI query') body.edit('new');
      else if (variant === 'UI cancel') { f.global.publish({ busy: true }); body.flush(); body.click('cancel'); }
      else if (variant === 'UI refresh') body.click('refresh');
      else body.visible(false);
      f.mounted('b'); body.unmount();
      const delivered = f.calls.delivered.length;
      const target = f.mount('b');
      assert.equal(f.calls.delivered.length, delivered);
      assert.equal(target.local.state.query, '');
      assert.equal(f.timers.size, 0);
    });
  }
});

test('visiting a third session cancels the delayed target instead of taking it over later', async t => {
  const f = fixture(t); const body = globalBody(f);
  await f.select('b');
  assert.equal(f.timers.size, 1);
  f.mounted('c'); body.unmount();
  assert.equal(f.timers.size, 0);
  f.mounted('b');
  const delivered = f.calls.delivered.length;
  const target = f.mount('b');
  assert.equal(f.calls.delivered.length, delivered);
  assert.equal(target.local.state.query, '');
  assert.equal(f.calls.selected.length, 0);
});

test('same-session hit rerenders to current scope and only its effect starts and stops local', async t => {
  const f = fixture(t); const body = globalBody(f);
  const count = f.calls.starts.filter(id => id === 'a').length;
  await f.select('a');
  assert.equal(body.local.started, false);
  body.flush();
  assert.equal(body.scope, 'current');
  assert.equal(body.local.started, true);
  assert.equal(f.calls.starts.filter(id => id === 'a').length, count + 1);
  assert.equal(body.local.state.query, 'needle');
  body.local.finish(); body.flush();
  assert.equal(f.calls.selected.length, 1);
  body.visible(false);
  assert.equal(body.local.started, false);
  assert.equal(f.timers.size, 0);
});

test('delayed binding keeps handoff pending without starting hidden source and new visible body accepts it', async t => {
  const f = fixture(t); const body = globalBody(f);
  f.bindings.delete('b');
  await f.select('b');
  f.mounted('b'); body.unmount();
  assert.equal(f.locals.has('b'), false);
  assert.equal(f.timers.size, 1);
  f.bindings.set('b', { sessionId: 'b' });
  const target = f.mount('b');
  assert.equal(target.scope, 'current');
  assert.equal(target.local.state.query, 'needle');
  assert.equal(target.local.started, true);
  assert.equal(f.timers.size, 0);
  target.local.finish(); target.flush();
  assert.equal(f.calls.selected.at(-1)?.sessionId, 'b');
  target.unmount();
  assert.equal(target.local.started, false);
});

test('hiding a selected current view invalidates selection before a late result can navigate', async t => {
  const f = fixture(t); const body = globalBody(f);
  await f.select('a'); body.flush();
  body.visible(false);
  body.local.finish(); body.visible(true);
  assert.equal(f.calls.selected.length, 0);
  assert.equal(f.timers.size, 0);
});

test('plugin unload releases handoff timer, view subscriptions and every active controller', async t => {
  const f = fixture(t); globalBody(f);
  await f.select('b');
  const callbacks = [...f.timers.values()];
  assert.equal(callbacks.length, 1);
  f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal([...f.locals.values()].every(local => !local.started && local.listeners.size === 0), true);
  assert.equal(f.global.started, false);
  for (const callback of callbacks) callback();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.selected.length, 0);
});

test('handoff consumes once when external-store rendering preempts normal state commits', async t => {
  for (const targetId of ['a', 'b']) await t.test(targetId === 'a' ? 'same-session' : 'same-commit acceptance on delayed target', async t => {
    const f = fixture(t, { priority: true, publishOnSelection: true });
    let body = globalBody(f);
    await f.select(targetId);
    if (targetId === 'b') { f.mounted('b'); body.unmount(); body = f.mount('b'); }
    body.flush();
    assert.equal(body.local.state.query, 'needle');
    assert.equal(body.scope, 'current');
    body.local.finish(); body.flush();
    assert.equal(f.calls.selected.length, 1);
    body.local.publish({ navigating: false }); body.flush();
    assert.equal(f.calls.selected.length, 1);
    body.visible(false);
    assert.equal(body.local.started, false);
  });
});

test('previous selection state loops under synchronous external-store priority', async t => {
  let old = uiBody.replace('const selection = React.useRef(null);', 'const [selection, setSelection] = React.useState(null);');
  old = old.replace('selection.current = pending;', 'setSelection(pending);');
  old = old.replaceAll('selection.current = null;', 'setSelection(null);');
  old = old.replace('const pending = selection.current;', 'const pending = selection;');
  old = old.replace('}, [tab.visible, scope, state, localController]);', '}, [selection, tab.visible, scope, state, localController]);');
  const f = fixture(t, { priority: true, publishOnSelection: true, source: old });
  const body = globalBody(f);
  await f.select('a'); body.flush();
  body.local.finish();
  assert.throws(() => body.flush(), /UI effect loop must settle/);
  assert.ok(f.calls.selected.length > 20, 'Old pending state repeatedly consumes the same handoff.');
});

test('fresh target surface retries only the known pre-adoption error and then delivers once', async t => {
  let attempts = 0;
  const f = fixture(t, { onOpenTab() { if (++attempts <= 2) throw new Error('sidebarRight: no session surface is mounted'); } });
  const body = globalBody(f);
  await f.select('b'); f.mounted('b'); body.unmount();
  assert.equal(attempts, 1);
  assert.equal(f.timers.size, 2);
  f.fire(35); assert.equal(attempts, 2); assert.equal(f.timers.size, 2);
  f.fire(35); assert.equal(attempts, 3); assert.equal(f.timers.size, 1);
  f.mounted('b'); assert.equal(attempts, 3, 'A successful request is not repeated before the target body mounts.');
  const target = f.mount('b');
  assert.equal(target.local.state.query, 'needle');
  assert.equal(f.timers.size, 0);
  target.local.finish(); target.flush();
  assert.equal(f.calls.selected.length, 1);
});

test('surface retries end at the original handoff deadline', async t => {
  let attempts = 0;
  const f = fixture(t, { onOpenTab() { attempts++; throw new Error('sidebarRight: no session surface is mounted'); } });
  const body = globalBody(f);
  await f.select('b'); f.mounted('b'); body.unmount();
  const staleRetry = [...f.timers].find(([id]) => f.timerDelays.get(id) === 35)[1];
  f.fire(20000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.global.state.notice, 'handoffTimeout');
  staleRetry(); assert.equal(attempts, 1);
});

test('third-session switch, UI cancel and unload prevent late surface opens', async t => {
  for (const variant of ['third session', 'UI cancel', 'unload']) await t.test(variant, async t => {
    let attempts = 0;
    const f = fixture(t, { onOpenTab() { attempts++; throw new Error('sidebarRight: no session surface is mounted'); } });
    const body = globalBody(f);
    await f.select('b'); f.mounted('b');
    const callbacks = [...f.timers.values()];
    if (variant === 'third session') f.mounted('c');
    else if (variant === 'UI cancel') { f.global.publish({ busy: true }); body.flush(); body.click('cancel'); }
    else f.dispose();
    assert.equal(f.timers.size, 0);
    for (const callback of callbacks) callback();
    assert.equal(attempts, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.selected.length, 0);
  });
});

test('unknown surface errors are visible and never retried', async t => {
  let attempts = 0;
  const f = fixture(t, { onOpenTab() { attempts++; throw new Error('broken tab provider'); } });
  const body = globalBody(f);
  await f.select('b'); f.mounted('b');
  assert.equal(f.global.state.error, 'broken tab provider');
  assert.equal(f.timers.size, 0);
  f.mounted('b'); assert.equal(attempts, 1);
  body.unmount(); const target = f.mount('b');
  assert.equal(target.local.state.query, '');
});

test('synchronous open callbacks cannot reenter the same tab request', async t => {
  let attempts = 0; let f;
  f = fixture(t, { onOpenTab() { assert.ok(++attempts < 3, 'The in-flight open is guarded.'); f.mounted('b'); } });
  const body = globalBody(f);
  await f.select('b'); f.mounted('b');
  assert.equal(attempts, 1);
  body.unmount(); const target = f.mount('b');
  assert.equal(target.local.state.query, 'needle');
  assert.equal(f.timers.size, 0);
});

test('service command has no default that can collide with any host platform', t => {
  const f = fixture(t);
  assert.deepEqual(f.command.defaults, {});
});

test('actual rc.3 ShortcutRegistry admits unbound find and reproduces old cross-platform rejection', async t => {
  if (!process.env.DSH_TEST_VENDOR_DIR) {
    t.skip('Set DSH_TEST_VENDOR_DIR to a directory containing dsh-client-shortcuts/lib/client.js.');
    return;
  }
  const hostText = await readFile(path.join(process.env.DSH_TEST_VENDOR_DIR, 'dsh-client-shortcuts/lib/client.js'), 'utf8');
  const bindingStart = hostText.indexOf('\t\tconst keyNames =');
  const bindingEnd = hostText.indexOf('\t\t//#endregion', bindingStart);
  const implementationStart = hostText.indexOf('\t\tconst commandPattern =');
  const registryEnd = hostText.indexOf('\t\t//#region lib/types/client/dom.js', implementationStart);
  assert.ok(bindingStart > 0 && bindingEnd > bindingStart && implementationStart > 0 && registryEnd > implementationStart);
  const createSnapshotStore = initial => {
    let value = initial; const listeners = new Set();
    return { getSnapshot: () => value, set(next) { value = next; for (const listener of listeners) listener(); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  };
  const { ShortcutRegistry, resolveShortcutDefault, normalizeBinding, bindingIssue } = vm.runInNewContext(
    `${hostText.slice(bindingStart, bindingEnd)}\n${hostText.slice(implementationStart, registryEnd)}\n({ ShortcutRegistry, resolveShortcutDefault, normalizeBinding, bindingIssue })`,
    { _deepseek_ai_dsh_client_store: { createSnapshotStore }, crypto: globalThis.crypto },
  );
  const f = fixture(t);
  const core = [
    { id: 'session.fork', defaults: { 'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'alt'] } } },
    { id: 'shortcuts.open', defaults: Object.fromEntries(['desktop', 'web'].flatMap(runtime => ['macos', 'windows', 'linux'].map(platform => [`${runtime}:${platform}`, { code: 'Slash', modifiers: ['primary'] }]))) },
  ];
  for (const runtime of ['desktop', 'web']) for (const platform of ['macos', 'windows', 'linux']) {
    const registry = new ShortcutRegistry(runtime, platform);
    for (const command of core) registry.register({ ...command, label: () => command.id, regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) });
    assert.equal(resolveShortcutDefault(f.command, runtime, platform), undefined);
    const bindingCount = registry.bindings.size;
    const dispose = registry.register(f.command);
    assert.equal(registry.commands.has(f.command.id), true);
    assert.equal(registry.catalog.getSnapshot().find(row => row.id === f.command.id).binding, null);
    assert.equal(registry.bindings.size, bindingCount);
    dispose(); dispose();
    assert.equal(registry.commands.has(f.command.id), false);
    assert.throws(() => registry.register({ ...f.command, defaults: { 'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'alt'] } } }), /Conflicting shortcut defaults: local.session.find and session.fork \(desktop:macos\)/);
    assert.throws(() => registry.register({ ...f.command, defaults: { 'web:linux': { code: 'Slash', modifiers: ['primary'] } } }), /Conflicting shortcut defaults: local.session.find and shortcuts.open \(web:linux\)/);
    assert.equal(bindingIssue(normalizeBinding({ code: 'KeyF', modifiers: ['primary', 'alt'] }, platform), 'desktop', platform), null);
  }
});
