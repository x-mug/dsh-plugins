import test from 'node:test';
import assert from 'node:assert/strict';
import { installFindKeyboard, canFindFromFocus } from '../src/keyboard.js';

class KeyboardTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    const entries = this.listeners.get(type) ?? [];
    if (!entries.some(entry => entry.listener === listener && entry.capture === capture)) entries.push({ listener, capture });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.listener !== listener || entry.capture !== capture));
  }
  count() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0); }
  invoke(event, capture) {
    for (const entry of [...this.listeners.get(event.type) ?? []]) if (entry.capture === capture) entry.listener(event);
  }
}

class KeyboardElement extends KeyboardTarget {
  constructor(document, tag, attributes = {}) {
    super();
    this.nodeType = 1;
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
    this.children = [];
    this.parentElement = null;
    this.style = { display: 'block', visibility: 'visible' };
    this.rects = [{ width: 100, height: 24 }];
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get isConnected() { return this.getRootNode() === this.ownerDocument || Boolean(this.getRootNode().host?.isConnected); }
  getRootNode() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node === this.ownerDocument.documentElement ? this.ownerDocument : node.shadowHost ? { host: node.shadowHost } : node;
  }
  getClientRects() { return this.rects; }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } };
    visit(this);
    return found;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      let check = part.trim();
      if (check === ':popover-open') return this.popoverOpen === true;
      const excluded = [...check.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      if (excluded.some(value => this.matches(value))) return false;
      check = check.replace(/:not\([^)]+\)/g, '');
      const tag = check.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const classes = [...check.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      if (classes.some(name => !(this.getAttribute('class') ?? '').split(/\s+/).includes(name))) return false;
      for (const [, name, value] of check.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (!this.hasAttribute(name) || value !== undefined && this.getAttribute(name) !== value) return false;
      }
      return true;
    });
  }
}

function fixture() {
  const window = new KeyboardTarget();
  const document = new KeyboardTarget();
  document.nodeType = 9;
  window.document = document;
  window.getComputedStyle = element => element.style;
  const element = (tag = 'div', attributes) => new KeyboardElement(document, tag, attributes);
  document.documentElement = element('html');
  document.body = element('body');
  document.documentElement.append(document.body);
  document.activeElement = document.body;
  document.querySelectorAll = selector => {
    const found = [];
    const visit = root => { if (root.matches(selector)) found.push(root); root.children.forEach(visit); };
    visit(document.documentElement);
    return found;
  };
  const root = element('div', { 'data-conversation-content': '', 'data-conversation-session': 'current', 'data-conversation-region': 'chat' });
  const scroller = element('div', { 'data-conversation-scroll': '' });
  const flow = element('div', { 'data-chat-flow': '' });
  const row = element('div', { 'data-chat-node-key': 'message_1' });
  const paragraph = element('p');
  const composer = element('div', { 'data-composer-seat': '', 'data-conversation-region': 'composer' });
  const input = element('div', { contenteditable: 'true', 'data-composer-input': 'true', 'data-lexical-editor': 'true' });
  document.body.append(root.append(scroller.append(flow.append(row.append(paragraph)), composer.append(input))));
  let session = 'current';
  let enabled = true;
  const opened = [];
  const options = { window, document, getSessionId: () => session, isEnabled: () => enabled, open: (id, event) => { opened.push({ id, event }); } };
  const install = overrides => installFindKeyboard({ ...options, ...overrides });
  function dispatch(type = 'keydown', target = paragraph, properties = {}) {
    const path = [];
    let current = target;
    while (current && current !== document) {
      path.push(current);
      current = current.parentElement ?? current.getRootNode?.().host;
    }
    path.push(document, window);
    let stopped = false;
    const event = {
      type, target, key: 'f', code: 'KeyF', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      repeat: false, cancelable: true, defaultPrevented: false, isComposing: false, keyCode: 70, which: 70,
      getModifierState: () => false, composedPath: () => path,
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
      stopPropagation() { stopped = true; }, ...properties,
    };
    for (const owner of [...path].reverse()) { owner.invoke?.(event, true); if (stopped) return event; }
    for (const owner of path) { owner.invoke?.(event, false); if (stopped) return event; }
    return event;
  }
  const panel = (owner = 'current', explicit = false) => {
    const sidebar = element('aside', { 'data-sidebar-right-session': owner });
    const pane = element('section', { 'data-dockkit-pane': 'pane1' });
    const find = element('section', explicit ? { 'data-session-find-panel': '', 'data-session-find-session': owner } : { class: 'dsh-find' });
    const input = element('input', { type: 'text' });
    document.body.append(sidebar.append(pane.append(find.append(input))));
    return { sidebar, pane, find, input };
  };
  return { window, document, element, root, scroller, flow, row, paragraph, composer, input, panel, opened, install, dispatch, setSession: value => { session = value; }, setEnabled: value => { enabled = value; } };
}

