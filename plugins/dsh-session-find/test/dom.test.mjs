import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeForText, collectTextNodes } from '../src/navigation.js';

class FakeText {
  constructor(data) { this.data = data; this.parentElement = null; this.parentNode = null; }
}
class FakeElement {
  constructor(doc, tag = 'div') {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.parentElement = null;
    this.parentNode = null;
    this.dataset = new Proxy({}, { get: (_, property) => this.attributes.get(`data-${String(property).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) });
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; node.parentNode = this; this.children.push(node); } return this; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll() { return []; }
  getClientRects() { return [{ width: 100, height: 20 }]; }
  closest() { return null; }
  get textContent() { return this.children.map((child) => child.data ?? child.textContent).join(''); }
}
function documentWith(lines) {
  const doc = { createTreeWalker: undefined, createRange: () => ({ setStart(node, offset) { this.start = { node, offset }; }, setEnd(node, offset) { this.end = { node, offset }; }, getBoundingClientRect: () => ({ top: 0, height: 10 }) }) };
  const root = new FakeElement(doc);
  for (const line of lines) {
    const paragraph = new FakeElement(doc, 'p');
    const text = new FakeText(line);
    doc.createTreeWalker = (walkerRoot, _what, filter) => {
      const flat = [];
      const visit = (node) => { for (const child of node.children) { if (child instanceof FakeText) { if (filter.acceptNode(child) === 1) flat.push(child); } else visit(child); } };
      visit(walkerRoot);
      let index = 0;
      return { nextNode: () => flat[index++] ?? null };
    };
    root.append(paragraph.append(text));
  }
  return { doc, root };
}

test('joins split text nodes so a match spanning inline markup is still located', () => {
  const { root } = documentWith(['前缀全文', '搜索后缀']);
  const { text } = collectTextNodes(root);
  assert.equal(text, '前缀全文搜索后缀');
  const range = rangeForText(root, '全文搜索');
  assert.ok(range);
  assert.equal(range.start.node.data, '前缀全文');
  assert.equal(range.end.node.data, '搜索后缀');
});

test('selects the requested occurrence and refuses when it is absent', () => {
  const { root } = documentWith(['重复重复重复']);
  const second = rangeForText(root, '重复', 1);
  assert.ok(second);
  const third = rangeForText(root, '重复', 2);
  assert.ok(third);
  assert.notEqual(second.start.offset, third.start.offset);
  assert.equal(rangeForText(root, '重复', 3), undefined);
  assert.equal(rangeForText(root, '不存在', 0), undefined);
});

test('repeated overlapping text follows the non-overlapping search result order', () => {
  const { root } = documentWith(['aaaa']);
  assert.equal(rangeForText(root, 'aa', 1).start.offset, 2);
});
