import { SearchWorkerBridge } from './bridge.js';
import { SessionFindController } from './controller.js';
import { createSessionSource } from './source.js';
import { revealHit, clearFindHighlight } from './navigation.js';
import { GlobalFindController } from './global-controller.js';
import { installFindKeyboard, canFindFromFocus } from './keyboard.js';

export function createFindPlugin({ React, workerText, css, dictionaries }) {
  const h = React.createElement;
  const namespace = 'local.sessionFind';
  const kind = 'local-session-find';
  const id = '@local/dsh-session-find';
  const inject = ['slots', 'locale', 'sessions', 'uiSession', 'uiConversation', 'sidebarRight', 'sidebarRightTabs', 'shortcuts', 'remote', 'remote.session', 'workspaces', 'uiWorkspace'];

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(namespace, dictionaries));
    const t = ctx.locale.bind(namespace);
    const controllers = new Map();
    const controllerFor = (sessionId) => {
      let controller = controllers.get(sessionId);
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error(t('unavailable'));
      if (controller && controller.binding !== binding) { controller.stop(); controllers.delete(sessionId); controller = undefined; }
      if (!controller) {
        controller = new SessionFindController({ ctx, binding, workerText, createSource: createSessionSource, Bridge: SearchWorkerBridge, reveal: revealHit });
        controllers.set(sessionId, controller);
      }
      return controller;
    };
    const open = (sessionId) => {
      if (!sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
      const controller = controllerFor(sessionId);
      controller.open();
      ctx.sidebarRight.openTab(kind);
    };
    let handoff = 0;
    let pendingHandoff = null;
    let handoffTimer;
    let handoffRetry;
    const views = new Map();
    const cancelHandoff = () => { handoff++; pendingHandoff = null; clearTimeout(handoffTimer); clearTimeout(handoffRetry); };
    const globalController = new GlobalFindController({
      ctx, workerText,
      onSelect: async (hit, query, options) => {
        cancelHandoff();
        const token = handoff;
        pendingHandoff = { token, hit, query, options, origin: ctx.sidebarRight.mounted.getSnapshot(), includeArchived: globalController.getSnapshot().includeArchived };
        handoffTimer = setTimeout(() => { if (pendingHandoff?.token === token) { cancelHandoff(); globalController.publish({ notice: t('handoffTimeout') }); } }, 20000);
        if (ctx.sidebarRight.mounted.getSnapshot() !== hit.sessionId) ctx.uiWorkspace.openSession(hit.sessionId);
        deliverHandoff();
      }
    });
    function deliverHandoff() {
      const pending = pendingHandoff;
      const sessionId = ctx.sidebarRight.mounted.getSnapshot();
      if (!pending) return;
      const state = globalController.getSnapshot();
      if (pending.token !== handoff || pending.query !== state.query || pending.options !== state.options || pending.includeArchived !== state.includeArchived) { cancelHandoff(); return; }
      if (sessionId !== pending.hit.sessionId) {
        if (sessionId && sessionId !== pending.origin) cancelHandoff();
        return;
      }
      if (!ctx.sessions.binding(sessionId)) return;
      const accept = views.get(sessionId);
      if (accept) {
        pendingHandoff = null;
        clearTimeout(handoffTimer);
        clearTimeout(handoffRetry);
        accept(pending);
      } else if (!pending.openRequested) {
        pending.openRequested = true;
        try { ctx.sidebarRight.openTab(kind); }
        catch (error) {
          pending.openRequested = false;
          if (error.message === 'sidebarRight: no session surface is mounted') {
            clearTimeout(handoffRetry);
            handoffRetry = setTimeout(deliverHandoff, 35);
          } else {
            cancelHandoff();
            globalController.publish({ error: error.message });
          }
        }
      }
    }
    ctx.effect(() => () => { cancelHandoff(); views.clear(); globalController.dispose(); for (const controller of controllers.values()) controller.stop(); controllers.clear(); clearFindHighlight(); });
    ctx.effect(() => ctx.sidebarRight.mounted.subscribe(deliverHandoff));
    ctx.effect(() => typeof window === 'undefined' || !window.document || !window.addEventListener ? undefined : installFindKeyboard({ window, document: window.document, getSessionId: () => ctx.sidebarRight.mounted.getSnapshot(), open }));
    ctx.effect(() => {
      const stopOthers = () => {
        const selected = ctx.sidebarRight.mounted.getSnapshot();
        for (const [sessionId, controller] of controllers) if (sessionId !== selected) controller.stop();
      };
      return ctx.sidebarRight.mounted.subscribe(stopOthers);
    });
    ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title: () => t('title') }));

    function SearchButton({ sessionId, selectView }) {
      if (selectView) controllerFor(sessionId).selectView = selectView;
      return h('button', { className: 'dsh-find-open', type: 'button', title: t('openTitle'), 'aria-label': t('open'), onClick: () => open(sessionId) },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, h('circle', { cx: 10.5, cy: 10.5, r: 6.5, stroke: 'currentColor', strokeWidth: 1.8 }), h('path', { d: 'm16 16 5 5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' })),
        h('style', null, css));
    }

    function SearchBody({ sessionId, useTabInfo }) {
      const { tab } = useTabInfo();
      const [scope, setScope] = React.useState('current');
      const selection = React.useRef(null);
      const localController = React.useMemo(() => controllerFor(sessionId), [sessionId]);
      const controller = scope === 'all' ? globalController : localController;
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const input = React.useRef(null);
      React.useEffect(() => {
        if (!tab.visible) return;
        const accept = (pending) => {
          selection.current = pending;
          localController.setQuery(pending.query, pending.options);
          setScope('current');
          localController.open();
        };
        views.set(sessionId, accept);
        deliverHandoff();
        return () => { if (views.get(sessionId) === accept) views.delete(sessionId); };
      }, [sessionId, localController, tab.visible]);
      React.useEffect(() => {
        if (!tab.visible) return;
        if (scope === 'all') { controller.start(); if (controller.getSnapshot().query && !controller.getSnapshot().result) controller.refresh(); }
        const start = () => {
          try { controller.start(); } catch (error) { controller.publish({ error: error.message, busy: false }); }
          input.current?.focus();
        };
        start();
        return () => controller.stop();
      }, [controller, tab.visible, scope]);
      React.useEffect(() => {
        if (!tab.visible) return;
        return () => { if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) cancelHandoff(); };
      }, [tab.visible, sessionId]);
      React.useEffect(() => {
        const pending = selection.current;
        if (!pending || !tab.visible || scope !== 'current') return;
        const latest = localController.getSnapshot();
        if (pending.token !== handoff || latest.query !== pending.query) { selection.current = null; return; }
        if (!latest.source.loading && !latest.busy && (latest.result || latest.error || latest.source.error)) {
          selection.current = null;
          if (latest.result) void localController.selectSource(pending.hit);
        }
      }, [tab.visible, scope, state, localController]);
      React.useEffect(() => { if (tab.visible) { input.current?.focus(); input.current?.select(); } }, [state.focus, tab.visible]);
      const result = state.result;
      const status = state.source;
      const total = result?.total ?? 0;
      const pageOffset = state.pageOffset;
      const item = (hit) => {
        const start = Math.max(0, hit.matchStart);
        const end = Math.max(start, hit.matchEnd);
        return h('button', { type: 'button', className: 'dsh-find-result', key: hit.ordinal, 'data-active': state.active === hit.ordinal || undefined, onClick: () => controller.select(hit.ordinal) },
          scope === 'all' && h('span', { className: 'dsh-find-session' }, hit.title, hit.archived ? ` · ${t('archived')}` : '', h('small', null, hit.workspace)),
          h('span', { className: 'dsh-find-meta' }, `${hit.ordinal + 1} · ${t(hit.role === 'user' ? 'user' : hit.role === 'reasoning' ? 'reasoning' : 'assistant')} · #${hit.seq}`),
          h('span', { className: 'dsh-find-snippet' }, hit.snippet.slice(0, start), h('mark', null, hit.snippet.slice(start, end) || '▏'), hit.snippet.slice(end)));
      };
      const edited = () => { cancelHandoff(); selection.current = null; };
      const option = (key, label) => h('button', { type: 'button', className: 'dsh-find-toggle', 'aria-pressed': state.options[key], title: t(key), onClick: () => { edited(); controller.toggle(key); } }, label);
      let statusText = scope === 'all' ? t(status.loading ? 'globalIndexing' : status.complete ? 'globalReady' : status.partial ? 'globalPartial' : 'globalWaiting', { count: status.scannedSessions ?? 0, total: status.sessionsTotal ?? 0 }) : status.loading ? t('indexing', { count: status.count ?? 0 }) : status.complete ? t('ready', { count: status.count ?? 0 }) : status.partial ? t('partial') : t('waiting');
      const switchScope = (next) => {
        if (next === scope) return;
        const query = state.query;
        const options = state.options;
        const target = next === 'all' ? globalController : localController;
        controller.stop();
        cancelHandoff();
        selection.current = null;
        if (next === 'all') { target.publish({ options }); target.setQuery(query); }
        else target.setQuery(query, options);
        setScope(next);
      };
      return h('section', { className: 'dsh-find', 'data-session-find-panel': true, 'data-session-find-session': sessionId, 'aria-label': t('title'), onKeyDown: (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); controller.move(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { event.preventDefault(); cancelHandoff(); tab.actions.close(); }
      } },
      h('style', null, css),
      h('div', { className: 'dsh-find-toolbar' },
        h('div', { className: 'dsh-find-scopes', role: 'group', 'aria-label': t('searchScope') },
          h('button', { type: 'button', 'aria-pressed': scope === 'current', onClick: () => switchScope('current') }, t('currentScope')),
          h('button', { type: 'button', 'aria-pressed': scope === 'all', onClick: () => switchScope('all') }, t('allScope'))),
        h('input', { ref: input, className: 'dsh-find-input', type: 'text', value: state.query, placeholder: t(scope === 'all' ? 'globalPlaceholder' : 'placeholder'), 'aria-label': t('placeholder'), maxLength: 4096, spellCheck: false, onChange: (event) => { edited(); controller.setQuery(event.target.value); } }),
        scope === 'all' && h('label', { className: 'dsh-find-archives' }, h('input', { type: 'checkbox', checked: state.includeArchived, onChange: () => { edited(); globalController.toggleArchived(); } }), t('includeArchived')),
        h('div', { className: 'dsh-find-options' }, option('matchCase', 'Aa'), option('wholeWord', 'ab'), option('regex', '.*'), option('includeReasoning', t('reasoning'))),
        h('div', { className: 'dsh-find-navigation' },
          h('span', { className: 'dsh-find-count', 'aria-live': 'polite' }, state.busy ? t('searching') : state.query ? `${state.active >= 0 ? state.active + 1 : '—'} / ${total}${result?.truncated ? '+' : ''}` : t('hint')),
          h('button', { type: 'button', title: t('previous'), 'aria-label': t('previous'), disabled: !total || state.busy, onClick: () => controller.move(-1) }, '↑'),
          h('button', { type: 'button', title: t('next'), 'aria-label': t('next'), disabled: !total || state.busy, onClick: () => controller.move(1) }, '↓'))),
      h('div', { className: 'dsh-find-status', role: 'status' }, statusText, result ? ` · ${Number(result.elapsedMs).toFixed(1)} ms` : '', h('button', { type: 'button', className: 'dsh-find-reload', onClick: () => { edited(); controller.refresh(); }, disabled: status.loading }, t('refresh'))),
      scope === 'all' && state.busy && h('button', { type: 'button', className: 'dsh-find-cancel', onClick: () => { edited(); globalController.cancel(); } }, t('cancel')),
      status.partial && h('div', { className: 'dsh-find-note' }, t('incompleteReason'), ': ', status.reason, status.errors?.length ? ` · ${status.errors.map(error => error.message).join(' · ')}` : ''),
      (state.error || status.error) && h('div', { className: 'dsh-find-error', role: 'alert' }, state.error || status.error),
      state.notice && h('div', { className: 'dsh-find-note' }, state.notice),
      state.navigating && h('div', { className: 'dsh-find-note' }, t('locating')),
      result?.truncated && h('div', { className: 'dsh-find-note' }, t(scope === 'all' ? 'globalCapped' : 'capped')),
      h('div', { className: 'dsh-find-results' }, result?.items.map(item), !state.busy && result && !total ? h('div', { className: 'dsh-find-empty' }, t('noMatches')) : null, !state.query ? h('div', { className: 'dsh-find-empty' }, t('instructions')) : null),
      total > 50 && h('nav', { className: 'dsh-find-paging', 'aria-label': t('pages') },
        h('button', { type: 'button', disabled: pageOffset === 0, onClick: () => controller.page(pageOffset - 50) }, t('previousPage')),
        h('span', null, `${pageOffset + 1}–${Math.min(pageOffset + 50, total)} / ${total}${result.truncated ? '+' : ''}`),
        h('button', { type: 'button', disabled: pageOffset + 50 >= total, onClick: () => controller.page(pageOffset + 50) }, t('nextPage'))),
      h('footer', { className: 'dsh-find-footer' }, t(scope === 'all' ? 'globalScope' : 'scope')));
    }

    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'local-session-find', order: 30 }, SearchButton)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, SearchBody)));
    ctx.effect(() => ctx.shortcuts.register({
      id: 'local.session.find', label: () => t('title'), aliases: ['find in conversation', 'search current session', '会话内查找'],
      defaults: {}, regions: ['page', 'editable'], modals: [], resolve: () => {
        const sessionId = ctx.sidebarRight.mounted.getSnapshot();
        if (typeof window !== 'undefined' && window.document && !canFindFromFocus({ window, sessionId })) return { status: 'pass' };
        return sessionId ? { status: 'handled', run: () => open(sessionId) } : { status: 'pass' };
      }
    }));
  }
  return { inject, apply };
}