const accepted = (f, target = f.paragraph, properties) => {
  const before = f.opened.length;
  const event = f.dispatch('keydown', target, properties);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.opened.length, before + 1);
  assert.equal(f.opened.at(-1).id, 'current');
  return event;
};
const preserved = (f, target = f.paragraph, properties) => {
  const before = f.opened.length;
  const event = f.dispatch('keydown', target, properties);
  assert.equal(event.defaultPrevented, properties?.defaultPrevented ?? false);
  assert.equal(f.opened.length, before);
  return event;
};

test('real Ctrl+F and Cmd+F open from current main chat before host window dispatch', () => {
  const f = fixture();
  const dispose = f.install();
  let host = 0;
  f.window.addEventListener('keydown', () => { host++; });
  accepted(f);
  accepted(f, f.paragraph, { ctrlKey: false, metaKey: true });
  assert.equal(host, 0);
  dispose();
});

test('composer editable controls, main scroll blank and page body/html blank are accepted', () => {
  const f = fixture();
  const dispose = f.install();
  for (const target of [f.input, f.composer, f.root, f.scroller, f.document.body, f.document.documentElement]) {
    f.document.activeElement = target;
    accepted(f, target);
  }
  const textarea = f.element('textarea');
  f.composer.append(textarea);
  f.document.activeElement = textarea;
  accepted(f, textarea);
  dispose();
});

test('plugin panel accepts explicit session ownership and legacy sidebar-owned class', () => {
  const f = fixture();
  const dispose = f.install();
  for (const explicit of [false, true]) {
    const { input } = f.panel('current', explicit);
    f.document.activeElement = input;
    accepted(f, input);
  }
  const wrong = f.panel('other', true);
  f.document.activeElement = wrong.input;
  preserved(f, wrong.input);
  wrong.find.setAttribute('data-session-find-session', 'current');
  preserved(f, wrong.input);
  dispose();
});

test('unowned or stale panel and a panel inside a hidden sidebar never steal find', () => {
  const f = fixture();
  const dispose = f.install();
  const unowned = f.element('section', { class: 'dsh-find' });
  f.document.body.append(unowned);
  preserved(f, unowned);
  const panel = f.panel();
  panel.sidebar.setAttribute('hidden', '');
  preserved(f, panel.input);
  dispose();
});

test('missing current session or disabled plugin leaves native find untouched', () => {
  const f = fixture();
  const dispose = f.install();
  for (const session of [undefined, null, '', 0]) { f.setSession(session); preserved(f); }
  f.setSession('current');
  f.setEnabled(false);
  preserved(f);
  f.setEnabled(true);
  accepted(f);
  dispose();
});

test('only exact primary plus F is handled, with a narrow unidentified-key fallback', () => {
  const f = fixture();
  const dispose = f.install();
  for (const properties of [
    { ctrlKey: false }, { ctrlKey: true, metaKey: true }, { altKey: true }, { shiftKey: true },
    { key: 'g' }, { key: 'Dead' }, { key: 'Process' }, { key: 'а', code: 'KeyF' },
    { getModifierState: name => name === 'AltGraph' },
  ]) preserved(f, f.paragraph, properties);
  accepted(f, f.paragraph, { key: 'F', code: 'KeyF' });
  accepted(f, f.paragraph, { key: 'Unidentified', code: 'KeyF' });
  accepted(f, f.paragraph, { key: '', code: 'KeyF' });
  dispose();
});

