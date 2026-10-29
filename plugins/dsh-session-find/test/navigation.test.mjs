import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFindHighlight, nodeForHit, rangeForSource, revealHit } from '../src/navigation.js';

const dataName = (name) => `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
class Text {
  constructor(doc, data) { this.ownerDocument = doc; this.data = data; this.nodeType = 3; }
}
class Element {
  constructor(doc, tag = 'div', attributes = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = new Map(Object.entries(attributes));
    this.dataset = new Proxy({}, { get: (_, name) => this.getAttribute(dataName(name)) ?? undefined });
    this.events = [];
    this.scrolls = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 100;
    this.scrollTop = 0;
    this.isConnected = true;
  }
  get classList() { return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') child = new Text(this.ownerDocument, child);
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('.')) return this.classList.includes(part.slice(1));
      const match = /^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(part);
      return Boolean(match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.attributes.has(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3])));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) if (child.nodeType === 1) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  dispatchEvent(event) { this.events.push(event.type); this.onEvent?.(event); return true; }
  scrollIntoView() { this.scrolls++; }
  getBoundingClientRect() { return { top: 0, height: 20 }; }
  animate() { this.animated = true; }
}
function documentFixture() {
  const flatten = (root) => root.nodeType === 3 ? [root] : root.children.flatMap(flatten);
  const doc = {
    roots: [],
    querySelectorAll(selector) { return this.roots.flatMap((root) => [root, ...root.querySelectorAll(selector)]).filter((root) => root.matches(selector)); },
    createTreeWalker(root, _what, filter) { const nodes = flatten(root).filter((node) => filter.acceptNode(node) === 1); let index = 0; return { nextNode: () => nodes[index++] ?? null }; },
    createRange() {
      return {
        setStart(node, offset) { this.start = { node, offset }; }, setEnd(node, offset) { this.end = { node, offset }; },
        toString() {
          if (doc.wrongRange) return 'wrong';
          let root = this.start.node;
          while (root.parentElement) root = root.parentElement;
          const nodes = flatten(root);
          const first = nodes.indexOf(this.start.node);
          const last = nodes.indexOf(this.end.node);
          return nodes.slice(first, last + 1).map((node, index) => node.data.slice(index === 0 ? this.start.offset : 0, index === last - first ? this.end.offset : undefined)).join('');
        },
        getBoundingClientRect: () => ({ top: 10, height: 20 })
      };
    }
  };
  return doc;
}
function assistant(parts, part = 0, offset = 0, length = 6, role = 'assistant') {
  const blocks = parts.map((text) => typeof text === 'string' ? { kind: 'text', text } : text);
  const node = { key: 'a', kind: 'assistant-step', data: { turn: 1, step: 1, blocks, finalNode: { seq: 5, turn: 1, step: 1, blocks } } };
  const hit = { docId: `5:${part}`, seq: 5, part, role, offset, length, turn: 1, step: 1 };
  const sourceDocument = { id: hit.docId, seq: 5, part, role, text: blocks[part].text };
  return { node, hit, sourceDocument };
}
function rowFixture(parts, groupPart = 'response') {
  const doc = documentFixture();
  const root = new Element(doc, 'section', { 'data-conversation-session': 's1' });
  const scroller = new Element(doc, 'div', { 'data-conversation-scroll': '' });
  const flow = new Element(doc, 'div', { 'data-chat-flow': '' });
  const row = new Element(doc, 'div', { 'data-chat-node-key': 'a', ...(groupPart ? { 'data-chat-group-part': groupPart } : {}) });
  for (const text of parts) row.append(new Element(doc, 'div', { class: 'hash_markdown' }).append(text));
  root.append(scroller.append(flow.append(row)));
  doc.roots.push(root);
  return { doc, root, flow, row };
}
function install(t, doc) {
  const original = Object.fromEntries(['document', 'CSS', 'Highlight', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, globalThis[key]]));
  globalThis.document = doc;
  globalThis.CSS = { highlights: new Map() };
  globalThis.Highlight = class { constructor(range) { this.range = range; } };
  globalThis.requestAnimationFrame = undefined;
  t.after(() => { clearFindHighlight(); for (const [key, value] of Object.entries(original)) value === undefined ? delete globalThis[key] : globalThis[key] = value; });
}
function revealFixture(t, raw = 'needle needle') {
  const fixture = { ...rowFixture([raw]), ...assistant([raw], 0, 7) };
  install(t, fixture.doc);
  let mounted = 's1';
  const listeners = new Set();
  const state = { sessionId: 's1', loadingOlder: false };
  const binding = { sessionId: 's1', session: { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, loadThrough: async () => {} } };
  const target = { getSnapshot: () => ({ nodes: new Map([['a', fixture.node]]) }) };
  const assembly = { activate() {}, target: () => target };
  const ctx = { uiConversation: { binding: () => assembly }, sessions: { binding: () => binding }, sidebarRight: { mounted: { getSnapshot: () => mounted } } };
  return { ...fixture, ctx, binding, state, listeners, target, assembly, switchSession: () => { mounted = 's2'; } };
}

test('settled seq mapping rejects duplicate nodes, invalid roles, and different turn or step', () => {
  const { node, hit } = assistant(['needle']);
  const snapshot = { nodes: new Map([['a', node]]) };
  assert.equal(nodeForHit(snapshot, hit), node);
  assert.equal(nodeForHit(snapshot, { ...hit, turn: 2 }), undefined);
  assert.equal(nodeForHit(snapshot, { ...hit, step: 2 }), undefined);
  assert.equal(nodeForHit(snapshot, { ...hit, role: 'tool' }), undefined);
  snapshot.nodes.set('copy', { ...node, key: 'copy' });
  assert.equal(nodeForHit(snapshot, hit), undefined);
});

test('uses exact UTF-16 offsets for repeated strings and split inline nodes', () => {
  const { row } = rowFixture([]);
  const content = new Element(row.ownerDocument, 'div', { class: 'hash_markdown' }).append('😀 needle ', new Element(row.ownerDocument, 'em').append('nee'), 'dle');
  row.append(content);
  const source = assistant(['😀 needle needle'], 0, 10);
  const result = rangeForSource(row, source.node, source.hit, source.sourceDocument);
  assert.equal(result.range.toString(), 'needle');
  assert.equal(result.range.start.node.data, 'nee');
});

test('maps duplicate text by durable part order, including interleaved reasoning', () => {
  const { row } = rowFixture(['needle', 'needle']);
  const source = assistant(['needle', { kind: 'reasoning', text: 'needle' }, 'needle'], 2);
  const result = rangeForSource(row, source.node, source.hit, source.sourceDocument);
  assert.equal(result.range.start.node, row.children[1].children[0]);
  assert.equal(rangeForSource(row, source.node, source.hit, { ...source.sourceDocument, part: 0 }).reason, 'source-changed');
});

test('joins only user text parts and preserves target part offsets', () => {
  const { row } = rowFixture([]);
  const content = [{ type: 'text', text: 'needle' }, { type: 'image' }, { type: 'text', text: 'needle' }];
  const node = { data: { content, source: { kind: 'user' } } };
  row.append(new Element(row.ownerDocument, 'span', { class: 'user_root' }).append('needle', new Element(row.ownerDocument, 'span').append('needle')));
  const hit = { docId: '1:2', seq: 1, part: 2, role: 'user', offset: 0, length: 6 };
  const result = rangeForSource(row, node, hit, { id: '1:2', seq: 1, part: 2, role: 'user', text: 'needle' });
  assert.equal(result.range.start.node, row.children[0].children[1].children[0]);
});

test('Markdown URLs, alt text, entities and missing markers never claim precise mappings', () => {
  for (const [raw, displayed] of [
    ['[link](https://needle.invalid) needle needle', 'link needle needle'],
    ['![needle](image.png) needle', 'needle'],
    ['**needle** needle', 'needle needle'],
    ['&amp; needle', '& needle'],
    ['needle\n\nneedle', 'needleneedle']
  ]) {
    const source = assistant([raw], 0, raw.lastIndexOf('needle'));
    const { row } = rowFixture([displayed]);
    const result = rangeForSource(row, source.node, source.hit, source.sourceDocument);
    assert.equal(result.range, undefined, raw);
    assert.equal(result.reason, 'display-text-different', raw);
  }
});

test('rejects changed source blocks, ambiguous renderers, and incorrect Range text', () => {
  const { row, doc } = rowFixture(['needle']);
  const source = assistant(['needle']);
  assert.ok(rangeForSource(row, source.node, source.hit, source.sourceDocument).range);
  doc.wrongRange = true;
  assert.equal(rangeForSource(row, source.node, source.hit, source.sourceDocument).reason, 'range-text-different');
  doc.wrongRange = false;
  row.append(new Element(doc, 'div', { class: 'copy_markdown' }).append('needle'));
  assert.equal(rangeForSource(row, source.node, source.hit, source.sourceDocument).reason, 'renderer-unavailable');
  source.node.data.blocks = [{ kind: 'text', text: 'changed needle' }];
  assert.equal(rangeForSource(row, source.node, source.hit, source.sourceDocument).reason, 'source-changed');
});

test('stale match text and zero-width matches cannot create a precise Range', () => {
  const { row } = rowFixture(['needle']);
  const source = assistant(['needle']);
  assert.equal(rangeForSource(row, source.node, { ...source.hit, matchedText: 'other' }, source.sourceDocument).reason, 'source-changed');
  assert.equal(rangeForSource(row, source.node, { ...source.hit, length: 0 }, source.sourceDocument).reason, 'empty-match');
});

test('collapsed or mixed unpartitioned reasoning never selects response text', () => {
  const source = assistant([{ kind: 'reasoning', text: 'needle' }, 'needle'], 0, 0, 6, 'reasoning');
  const collapsed = rowFixture([]);
  assert.equal(rangeForSource(collapsed.row, source.node, source.hit, source.sourceDocument).reason, 'renderer-unavailable');
  const mixed = rowFixture(['needle', 'needle'], undefined);
  assert.equal(rangeForSource(mixed.row, source.node, source.hit, source.sourceDocument).reason, 'renderer-unavailable');
});

test('reveals a verified plain-text Range and isolates highlight ownership', async (t) => {
  const fixture = revealFixture(t);
  const owner = {};
  assert.deepEqual(await revealHit({ ...fixture, highlightOwner: owner }), { precise: true });
  assert.equal(fixture.row.scrolls, 1);
  assert.equal(CSS.highlights.get('dsh-session-find').range.toString(), 'needle');
  clearFindHighlight({});
  assert.equal(CSS.highlights.size, 1);
  clearFindHighlight(owner);
  assert.equal(CSS.highlights.size, 0);
});

test('Markdown differences and unavailable browser highlight produce explicit message fallback', async (t) => {
  const fixture = revealFixture(t, '[link](https://needle.invalid) needle needle');
  fixture.row.children[0].children[0].data = 'link needle needle';
  fixture.hit.offset = 30;
  const outcome = await revealHit(fixture);
  assert.equal(outcome.precise, false);
  assert.match(outcome.notice, /已定位到消息.*精确高亮不可用/);
  assert.equal(CSS.highlights.size, 0);
  fixture.sourceDocument.text = fixture.node.data.blocks[0].text = 'link needle needle';
  fixture.hit.offset = 5;
  globalThis.Highlight = undefined;
  const unsupported = await revealHit(fixture);
  assert.equal(unsupported.reason, 'highlight-unavailable');
});

test('session and DOM scopes reject wrong-session sources and duplicate mounted roots', async (t) => {
  const fixture = revealFixture(t);
  await assert.rejects(revealHit({ ...fixture, hit: { ...fixture.hit, sessionId: 's2' } }), /来源与当前会话不一致/);
  fixture.doc.roots.push(new Element(fixture.doc, 'section', { 'data-conversation-session': 's1' }).append(new Element(fixture.doc, 'div', { 'data-chat-flow': '' })));
  await assert.rejects(revealHit(fixture), /未唯一挂载/);
  assert.equal(fixture.row.scrolls, 0);
});

test('does not select a nested other-session row with the same key', async (t) => {
  const fixture = revealFixture(t);
  const nested = new Element(fixture.doc, 'section', { 'data-conversation-session': 's2' });
  const wrong = new Element(fixture.doc, 'div', { 'data-chat-node-key': 'a', 'data-chat-group-part': 'response' });
  nested.append(new Element(fixture.doc, 'div', { 'data-chat-flow': '' }).append(wrong));
  fixture.root.append(nested);
  assert.equal((await revealHit(fixture)).precise, true);
  assert.equal(wrong.scrolls, 0);
});

test('abort cancels history waits and releases subscriptions immediately', async (t) => {
  const fixture = revealFixture(t);
  fixture.state.loadingOlder = true;
  const abort = new AbortController();
  const operation = revealHit({ ...fixture, signal: abort.signal });
  assert.equal(fixture.listeners.size, 1);
  abort.abort();
  assert.deepEqual(await operation, { cancelled: true });
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.row.scrolls, 0);
});

test('late load completion, session switches and replaced bindings cannot scroll', async (t) => {
  const fixture = revealFixture(t);
  let release;
  fixture.binding.session.loadThrough = () => new Promise((resolve) => { release = resolve; });
  const operation = revealHit(fixture);
  await Promise.resolve();
  fixture.switchSession();
  release();
  assert.deepEqual(await operation, { cancelled: true });
  assert.equal(fixture.row.scrolls, 0);
  const replacement = { ...fixture.binding };
  fixture.ctx.sidebarRight.mounted.getSnapshot = () => 's1';
  fixture.ctx.sessions.binding = () => replacement;
  assert.deepEqual(await revealHit(fixture), { cancelled: true });
});

test('switching during hidden-region expansion cancels before scrolling', async (t) => {
  const fixture = revealFixture(t);
  fixture.row.attributes.set('hidden', 'until-found');
  fixture.row.onEvent = () => fixture.switchSession();
  assert.deepEqual(await revealHit(fixture), { cancelled: true });
  assert.equal(fixture.row.scrolls, 0);
});
