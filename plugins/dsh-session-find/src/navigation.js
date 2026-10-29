const HIGHLIGHT = 'dsh-session-find';
const SKIP_TEXT = 'button,script,style,noscript,svg,[aria-hidden="true"],[data-code-block-banner],[data-clock],.sr-only,.katex-mathml';
let highlightOwner;

const sequence = (value) => Number.isSafeInteger(value) && value >= 0;
const cancelled = () => Object.assign(new Error('定位已取消'), { code: 'CANCELLED' });

function waitUntil(check, { signal, isCurrent, subscribe, timeout = 15000, message = '定位等待超时，请重试' }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let unsubscribe;
    let timer;
    const started = Date.now();
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(cancelled());
    const poll = () => {
      if (finished) return;
      try {
        if (signal?.aborted || !isCurrent()) return abort();
        if (check()) return finish();
        if (Date.now() - started >= timeout) return finish(new Error(message));
        clearTimeout(timer);
        timer = setTimeout(poll, 35);
      } catch (error) { finish(error); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = subscribe?.(poll);
    if (finished) unsubscribe?.();
    else poll();
  });
}

async function pending(operation, options) {
  let done = false;
  let failure;
  Promise.resolve(operation).then(() => { done = true; }, (error) => { done = true; failure = error; });
  await waitUntil(() => done, options);
  if (failure) throw failure;
}

async function nextPaint(options) {
  if (typeof globalThis.requestAnimationFrame !== 'function') return;
  let painted = false;
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { painted = true; }); });
  try { await waitUntil(() => painted, options); }
  finally { globalThis.cancelAnimationFrame?.(frame); }
}

export function nodeForHit(snapshot, hit) {
  if (!snapshot?.nodes?.values || !sequence(hit?.seq) || !['user', 'assistant', 'reasoning'].includes(hit.role)) return undefined;
  const matches = [];
  for (const node of snapshot.nodes.values()) {
    const data = hit.role === 'user' ? node.data : node.data?.finalNode;
    const kindMatches = hit.role === 'user' ? ['user', 'steering'].includes(node.kind) : node.kind === 'assistant-step';
    if (!kindMatches || data?.seq !== hit.seq) continue;
    if (hit.turn !== undefined && (data.turn ?? node.data?.turn ?? node.location?.turn) !== hit.turn) continue;
    if (hit.step !== undefined && (data.step ?? node.data?.step ?? node.location?.step) !== hit.step) continue;
    if (hit.messageId !== undefined && data.messageId !== hit.messageId) continue;
    matches.push(node);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function collectTextNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest(SKIP_TEXT) ? 2 : 1;
    }
  });
  const nodes = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
  }
  return { nodes, text };
}