test('target handlers can prevent or stop the event before document routing', () => {
  const f = fixture();
  const dispose = f.install();
  f.paragraph.addEventListener('keydown', event => event.preventDefault());
  const local = f.dispatch();
  assert.equal(local.defaultPrevented, true);
  assert.equal(f.opened.length, 0);
  f.row.addEventListener('keydown', event => event.stopPropagation());
  preserved(f, f.row);
  assert.equal(f.opened.length, 0);
  dispose();
});

test('defaultPrevented, noncancelable, IME and 229 events preserve native ownership', () => {
  const f = fixture();
  const dispose = f.install();
  for (const properties of [{ defaultPrevented: true }, { cancelable: false }, { isComposing: true }, { keyCode: 229 }, { which: 229 }]) preserved(f, f.paragraph, properties);
  f.dispatch('compositionstart', f.input);
  preserved(f);
  f.dispatch('compositionend', f.input);
  accepted(f);
  f.dispatch('compositionstart', f.input);
  f.dispatch('blur', f.window);
  accepted(f);
  dispose();
});

test('held repeats do not reopen, keyup and blur reset repeat consumption', () => {
  const f = fixture();
  const dispose = f.install();
  preserved(f, f.paragraph, { repeat: true });
  accepted(f);
  const repeated = f.dispatch('keydown', f.paragraph, { repeat: true });
  assert.equal(repeated.defaultPrevented, true);
  assert.equal(f.opened.length, 1);
  f.dispatch('keyup', f.paragraph);
  preserved(f, f.paragraph, { repeat: true });
  accepted(f);
  f.dispatch('blur', f.window);
  preserved(f, f.paragraph, { repeat: true });
  dispose();
});

test('repeat after focus changes to native editor or another session is preserved', () => {
  const f = fixture();
  const dispose = f.install();
  accepted(f);
  const editor = f.element('div', { class: 'monaco-editor' });
  f.row.append(editor);
  preserved(f, editor, { repeat: true });
  f.setSession('other');
  preserved(f, f.paragraph, { repeat: true });
  dispose();
});

test('file preview, code editors, terminal and embedded frames are never intercepted', () => {
  const f = fixture();
  const dispose = f.install();
  for (const attributes of [
    { class: 'xterm' }, { class: 'monaco-editor' }, { class: 'cm-editor' }, { class: 'CodeMirror' }, { class: 'ace_editor' },
    { 'data-document-preview': 'file' }, { 'data-textpreview-state': 'loading' }, { 'data-textpreview-body': '' },
    { 'data-code-preview': '' }, { 'data-html-preview': '' }, { 'data-pdf-preview': '' },
    { 'data-image-preview': '' }, { 'data-document-markdown': '' }, { 'data-session-find-native': '' },
  ]) {
    const owner = f.element('div', attributes);
    const child = f.element('span');
    f.row.append(owner.append(child));
    preserved(f, child);
  }
  for (const tag of ['iframe', 'webview', 'object', 'embed']) {
    const native = f.element(tag);
    f.row.append(native);
    preserved(f, native);
  }
  dispose();
});

test('unknown input and editable outside composer/plugin retain their find behavior', () => {
  const f = fixture();
  const dispose = f.install();
  for (const [tag, attributes] of [['input'], ['textarea'], ['select'], ['div', { contenteditable: 'true' }], ['div', { contenteditable: 'plaintext-only' }], ['div', { role: 'textbox' }], ['div', { role: 'combobox' }]]) {
    const control = f.element(tag, attributes);
    const child = f.element('span');
    f.row.append(control.append(child));
    preserved(f, child);
  }
  const literal = f.element('div', { contenteditable: 'false' });
  f.row.append(literal);
  accepted(f, literal);
  dispose();
});

test('visible dialog/menu/listbox blocks chat shortcut even with stale chat focus', () => {
  const f = fixture();
  const dispose = f.install();
  for (const attributes of [{ role: 'dialog' }, { 'aria-modal': 'true' }, { 'data-shortcut-modal': 'settings' }, { role: 'menu' }, { role: 'listbox' }]) {
    const overlay = f.element('div', attributes);
    f.document.body.append(overlay);
    preserved(f);
    overlay.setAttribute('hidden', '');
    accepted(f);
  }
  dispose();
});

