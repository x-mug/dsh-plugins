window.__ModuleLoader__.load({id:'@local/dsh-session-find',factory:(require)=>{
const DEFAULT_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_SOURCE_MAX_DOCS = 100000;
const DEFAULT_SOURCE_PAGE_SIZE = 500;

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function durableEvent(entry) {
  return entry?.type === 'event' && isSequence(entry.event?.seq) ? entry.event : null;
}

function extractSearchDocuments(entry) {
  const event = durableEvent(entry);
  if (!event || event.surfaceOp !== 'append') return [];
  const data = event.data;
  if (!data || typeof data !== 'object') return [];
  let content;
  let role;
  if (event.type === 'user/message' && data.source?.kind === 'user') {
    content = data.content;
    role = 'user';
  } else if (event.type === 'assistant/message') {
    content = data.message?.content;
    role = 'assistant';
  } else {
    return [];
  }
  if (!Array.isArray(content)) return [];
  const documents = [];
  for (let part = 0; part < content.length; part += 1) {
    const block = content[part];
    if (!block || (block.type !== 'text' && block.type !== 'reasoning') ||
        typeof block.text !== 'string' || block.text.length === 0) continue;
    const document = {
      id: `${event.seq}:${part}`,
      seq: event.seq,
      part,
      role: block.type === 'reasoning' ? 'reasoning' : role,
      text: block.text,
    };
    if (Number.isSafeInteger(data.turn) && data.turn >= 0) document.turn = data.turn;
    if (Number.isSafeInteger(data.step) && data.step >= 0) document.step = data.step;
    documents.push(document);
  }
  return documents;
}

function addressFor(binding, snapshot) {
  if (snapshot.sessionId !== undefined && snapshot.sessionId !== binding.sessionId) {
    throw sourceError('SOURCE_SESSION_MISMATCH', 'The session binding changed while search was open.');
  }
  const subagent = snapshot.subagent?.address;
  if (subagent != null) {
    if (typeof subagent.parentSessionId !== 'string' || subagent.parentSessionId.length === 0 ||
        subagent.childSessionId !== binding.sessionId ||
        !['one-shot', 'continuable', 'unknown'].includes(subagent.mode)) {
      throw sourceError('SOURCE_ADDRESS_INVALID', 'The subagent session address is unavailable.');
    }
    return {
      kind: 'subagent',
      parentSessionId: subagent.parentSessionId,
      childSessionId: subagent.childSessionId,
      mode: subagent.mode,
    };
  }
  return { kind: 'session', sessionId: binding.sessionId };
}

function sameAddress(left, right) {
  return left?.kind === right?.kind && left?.sessionId === right?.sessionId &&
    left?.parentSessionId === right?.parentSessionId &&
    left?.childSessionId === right?.childSessionId && left?.mode === right?.mode;
}

function errorDetails(error) {
  const message = typeof error?.message === 'string' ? error.message :
    typeof error?.reason === 'string' ? error.reason :
    typeof error === 'string' ? error : 'Session history could not be read.';
  return { error: message, errorCode: typeof error?.code === 'string' ? error.code : 'SOURCE_READ_FAILED' };
}

function createSessionSource(options) {
  const { binding, remote, onUpsert = () => {}, onRemove = () => {}, onStatus = () => {} } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  const maxDocs = options.maxDocs ?? DEFAULT_SOURCE_MAX_DOCS;
  const pageSize = options.pageSize ?? DEFAULT_SOURCE_PAGE_SIZE;
  if (!binding || typeof binding.sessionId !== 'string' || binding.sessionId.length === 0 ||
      typeof binding.eventSource?.getSnapshot !== 'function' ||
      typeof binding.eventSource?.subscribe !== 'function' ||
      typeof binding.session?.getSnapshot !== 'function') {
    throw new TypeError('A current SessionBinding is required.');
  }
  if (typeof remote?.session?.page !== 'function') throw new TypeError('The authorized session.page RPC is required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer.');
  if (!Number.isSafeInteger(maxDocs) || maxDocs < 1) throw new TypeError('maxDocs must be a positive safe integer.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new TypeError('pageSize must be between 1 and 500.');

  const indexed = new Map();
  let started = false;
  let disposed = false;
  let generation = 0;
  let controller = null;
  let unsubscribeEvents = null;
  let unsubscribeSession = null;
  let loadPromise = Promise.resolve();
  let lastWindow = null;
  let address = null;
  let state = {
    sessionId: binding.sessionId,
    loading: false,
    complete: false,
    partial: false,
    count: 0,
    messageCount: 0,
    bytes: 0,
    maxBytes,
    maxDocs,
    pages: 0,
    throughSeq: -1,
    beforeSeq: null,
    error: null,
    errorCode: null,
    reason: 'idle',
    reloadReason: null,
    livePolicy: 'settled',
  };

  function publish(patch = {}) {
    state = { ...state, ...patch };
    onStatus({ ...state });
  }

  function clearDocuments() {
    const ids = [];
    for (const documents of indexed.values()) {
      for (const document of documents) ids.push(document.id);
    }
    indexed.clear();
    state = { ...state, count: 0, messageCount: 0, bytes: 0 };
    for (let offset = 0; offset < ids.length; offset += 500) onRemove(ids.slice(offset, offset + 500));
  }

  function fail(error, reason) {
    publish({ loading: false, complete: false, partial: true, reason, ...errorDetails(error) });
  }

  function addEntries(entries) {
    let added = [];
    let limitError = null;
    for (const entry of entries) {
      const event = durableEvent(entry);
      if (!event || indexed.has(event.seq)) continue;
      const documents = extractSearchDocuments(entry);
      if (documents.length === 0) continue;
      let bytes = 0;
      for (const document of documents) bytes += document.text.length * 2;
      if (bytes > maxBytes - state.bytes) {
        limitError ??= sourceError('SOURCE_MEMORY_LIMIT', `Search text exceeds the ${maxBytes} byte UTF-16 budget; only part of this session is indexed.`);
        continue;
      }
      if (documents.length > maxDocs - state.count) {
        limitError ??= sourceError('SOURCE_DOCUMENT_LIMIT', `Search exceeds the ${maxDocs} document budget; only part of this session is indexed.`);
        continue;
      }
      indexed.set(event.seq, documents.map(document => ({ id: document.id, bytes: document.text.length * 2 })));
      state = {
        ...state,
        count: state.count + documents.length,
        messageCount: state.messageCount + 1,
        bytes: state.bytes + bytes,
      };
      for (const document of documents) {
        added.push(document);
        if (added.length === 500) {
          onUpsert(added);
          added = [];
        }
      }
    }
    if (added.length > 0) onUpsert(added);
    if (limitError) {
      controller?.abort();
      if (state.errorCode !== 'SOURCE_MEMORY_LIMIT' && state.errorCode !== 'SOURCE_DOCUMENT_LIMIT') {
        fail(limitError, limitError.code === 'SOURCE_MEMORY_LIMIT' ? 'memory-limit' : 'document-limit');
      }
    }
    return limitError === null;
  }

  function sessionSnapshot() {
    const snapshot = binding.session.getSnapshot();
    if (!snapshot || typeof snapshot !== 'object') throw sourceError('SOURCE_SESSION_UNAVAILABLE', 'The current session snapshot is unavailable.');
    const nextAddress = addressFor(binding, snapshot);
    if (snapshot.removed) throw sourceError('SOURCE_SESSION_REMOVED', 'This session has been removed.');
    if (snapshot.openState === 'error') {
      const details = errorDetails(snapshot.openError);
      throw sourceError(details.errorCode, details.error);
    }
    return { snapshot, nextAddress };
  }

  function validatePage(result, throughSeq, beforeSeq) {
    if (!result || typeof result.ok !== 'boolean') throw sourceError('SOURCE_PAGE_INVALID', 'The session.page RPC returned an invalid result.');
    if (!result.ok) throw result.error ?? sourceError('SOURCE_READ_FAILED', 'Session history could not be read.');
    const page = result.value;
    if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') {
      throw sourceError('SOURCE_PAGE_INVALID', 'The session.page RPC returned an invalid history page.');
    }
    let previous = -1;
    for (const entry of page.records) {
      const event = durableEvent(entry);
      if (!event || event.seq <= previous || event.seq > throughSeq || event.seq >= beforeSeq) {
        throw sourceError('SOURCE_PAGE_INVALID', 'Session history was not chronological within the requested cursor.');
      }
      previous = event.seq;
    }
    if (page.hasMore && page.records.length === 0) {
      throw sourceError('SOURCE_PAGE_STALLED', 'Session history paging made no progress.');
    }
    return page;
  }

  function readWindow() {
    const window = binding.eventSource.getSnapshot();
    if (!Array.isArray(window?.entries) || typeof window.hasMore !== 'boolean' ||
        !Number.isSafeInteger(window.revision) || window.revision < 0) {
      throw sourceError('SOURCE_WINDOW_INVALID', 'The session event window is unavailable.');
    }
    return window;
  }

  async function readPage(request, signal) {
    if (signal.aborted) return null;
    let stop;
    const aborted = new Promise(resolve => {
      stop = () => resolve(null);
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([remote.session.page(request, signal), aborted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  async function readHistory(window, pass, signal) {
    const { snapshot, nextAddress } = sessionSnapshot();
    address = nextAddress;
    let head = Infinity;
    let tail = -1;
    for (const entry of window.entries) {
      const event = durableEvent(entry);
      if (!event) continue;
      head = Math.min(head, event.seq);
      tail = Math.max(tail, event.seq);
    }
    publish({ throughSeq: tail, beforeSeq: head === Infinity ? null : head });
    if (!addEntries(window.entries)) return;
    if (tail < 0 && snapshot.openState !== undefined && snapshot.openState !== 'open') {
      publish({ loading: true, reason: 'waiting-for-session' });
      return;
    }
    if (window.hasMore && tail < 0) {
      throw sourceError('SOURCE_CURSOR_UNAVAILABLE', 'Older history exists, but the durable session cursor is unavailable.');
    }
    let hasMore = window.hasMore;
    let beforeSeq = head === Infinity ? 0 : head;
    while (hasMore && pass === generation && !signal.aborted) {
      const result = await readPage({
        address: { ...nextAddress },
        throughSeq: tail,
        beforeSeq,
        maxMessages: pageSize,
      }, signal);
      if (pass !== generation || signal.aborted || disposed) return;
      const current = sessionSnapshot();
      if (!sameAddress(nextAddress, current.nextAddress)) {
        restart('session-address');
        return;
      }
      const page = validatePage(result, tail, beforeSeq);
      if (page.records.length > 0) beforeSeq = page.records[0].event.seq;
      hasMore = page.hasMore;
      state = { ...state, pages: state.pages + 1, beforeSeq };
      if (!addEntries(page.records)) return;
      publish();
    }
    if (pass === generation && !signal.aborted && !disposed) {
      publish({ loading: false, complete: true, partial: false, reason: 'complete' });
    }
  }

  function restart(reason) {
    if (disposed) return;
    controller?.abort();
    const pass = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    clearDocuments();
    publish({
      loading: true,
      complete: false,
      partial: false,
      pages: 0,
      throughSeq: -1,
      beforeSeq: null,
      error: null,
      errorCode: null,
      reason: 'loading',
      reloadReason: reason,
    });
    loadPromise = Promise.resolve().then(async () => {
      if (pass !== generation || signal.aborted || disposed) return;
      const window = readWindow();
      lastWindow = window;
      await readHistory(window, pass, signal);
    }).catch(error => {
      if (pass === generation && !signal.aborted && !disposed) fail(error, 'read-error');
    });
  }

  function acceptWindow() {
    if (disposed) return;
    try {
      const current = sessionSnapshot();
      const window = readWindow();
      if (!sameAddress(address, current.nextAddress)) {
        restart('session-address');
        return;
      }
      if (window === lastWindow || window.revision === lastWindow?.revision) return;
      const previous = lastWindow;
      lastWindow = window;
      if (window.change?.kind === 'replace' ||
          (previous && window.revision !== previous.revision + 1)) {
        restart(window.change?.kind === 'replace' ? 'replace' : 'event-gap');
        return;
      }
      const change = window.change;
      if (change?.kind === 'append' || change?.kind === 'prepend') {
        addEntries(change.entries ?? []);
      } else if (change?.kind === 'settle-assistant') {
        if (change.entry) addEntries([change.entry]);
      } else {
        restart('event-change');
        return;
      }
      publish();
    } catch (error) {
      controller?.abort();
      generation += 1;
      clearDocuments();
      fail(error, 'session-error');
    }
  }

  function acceptSession() {
    if (disposed) return;
    try {
      const current = sessionSnapshot();
      if (!sameAddress(address, current.nextAddress) ||
          (state.reason === 'waiting-for-session' && current.snapshot.openState === 'open') ||
          (state.reason === 'session-error' && current.snapshot.openState === 'open')) {
        restart('session-ready');
      }
    } catch (error) {
      controller?.abort();
      generation += 1;
      clearDocuments();
      fail(error, 'session-error');
    }
  }

  async function settled() {
    let current;
    do {
      current = loadPromise;
      await current;
    } while (current !== loadPromise && !disposed);
  }

  function start() {
    if (disposed) return Promise.resolve();
    if (!started) {
      started = true;
      unsubscribeEvents = binding.eventSource.subscribe(acceptWindow);
      if (typeof binding.session.subscribe === 'function') unsubscribeSession = binding.session.subscribe(acceptSession);
      restart('start');
    }
    return settled();
  }

  function refresh() {
    if (!started) return start();
    restart('refresh');
    return settled();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    controller?.abort();
    unsubscribeEvents?.();
    unsubscribeSession?.();
    unsubscribeEvents = null;
    unsubscribeSession = null;
    lastWindow = null;
    clearDocuments();
    publish({ loading: false, complete: false, partial: false, reason: 'disposed' });
  }

  return { start, refresh, dispose, getStatus: () => ({ ...state }) };
}

const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function nodeForHit(snapshot, hit) {
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

function collectTextNodes(root) {
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

function rangeForText(root, text, occurrence = 0) {
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

async function revealHit({ ctx, binding, hit, matchedText, occurrence = 0, selectView, isCurrent = () => true }) {
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

function clearFindHighlight() {
  globalThis.CSS?.highlights?.delete('dsh-session-find');
}

class SearchWorkerBridge {
  constructor(workerText, onChange = () => {}) {
    this.workerText = workerText;
    this.onChange = onChange;
    this.docs = new Map();
    this.pending = new Map();
    this.regexInFlight = false;
    this.counter = 0;
    this.generation = 0;
    this.disposed = false;
    this.spawn();
  }

  spawn() {
    this.generation++;
    const blob = new Blob([this.workerText], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') return;
      const request = this.pending.get(data.requestId);
      if (!request) return;
      if (data.type === 'progress') { request.progress?.(data.progress); return; }
      if (request.type === 'query') this.regexInFlight = false;
      this.pending.delete(data.requestId);
      clearTimeout(request.timer);
      if (data.type === 'error') request.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
      else if (data.type === 'cancelled') request.reject(Object.assign(new Error('查询已被更新'), { code: 'CANCELLED' }));
      else request.resolve(data.result ?? data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.terminalError = Object.assign(new Error(event.message || '搜索线程启动失败'), { code: 'WORKER_ERROR' });
      this.failAll(this.terminalError);
      this.onChange({ error: '搜索线程启动失败，请关闭后重新打开查找' });
    };
    this.worker.postMessage({ type: 'reset', options: { maxTotalChars: 64 * 1024 * 1024, maxMatches: 100000, overflowPolicy: 'reject' } });
  }

  failAll(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  request(type, payload = {}, { timeoutMs = 0, progress } = {}) {
    if (this.disposed) return Promise.reject(new Error('搜索线程已关闭'));
    if (this.terminalError) return Promise.reject(this.terminalError);
    const requestId = ++this.counter;
    return new Promise((resolve, reject) => {
      const request = { type, resolve, reject, progress };
      if (timeoutMs) request.timer = setTimeout(() => {
        this.failAll(Object.assign(new Error('正则或查询超过执行时限；已中止搜索线程'), { code: 'WORKER_TIMEOUT' }));
        this.worker.terminate();
        this.regexInFlight = false;
        this.spawn();
        const docs = [...this.docs.values()];
        for (let index = 0; index < docs.length; index += 100) this.worker.postMessage({ type: 'upsert', docs: docs.slice(index, index + 100) });
        this.onChange({ reset: true, error: '查询超过执行时限，已中止；请缩短文本或简化正则' });
      }, timeoutMs);
      this.pending.set(requestId, request);
      this.worker.postMessage({ type, requestId, ...payload });
    });
  }

  async upsert(docs) {
    for (const doc of docs) this.docs.set(doc.id, doc);
    const result = await this.request('upsert', { docs });
    if (result.evictedIds?.length || result.rejected?.length) throw new Error('搜索文本超过内存限额，请缩小会话');
    return result;
  }

  async remove(ids) {
    for (const id of ids) this.docs.delete(id);
    return this.request('remove', { ids });
  }

  query(query, options, progress) {
    this.regexInFlight = options.regex === true;
    return this.request('query', { query, options }, { timeoutMs: options.regex ? 1500 : 5000, progress });
  }

  restart() {
    this.worker.terminate();
    this.regexInFlight = false;
    this.failAll(Object.assign(new Error('查询已被更新'), { code: 'CANCELLED' }));
    this.spawn();
    const docs = [...this.docs.values()];
    for (let index = 0; index < docs.length; index += 100) this.worker.postMessage({ type: 'upsert', docs: docs.slice(index, index + 100) });
  }

  page(id, offset, limit = 50) { return this.request('page', { id, offset, limit }); }
  cancel() {
    if (this.disposed) return;
    if (this.regexInFlight) { this.restart(); return; }
    for (const [id, request] of this.pending) {
      if (request.type !== 'query') continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(Object.assign(new Error('查询已被更新'), { code: 'CANCELLED' }));
    }
    this.worker.postMessage({ type: 'cancel' });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(Object.assign(new Error('查找已关闭'), { code: 'CANCELLED' }));
    this.worker.terminate();
    this.docs.clear();
  }
}


class SessionFindController {
  constructor({ ctx, binding, workerText, createSource, Bridge, reveal }) {
    this.ctx = ctx;
    this.binding = binding;
    this.workerText = workerText;
    this.createSource = createSource;
    this.Bridge = Bridge;
    this.reveal = reveal;
    this.listeners = new Set();
    this.revision = 0;
    this.navigation = 0;
    this.snapshot = {
      query: '', options: { matchCase: false, wholeWord: false, regex: false, includeReasoning: false },
      source: { loading: false, complete: false, count: 0, bytes: 0, error: null },
      result: null, busy: false, active: -1, pageOffset: 0, error: null, notice: null, focus: 0, navigating: false
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  publish(change) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  open() {
    this.publish({ focus: this.snapshot.focus + 1 });
  }
  start() {
    if (this.bridge) return;
    this.bridge = new this.Bridge(this.workerText, (change) => {
      if (change.reset) this.revision++;
      this.publish({ error: change.error ?? null, busy: false, result: change.reset ? null : this.snapshot.result });
    });
    const bridge = this.bridge;
    this.mutationQueue = Promise.resolve();
    const enqueue = (operation) => {
      if (this.bridge !== bridge) return;
      this.mutationQueue = this.mutationQueue.then(() => this.bridge === bridge ? operation(bridge) : undefined).catch((error) => {
        if (this.bridge === bridge) this.publish({ error: error.message });
      });
      this.schedule(true);
    };
    this.source = this.createSource({
      binding: this.binding, remote: this.ctx.remote,
      onUpsert: (docs) => enqueue((current) => current.upsert(docs)),
      onRemove: (ids) => enqueue((current) => current.remove(ids)),
      onStatus: (source) => { if (this.bridge === bridge) this.publish({ source }); }
    });
    this.source.start().catch((error) => this.publish({ error: error.message }));
    this.schedule(false);
  }
  stop() {
    this.revision++;
    this.navigation++;
    clearTimeout(this.timer);
    const bridge = this.bridge;
    this.bridge = null;
    this.source?.dispose();
    this.source = null;
    bridge?.dispose();
    clearFindHighlight();
    this.publish({ result: null, busy: false, navigating: false, source: { loading: false, complete: false, count: 0, bytes: 0, error: null } });
  }
  setQuery(query) {
    this.publish({ query, error: null, notice: null, active: -1, pageOffset: 0 });
    this.schedule(false);
  }
  toggle(option) {
    this.publish({ options: { ...this.snapshot.options, [option]: !this.snapshot.options[option] }, active: -1, pageOffset: 0, error: null });
    this.schedule(false);
  }
  schedule(dataChange) {
    const revision = ++this.revision;
    clearTimeout(this.timer);
    this.bridge?.cancel();
    this.publish({ result: null, busy: Boolean(this.snapshot.query) });
    this.timer = setTimeout(() => this.search(revision), dataChange ? 100 : 35);
  }
  async search(revision) {
    if (!this.bridge || revision !== this.revision) return;
    const { query, options } = this.snapshot;
    if (!query) { this.publish({ result: null, busy: false }); return; }
    try {
      await this.mutationQueue;
      if (!this.bridge || revision !== this.revision) return;
      const result = await this.bridge.query(query, options);
      if (revision === this.revision) this.publish({ result, busy: false, active: -1, pageOffset: 0, error: null });
    } catch (error) {
      if (revision === this.revision && error.code !== 'CANCELLED') this.publish({ busy: false, error: error.message });
    }
  }
  async refresh() {
    if (!this.source) return;
    this.publish({ error: null, notice: null });
    try { await this.source.refresh(); } catch (error) { this.publish({ error: error.message }); }
  }
  async page(offset) {
    const result = this.snapshot.result;
    if (!result || !this.bridge) return;
    const revision = this.revision;
    try {
      const page = await this.bridge.page(result.id, Math.max(0, offset), 50);
      if (revision === this.revision) this.publish({ result: { ...result, ...page }, pageOffset: Math.max(0, offset) });
    } catch (error) { if (revision === this.revision) this.publish({ error: error.message }); }
  }
  async move(delta) {
    const result = this.snapshot.result;
    if (!result?.total || !this.bridge) return;
    const index = (this.snapshot.active < 0 ? delta > 0 ? 0 : result.total - 1 : (this.snapshot.active + delta + result.total) % result.total);
    await this.select(index);
  }
  async select(index) {
    const result = this.snapshot.result;
    if (!result || !this.bridge) return;
    const revision = this.revision;
    const token = ++this.navigation;
    try {
      let hit = result.items.find((item) => item.ordinal === index);
      if (!hit) {
        const offset = Math.floor(index / 50) * 50;
        const page = await this.bridge.page(result.id, offset, 50);
        if (revision !== this.revision || token !== this.navigation) return;
        hit = page.items.find((item) => item.ordinal === index);
        this.publish({ result: { ...result, ...page }, pageOffset: offset });
      }
      if (!hit) return;
      this.publish({ active: index, navigating: true, notice: null, error: null });
      let occurrence = 0;
      if (hit.matchedText) {
        const parts = [...this.bridge.docs.values()].filter((doc) => doc.seq === hit.seq && doc.role === hit.role && (doc.part ?? 0) <= (hit.part ?? 0)).sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
        for (const part of parts) {
          const prefix = part.id === hit.docId ? part.text.slice(0, hit.offset) : part.text;
          let cursor = 0;
          let found;
          while ((found = prefix.indexOf(hit.matchedText, cursor)) >= 0) { occurrence++; cursor = found + hit.matchedText.length; }
        }
      }
      const outcome = await this.reveal({
        ctx: this.ctx, binding: this.binding, hit, selectView: this.selectView,
        matchedText: hit.matchTruncated ? '' : hit.matchedText, occurrence,
        isCurrent: () => revision === this.revision && token === this.navigation && Boolean(this.bridge) && this.ctx.sidebarRight.mounted.getSnapshot() === this.binding.sessionId
      });
      if (revision === this.revision && token === this.navigation) this.publish({ navigating: false, notice: outcome?.cancelled ? null : outcome.precise ? null : '已定位到消息；Markdown 显示文字与原文不同，精确高亮不可用' });
    } catch (error) {
      if (revision === this.revision && token === this.navigation) this.publish({ navigating: false, error: error.message });
    }
  }
}





function createFindPlugin({ React, workerText, css, dictionaries }) {
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

return createFindPlugin({React:require('react'),workerText:"const WORD_CHARACTER = /[\\p{L}\\p{N}_]/u;\nconst ASCII_TEXT = /^[\\x00-\\x7f]*$/;\nconst CASED_CHARACTER = /\\p{Cased}/u;\nconst now = () => globalThis.performance?.now() ?? Date.now();\nconst yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));\n\nclass FindError extends Error {\n  constructor(code, message) {\n    super(message);\n    this.name = 'FindError';\n    this.code = code;\n  }\n}\n\nfunction integer(value, fallback, min, max) {\n  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;\n}\n\nfunction escapeRegex(text) {\n  return text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n}\n\nfunction wordBefore(text, offset) {\n  if (!offset) return false;\n  const last = text.charCodeAt(offset - 1);\n  const previous = offset > 1 ? text.charCodeAt(offset - 2) : 0;\n  const start = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 2 : offset - 1;\n  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(start)));\n}\n\nfunction wholeWord(text, offset, length) {\n  return !wordBefore(text, offset) &&\n    (offset + length >= text.length || !WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(offset + length))));\n}\n\nfunction snippet(doc, offset, length, options) {\n  const max = options.maxSnippetLength;\n  let start = Math.max(0, offset - Math.min(options.contextChars, Math.floor(max / 3)));\n  if (start > 0 && doc.text.charCodeAt(start) >= 0xdc00 && doc.text.charCodeAt(start) <= 0xdfff && doc.text.charCodeAt(start - 1) >= 0xd800 && doc.text.charCodeAt(start - 1) <= 0xdbff) start--;\n  let end = Math.min(doc.text.length, Math.max(offset + Math.min(length, max), offset + options.contextChars), start + max);\n  if (end < doc.text.length && doc.text.charCodeAt(end - 1) >= 0xd800 && doc.text.charCodeAt(end - 1) <= 0xdbff && doc.text.charCodeAt(end) >= 0xdc00 && doc.text.charCodeAt(end) <= 0xdfff) end = end + 1 - start <= max ? end + 1 : end - 1;\n  const matchStart = Math.max(0, offset - start);\n  const matchEnd = Math.max(matchStart, Math.min(end - start, offset + length - start));\n  return {\n    snippet: doc.text.slice(start, end), snippetOffset: start, matchStart, matchEnd,\n    matchedText: doc.text.slice(offset, Math.min(offset + length, end)),\n    matchTruncated: offset + length > end, clippedBefore: start > 0, clippedAfter: end < doc.text.length,\n  };\n}\n\nclass SearchEngine {\n  constructor(options = {}) {\n    this.options = {\n      maxTotalChars: integer(options.maxTotalChars, 64 * 1024 * 1024, 1, 1024 * 1024 * 1024),\n      maxDocs: integer(options.maxDocs, 100000, 1, 1000000),\n      maxMatches: integer(options.maxMatches, 100000, 1, 1000000),\n      blockChars: integer(options.blockChars, 256 * 1024, 1024, 4 * 1024 * 1024),\n      foldCacheChars: integer(options.foldCacheChars, 16 * 1024 * 1024, 0, 256 * 1024 * 1024),\n      stepBudgetMs: integer(options.stepBudgetMs, 8, 1, 50),\n      overflowPolicy: options.overflowPolicy === 'evict' ? 'evict' : 'reject',\n    };\n    this._docs = new Map();\n    this._chars = 0;\n    this._order = 0;\n    this._version = 0;\n    this._nextId = 0;\n    this._ordered = null;\n    this._folds = new Map();\n    this._foldChars = 0;\n    this._job = null;\n    this._last = null;\n    this._buffers = null;\n  }\n\n  _invalidate() {\n    this.cancel('mutation');\n    this._last = null;\n    this._ordered = null;\n    this._version++;\n  }\n\n  _dropFold(id) {\n    const cached = this._folds.get(id);\n    if (cached !== undefined) {\n      this._foldChars -= cached.length;\n      this._folds.delete(id);\n    }\n  }\n\n  _orderedDocs() {\n    if (!this._ordered) this._ordered = [...this._docs.values()].sort((a, b) => a.seq - b.seq || a.part - b.part || a._order - b._order);\n    return this._ordered;\n  }\n\n  _fold(doc) {\n    let text = this._folds.get(doc.id);\n    if (text !== undefined) return text;\n    if (!doc._ascii || doc.text.length > this.options.foldCacheChars || doc.text.length > this.options.blockChars) return null;\n    if (this._foldChars + doc.text.length > this.options.foldCacheChars) return null;\n    text = doc.text.toLowerCase();\n    this._folds.set(doc.id, text);\n    this._foldChars += text.length;\n    return text;\n  }\n\n  upsert(documents) {\n    if (!Array.isArray(documents)) documents = [documents];\n    if (documents.length > this.options.maxDocs) throw new FindError('BATCH_LIMIT', 'Document batch exceeds maxDocs.');\n    this._invalidate();\n    let added = 0;\n    let updated = 0;\n    const rejected = [];\n    const evictedIds = [];\n    for (const input of documents) {\n      if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 1024 || typeof input.text !== 'string' ||\n          !Number.isFinite(input.seq) || !['user', 'assistant', 'reasoning'].includes(input.role)) {\n        rejected.push({ id: typeof input?.id === 'string' ? input.id.slice(0, 1024) : null, code: 'INVALID_DOCUMENT' });\n        continue;\n      }\n      const old = this._docs.get(input.id);\n      const nextChars = this._chars - (old?.text.length ?? 0) + input.text.length;\n      const nextDocs = this._docs.size + (old ? 0 : 1);\n      if (input.text.length > this.options.maxTotalChars ||\n          (this.options.overflowPolicy === 'reject' && (nextChars > this.options.maxTotalChars || nextDocs > this.options.maxDocs))) {\n        rejected.push({ id: input.id, code: input.text.length > this.options.maxTotalChars || nextChars > this.options.maxTotalChars ? 'TEXT_LIMIT' : 'DOCUMENT_LIMIT' });\n        continue;\n      }\n      if (this.options.overflowPolicy === 'evict') {\n        while (this._chars - (old?.text.length ?? 0) + input.text.length > this.options.maxTotalChars || this._docs.size + (old ? 0 : 1) > this.options.maxDocs) {\n          const candidate = this._orderedDocs().find(doc => doc.id !== input.id);\n          if (!candidate) break;\n          this._docs.delete(candidate.id);\n          this._chars -= candidate.text.length;\n          this._dropFold(candidate.id);\n          this._ordered = null;\n          evictedIds.push(candidate.id);\n        }\n      }\n      const doc = {\n        id: input.id, seq: input.seq, part: integer(input.part, 0, 0, Number.MAX_SAFE_INTEGER), role: input.role, text: input.text,\n        turn: typeof input.turn === 'number' ? input.turn : typeof input.turn === 'string' ? input.turn.slice(0, 256) : undefined,\n        step: typeof input.step === 'number' ? input.step : typeof input.step === 'string' ? input.step.slice(0, 256) : undefined,\n        _order: old?._order ?? this._order++, _ascii: ASCII_TEXT.test(input.text),\n      };\n      this._docs.set(doc.id, doc);\n      this._chars += doc.text.length - (old?.text.length ?? 0);\n      this._dropFold(doc.id);\n      this._ordered = null;\n      if (old) updated++; else added++;\n    }\n    return { added, updated, rejected, evictedIds, ...this.stats() };\n  }\n\n  remove(ids) {\n    if (!Array.isArray(ids)) ids = [ids];\n    this._invalidate();\n    let removed = 0;\n    for (const id of ids) {\n      const doc = this._docs.get(id);\n      if (!doc) continue;\n      this._chars -= doc.text.length;\n      this._docs.delete(id);\n      this._dropFold(id);\n      removed++;\n    }\n    return { removed, ...this.stats() };\n  }\n\n  reset(docs = []) {\n    this.clear();\n    return this.upsert(docs);\n  }\n\n  clear() {\n    this._invalidate();\n    this._docs.clear();\n    this._folds.clear();\n    this._chars = 0;\n    this._foldChars = 0;\n    this._order = 0;\n    this._buffers = null;\n    return this.stats();\n  }\n\n  stats() {\n    return {\n      docs: this._docs.size, chars: this._chars, estimatedTextBytes: this._chars * 2,\n      maxTotalChars: this.options.maxTotalChars, maxDocs: this.options.maxDocs, maxMatches: this.options.maxMatches,\n      foldedChars: this._foldChars, foldCacheChars: this.options.foldCacheChars,\n      resultMatches: this._last?.total ?? 0, resultIndexBytes: this._buffers ? this._buffers.starts.byteLength * 3 : 0,\n      version: this._version,\n    };\n  }\n\n  cancel(reason = 'cancelled') {\n    if (this._job && !this._job.done) this._job.cancel(reason);\n    this._job = null;\n  }\n\n  createJob(query, options = {}) {\n    this.cancel('superseded');\n    this._last = null;\n    if (typeof query !== 'string') throw new FindError('INVALID_QUERY', 'Query must be a string.');\n    if (query.length > 16384) throw new FindError('QUERY_LIMIT', 'Query exceeds 16384 UTF-16 code units.');\n    const normalized = {\n      matchCase: options.matchCase === true, wholeWord: options.wholeWord === true,\n      regex: options.regex === true, includeReasoning: options.includeReasoning === true,\n      maxMatches: integer(options.maxMatches, this.options.maxMatches, 1, this.options.maxMatches),\n      contextChars: integer(options.contextChars, 80, 0, 512),\n      maxSnippetLength: integer(options.maxSnippetLength, 240, 32, 2048),\n      limit: integer(options.limit, 50, 1, 200),\n    };\n    let expression = null;\n    if (query) {\n      if (normalized.regex) {\n        try { expression = new RegExp(query, normalized.matchCase ? 'g' : 'gi'); }\n        catch (error) { throw new FindError('INVALID_REGEX', error.message); }\n      } else if (!normalized.matchCase && CASED_CHARACTER.test(query)) {\n        const pattern = escapeRegex(query);\n        try { expression = new RegExp(pattern, 'giu'); }\n        catch { expression = new RegExp(pattern, 'gi'); }\n      }\n    }\n    const job = new SearchJob(this, ++this._nextId, query, normalized, expression);\n    this._job = job;\n    return job;\n  }\n\n  async query(query, options = {}, control = {}) {\n    const job = this.createJob(query, options);\n    while (!job.done) {\n      if (control.signal?.aborted) job.cancel('cancelled');\n      job.next();\n      if (!job.done) await yieldTask();\n    }\n    if (job.cancelled) throw new FindError(job.reason === 'superseded' ? 'SUPERSEDED' : 'CANCELLED', job.reason);\n    return job.result();\n  }\n\n  searchSync(query, options = {}) {\n    const job = this.createJob(query, options);\n    while (!job.done) job.next(Infinity);\n    return job.result();\n  }\n\n  page(id, { offset = 0, limit = 50 } = {}) {\n    const record = this._last;\n    if (!record || record.id !== id) throw new FindError('STALE_RESULT', 'Search result is no longer available.');\n    offset = integer(offset, 0, 0, record.total);\n    limit = integer(limit, 50, 1, 200);\n    const items = [];\n    let lastDocIndex = -1;\n    let firstOrdinal = 0;\n    for (let ordinal = offset; ordinal < Math.min(record.total, offset + limit); ordinal++) {\n      const docIndex = record.docIndices[ordinal];\n      const doc = record.documents[docIndex];\n      if (docIndex !== lastDocIndex) {\n        let low = 0;\n        let high = ordinal;\n        while (low < high) {\n          const middle = (low + high) >>> 1;\n          if (record.docIndices[middle] < docIndex) low = middle + 1;\n          else high = middle;\n        }\n        firstOrdinal = low;\n        lastDocIndex = docIndex;\n      }\n      const start = record.starts[ordinal];\n      const length = record.lengths[ordinal];\n      items.push({\n        id: doc.id, docId: doc.id, seq: doc.seq, part: doc.part, role: doc.role, turn: doc.turn, step: doc.step,\n        offset: start, length, occurrence: ordinal - firstOrdinal, ordinal,\n        ...snippet(doc, start, length, record.options),\n      });\n    }\n    return {\n      id: record.id, query: record.query, total: record.total, truncated: record.truncated,\n      truncatedReason: record.truncated ? 'match-limit' : null, matchedDocs: record.matchedDocs,\n      offset, limit, hasMore: offset + items.length < record.total, items, elapsedMs: record.elapsedMs,\n      version: record.version, stats: record.stats,\n    };\n  }\n}\n\nclass SearchJob {\n  constructor(engine, id, query, options, expression) {\n    this.engine = engine;\n    this.id = id;\n    this.query = query;\n    this.options = options;\n    this.expression = expression;\n    this.documents = engine._orderedDocs().filter(doc => options.includeReasoning || doc.role !== 'reasoning');\n    this.totalChars = this.documents.reduce((sum, doc) => sum + doc.text.length, 0);\n    const capacity = query ? options.maxMatches : 0;\n    if (!engine._buffers || engine._buffers.starts.length < capacity) {\n      engine._buffers = { starts: new Uint32Array(capacity), lengths: new Uint32Array(capacity), docIndices: new Uint32Array(capacity) };\n    }\n    this.starts = engine._buffers.starts;\n    this.lengths = engine._buffers.lengths;\n    this.docIndices = engine._buffers.docIndices;\n    this.total = 0;\n    this.matchedDocs = 0;\n    this.docIndex = 0;\n    this.scannedChars = 0;\n    this.cursor = 0;\n    this.block = null;\n    this.started = now();\n    this.done = false;\n    this.cancelled = false;\n    this.reason = null;\n    this.truncated = false;\n    this._matchedCurrent = false;\n    this._record = null;\n    const cased = CASED_CHARACTER.test(query);\n    this.caseSensitiveScan = options.matchCase || !cased;\n    this.foldNeedle = !options.regex && !this.caseSensitiveScan && ASCII_TEXT.test(query) ? query.toLowerCase() : null;\n    this.overlap = Math.max(0, query.length - 1);\n    if (!query) this._finish();\n  }\n\n  cancel(reason) {\n    if (this.done) return;\n    this.reason = reason;\n    this.cancelled = true;\n    this.done = true;\n    this.documents = null;\n    this.starts = this.lengths = this.docIndices = null;\n    this.block = null;\n  }\n\n  progress() {\n    return {\n      docsSearched: this.docIndex, docsTotal: this.documents?.length ?? 0,\n      scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars, matches: this.total,\n    };\n  }\n\n  _advanceDoc() {\n    this.scannedChars += this.documents[this.docIndex].text.length;\n    this.docIndex++;\n    this.cursor = 0;\n    this.block = null;\n    this._matchedCurrent = false;\n    if (this.expression) this.expression.lastIndex = 0;\n  }\n\n  _accept(start, length, doc) {\n    if (this.options.wholeWord && !wholeWord(doc.text, start, length)) return;\n    if (this.total === this.options.maxMatches) {\n      this.truncated = true;\n      this._finish();\n      return;\n    }\n    this.starts[this.total] = start;\n    this.lengths[this.total] = length;\n    this.docIndices[this.total] = this.docIndex;\n    this.total++;\n    if (!this._matchedCurrent) {\n      this.matchedDocs++;\n      this._matchedCurrent = true;\n    }\n  }\n\n  next(budgetMs = this.engine.options.stepBudgetMs) {\n    if (this.done) return { done: true, cancelled: this.cancelled, progress: this.progress() };\n    const deadline = now() + budgetMs;\n    let iterations = 0;\n    do {\n      if (this.docIndex === this.documents.length) { this._finish(); break; }\n      iterations++;\n      const doc = this.documents[this.docIndex];\n      if (this.options.regex) this._stepExpression(doc);\n      else this._stepLiteral(doc);\n    } while (!this.done && ((iterations & 255) !== 0 && this.block !== null || now() < deadline));\n    return { done: this.done, cancelled: this.cancelled, progress: this.progress() };\n  }\n\n  _stepLiteral(doc) {\n    const folded = this.foldNeedle !== null && doc._ascii ? this.engine._fold(doc) : null;\n    const source = folded ?? doc.text;\n    if (!this.block) {\n      if (this.cursor >= source.length) { this._advanceDoc(); return; }\n      const end = Math.min(source.length, this.cursor + this.engine.options.blockChars);\n      this.block = { start: this.cursor, end, text: source.slice(this.cursor, Math.min(source.length, end + this.overlap)), cursor: 0, indexOf: folded !== null || this.caseSensitiveScan };\n    }\n    let found;\n    let length;\n    if (this.block.indexOf) {\n      const needle = folded !== null ? this.foldNeedle : this.query;\n      length = needle.length;\n      found = this.block.text.indexOf(needle, this.block.cursor);\n    } else {\n      this.expression.lastIndex = this.block.cursor;\n      const match = this.expression.exec(this.block.text);\n      found = match ? match.index : -1;\n      length = match ? match[0].length : 0;\n    }\n    if (found < 0 || this.block.start + found >= this.block.end) {\n      this.cursor = this.block.end;\n      this.block = null;\n      return;\n    }\n    const start = this.block.start + found;\n    this.cursor = start + length;\n    this.block.cursor = found + length;\n    this._accept(start, length, doc);\n    if (!this.done && this.cursor >= this.block.end) this.block = null;\n  }\n\n  _stepExpression(doc) {\n    this.expression.lastIndex = this.cursor;\n    const match = this.expression.exec(doc.text);\n    if (!match) { this._advanceDoc(); return; }\n    this.cursor = this.expression.lastIndex;\n    if (!match[0].length) this.cursor = match.index + 1;\n    this._accept(match.index, match[0].length, doc);\n    if (!this.done && this.cursor > doc.text.length) this._advanceDoc();\n  }\n\n  _finish() {\n    this.done = true;\n    this._record = {\n      id: this.id, query: this.query, options: this.options, documents: this.documents,\n      starts: this.starts, lengths: this.lengths, docIndices: this.docIndices,\n      total: this.total, truncated: this.truncated, matchedDocs: this.matchedDocs,\n      elapsedMs: now() - this.started, version: this.engine._version,\n      stats: { docsSearched: this.docIndex, docsTotal: this.documents.length, scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars },\n    };\n    this.block = null;\n    this.engine._last = this._record;\n    if (this.engine._job === this) this.engine._job = null;\n  }\n\n  result() {\n    return this.done && !this.cancelled ? this.engine.page(this.id, { limit: this.options.limit }) : null;\n  }\n}\n\nfunction createSearchEngine(options = {}) {\n  return new SearchEngine(options);\n}\n\n\nfunction createEngineServer(port = globalThis, options = {}) {\n  let engine = new SearchEngine(options);\n  let active = null;\n  let timer = null;\n  let disposed = false;\n  let lastProgress = 0;\n  const post = message => { if (!disposed) port.postMessage(message); };\n  const fail = (requestId, error) => post({ type: 'error', requestId, error: { code: error.code || 'ENGINE_ERROR', message: error.message || String(error) } });\n\n  function cancel(reason = 'cancelled') {\n    if (timer !== null) clearTimeout(timer);\n    timer = null;\n    if (active) {\n      active.job.cancel(reason);\n      post({ type: 'cancelled', requestId: active.requestId, reason });\n      active = null;\n    }\n    engine.cancel(reason);\n  }\n\n  function step() {\n    timer = null;\n    const current = active;\n    if (!current || disposed) return;\n    try {\n      const state = current.job.next();\n      if (current !== active) return;\n      if (state.done) {\n        active = null;\n        if (state.cancelled) post({ type: 'cancelled', requestId: current.requestId, reason: current.job.reason });\n        else post({ type: 'result', requestId: current.requestId, result: current.job.result() });\n      } else {\n        const time = globalThis.performance?.now() ?? Date.now();\n        if (time - lastProgress >= 50) {\n          post({ type: 'progress', requestId: current.requestId, progress: state.progress });\n          lastProgress = time;\n        }\n        timer = setTimeout(step, 0);\n      }\n    } catch (error) {\n      if (current === active) active = null;\n      engine.cancel('error');\n      fail(current.requestId, error);\n    }\n  }\n\n  function receive(data) {\n    if (disposed || !data || typeof data.type !== 'string') return;\n    const { requestId } = data;\n    try {\n      switch (data.type) {\n        case 'reset':\n          cancel('mutation');\n          if (data.options) engine = new SearchEngine(data.options);\n          post({ type: 'ack', requestId, ...engine.reset(data.docs || []) });\n          break;\n        case 'upsert':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.upsert(data.docs || []) });\n          break;\n        case 'remove':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.remove(data.ids || []) });\n          break;\n        case 'clear':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.clear() });\n          break;\n        case 'query':\n          cancel('superseded');\n          active = { requestId, job: engine.createJob(data.query, data.options || {}) };\n          lastProgress = 0;\n          timer = setTimeout(step, 0);\n          break;\n        case 'page':\n          post({ type: 'page', requestId, result: engine.page(data.id, { offset: data.offset, limit: data.limit }) });\n          break;\n        case 'cancel':\n          cancel('cancelled');\n          if (requestId !== undefined) post({ type: 'ack', requestId });\n          break;\n        case 'stats':\n          post({ type: 'ack', requestId, ...engine.stats() });\n          break;\n        case 'ping':\n          post({ type: 'pong', requestId });\n          break;\n        case 'dispose':\n          cancel('disposed');\n          engine.clear();\n          post({ type: 'ack', requestId });\n          dispose();\n          break;\n        default:\n          fail(requestId, { code: 'UNKNOWN_MESSAGE', message: 'Unknown search worker message.' });\n      }\n    } catch (error) { fail(requestId, error); }\n  }\n\n  const listener = event => receive(event.data);\n  if (typeof port.addEventListener === 'function') {\n    port.addEventListener('message', listener);\n    port.start?.();\n  } else if (typeof port.on === 'function') {\n    port.on('message', receive);\n  } else {\n    port.onmessage = listener;\n  }\n\n  function dispose() {\n    if (disposed) return;\n    cancel('disposed');\n    engine.clear();\n    disposed = true;\n    if (typeof port.removeEventListener === 'function') port.removeEventListener('message', listener);\n    else if (typeof port.off === 'function') port.off('message', receive);\n    else if (port.onmessage === listener) port.onmessage = null;\n  }\n\n  post({ type: 'ready', capabilities: { paging: true, cancellation: 'cooperative', regexWatchdog: 'client', offsets: 'utf16' }, ...engine.stats() });\n  return { receive, dispose, get engine() { return engine; } };\n}\n\nif (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) createEngineServer(globalThis);\n",css:".dsh-find-open{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a3a3a3);cursor:pointer}.dsh-find-open:hover{background:var(--dsw-alias-interactive-bg-hover,#282828);color:var(--dsw-alias-label-primary,#eee)}.dsh-find{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#eee);font:14px var(--dsw-font,sans-serif);background:var(--dsw-alias-bg-base,#141414)}.dsh-find *{box-sizing:border-box}.dsh-find-toolbar{padding:16px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#333)}.dsh-find-input{width:100%;height:38px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-layer-2,#242424);color:inherit;font:inherit;outline:none}.dsh-find-input:focus{border-color:#68aaff;box-shadow:0 0 0 1px #68aaff}.dsh-find-options{display:flex;gap:6px;margin-top:10px}.dsh-find button{font:inherit;color:inherit;cursor:pointer}.dsh-find button:disabled{opacity:.4;cursor:default}.dsh-find-toggle{border:1px solid transparent;border-radius:5px;padding:4px 8px;background:transparent;min-width:34px}.dsh-find-toggle:hover,.dsh-find-navigation button:hover,.dsh-find-paging button:hover{background:var(--dsw-alias-interactive-bg-hover,#303030)}.dsh-find-toggle[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#303030);border-color:#68aaff;color:#91baff}.dsh-find-navigation{display:flex;align-items:center;gap:6px;margin-top:8px;min-height:30px}.dsh-find-count{flex:1;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dsh-find-navigation button{border:0;border-radius:5px;background:transparent;width:30px;height:28px}.dsh-find-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);padding:10px 14px}.dsh-find-reload{margin-left:auto;border:0;background:none;color:#91baff!important;font-size:11px!important}.dsh-find-results{flex:1;min-height:0;overflow:auto;padding:0 6px 10px}.dsh-find-result{width:100%;display:block;text-align:left;border:1px solid transparent;border-radius:8px;background:none;padding:10px 8px;margin-bottom:4px;overflow-wrap:anywhere}.dsh-find-result:hover{background:var(--dsw-alias-interactive-bg-hover,#282828)}.dsh-find-result[data-active=true]{border-color:#68aaff;background:var(--dsw-alias-interactive-bg-hover,#282828)}.dsh-find-meta{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:6px}.dsh-find-snippet{display:block;white-space:pre-wrap;font-family:var(--dsw-font-mono,monospace);font-size:12px;line-height:1.65}.dsh-find mark{color:inherit;background:#986b2566;border-radius:2px}.dsh-find-paging{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-top:1px solid var(--dsw-alias-border-l2,#333);font-size:11px}.dsh-find-paging button{border:0;background:none;border-radius:5px;padding:5px;font-size:11px}.dsh-find-footer{padding:10px 14px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);border-top:1px solid var(--dsw-alias-border-l2,#333)}.dsh-find-error{margin:0 14px 10px;padding:10px;border-radius:6px;color:#ffaaaa;background:#84232340;font-size:12px;line-height:1.6}.dsh-find-note{padding:4px 14px 10px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px;line-height:1.6}.dsh-find-empty{padding:32px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:1.8}::highlight(dsh-session-find){background:#ffbd4580;color:inherit}\n",dictionaries:{"zh":{"meta":{"title":"会话内查找","description":"在当前会话的完整历史中查找文字，后台线程搜索，逐个导航并高亮命中。"},"title":"会话内查找","open":"查找当前会话","openTitle":"查找当前会话 · Desktop Ctrl+F / Web Ctrl+Alt+F","placeholder":"查找当前会话…","matchCase":"区分大小写","wholeWord":"全字匹配","regex":"使用正则表达式","includeReasoning":"包括思考文字","reasoning":"思考","user":"你","assistant":"助手","previous":"上一个命中 · Shift+Enter","next":"下一个命中 · Enter","previousPage":"上一页","nextPage":"下一页","pages":"结果分页","indexing":"正在读取历史 · {count} 个文本块","ready":"完整历史 · {count} 个文本块","partial":"仅部分历史 · 请查看原因","waiting":"等待会话历史","searching":"查找中…","hint":"Enter 下一个 · Shift+Enter 上一个","refresh":"重新读取","noMatches":"没有匹配文字","instructions":"输入关键字查找当前会话。中文和代码片段可直接搜索。","locating":"正在加载并定位历史消息…","capped":"命中超过 100,000 处，当前仅显示前 100,000 处，请缩小查询。","scope":"搜索已完成的用户输入与助手文字；可包括思考。正在生成的回复完成后纳入。工具、附件和注入上下文不在范围内。","unavailable":"当前没有可查找的会话"},"en":{"meta":{"title":"Find in conversation","description":"Find text throughout the current conversation with background search, match navigation and highlighting."},"title":"Find in conversation","open":"Find in current conversation","openTitle":"Find in conversation · Desktop Ctrl+F / Web Ctrl+Alt+F","placeholder":"Find in this conversation…","matchCase":"Match case","wholeWord":"Whole word","regex":"Regular expression","includeReasoning":"Include reasoning","reasoning":"Reasoning","user":"You","assistant":"Assistant","previous":"Previous match · Shift+Enter","next":"Next match · Enter","previousPage":"Previous page","nextPage":"Next page","pages":"Result pages","indexing":"Reading history · {count} text blocks","ready":"Complete history · {count} text blocks","partial":"Partial history · see the reason","waiting":"Waiting for session history","searching":"Searching…","hint":"Enter next · Shift+Enter previous","refresh":"Reload history","noMatches":"No matches","instructions":"Find words or code fragments throughout this conversation.","locating":"Loading and locating the historical message…","capped":"More than 100,000 matches. The first 100,000 are shown; refine the query.","scope":"Searches committed user input and assistant text; reasoning is optional. Streaming replies join when committed. Tools, attachments and injected context are excluded.","unavailable":"No conversation is available to search"}}});
}});
