import { SearchWorkerBridge } from './bridge.js';
import { SessionFindController } from './controller.js';
import { createSessionSource } from './source.js';
import { revealHit, clearFindHighlight } from './navigation.js';

export function createFindPlugin({ React, workerText, css, dictionaries }) {
  const h = React.createElement;
  const namespace = 'local.sessionFind';
  const kind = 'local-session-find';
  const id = '@local/dsh-session-find';
  const inject = ['slots', 'locale', 'sessions', 'uiSession', 'uiConversation', 'sidebarRight', 'sidebarRightTabs', 'shortcuts', 'remote', 'remote.session'];

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
    ctx.effect(() => () => { for (const controller of controllers.values()) controller.stop(); controllers.clear(); clearFindHighlight(); });
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
      const controller = React.useMemo(() => controllerFor(sessionId), [sessionId]);
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const input = React.useRef(null);
      React.useEffect(() => {
        if (!tab.visible) return;
        const start = () => {
          try { controller.start(); } catch (error) { controller.publish({ error: error.message, busy: false }); }
          input.current?.focus();
        };
        start();
        return () => controller.stop();
      }, [controller, tab.visible]);
      React.useEffect(() => { if (tab.visible) { input.current?.focus(); input.current?.select(); } }, [state.focus, tab.visible]);
      const result = state.result;
      const status = state.source;
      const total = result?.total ?? 0;
      const pageOffset = state.pageOffset;
      const item = (hit) => {
        const start = Math.max(0, hit.matchStart);
        const end = Math.max(start, hit.matchEnd);
        return h('button', { type: 'button', className: 'dsh-find-result', key: hit.ordinal, 'data-active': state.active === hit.ordinal || undefined, onClick: () => controller.select(hit.ordinal) },
          h('span', { className: 'dsh-find-meta' }, `${hit.ordinal + 1} · ${t(hit.role === 'user' ? 'user' : hit.role === 'reasoning' ? 'reasoning' : 'assistant')} · #${hit.seq}`),
          h('span', { className: 'dsh-find-snippet' }, hit.snippet.slice(0, start), h('mark', null, hit.snippet.slice(start, end) || '▏'), hit.snippet.slice(end)));
      };
      const option = (key, label) => h('button', { type: 'button', className: 'dsh-find-toggle', 'aria-pressed': state.options[key], title: t(key), onClick: () => controller.toggle(key) }, label);
      let statusText = status.loading ? t('indexing', { count: status.count ?? 0 }) : status.complete ? t('ready', { count: status.count ?? 0 }) : status.partial ? t('partial') : t('waiting');
      return h('section', { className: 'dsh-find', 'aria-label': t('title'), onKeyDown: (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); controller.move(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { event.preventDefault(); tab.actions.close(); }
      } },
      h('style', null, css),
      h('div', { className: 'dsh-find-toolbar' },
        h('input', { ref: input, className: 'dsh-find-input', type: 'text', value: state.query, placeholder: t('placeholder'), 'aria-label': t('placeholder'), maxLength: 4096, spellCheck: false, onChange: (event) => controller.setQuery(event.target.value) }),
        h('div', { className: 'dsh-find-options' }, option('matchCase', 'Aa'), option('wholeWord', 'ab'), option('regex', '.*'), option('includeReasoning', t('reasoning'))),
        h('div', { className: 'dsh-find-navigation' },
          h('span', { className: 'dsh-find-count', 'aria-live': 'polite' }, state.busy ? t('searching') : state.query ? `${state.active >= 0 ? state.active + 1 : '—'} / ${total}${result?.truncated ? '+' : ''}` : t('hint')),
          h('button', { type: 'button', title: t('previous'), 'aria-label': t('previous'), disabled: !total || state.busy, onClick: () => controller.move(-1) }, '↑'),
          h('button', { type: 'button', title: t('next'), 'aria-label': t('next'), disabled: !total || state.busy, onClick: () => controller.move(1) }, '↓'))),
      h('div', { className: 'dsh-find-status', role: 'status' }, statusText, result ? ` · ${Number(result.elapsedMs).toFixed(1)} ms` : '', h('button', { type: 'button', className: 'dsh-find-reload', onClick: () => controller.refresh(), disabled: status.loading }, t('refresh'))),
      (state.error || status.error) && h('div', { className: 'dsh-find-error', role: 'alert' }, state.error || status.error),
      state.notice && h('div', { className: 'dsh-find-note' }, state.notice),
      state.navigating && h('div', { className: 'dsh-find-note' }, t('locating')),
      result?.truncated && h('div', { className: 'dsh-find-note' }, t('capped')),
      h('div', { className: 'dsh-find-results' }, result?.items.map(item), !state.busy && result && !total ? h('div', { className: 'dsh-find-empty' }, t('noMatches')) : null, !state.query ? h('div', { className: 'dsh-find-empty' }, t('instructions')) : null),
      total > 50 && h('nav', { className: 'dsh-find-paging', 'aria-label': t('pages') },
        h('button', { type: 'button', disabled: pageOffset === 0, onClick: () => controller.page(pageOffset - 50) }, t('previousPage')),
        h('span', null, `${pageOffset + 1}–${Math.min(pageOffset + 50, total)} / ${total}${result.truncated ? '+' : ''}`),
        h('button', { type: 'button', disabled: pageOffset + 50 >= total, onClick: () => controller.page(pageOffset + 50) }, t('nextPage'))),
      h('footer', { className: 'dsh-find-footer' }, t('scope')));
    }

    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'local-session-find', order: 30 }, SearchButton)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, SearchBody)));
    ctx.effect(() => ctx.shortcuts.register({
      id: 'local.session.find', label: () => t('title'), aliases: ['find in conversation', 'search current session', '会话内查找'],
      defaults: {
        'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
        'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
        'web:windows': { code: 'KeyF', modifiers: ['primary', 'alt'] },
        'web:macos': { code: 'KeyF', modifiers: ['primary', 'alt'] },
        'web:linux': { code: 'Slash', modifiers: ['primary'] }
      }, regions: ['page', 'editable'], modals: [], resolve: () => {
        const sessionId = ctx.sidebarRight.mounted.getSnapshot();
        return sessionId ? { status: 'handled', run: () => open(sessionId) } : { status: 'pass' };
      }
    }));
  }
  return { inject, apply };
}