test('closed, hidden, inert and zero-sized overlays do not block current chat', () => {
  const f = fixture();
  const dispose = f.install();
  const closedDialog = f.element('dialog');
  closedDialog.rects = [];
  f.document.body.append(closedDialog);
  for (const modifier of [node => node.setAttribute('hidden', ''), node => node.setAttribute('aria-hidden', 'true'), node => node.setAttribute('inert', ''), node => { node.style.display = 'none'; }, node => { node.style.visibility = 'hidden'; }, node => { node.rects = []; }]) {
    const overlay = f.element('div', { role: 'dialog' });
    modifier(overlay);
    f.document.body.append(overlay);
    accepted(f);
  }
  const popover = f.element('div', { popover: 'auto' });
  f.document.body.append(popover);
  accepted(f);
  popover.popoverOpen = true;
  preserved(f);
  popover.popoverOpen = false;
  accepted(f);
  dispose();
});

test('wrong-session, ambiguous main roots and nested embedded sessions are preserved', () => {
  const f = fixture();
  const dispose = f.install();
  const other = f.element('div', { 'data-conversation-content': '', 'data-conversation-session': 'other' });
  const otherFlow = f.element('div', { 'data-chat-flow': '' });
  f.document.body.append(other.append(otherFlow));
  preserved(f, otherFlow);
  const duplicate = f.element('div', { 'data-conversation-content': '', 'data-conversation-session': 'current' });
  f.document.body.append(duplicate);
  preserved(f);
  duplicate.setAttribute('hidden', '');
  accepted(f);
  const embedded = f.element('div', { 'data-conversation-session': 'other' });
  const embeddedFlow = f.element('div', { 'data-chat-flow': '' });
  f.row.append(embedded.append(embeddedFlow));
  preserved(f, embeddedFlow);
  dispose();
});

test('sidebar and trajectory/custom view are not mistaken for main chat blank', () => {
  const f = fixture();
  const dispose = f.install();
  const sidebar = f.element('aside', { 'data-sidebar-right-session': 'current' });
  const preview = f.element('div');
  f.document.body.append(sidebar.append(preview));
  preserved(f, preview);
  const trajectory = f.element('table');
  f.scroller.append(trajectory);
  preserved(f, trajectory);
  const randomPage = f.element('div');
  f.document.body.append(randomPage);
  preserved(f, randomPage);
  f.flow.setAttribute('hidden', '');
  for (const blank of [f.root, f.scroller, f.document.body, f.document.documentElement]) preserved(f, blank);
  accepted(f, f.input);
  f.flow.removeAttribute('hidden');
  accepted(f, f.document.body);
  dispose();
});

test('background documents and unfocused windows preserve their keyboard ownership', () => {
  const f = fixture();
  const dispose = f.install();
  f.document.visibilityState = 'hidden';
  preserved(f);
  f.document.visibilityState = 'visible';
  f.document.hasFocus = () => false;
  preserved(f);
  f.document.hasFocus = () => true;
  accepted(f);
  dispose();
});

test('active native focus vetoes body or chat-retargeted events', () => {
  const f = fixture();
  const dispose = f.install();
  const editor = f.element('textarea');
  f.document.body.append(editor);
  f.document.activeElement = editor;
  preserved(f, f.document.body);
  preserved(f);
  f.document.activeElement = f.input;
  accepted(f, f.document.body);
  dispose();
});

test('composed shadow paths preserve native editor owners and accept current composer roots', () => {
  const f = fixture();
  const dispose = f.install();
  const host = f.element('div');
  f.row.append(host);
  const editor = f.element('textarea');
  editor.shadowHost = host;
  host.shadowRoot = { activeElement: editor };
  f.document.activeElement = host;
  preserved(f, host, { composedPath: () => [editor, host, f.row, f.flow, f.root, f.document.body, f.document, f.window] });
  host.shadowRoot = null;
  const composerHost = f.element('div');
  f.composer.append(composerHost);
  const inner = f.element('div', { contenteditable: 'true' });
  inner.shadowHost = composerHost;
  composerHost.shadowRoot = { activeElement: inner };
  f.document.activeElement = composerHost;
  accepted(f, inner);
  dispose();
});