function rangeAt(root, source, offset, length) {
  if (!sequence(offset) || !sequence(length) || length === 0 || offset + length > source.text.length) return undefined;
  const end = offset + length;
  const first = source.nodes.find((entry) => entry.end > offset);
  const last = source.nodes.find((entry) => entry.start < end && entry.end >= end);
  if (!first || !last) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, offset - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function rangeForText(root, text, occurrence = 0) {
  if (!text || !sequence(occurrence)) return undefined;
  const source = collectTextNodes(root);
  let offset = -text.length;
  for (let index = 0; index <= occurrence; index++) {
    offset = source.text.indexOf(text, offset + text.length);
    if (offset < 0) return undefined;
  }
  return rangeAt(root, source, offset, text.length);
}

function sourceMapping(node, hit, sourceDocument) {
  if (!['user', 'assistant', 'reasoning'].includes(hit.role) || !sourceDocument || sourceDocument.id !== hit.docId || sourceDocument.seq !== hit.seq ||
      (sourceDocument.part ?? 0) !== hit.part || sourceDocument.role !== hit.role || typeof sourceDocument.text !== 'string') return undefined;
  if (!sequence(hit.part) || !sequence(hit.offset) || !sequence(hit.length) || hit.offset + hit.length > sourceDocument.text.length) return undefined;
  if (typeof hit.matchedText === 'string') {
    const actual = sourceDocument.text.slice(hit.offset, hit.offset + hit.length);
    if (hit.matchTruncated ? !actual.startsWith(hit.matchedText) : actual !== hit.matchedText) return undefined;
  }
  if (hit.role === 'user') {
    const content = node.data?.content;
    if (!Array.isArray(content) || content[hit.part]?.type !== 'text' || content[hit.part].text !== sourceDocument.text || node.data.source?.kind !== 'user') return undefined;
    const parts = content.filter((part) => part?.type === 'text');
    if (parts.some((part) => typeof part.text !== 'string')) return undefined;
    return { text: parts.map((part) => part.text).join(''), offset: content.slice(0, hit.part).filter((part) => part?.type === 'text').reduce((sum, part) => sum + part.text.length, hit.offset), count: 1, ordinal: 0 };
  }
  const kind = hit.role === 'reasoning' ? 'reasoning' : 'text';
  const blocks = node.data?.blocks;
  const finalBlocks = node.data?.finalNode?.blocks;
  if (!Array.isArray(blocks) || !Array.isArray(finalBlocks) || blocks[hit.part]?.kind !== kind ||
      blocks[hit.part].text !== sourceDocument.text || finalBlocks[hit.part]?.kind !== kind || finalBlocks[hit.part].text !== sourceDocument.text) return undefined;
  const visible = (block) => block?.kind === kind && (kind !== 'reasoning' || block.text?.trim() !== '');
  return { text: sourceDocument.text, offset: hit.offset, count: blocks.filter(visible).length, ordinal: blocks.slice(0, hit.part).filter(visible).length };
}

function classEnds(element, suffix) {
  return [...element.classList].some((name) => name.endsWith(suffix));
}

export function rangeForSource(row, node, hit, sourceDocument) {
  const mapping = sourceMapping(node, hit, sourceDocument);
  if (!mapping) return { reason: 'source-changed' };
  if (!hit.length) return { reason: 'empty-match' };
  const roots = [...row.querySelectorAll(hit.role === 'user' ? 'span[class]' : 'div[class]')].filter((element) => {
    if (element.closest('[data-chat-node-key]') !== row) return false;
    return hit.role === 'user' ? classEnds(element, '_root') || classEnds(element, '_ellipsis') : classEnds(element, '_markdown');
  });
  if (roots.length !== mapping.count) return { reason: 'renderer-unavailable' };
  const root = roots[mapping.ordinal];
  if (!root) return { reason: 'renderer-unavailable' };
  const source = collectTextNodes(root);
  if (source.text !== mapping.text) return { reason: 'display-text-different' };
  const range = rangeAt(root, source, mapping.offset, hit.length);
  if (!range || range.toString() !== sourceDocument.text.slice(hit.offset, hit.offset + hit.length)) return { reason: 'range-text-different' };
  return { range };
}

function mountedRoot(binding) {
  const roots = [...document.querySelectorAll('[data-conversation-session]')].filter((root) => root.dataset.conversationSession === binding.sessionId && root.isConnected !== false && root.querySelector('[data-chat-flow]'));
  if (roots.length !== 1) throw new Error('当前会话聊天区域未唯一挂载，无法安全定位消息');
  return roots[0];
}

function rowForHit(root, node, hit) {
  const candidates = [...root.querySelectorAll('[data-chat-node-key]')].filter((row) => row.dataset.chatNodeKey === node.key && row.closest('[data-conversation-session]') === root && row.closest('[data-chat-flow]'));
  const part = hit.role === 'reasoning' ? 'reasoning' : 'response';
  const scoped = candidates.filter((row) => row.dataset.chatGroupPart === part);
  const rows = scoped.length ? scoped : candidates.filter((row) => !row.dataset.chatGroupPart);
  if (rows.length !== 1) throw new Error('当前 DSH 的消息锚点不唯一或不兼容，无法安全定位');
  return rows[0];
}

export async function revealHit({ ctx, binding, hit, sourceDocument, selectView, signal, highlightOwner: owner = binding, isCurrent = () => true }) {
  let assembly;
  let target;
  let root;
  const current = () => {
    if (signal?.aborted || !isCurrent()) return false;
    if (ctx.sidebarRight?.mounted?.getSnapshot?.() !== binding.sessionId) return false;
    if (ctx.sessions?.binding && ctx.sessions.binding(binding.sessionId) !== binding) return false;
    const snapshot = binding.session.getSnapshot();
    if (snapshot.removed || snapshot.sessionId !== undefined && snapshot.sessionId !== binding.sessionId) return false;
    if (assembly && (ctx.uiConversation.binding(binding) !== assembly || assembly.target('chat') !== target)) return false;
    return !root || root.isConnected !== false;
  };
  const options = { signal, isCurrent: current };
  try {
    if (!current()) return { cancelled: true };
    if (!sequence(hit?.seq)) throw new Error('命中来源序号无效，无法定位');
    if (hit.sessionId !== undefined && hit.sessionId !== binding.sessionId || sourceDocument?.sessionId !== undefined && sourceDocument.sessionId !== binding.sessionId) throw new Error('命中来源与当前会话不一致，无法定位');
    clearFindHighlight(owner);
    selectView?.('chat');
    await waitUntil(() => !binding.session.getSnapshot().loadingOlder, { ...options, subscribe: (listener) => binding.session.subscribe(listener), message: '历史正在加载，请稍后重试' });
    if (!current()) return { cancelled: true };
    const outline = binding.session.projections?.values?.().turnOutline;
    const startSeq = Array.isArray(outline) ? outline.find((entry) => entry.turn === hit.turn)?.seq : undefined;
    await pending(binding.session.loadThrough(sequence(startSeq) ? Math.min(startSeq, hit.seq) : hit.seq), options);
    if (!current()) return { cancelled: true };
    assembly = ctx.uiConversation.binding(binding);
    target = assembly.target('chat');
    assembly.activate('chat');
    await nextPaint(options);
    if (!current()) return { cancelled: true };
    let node = nodeForHit(target.getSnapshot(), hit);
    if (!node) throw new Error('历史已读取，但命中来源没有唯一的聊天位置');
    root = mountedRoot(binding);
    let row = rowForHit(root, node, hit);
    const hidden = [];
    for (let element = row; element && element !== root; element = element.parentElement) {
      if (element.getAttribute('hidden') === 'until-found') hidden.push(element);
    }
    for (const element of [...hidden.reverse(), ...row.querySelectorAll('[hidden="until-found"]')]) {
      if (!current()) return { cancelled: true };
      element.dispatchEvent(new Event('beforematch'));
    }
    await nextPaint(options);
    if (!current()) return { cancelled: true };
    node = nodeForHit(target.getSnapshot(), hit);
    if (!node) throw new Error('定位期间消息来源已改变，请重新搜索');
    if (mountedRoot(binding) !== root) return { cancelled: true };
    row = rowForHit(root, node, hit);
    const mapped = rangeForSource(row, node, hit, sourceDocument);
    if (!current()) return { cancelled: true };
    const scroller = row.closest('[data-conversation-scroll]');
    scroller?.dispatchEvent(new Event('wheel', { bubbles: false }));
    if (!current()) return { cancelled: true };
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    scroller?.dispatchEvent(new Event('scroll'));
    if (!current()) return { cancelled: true };
    const rect = mapped.range?.getBoundingClientRect();
    if (mapped.range && rect?.height > 0 && globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(mapped.range));
      highlightOwner = owner;
      let scroll = scroller ?? row.parentElement;
      while (scroll && scroll.scrollHeight <= scroll.clientHeight + 1) scroll = scroll.parentElement;
      if (scroll) scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2;
      return { precise: true };
    }
    row.animate?.([{ outline: '2px solid #68aaff' }, { outline: '2px solid transparent' }], { duration: 1200 });
    const reason = mapped.reason ?? (mapped.range ? 'highlight-unavailable' : 'renderer-unavailable');
    const details = reason === 'source-changed' ? '来源文本已改变' : reason === 'empty-match' ? '零长度命中没有可高亮文字' : reason === 'highlight-unavailable' ? '正文未展开或浏览器不支持文字高亮' : 'Markdown 显示文字或渲染结构与原文不同';
    return { precise: false, reason, notice: `已定位到消息；${details}，精确高亮不可用` };
  } catch (error) {
    if (error?.code === 'CANCELLED' || signal?.aborted || !isCurrent()) return { cancelled: true };
    throw error;
  }
}

export function clearFindHighlight(owner) {
  if (owner !== undefined && highlightOwner !== owner) return;
  globalThis.CSS?.highlights?.delete(HIGHLIGHT);
  highlightOwner = undefined;
}
