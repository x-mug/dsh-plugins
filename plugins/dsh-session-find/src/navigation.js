const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export function nodeForHit(snapshot, hit) {
  if (!snapshot?.nodes) return undefined;
  const nodes = snapshot.nodes.values();
  for (const node of nodes) {
    if (hit.role === 'user' && ['user', 'steering'].includes(node.kind) && node.data?.seq === hit.seq) return node;
    if (hit.role !== 'user' && node.kind === 'assistant-step') {
      if (node.data?.finalNode?.seq === hit.seq) return node;
    }
  }
  return undefined;
}

export function collectTextNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest('button,script,style,svg,[aria-hidden="true"]') ? 2 : 1;
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

export function rangeForText(root, text, occurrence = 0) {
  if (!text) return undefined;
  const source = collectTextNodes(root);
  let offset = -text.length;
  for (let index = 0; index <= occurrence; index++) {
    offset = source.text.indexOf(text, offset + text.length);
    if (offset < 0) return undefined;
  }
  const end = offset + text.length;
  const first = source.nodes.find((entry) => entry.end > offset);
  const last = source.nodes.find((entry) => entry.end >= end);
  if (!first || !last) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, offset - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export async function revealHit({ ctx, binding, hit, matchedText, occurrence = 0, selectView, isCurrent = () => true }) {
  if (typeof selectView === 'function') selectView('chat');
  const session = binding.session;
  if (session.getSnapshot().loadingOlder) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('历史正在加载，请稍后重试')); }, 15000);
      const stop = session.subscribe(() => {
        if (!session.getSnapshot().loadingOlder) { clearTimeout(timeout); stop(); resolve(); }
      });
    });
  }
  if (!isCurrent()) return { cancelled: true };
  const outline = session.projections?.values?.().turnOutline;
  const startSeq = Array.isArray(outline) ? outline.find((entry) => entry.turn === hit.turn)?.seq : undefined;
  await session.loadThrough(Number.isSafeInteger(startSeq) ? Math.min(startSeq, hit.seq) : hit.seq);
  if (!isCurrent()) return { cancelled: true };
  const assembly = ctx.uiConversation.binding(binding);
  assembly.activate('chat');
  await nextPaint();
  if (!isCurrent()) return { cancelled: true };
  const node = nodeForHit(assembly.target('chat').getSnapshot(), hit);
  if (!node) throw new Error('历史已读取，但此消息没有可显示的聊天位置');
  const selector = `[data-chat-node-key="${CSS.escape(node.key)}"]`;
  const sessionRoot = document.querySelector(`[data-conversation-session="${CSS.escape(binding.sessionId)}"]`);
  if (!sessionRoot) throw new Error('当前会话聊天区域没有挂载，请切回聊天视图后重试');
  const pickRow = () => {
    const candidates = [...sessionRoot.querySelectorAll(selector)].filter((element) => element.closest('[data-chat-flow]'));
    const part = hit.role === 'reasoning' ? 'reasoning' : 'response';
    return candidates.find((element) => element.dataset.chatGroupPart === part) ?? candidates.find((element) => !element.dataset.chatGroupPart) ?? candidates[0];
  };
  let row = pickRow();
  if (!row) throw new Error('当前 DSH 的聊天锚点不兼容，无法定位消息');
  const ancestors = [];
  for (let element = row; element; element = element.parentElement) {
    if (element.getAttribute('hidden') === 'until-found') ancestors.push(element);
  }
  for (const element of ancestors.reverse()) element.dispatchEvent(new Event('beforematch'));
  for (const element of row.querySelectorAll('[hidden="until-found"]')) element.dispatchEvent(new Event('beforematch'));
  await nextPaint();
  if (!isCurrent()) return { cancelled: true };
  row = pickRow() ?? row;
  const range = rangeForText(row, matchedText, occurrence);
  clearFindHighlight();
  const scroller = row.closest('[data-conversation-scroll]');
  scroller?.dispatchEvent(new Event('wheel', { bubbles: false }));
  row.scrollIntoView({ block: 'center', behavior: 'instant' });
  scroller?.dispatchEvent(new Event('scroll'));
  if (range) {
    const highlights = globalThis.CSS?.highlights;
    if (highlights && globalThis.Highlight) highlights.set('dsh-session-find', new Highlight(range));
    const rect = range.getBoundingClientRect();
    let scroll = scroller ?? row.parentElement;
    while (scroll && scroll.scrollHeight <= scroll.clientHeight + 1) scroll = scroll.parentElement;
    if (scroll && rect.height > 0) scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2;
    return { precise: true };
  }
  if (typeof row.animate === 'function') row.animate([{ outline: '2px solid #68aaff' }, { outline: '2px solid transparent' }], { duration: 1200 });
  return { precise: false };
}

export function clearFindHighlight() {
  globalThis.CSS?.highlights?.delete('dsh-session-find');
}