test('throwing or declining callbacks leave native find available', () => {
  const f = fixture();
  let dispose = f.install({ open: () => false });
  preserved(f);
  dispose();
  dispose = f.install({ open: () => { throw new Error('Unavailable'); } });
  preserved(f);
  dispose();
  dispose = f.install({ getSessionId: () => { throw new Error('Unmounted'); } });
  preserved(f);
  dispose();
  dispose = f.install({ isEnabled: () => { throw new Error('Disposed'); } });
  preserved(f);
  dispose();
});

test('disposer removes every listener and repeated install replaces old routing exactly once', () => {
  const f = fixture();
  const initial = f.window.count() + f.document.count();
  const first = f.install();
  assert.equal(f.window.count() + f.document.count(), initial + 5);
  const second = f.install();
  assert.equal(f.window.count() + f.document.count(), initial + 5);
  first();
  accepted(f);
  second();
  second();
  assert.equal(f.window.count() + f.document.count(), initial);
  preserved(f);
});

test('focus guard admits only current chat, composer, owned panel and safe page blank', () => {
  const f = fixture();
  const check = () => canFindFromFocus({ window: f.window, sessionId: 'current' });
  for (const target of [f.paragraph, f.input, f.root, f.document.body, f.document.documentElement, f.panel().input]) {
    f.document.activeElement = target;
    assert.equal(check(), true);
  }
  f.document.activeElement = f.panel('other', true).input;
  assert.equal(check(), false);
  f.document.activeElement = f.document.body;
  f.flow.setAttribute('hidden', '');
  assert.equal(check(), false);
  f.document.activeElement = f.input;
  assert.equal(check(), true);
  assert.equal(canFindFromFocus({ window: f.window, sessionId: 'other' }), false);
  assert.equal(canFindFromFocus({ window: f.window, sessionId: '' }), false);
});

test('shortcut registry with saved CtrlF override passes on preview/editor/terminal and modal focus', () => {
  const f = fixture();
  let invoked = 0;
  const resolve = () => canFindFromFocus({ window: f.window, document: f.document, sessionId: 'current' }) ? { status: 'handled', run: () => { invoked++; } } : { status: 'pass' };
  const preview = f.element('section', { 'data-document-preview': 'source.ts' });
  const previewInput = f.element('input');
  f.document.body.append(preview.append(previewInput));
  const editor = f.element('div', { class: 'monaco-editor' });
  const editorInput = f.element('textarea');
  f.row.append(editor.append(editorInput));
  const terminal = f.element('div', { class: 'xterm' });
  f.row.append(terminal);
  for (const target of [previewInput, editorInput, terminal]) {
    f.document.activeElement = target;
    assert.deepEqual(resolve(), { status: 'pass' });
  }
  f.document.activeElement = f.input;
  const modal = f.element('div', { role: 'dialog' });
  f.document.body.append(modal);
  assert.deepEqual(resolve(), { status: 'pass' });
  modal.setAttribute('hidden', '');
  const allowed = resolve();
  assert.equal(allowed.status, 'handled');
  allowed.run();
  assert.equal(invoked, 1);
});

test('focus guard rejects background windows and follows shadow active owner', () => {
  const f = fixture();
  const check = () => canFindFromFocus({ window: f.window, sessionId: 'current' });
  f.document.activeElement = f.input;
  f.document.visibilityState = 'hidden';
  assert.equal(check(), false);
  f.document.visibilityState = 'visible';
  f.document.hasFocus = () => false;
  assert.equal(check(), false);
  f.document.hasFocus = () => true;
  const host = f.element('div');
  const inner = f.element('textarea');
  inner.shadowHost = host;
  host.shadowRoot = { activeElement: inner };
  f.row.append(host);
  f.document.activeElement = host;
  assert.equal(check(), false);
  f.composer.append(host);
  assert.equal(check(), true);
  const menu = f.element('div', { role: 'menu' });
  f.document.body.append(menu);
  assert.equal(check(), false);
});

test('defaults document from owning window and rejects invalid installation contracts', () => {
  const f = fixture();
  const dispose = installFindKeyboard({ window: f.window, getSessionId: () => 'current', open: id => f.opened.push({ id }) });
  accepted(f);
  dispose();
  for (const options of [{}, { window: f.window }, { window: f.window, getSessionId: () => 'current' }]) assert.throws(() => installFindKeyboard(options), TypeError);
});
