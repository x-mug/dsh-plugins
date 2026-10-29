window.__ModuleLoader__.load({id:'@x-mug/dsh-session-find',factory:(require)=>{
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
  const event = entry?.event;
  return entry?.type === 'event' && isSequence(event?.seq) &&
    typeof event.type === 'string' && event.type.length > 0 ? event : null;
}

function auditHistoryPage(page, expectedLast) {
  if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') {
    throw sourceError('SOURCE_PAGE_INVALID', 'The history page has no valid records and hasMore fields.');
  }
  if (page.records.length === 0) {
    if (expectedLast !== -1 || page.hasMore) {
      throw sourceError('SOURCE_HISTORY_GAP', 'History ended before every durable event was read.');
    }
    return { first: 0, count: 0 };
  }
  const first = durableEvent(page.records[0])?.seq;
  if (first === undefined || first > expectedLast) {
    throw sourceError('SOURCE_HISTORY_GAP', 'The history page starts outside its requested range.');
  }
  for (let index = 0; index < page.records.length; index += 1) {
    if (durableEvent(page.records[index])?.seq !== first + index) {
      throw sourceError('SOURCE_HISTORY_GAP', 'History has a missing, repeated, or unordered durable event.');
    }
  }
  if (first + page.records.length - 1 !== expectedLast) {
    throw sourceError('SOURCE_HISTORY_GAP', 'The history page does not reach the preceding page or opening cursor.');
  }
  if (page.hasMore !== (first > 0)) {
    throw sourceError('SOURCE_HISTORY_GAP', 'History exhaustion disagrees with its zero-based durable sequence.');
  }
  return { first, count: page.records.length };
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
  let hasBaseline = false;
  let historyComplete = false;
  let authoritativeFrom = Infinity;
  let authoritativeThrough = -1;
  let liveThrough = -1;
  const pendingLive = new Set();
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
    authority: 'projections',
    eventsRead: 0,
    coverageThroughSeq: -1,
    liveThroughSeq: -1,
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

  function stopTransport() {
    controller?.abort();
  }

  function fail(error, reason) {
    publish({ loading: false, complete: false, partial: true, reason, ...errorDetails(error) });
  }

  function failRead(error, reason) {
    stopTransport();
    fail(error, reason);
  }

  function addEntries(entries, authoritative = false) {
    let added = [];
    let limitError = null;
    for (const entry of entries) {
      const event = durableEvent(entry);
      if (!event) continue;
      const previous = indexed.get(event.seq);
      if (!authoritative && (previous ||
          (event.seq >= authoritativeFrom && event.seq <= authoritativeThrough))) continue;
      const documents = extractSearchDocuments(entry);
      if (previous) {
        let previousBytes = 0;
        for (const document of previous) previousBytes += document.bytes;
        indexed.delete(event.seq);
        state = {
          ...state, count: state.count - previous.length,
          messageCount: state.messageCount - 1, bytes: state.bytes - previousBytes,
        };
      }
      let bytes = 0;
      for (const document of documents) bytes += document.text.length * 2;
      let error = null;
      if (bytes > maxBytes - state.bytes) {
        error = sourceError('SOURCE_MEMORY_LIMIT', `Search text exceeds the ${maxBytes} byte UTF-16 budget; only part of this session is indexed.`);
      } else if (documents.length > maxDocs - state.count) {
        error = sourceError('SOURCE_DOCUMENT_LIMIT', `Search exceeds the ${maxDocs} document budget; only part of this session is indexed.`);
      }
      if (previous) {
        const nextIds = error ? new Set() : new Set(documents.map(document => document.id));
        const removed = previous.filter(document => !nextIds.has(document.id)).map(document => document.id);
        for (let offset = 0; offset < removed.length; offset += 500) onRemove(removed.slice(offset, offset + 500));
      }
      if (error) {
        limitError ??= error;
        continue;
      }
      if (documents.length === 0) continue;
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
      stopTransport();
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

  function unwrapPage(result) {
    if (!result || typeof result.ok !== 'boolean') throw sourceError('SOURCE_PAGE_INVALID', 'The session.page RPC returned an invalid result.');
    if (!result.ok) throw result.error ?? sourceError('SOURCE_READ_FAILED', 'Session history could not be read.');
    return result.value;
  }

  function readWindow() {
    const window = binding.eventSource.getSnapshot();
    if (!Array.isArray(window?.entries) || typeof window.hasMore !== 'boolean' ||
        !Number.isSafeInteger(window.revision) || window.revision < 0) {
      throw sourceError('SOURCE_WINDOW_INVALID', 'The session event window is unavailable.');
    }
    return window;
  }

  async function pending(operation, signal) {
    if (signal.aborted) return null;
    let stop;
    const aborted = new Promise(resolve => {
      stop = () => resolve(null);
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => signal.aborted ? null : operation()), aborted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  function isCurrent(pass, signal) {
    return pass === generation && !signal.aborted && !disposed;
  }

  function checkAddress(expected) {
    const current = sessionSnapshot();
    if (sameAddress(expected, current.nextAddress)) return true;
    restart('session-address');
    return false;
  }

  function observeLive(entries) {
    for (const entry of entries) {
      if (entry?.type === 'transient') continue;
      const event = durableEvent(entry);
      if (!event) throw sourceError('SOURCE_HISTORY_GAP', 'The session feed contains an invalid durable event.');
      if (event.seq > liveThrough) pendingLive.add(event.seq);
    }
    if (!hasBaseline) return;
    for (const seq of pendingLive) if (seq <= liveThrough) pendingLive.delete(seq);
    while (pendingLive.delete(liveThrough + 1)) liveThrough += 1;
    state = { ...state, liveThroughSeq: liveThrough };
    if (historyComplete && (state.error === null || state.errorCode === 'SOURCE_LIVE_GAP')) {
      publish({
        complete: pendingLive.size === 0,
        partial: pendingLive.size > 0,
        reason: pendingLive.size > 0 ? 'waiting-for-durable-gap' : 'complete',
        error: pendingLive.size > 0 ? 'A durable event has not reached the session feed yet; new-message coverage is incomplete.' : null,
        errorCode: pendingLive.size > 0 ? 'SOURCE_LIVE_GAP' : null,
      });
    }
  }

  async function readHistory(window, pass, signal) {
    const { nextAddress } = sessionSnapshot();
    address = nextAddress;
    observeLive(window.entries);
    if (!addEntries(window.entries)) return;
    if (typeof remote.session.projections !== 'function') {
      throw sourceError('SOURCE_UNSUPPORTED_HOST', 'This host has no authorized session.projections API to establish a durable history cursor.');
    }
    // The host publishes sequenced projections at the synchronous durable log cut.
    const result = await pending(() => remote.session.projections({ sessionId: binding.sessionId }, signal), signal);
    if (!isCurrent(pass, signal) || !checkAddress(nextAddress)) return;
    if (!result || typeof result.ok !== 'boolean') {
      throw sourceError('SOURCE_CURSOR_INVALID', 'The session.projections RPC returned an invalid result.');
    }
    if (!result.ok) throw result.error ?? sourceError('SOURCE_READ_FAILED', 'The session history cursor could not be read.');
    const projection = result.value;
    if (projection?.kind !== 'sequenced') {
      throw sourceError('SOURCE_CURSOR_UNAVAILABLE', 'The host has no exact durable history cursor for this session.');
    }
    const throughSeq = projection.asOfSeq;
    if ((!isSequence(throughSeq) && throughSeq !== -1) || throughSeq === Number.MAX_SAFE_INTEGER) {
      throw sourceError('SOURCE_CURSOR_INVALID', 'The durable history cursor is invalid.');
    }
    liveThrough = throughSeq;
    hasBaseline = true;
    observeLive([]);
    publish({ throughSeq, liveThroughSeq: liveThrough });
    let beforeSeq;
    let expectedLast = throughSeq;
    while (isCurrent(pass, signal)) {
      const response = await pending(() => remote.session.page({
        address: { ...nextAddress }, throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: pageSize,
      }, signal), signal);
      if (!isCurrent(pass, signal) || !checkAddress(nextAddress)) return;
      const page = unwrapPage(response);
      const proof = auditHistoryPage(page, expectedLast);
      authoritativeFrom = proof.first;
      authoritativeThrough = throughSeq;
      state = {
        ...state, pages: state.pages + 1,
        eventsRead: state.eventsRead + proof.count, beforeSeq: proof.first,
      };
      if (!addEntries(page.records, true)) return;
      publish();
      if (proof.first === 0) break;
      expectedLast = proof.first - 1;
      beforeSeq = proof.first;
    }
    if (isCurrent(pass, signal)) {
      if (state.eventsRead !== throughSeq + 1) {
        throw sourceError('SOURCE_HISTORY_GAP', 'History coverage does not span every durable event from zero through the cursor.');
      }
      historyComplete = true;
      publish({ loading: false, coverageThroughSeq: throughSeq });
      observeLive([]);
    }
  }

  function restart(reason) {
    if (disposed) return;
    stopTransport();
    const pass = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    hasBaseline = false;
    historyComplete = false;
    authoritativeFrom = Infinity;
    authoritativeThrough = -1;
    liveThrough = -1;
    pendingLive.clear();
    clearDocuments();
    publish({
      loading: true,
      complete: false,
      partial: false,
      pages: 0,
      throughSeq: -1,
      beforeSeq: null,
      eventsRead: 0,
      coverageThroughSeq: -1,
      liveThroughSeq: -1,
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
      if (isCurrent(pass, signal)) failRead(error, 'read-error');
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
        observeLive(change.entries ?? []);
        addEntries(change.entries ?? []);
      } else if (change?.kind === 'settle-assistant') {
        if (change.entry) {
          observeLive([change.entry]);
          addEntries([change.entry]);
        }
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

function nodeForHit(snapshot, hit) {
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

function collectTextNodes(root) {
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

function rangeForText(root, text, occurrence = 0) {
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

function rangeForSource(row, node, hit, sourceDocument) {
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

async function revealHit({ ctx, binding, hit, sourceDocument, selectView, signal, highlightOwner: owner = binding, isCurrent = () => true }) {
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

function clearFindHighlight(owner) {
  if (owner !== undefined && highlightOwner !== owner) return;
  globalThis.CSS?.highlights?.delete(HIGHLIGHT);
  highlightOwner = undefined;
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


const OPTIONS = ['matchCase', 'wholeWord', 'regex', 'includeReasoning'];
const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const sameSource = (hit, source) => ['seq', 'part', 'role', 'offset', 'length'].every((key) => hit[key] === source[key]);

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
    this.lifecycle = 0;
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
  currentBinding() {
    if (this.ctx.sidebarRight?.mounted?.getSnapshot?.() !== this.binding.sessionId) return false;
    if (this.ctx.sessions?.binding && this.ctx.sessions.binding(this.binding.sessionId) !== this.binding) return false;
    const session = this.binding.session?.getSnapshot?.();
    return !session?.removed && (session?.sessionId === undefined || session.sessionId === this.binding.sessionId);
  }
  cancelNavigation() {
    this.navigation++;
    this.navigationAbort?.abort();
    this.navigationAbort = null;
    clearFindHighlight(this);
  }
  open() {
    this.publish({ focus: this.snapshot.focus + 1 });
  }
  start() {
    if (this.bridge) return;
    const lifecycle = ++this.lifecycle;
    this.bridge = new this.Bridge(this.workerText, (change) => {
      if (lifecycle !== this.lifecycle) return;
      if (change.reset) { this.revision++; this.cancelNavigation(); }
      this.publish({ error: change.error ?? null, busy: false, navigating: false, result: change.reset ? null : this.snapshot.result });
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
    try {
      this.source = this.createSource({
        binding: this.binding, remote: this.ctx.remote,
        onUpsert: (docs) => enqueue((current) => current.upsert(docs)),
        onRemove: (ids) => enqueue((current) => current.remove(ids)),
        onStatus: (source) => { if (this.bridge === bridge) this.publish({ source }); }
      });
      Promise.resolve(this.source.start()).catch((error) => {
        if (this.bridge === bridge) this.publish({ error: error.message });
      });
    } catch (error) {
      this.stop();
      throw error;
    }
    this.schedule(false);
  }
  stop() {
    this.revision++;
    this.lifecycle++;
    this.cancelNavigation();
    clearTimeout(this.timer);
    const bridge = this.bridge;
    this.bridge = null;
    this.source?.dispose();
    this.source = null;
    bridge?.dispose();
    this.publish({ result: null, busy: false, navigating: false, active: -1, pageOffset: 0, notice: null, source: { loading: false, complete: false, count: 0, bytes: 0, error: null } });
  }
  setQuery(query, options) {
    const nextOptions = { ...this.snapshot.options };
    for (const key of OPTIONS) if (typeof options?.[key] === 'boolean') nextOptions[key] = options[key];
    this.publish({ query: String(query ?? ''), options: nextOptions, error: null, notice: null, active: -1, pageOffset: 0 });
    this.schedule(false);
  }
  toggle(option) {
    if (!OPTIONS.includes(option)) return;
    this.publish({ options: { ...this.snapshot.options, [option]: !this.snapshot.options[option] }, active: -1, pageOffset: 0, error: null, notice: null });
    this.schedule(false);
  }
  schedule(dataChange) {
    const revision = ++this.revision;
    this.cancelNavigation();
    clearTimeout(this.timer);
    this.bridge?.cancel();
    this.publish({ result: null, busy: Boolean(this.bridge && this.snapshot.query), navigating: false, active: -1, pageOffset: 0, notice: null });
    if (this.bridge) this.timer = setTimeout(() => this.search(revision), dataChange ? 100 : 35);
  }
  async search(revision) {
    const bridge = this.bridge;
    if (!bridge || revision !== this.revision) return;
    const { query, options } = this.snapshot;
    if (!query) { this.publish({ result: null, busy: false }); return; }
    try {
      await this.mutationQueue;
      if (this.bridge !== bridge || revision !== this.revision) return;
      const result = await bridge.query(query, options);
      if (this.bridge === bridge && revision === this.revision) this.publish({ result, busy: false, active: -1, pageOffset: 0, error: null });
    } catch (error) {
      if (this.bridge === bridge && revision === this.revision && error.code !== 'CANCELLED') this.publish({ busy: false, error: error.message });
    }
  }
  async refresh() {
    const source = this.source;
    if (!source) return;
    this.cancelNavigation();
    this.publish({ error: null, notice: null, navigating: false });
    try { await source.refresh(); } catch (error) { if (this.source === source) this.publish({ error: error.message }); }
  }
  async page(offset) {
    const result = this.snapshot.result;
    const bridge = this.bridge;
    if (!result || !bridge || !validInteger(offset)) return;
    const revision = this.revision;
    const token = this.pageToken = (this.pageToken ?? 0) + 1;
    try {
      const page = await bridge.page(result.id, offset, 50);
      if (this.bridge === bridge && revision === this.revision && token === this.pageToken) this.publish({ result: { ...result, ...page }, pageOffset: offset });
    } catch (error) { if (this.bridge === bridge && revision === this.revision && token === this.pageToken) this.publish({ error: error.message }); }
  }
  async move(delta) {
    const result = this.snapshot.result;
    if (!result?.total || !this.bridge) return;
    const index = this.snapshot.active < 0 ? delta > 0 ? 0 : result.total - 1 : (this.snapshot.active + delta + result.total) % result.total;
    return this.select(index);
  }
  async select(index) {
    const result = this.snapshot.result;
    const bridge = this.bridge;
    if (!result || !bridge || !validInteger(index) || index >= result.total) return false;
    this.cancelNavigation();
    const revision = this.revision;
    const token = this.navigation;
    const controller = this.navigationAbort = new AbortController();
    const current = () => this.bridge === bridge && revision === this.revision && token === this.navigation && !controller.signal.aborted && this.currentBinding();
    try {
      if (!current()) return false;
      let hit = result.items.find((item) => item.ordinal === index);
      if (!hit) {
        const offset = Math.floor(index / 50) * 50;
        const page = await bridge.page(result.id, offset, 50);
        if (!current()) return false;
        hit = page.items.find((item) => item.ordinal === index);
        this.publish({ result: { ...result, ...page }, pageOffset: offset });
      }
      if (!hit) throw new Error('该命中已不可用，请重新搜索');
      const sourceDocument = bridge.docs.get(hit.docId);
      if (!sourceDocument || sourceDocument.seq !== hit.seq || (sourceDocument.part ?? 0) !== hit.part || sourceDocument.role !== hit.role ||
          typeof sourceDocument.text !== 'string' || !validInteger(hit.offset) || !validInteger(hit.length) || hit.offset + hit.length > sourceDocument.text.length) throw new Error('命中来源已改变，请重新搜索');
      if (typeof hit.matchedText === 'string') {
        const actual = sourceDocument.text.slice(hit.offset, hit.offset + hit.length);
        if (hit.matchTruncated ? !actual.startsWith(hit.matchedText) : actual !== hit.matchedText) throw new Error('命中文字已改变，请重新搜索');
      }
      this.publish({ active: index, navigating: true, notice: null, error: null });
      const outcome = await this.reveal({
        ctx: this.ctx, binding: this.binding, hit, sourceDocument, selectView: this.selectView,
        matchedText: hit.matchTruncated ? '' : hit.matchedText,
        signal: controller.signal, highlightOwner: this, isCurrent: current
      });
      if (!current()) return false;
      this.publish({ navigating: false, notice: outcome?.cancelled || outcome?.precise ? null : outcome?.notice ?? '已定位到消息；无法核对精确文字位置，精确高亮不可用' });
      return !outcome?.cancelled;
    } catch (error) {
      if (current() && error.code !== 'CANCELLED') this.publish({ navigating: false, error: error.message });
      return false;
    } finally {
      if (token === this.navigation && this.bridge === bridge) {
        this.navigationAbort = null;
        if (this.snapshot.navigating) this.publish({ navigating: false });
      }
    }
  }
  async selectSource(source) {
    if (!source || source.sessionId !== undefined && source.sessionId !== this.binding.sessionId ||
        !validInteger(source.seq) || !validInteger(source.part) || !validInteger(source.offset) || !validInteger(source.length) || !['user', 'assistant', 'reasoning'].includes(source.role)) {
      this.publish({ notice: '结果来源与当前会话不一致，无法定位' });
      return false;
    }
    this.cancelNavigation();
    this.publish({ navigating: false });
    const token = this.navigation;
    const lifecycle = this.lifecycle;
    const query = this.snapshot.query;
    const options = this.snapshot.options;
    const bridge = this.bridge;
    const current = () => Boolean(bridge) && bridge === this.bridge && lifecycle === this.lifecycle && token === this.navigation && query === this.snapshot.query && options === this.snapshot.options && this.currentBinding();
    if (!current()) return false;
    const revision = this.revision;
    const result = this.snapshot.result;
    if (!result || this.snapshot.busy || this.snapshot.source.loading) {
      this.publish({ notice: '当前会话仍在索引或查询，请完成后重试定位' });
      return false;
    }
    try {
      let hit = result.items.find((item) => sameSource(item, source));
      for (let offset = 0; !hit && offset < result.total; offset += 50) {
        if (offset === (result.offset ?? this.snapshot.pageOffset)) continue;
        const page = await bridge.page(result.id, offset, 50);
        if (!current() || revision !== this.revision) return false;
        hit = page.items.find((item) => sameSource(item, source));
        if (hit) this.publish({ result: { ...result, ...page }, pageOffset: offset });
      }
      if (!current() || revision !== this.revision) return false;
      if (hit) return this.select(hit.ordinal);
      const limit = result.truncated || this.snapshot.source.partial;
      this.publish({ notice: limit ? '结果或会话索引已达到限额，当前结果中没有此来源，无法定位；请缩小查询后重试' : '当前查询没有相同来源的命中，无法定位；请重新搜索' });
      return false;
    } catch (error) {
      if (current() && revision === this.revision && error.code !== 'CANCELLED') this.publish({ error: error.message });
      return false;
    }
  }
}


const DEFAULT_GLOBAL_BUDGETS = Object.freeze({
  maxSessions: 10000,
  maxPages: 10000,
  maxDocuments: 100000,
  maxBytes: 128 * 1024 * 1024,
  maxBatchBytes: 16 * 1024 * 1024,
  maxPageEvents: 50000,
  maxElapsedMs: 60000,
  pageSize: 50,
});

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const validSeq = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function details(error, sessionId) {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    code: typeof error?.code === 'string' ? error.code : 'GLOBAL_READ_FAILED',
    message: typeof error?.message === 'string' ? error.message : 'Session history could not be read.',
  };
}

function unwrap(result, operation) {
  if (result?.ok === false) throw result.error ?? failure('GLOBAL_RPC_FAILED', `${operation} failed.`);
  if (result?.ok !== true) throw failure('GLOBAL_RPC_INVALID', `${operation} returned an invalid result.`);
  return result.value;
}

function resolveBudgets(input = {}) {
  const budgets = { ...DEFAULT_GLOBAL_BUDGETS, ...input };
  for (const [key, value] of Object.entries(budgets)) {
    if (!(key in DEFAULT_GLOBAL_BUDGETS) || !Number.isSafeInteger(value) || value < 1 || Object.is(value, -0)) {
      throw new TypeError(`${key} must be a positive safe integer budget.`);
    }
  }
  if (budgets.pageSize > 500) throw new TypeError('pageSize must not exceed 500.');
  return Object.freeze(budgets);
}

function workspaceState(getSnapshot) {
  const value = getSnapshot();
  if (!Array.isArray(value?.items) || !Array.isArray(value.archivedSessionIds) ||
      value.archivedSessionIds.some(id => typeof id !== 'string')) {
    throw failure('GLOBAL_WORKSPACES_UNAVAILABLE', 'Workspace archive metadata is unavailable.');
  }
  return value;
}

function metadata(row, snapshot, title) {
  const workspace = snapshot.items.find(item => Array.isArray(item?.sessionIds) && item.sessionIds.includes(row.sessionId));
  return {
    sessionId: row.sessionId,
    title: typeof title === 'string' && title.length ? title : row.sessionId,
    workspace: typeof workspace?.title === 'string' && workspace.title.length ? workspace.title : row.cwd,
    cwd: row.cwd,
    ...(typeof workspace?.workspaceId === 'string' ? { workspaceId: workspace.workspaceId } : {}),
    archived: snapshot.archivedSessionIds.includes(row.sessionId),
  };
}

function snapshot(state) {
  return { ...state, errors: state.errors.map(error => ({ ...error })) };
}

function pageRecords(page, throughSeq, beforeSeq, budgets) {
  if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') {
    throw failure('GLOBAL_PAGE_INVALID', 'History page records are unavailable.');
  }
  if (page.records.length > budgets.maxPageEvents) {
    throw failure('GLOBAL_PAGE_EVENT_LIMIT', 'A history page exceeds the event budget.');
  }
  const end = beforeSeq ?? throughSeq + 1;
  const records = page.records;
  if (records.length === 0) {
    if (end !== 0 || page.hasMore) throw failure('GLOBAL_PAGE_GAP', 'History ended before its committed cursor.');
    return 0;
  }
  const first = records[0]?.event?.seq;
  if (!validSeq(first) || first >= end || records.length !== end - first || page.hasMore !== (first > 0)) {
    throw failure('GLOBAL_PAGE_GAP', 'History does not prove complete cursor coverage.');
  }
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.type !== 'event' || records[index].event?.seq !== first + index) {
      throw failure('GLOBAL_PAGE_GAP', 'History contains a sequence gap or a repeated event.');
    }
  }
  return first;
}

function createGlobalSource(options) {
  const { remote, getWorkspaceSnapshot, onBatch, onStatus = () => {} } = options;
  if (['list', 'projections', 'page'].some(name => typeof remote?.session?.[name] !== 'function')) {
    throw new TypeError('Authorized session.list, session.projections and session.page RPCs are required.');
  }
  if (typeof getWorkspaceSnapshot !== 'function' || typeof onBatch !== 'function' || typeof onStatus !== 'function') {
    throw new TypeError('Workspace, batch and status callbacks are required.');
  }
  const budgets = resolveBudgets(options.budgets);
  let active = null;
  let nextRunId = 0;
  let disposed = false;
  let last = { runId: 0, state: 'incomplete', loading: false, complete: false, partial: true, reason: 'idle', errors: [], budgets };

  function publish(run, patch = {}) {
    Object.assign(run.state, patch);
    if (active === run && !disposed) {
      last = snapshot(run.state);
      onStatus(snapshot(last));
    }
  }

  function remember(run, error, sessionId) {
    if (run.state.errors.length < 20) run.state.errors.push(details(error, sessionId));
    else run.state.omittedErrors += 1;
  }

  function check(run) {
    if (run.controller.signal.aborted) throw run.controller.signal.reason;
  }

  async function cancellable(run, operation) {
    check(run);
    const signal = run.controller.signal;
    let stop;
    const aborted = new Promise((resolve, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(run); return operation(); }), aborted]);
      check(run);
      return value;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  function stop(reason = 'cancelled') {
    active?.controller.abort(failure('GLOBAL_CANCELLED', reason));
  }

  async function run({ includeArchived = false, signal } = {}) {
    if (disposed) throw new Error('Global source is disposed.');
    if (typeof includeArchived !== 'boolean') throw new TypeError('includeArchived must be a boolean.');
    stop('superseded');
    const current = {
      controller: new AbortController(),
      state: {
        runId: ++nextRunId, state: 'running', loading: true, complete: false, partial: false, reason: 'listing',
        includeArchived, budgetScope: 'client-scan-and-delivery', sessionsTotal: 0, scannedSessions: 0, failedSessions: 0, skippedSessions: 0,
        pages: 0, documents: 0, bytes: 0, currentSessionId: null, throughSeq: null, beforeSeq: null,
        errors: [], omittedErrors: 0, budgets,
      },
    };
    active = current;
    const abortExternal = () => current.controller.abort(failure('GLOBAL_CANCELLED', 'cancelled'));
    signal?.addEventListener('abort', abortExternal, { once: true });
    if (signal?.aborted) abortExternal();
    const timer = setTimeout(() => current.controller.abort(failure('GLOBAL_TIME_LIMIT', 'The global scan reached its time budget.')), budgets.maxElapsedMs);
    let limited = null;
    let sessionLimit = false;
    try {
      publish(current);
      const initialWorkspaces = workspaceState(getWorkspaceSnapshot);
      const initialArchives = new Set(initialWorkspaces.archivedSessionIds);
      const listing = unwrap(await cancellable(current, () => remote.session.list({}, current.controller.signal)), 'session.list');
      if (!Array.isArray(listing?.items)) throw failure('GLOBAL_LIST_INVALID', 'The authorized session catalog is unavailable.');
      const seen = new Set();
      const candidates = [];
      for (let index = 0; index < listing.items.length; index += 1) {
        if (index % 256 === 0) await cancellable(current, yieldTask);
        const row = listing.items[index];
        if (typeof row?.sessionId !== 'string' || !row.sessionId || typeof row.cwd !== 'string' || !row.cwd || row.origin === 'subagent') continue;
        if (seen.has(row.sessionId)) throw failure('GLOBAL_LIST_INVALID', 'The authorized catalog repeated a session identity.');
        if (!includeArchived && initialArchives.has(row.sessionId)) continue;
        current.state.sessionsTotal += 1;
        if (candidates.length < budgets.maxSessions) {
          seen.add(row.sessionId);
          candidates.push({ sessionId: row.sessionId, cwd: row.cwd });
        } else sessionLimit = true;
      }
      publish(current, { reason: 'scanning' });
      for (const row of candidates) {
        check(current);
        let sessionFailed = false;
        publish(current, { currentSessionId: row.sessionId, throughSeq: null, beforeSeq: null });
        try {
          let workspaces = workspaceState(getWorkspaceSnapshot);
          if (!includeArchived && workspaces.archivedSessionIds.includes(row.sessionId)) {
            current.state.skippedSessions += 1;
            continue;
          }
          const projection = unwrap(await cancellable(current, () => remote.session.projections({ sessionId: row.sessionId }, current.controller.signal)), 'session.projections');
          if (projection?.kind !== 'sequenced' || !(projection.asOfSeq === -1 || validSeq(projection.asOfSeq))) {
            throw failure('GLOBAL_CURSOR_UNAVAILABLE', 'A sequenced session snapshot is unavailable; migration or refresh is required.');
          }
          const throughSeq = projection.asOfSeq;
          publish(current, { throughSeq });
          const title = projection.values?.title;
          let beforeSeq;
          let hasMore = true;
          while (hasMore) {
            check(current);
            if (current.state.pages >= budgets.maxPages) { limited = 'page-limit'; break; }
            const request = { address: { kind: 'session', sessionId: row.sessionId }, throughSeq, maxMessages: budgets.pageSize };
            if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
            const page = unwrap(await cancellable(current, () => remote.session.page(request, current.controller.signal)), 'session.page');
            const next = pageRecords(page, throughSeq, beforeSeq, budgets);
            current.state.pages += 1;
            workspaces = workspaceState(getWorkspaceSnapshot);
            if (!includeArchived && workspaces.archivedSessionIds.includes(row.sessionId)) {
              current.state.skippedSessions += 1;
              break;
            }
            const documents = [];
            let bytes = 0;
            for (let index = 0; index < page.records.length; index += 1) {
              if (index % 256 === 0) await cancellable(current, yieldTask);
              for (const document of extractSearchDocuments(page.records[index])) {
                const size = document.text.length * 2;
                if (size > budgets.maxBatchBytes - bytes || size > budgets.maxBytes - current.state.bytes - bytes) {
                  limited = bytes + size > budgets.maxBatchBytes ? 'batch-memory-limit' : 'memory-limit';
                  break;
                }
                if (documents.length >= budgets.maxDocuments - current.state.documents) { limited = 'document-limit'; break; }
                bytes += size;
                documents.push({ ...document, id: JSON.stringify([row.sessionId, document.id]), sessionId: row.sessionId });
              }
              if (limited) break;
            }
            workspaces = workspaceState(getWorkspaceSnapshot);
            if (!includeArchived && workspaces.archivedSessionIds.includes(row.sessionId)) {
              current.state.skippedSessions += 1;
              break;
            }
            if (documents.length > 0) {
              const session = metadata(row, workspaces, title);
              let response;
              try {
                response = await cancellable(current, () => onBatch({
                  runId: current.state.runId, session, documents, throughSeq,
                  beforeSeq: next, signal: current.controller.signal,
                }));
              } catch (error) {
                check(current);
                throw failure('GLOBAL_CONSUMER_FAILED', typeof error?.message === 'string' ? error.message : 'The search worker could not consume a history page.');
              }
              current.state.documents += documents.length;
              current.state.bytes += bytes;
              if (response?.stop === true) limited = typeof response.reason === 'string' ? response.reason : 'consumer-limit';
            }
            beforeSeq = next;
            current.state.beforeSeq = next;
            hasMore = page.hasMore;
            publish(current);
            if (limited) break;
          }
          if (!hasMore && !limited) current.state.scannedSessions += 1;
        } catch (error) {
          check(current);
          if (error?.code === 'GLOBAL_CONSUMER_FAILED' || error?.code === 'GLOBAL_WORKSPACES_UNAVAILABLE') throw error;
          remember(current, error, row.sessionId);
          current.state.failedSessions += 1;
          sessionFailed = true;
        }
        publish(current);
        if (limited) break;
        if (sessionFailed || candidates.length > 1) await cancellable(current, yieldTask);
      }
      limited ??= sessionLimit ? 'session-limit' : null;
      const partial = limited !== null || current.state.failedSessions > 0 || current.state.skippedSessions > 0;
      publish(current, {
        state: partial ? 'incomplete' : 'complete', loading: false, complete: !partial, partial,
        reason: limited ?? (current.state.failedSessions ? 'session-errors' : current.state.skippedSessions ? 'catalog-changed' : 'complete'),
      });
    } catch (error) {
      const code = error?.code;
      const cancelled = code === 'GLOBAL_CANCELLED';
      const budget = code === 'GLOBAL_TIME_LIMIT';
      if (!cancelled) remember(current, error);
      publish(current, {
        state: cancelled ? 'cancelled' : budget ? 'incomplete' : 'failed', loading: false, complete: false, partial: true,
        reason: cancelled ? error.message : budget ? 'time-limit' : 'error',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortExternal);
      if (active === current) { last = snapshot(current.state); active = null; }
    }
    return snapshot(current.state);
  }

  return {
    run,
    cancel: stop,
    getSnapshot: () => snapshot(active?.state ?? last),
    dispose() { stop('disposed'); disposed = true; },
  };
}



class GlobalFindController {
  constructor({ ctx, workerText, Bridge = SearchWorkerBridge, createSource = createGlobalSource, onSelect, maxResults = 5000 }) {
    this.ctx = ctx;
    this.workerText = workerText;
    this.Bridge = Bridge;
    this.createSource = createSource;
    this.onSelect = onSelect;
    this.maxResults = maxResults;
    this.listeners = new Set();
    this.revision = 0;
    this.navigation = 0;
    this.items = [];
    this.snapshot = {
      query: '', options: { matchCase: false, wholeWord: false, regex: false, includeReasoning: false },
      includeArchived: false, source: { loading: false, complete: false, count: 0 },
      result: null, busy: false, active: -1, pageOffset: 0, error: null, notice: null, focus: 0
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  publish(change) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  open() { this.publish({ focus: this.snapshot.focus + 1 }); }
  start() { this.visible = true; }
  stop() {
    this.visible = false;
    this.cancel();
  }
  cancel() {
    this.revision++;
    this.navigation++;
    clearTimeout(this.timer);
    this.run?.source.dispose();
    this.run?.bridge.dispose();
    this.run = null;
    if (this.snapshot.busy) this.publish({ busy: false, source: { ...this.snapshot.source, state: 'cancelled', loading: false, complete: false, partial: true, reason: 'cancelled' } });
  }
  setQuery(query) {
    this.navigation++;
    this.publish({ query, error: null, notice: null });
    this.schedule();
  }
  toggle(option) {
    this.publish({ options: { ...this.snapshot.options, [option]: !this.snapshot.options[option] } });
    this.schedule();
  }
  toggleArchived() {
    this.navigation++;
    this.publish({ includeArchived: !this.snapshot.includeArchived });
    this.schedule();
  }
  schedule() {
    this.cancel();
    this.items = [];
    this.publish({ result: null, active: -1, pageOffset: 0, busy: Boolean(this.snapshot.query), source: { loading: false, complete: false, count: 0 } });
    const revision = this.revision;
    if (this.snapshot.query) this.timer = setTimeout(() => this.search(revision), 150);
  }
  refresh() { this.schedule(); }
  updateResults(truncated = false) {
    this.publish({ result: { total: this.items.length, items: this.items.slice(this.snapshot.pageOffset, this.snapshot.pageOffset + 50), truncated, elapsedMs: this.elapsedMs ?? 0 } });
  }
  async search(revision) {
    if (revision !== this.revision || !this.snapshot.query || !this.visible) return;
    const { query, options, includeArchived } = this.snapshot;
    const current = { bridge: null, source: null };
    const isCurrent = () => revision === this.revision && this.run === current;
    this.run = current;
    this.elapsedMs = 0;
    try {
      current.bridge = new this.Bridge(this.workerText, (change) => {
        if (isCurrent() && change.error) this.publish({ error: change.error });
      });
      current.source = this.createSource({
        remote: this.ctx.remote,
        getWorkspaceSnapshot: () => this.ctx.workspaces.list.getSnapshot(),
        onStatus: (status) => { if (isCurrent()) this.publish({ source: { ...status, count: status.documents ?? 0 } }); },
        onBatch: async ({ session, documents, signal }) => {
          if (!isCurrent() || signal.aborted) return { stop: true, reason: 'cancelled' };
          const bridge = current.bridge;
          const ids = documents.map(doc => doc.id);
          try {
            await bridge.upsert(documents);
            if (!isCurrent() || signal.aborted) return { stop: true, reason: 'cancelled' };
            const result = await bridge.query(query, { ...options, maxMatches: this.maxResults - this.items.length, limit: 50 });
            if (!isCurrent() || signal.aborted) return { stop: true, reason: 'cancelled' };
            this.elapsedMs += result.elapsedMs;
            for (let offset = 0; offset < result.total; offset += 50) {
              const page = offset === 0 ? result : await bridge.page(result.id, offset, 50);
              if (!isCurrent() || signal.aborted) return { stop: true, reason: 'cancelled' };
              for (const hit of page.items) {
                if (this.items.length >= this.maxResults) break;
                this.items.push({ ...hit, ...session, ordinal: this.items.length });
              }
            }
            const capped = result.truncated || this.items.length >= this.maxResults;
            this.updateResults(capped);
            if (capped) return { stop: true, reason: 'result-limit' };
          } finally {
            if (isCurrent()) await bridge.remove(ids);
          }
        }
      });
      const status = await current.source.run({ includeArchived });
      if (isCurrent()) {
        this.updateResults(this.snapshot.result?.truncated ?? false);
        this.publish({ busy: false, source: { ...status, count: status.documents ?? 0 }, error: status.state === 'failed' ? status.errors?.[0]?.message ?? 'Cross-session search failed.' : this.snapshot.error });
      }
    } catch (error) {
      if (isCurrent()) this.publish({ busy: false, error: error.message, source: { ...this.snapshot.source, loading: false, complete: false, partial: true, state: 'failed', reason: 'search-failed' } });
    } finally {
      current.source?.dispose();
      current.bridge?.dispose();
      if (this.run === current) this.run = null;
    }
  }
  page(offset) {
    const pageOffset = Math.max(0, Math.min(offset, Math.floor(Math.max(0, this.items.length - 1) / 50) * 50));
    this.publish({ pageOffset });
    this.updateResults(this.snapshot.result?.truncated ?? false);
  }
  move(delta) {
    if (!this.items.length) return;
    const index = this.snapshot.active < 0 ? delta > 0 ? 0 : this.items.length - 1 : (this.snapshot.active + delta + this.items.length) % this.items.length;
    return this.select(index);
  }
  async select(index) {
    const hit = this.items[index];
    if (!hit) return;
    const archived = this.ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(hit.sessionId);
    if (archived) { this.publish({ notice: '归档会话可检索；请先在工作区取消归档，再打开定位。' }); return; }
    const token = ++this.navigation;
    const query = this.snapshot.query;
    const includeArchived = this.snapshot.includeArchived;
    this.publish({ active: index, notice: null });
    try { await this.onSelect(hit, query, this.snapshot.options); }
    catch (error) { if (token === this.navigation && query === this.snapshot.query && includeArchived === this.snapshot.includeArchived) this.publish({ error: error.message }); }
  }
  dispose() { this.cancel(); this.items = []; this.listeners.clear(); }
}

const findKeyboardInstalls = new WeakMap();
const findKeyboardHidden = '[hidden], [inert], [aria-hidden="true"]';
const findKeyboardOverlays = 'dialog[open], [role="dialog"], [aria-modal="true"], [data-shortcut-modal], [role="menu"], [role="listbox"], [popover]';
const findKeyboardNative = [
  '.xterm', '.monaco-editor', '.cm-editor', '.CodeMirror', '.ace_editor',
  'iframe', 'webview', 'object', 'embed', 'dialog', '[role="dialog"]', '[aria-modal="true"]',
  '[role="menu"]', '[role="menuitem"]', '[role="listbox"]', '[role="option"]',
  '[data-shortcut-modal]', '[data-code-editor]', '[data-code-preview]', '[data-document-preview]',
  '[data-textpreview-state]', '[data-textpreview-body]', '[data-document-loading]',
  '[data-html-preview]', '[data-pdf-preview]', '[data-image-preview]', '[data-document-markdown]',
  '[data-sidebar-browser-frame]', '[data-session-find-native]',
].join(', ');
const findKeyboardEditable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [data-lexical-editor]';
const findKeyboardPanel = '[data-session-find-panel], .dsh-find';
const findKeyboardConversation = '[data-conversation-content][data-conversation-session]';

function keyboardElement(node) {
  return node?.nodeType === 1 && typeof node.matches === 'function';
}

function keyboardAncestors(element) {
  const result = [];
  while (keyboardElement(element)) {
    result.push(element);
    element = element.parentElement ?? element.getRootNode?.().host;
  }
  return result;
}

function keyboardVisible(element, window) {
  if (!keyboardElement(element) || element.isConnected === false) return false;
  for (const ancestor of keyboardAncestors(element)) {
    if (ancestor.matches(findKeyboardHidden)) return false;
    const style = window.getComputedStyle?.(ancestor);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return typeof element.getClientRects === 'function' && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
}

function keyboardOverlayOpen(document, window) {
  for (const element of document.querySelectorAll(findKeyboardOverlays)) {
    if (element.hasAttribute('popover')) {
      let open = element.getAttribute('data-state') === 'open';
      try { open ||= element.matches(':popover-open'); } catch {}
      if (!open) continue;
    }
    if (keyboardVisible(element, window)) return true;
  }
  return false;
}

function keyboardOwner(element, sessionId, document, window) {
  const chain = keyboardAncestors(element);
  if (chain.some(node => node.matches(findKeyboardNative) || node.matches(findKeyboardHidden))) return false;
  const panel = chain.find(node => node.matches(findKeyboardPanel));
  if (panel) {
    const explicit = panel.getAttribute('data-session-find-session');
    const sidebar = chain.find(node => node.hasAttribute('data-sidebar-right-session'));
    const sidebarOwner = sidebar?.getAttribute('data-sidebar-right-session');
    const owner = explicit ?? sidebarOwner;
    return owner === sessionId && (sidebarOwner === undefined || sidebarOwner === sessionId) && keyboardVisible(panel, window);
  }
  if (chain.some(node => node.matches('[data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-float]'))) return false;
  const roots = [...document.querySelectorAll(findKeyboardConversation)].filter(root =>
    root.getAttribute('data-conversation-session') === sessionId && keyboardVisible(root, window) &&
    !keyboardAncestors(root).some(node => node.matches('[data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-float]')));
  if (roots.length !== 1) return false;
  const root = roots[0];
  const occurrence = chain.find(node => node.hasAttribute('data-conversation-session'));
  if (occurrence && occurrence !== root) return false;
  const composer = chain.find(node => node.matches('[data-composer-seat], [data-composer-input]'));
  if (chain.some(node => node.matches(findKeyboardEditable)) && !composer) return false;
  if (composer) return chain.includes(root) && keyboardVisible(composer, window);
  const flow = chain.find(node => node.hasAttribute('data-chat-flow'));
  if (flow) return chain.includes(root) && keyboardVisible(flow, window);
  const blank = element === root || element.parentElement === root && element.hasAttribute('data-conversation-scroll') || element === document.body || element === document.documentElement;
  return blank && [...root.querySelectorAll('[data-chat-flow]')].some(flow =>
    keyboardVisible(flow, window) && keyboardAncestors(flow).find(node => node.hasAttribute('data-conversation-session')) === root);
}

function keyboardInputElements(event, document) {
  let path = [];
  try { path = event.composedPath?.() ?? []; } catch {}
  const target = path.find(keyboardElement) ?? (keyboardElement(event.target) ? event.target : event.target?.parentElement);
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return { target, active, path: path.filter(keyboardElement) };
}

function canFindFromFocus({ window, document = window?.document, sessionId }) {
  if (!window || !document || typeof sessionId !== 'string' || !sessionId || document.visibilityState === 'hidden' || document.hasFocus?.() === false) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return keyboardElement(active) && keyboardVisible(active, window) && !keyboardOverlayOpen(document, window) && keyboardOwner(active, sessionId, document, window);
}

function installFindKeyboard({ window, document = window?.document, getSessionId, open, isEnabled = () => true }) {
  if (!window?.addEventListener || !document?.addEventListener || typeof getSessionId !== 'function' || typeof open !== 'function' || typeof isEnabled !== 'function') {
    throw new TypeError('Find keyboard requires a window, document and synchronous callbacks.');
  }
  findKeyboardInstalls.get(window)?.();
  let disposed = false;
  let composing = false;
  let heldSession;
  const reset = () => { heldSession = undefined; };
  const compositionStart = () => { composing = true; reset(); };
  const compositionEnd = () => { composing = false; reset(); };
  const blur = () => { composing = false; reset(); };
  const keyup = event => {
    if (event.code === 'KeyF' || event.key?.toLowerCase() === 'f' || ['Control', 'Meta'].includes(event.key)) reset();
  };
  const consume = event => { event.preventDefault(); event.stopPropagation(); };
  const keydown = event => {
    if (disposed || event.defaultPrevented || event.cancelable === false || composing || event.isComposing || event.keyCode === 229 || event.which === 229 || document.visibilityState === 'hidden' || document.hasFocus?.() === false) return;
    if (event.altKey || event.shiftKey || Boolean(event.ctrlKey) === Boolean(event.metaKey) || event.getModifierState?.('AltGraph')) return;
    if (event.key?.toLowerCase() !== 'f' && !(event.code === 'KeyF' && (!event.key || event.key === 'Unidentified'))) return;
    let sessionId;
    try {
      if (!isEnabled()) return;
      sessionId = getSessionId();
    } catch { return; }
    if (typeof sessionId !== 'string' || !sessionId) return;
    const { target, active, path } = keyboardInputElements(event, document);
    if (!keyboardElement(target) || !keyboardVisible(target, window) || keyboardOverlayOpen(document, window)) return;
    if (path.some(element => keyboardAncestors(element).some(node => node.matches(findKeyboardNative)))) return;
    if (!keyboardOwner(target, sessionId, document, window)) return;
    if (active && active !== document.body && active !== document.documentElement && !keyboardOwner(active, sessionId, document, window)) return;
    if (event.repeat) {
      if (heldSession === sessionId) consume(event);
      return;
    }
    try { if (open(sessionId, event) === false) return; } catch { return; }
    heldSession = sessionId;
    consume(event);
  };
  document.addEventListener('keydown', keydown);
  document.addEventListener('compositionstart', compositionStart, true);
  document.addEventListener('compositionend', compositionEnd, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', blur);
  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('compositionstart', compositionStart, true);
    document.removeEventListener('compositionend', compositionEnd, true);
    window.removeEventListener('keyup', keyup, true);
    window.removeEventListener('blur', blur);
    if (findKeyboardInstalls.get(window) === dispose) findKeyboardInstalls.delete(window);
  }
  findKeyboardInstalls.set(window, dispose);
  return dispose;
}







function createFindPlugin({ React, workerText, css, dictionaries }) {
  const h = React.createElement;
  const namespace = 'local.sessionFind';
  const kind = 'local-session-find';
  const id = '@x-mug/dsh-session-find';
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

return createFindPlugin({React:require('react'),workerText:"const WORD_CHARACTER = /[\\p{L}\\p{N}_]/u;\nconst ASCII_TEXT = /^[\\x00-\\x7f]*$/;\nconst CASED_CHARACTER = /\\p{Cased}/u;\nconst now = () => globalThis.performance?.now() ?? Date.now();\nconst yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));\n\nclass FindError extends Error {\n  constructor(code, message) {\n    super(message);\n    this.name = 'FindError';\n    this.code = code;\n  }\n}\n\nfunction integer(value, fallback, min, max) {\n  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;\n}\n\nfunction escapeRegex(text) {\n  return text.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n}\n\nfunction wordBefore(text, offset) {\n  if (!offset) return false;\n  const last = text.charCodeAt(offset - 1);\n  const previous = offset > 1 ? text.charCodeAt(offset - 2) : 0;\n  const start = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 2 : offset - 1;\n  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(start)));\n}\n\nfunction wholeWord(text, offset, length) {\n  return !wordBefore(text, offset) &&\n    (offset + length >= text.length || !WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(offset + length))));\n}\n\nfunction snippet(doc, offset, length, options) {\n  const max = options.maxSnippetLength;\n  let start = Math.max(0, offset - Math.min(options.contextChars, Math.floor(max / 3)));\n  if (start > 0 && doc.text.charCodeAt(start) >= 0xdc00 && doc.text.charCodeAt(start) <= 0xdfff && doc.text.charCodeAt(start - 1) >= 0xd800 && doc.text.charCodeAt(start - 1) <= 0xdbff) start--;\n  let end = Math.min(doc.text.length, Math.max(offset + Math.min(length, max), offset + options.contextChars), start + max);\n  if (end < doc.text.length && doc.text.charCodeAt(end - 1) >= 0xd800 && doc.text.charCodeAt(end - 1) <= 0xdbff && doc.text.charCodeAt(end) >= 0xdc00 && doc.text.charCodeAt(end) <= 0xdfff) end = end + 1 - start <= max ? end + 1 : end - 1;\n  const matchStart = Math.max(0, offset - start);\n  const matchEnd = Math.max(matchStart, Math.min(end - start, offset + length - start));\n  return {\n    snippet: doc.text.slice(start, end), snippetOffset: start, matchStart, matchEnd,\n    matchedText: doc.text.slice(offset, Math.min(offset + length, end)),\n    matchTruncated: offset + length > end, clippedBefore: start > 0, clippedAfter: end < doc.text.length,\n  };\n}\n\nclass SearchEngine {\n  constructor(options = {}) {\n    this.options = {\n      maxTotalChars: integer(options.maxTotalChars, 64 * 1024 * 1024, 1, 1024 * 1024 * 1024),\n      maxDocs: integer(options.maxDocs, 100000, 1, 1000000),\n      maxMatches: integer(options.maxMatches, 100000, 1, 1000000),\n      blockChars: integer(options.blockChars, 256 * 1024, 1024, 4 * 1024 * 1024),\n      foldCacheChars: integer(options.foldCacheChars, 16 * 1024 * 1024, 0, 256 * 1024 * 1024),\n      stepBudgetMs: integer(options.stepBudgetMs, 8, 1, 50),\n      overflowPolicy: options.overflowPolicy === 'evict' ? 'evict' : 'reject',\n    };\n    this._docs = new Map();\n    this._chars = 0;\n    this._order = 0;\n    this._version = 0;\n    this._nextId = 0;\n    this._ordered = null;\n    this._folds = new Map();\n    this._foldChars = 0;\n    this._job = null;\n    this._last = null;\n    this._buffers = null;\n  }\n\n  _invalidate() {\n    this.cancel('mutation');\n    this._last = null;\n    this._ordered = null;\n    this._version++;\n  }\n\n  _dropFold(id) {\n    const cached = this._folds.get(id);\n    if (cached !== undefined) {\n      this._foldChars -= cached.length;\n      this._folds.delete(id);\n    }\n  }\n\n  _orderedDocs() {\n    if (!this._ordered) this._ordered = [...this._docs.values()].sort((a, b) => a.seq - b.seq || a.part - b.part || a._order - b._order);\n    return this._ordered;\n  }\n\n  _fold(doc) {\n    let text = this._folds.get(doc.id);\n    if (text !== undefined) return text;\n    if (!doc._ascii || doc.text.length > this.options.foldCacheChars || doc.text.length > this.options.blockChars) return null;\n    if (this._foldChars + doc.text.length > this.options.foldCacheChars) return null;\n    text = doc.text.toLowerCase();\n    this._folds.set(doc.id, text);\n    this._foldChars += text.length;\n    return text;\n  }\n\n  upsert(documents) {\n    if (!Array.isArray(documents)) documents = [documents];\n    if (documents.length > this.options.maxDocs) throw new FindError('BATCH_LIMIT', 'Document batch exceeds maxDocs.');\n    this._invalidate();\n    let added = 0;\n    let updated = 0;\n    const rejected = [];\n    const evictedIds = [];\n    for (const input of documents) {\n      if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 1024 || typeof input.text !== 'string' ||\n          !Number.isFinite(input.seq) || !['user', 'assistant', 'reasoning'].includes(input.role)) {\n        rejected.push({ id: typeof input?.id === 'string' ? input.id.slice(0, 1024) : null, code: 'INVALID_DOCUMENT' });\n        continue;\n      }\n      const old = this._docs.get(input.id);\n      const nextChars = this._chars - (old?.text.length ?? 0) + input.text.length;\n      const nextDocs = this._docs.size + (old ? 0 : 1);\n      if (input.text.length > this.options.maxTotalChars ||\n          (this.options.overflowPolicy === 'reject' && (nextChars > this.options.maxTotalChars || nextDocs > this.options.maxDocs))) {\n        rejected.push({ id: input.id, code: input.text.length > this.options.maxTotalChars || nextChars > this.options.maxTotalChars ? 'TEXT_LIMIT' : 'DOCUMENT_LIMIT' });\n        continue;\n      }\n      if (this.options.overflowPolicy === 'evict') {\n        while (this._chars - (old?.text.length ?? 0) + input.text.length > this.options.maxTotalChars || this._docs.size + (old ? 0 : 1) > this.options.maxDocs) {\n          const candidate = this._orderedDocs().find(doc => doc.id !== input.id);\n          if (!candidate) break;\n          this._docs.delete(candidate.id);\n          this._chars -= candidate.text.length;\n          this._dropFold(candidate.id);\n          this._ordered = null;\n          evictedIds.push(candidate.id);\n        }\n      }\n      const doc = {\n        id: input.id, seq: input.seq, part: integer(input.part, 0, 0, Number.MAX_SAFE_INTEGER), role: input.role, text: input.text,\n        turn: typeof input.turn === 'number' ? input.turn : typeof input.turn === 'string' ? input.turn.slice(0, 256) : undefined,\n        step: typeof input.step === 'number' ? input.step : typeof input.step === 'string' ? input.step.slice(0, 256) : undefined,\n        _order: old?._order ?? this._order++, _ascii: ASCII_TEXT.test(input.text),\n      };\n      this._docs.set(doc.id, doc);\n      this._chars += doc.text.length - (old?.text.length ?? 0);\n      this._dropFold(doc.id);\n      this._ordered = null;\n      if (old) updated++; else added++;\n    }\n    return { added, updated, rejected, evictedIds, ...this.stats() };\n  }\n\n  remove(ids) {\n    if (!Array.isArray(ids)) ids = [ids];\n    this._invalidate();\n    let removed = 0;\n    for (const id of ids) {\n      const doc = this._docs.get(id);\n      if (!doc) continue;\n      this._chars -= doc.text.length;\n      this._docs.delete(id);\n      this._dropFold(id);\n      removed++;\n    }\n    return { removed, ...this.stats() };\n  }\n\n  reset(docs = []) {\n    this.clear();\n    return this.upsert(docs);\n  }\n\n  clear() {\n    this._invalidate();\n    this._docs.clear();\n    this._folds.clear();\n    this._chars = 0;\n    this._foldChars = 0;\n    this._order = 0;\n    this._buffers = null;\n    return this.stats();\n  }\n\n  stats() {\n    return {\n      docs: this._docs.size, chars: this._chars, estimatedTextBytes: this._chars * 2,\n      maxTotalChars: this.options.maxTotalChars, maxDocs: this.options.maxDocs, maxMatches: this.options.maxMatches,\n      foldedChars: this._foldChars, foldCacheChars: this.options.foldCacheChars,\n      resultMatches: this._last?.total ?? 0, resultIndexBytes: this._buffers ? this._buffers.starts.byteLength * 3 : 0,\n      version: this._version,\n    };\n  }\n\n  cancel(reason = 'cancelled') {\n    if (this._job && !this._job.done) this._job.cancel(reason);\n    this._job = null;\n  }\n\n  createJob(query, options = {}) {\n    this.cancel('superseded');\n    this._last = null;\n    if (typeof query !== 'string') throw new FindError('INVALID_QUERY', 'Query must be a string.');\n    if (query.length > 16384) throw new FindError('QUERY_LIMIT', 'Query exceeds 16384 UTF-16 code units.');\n    const normalized = {\n      matchCase: options.matchCase === true, wholeWord: options.wholeWord === true,\n      regex: options.regex === true, includeReasoning: options.includeReasoning === true,\n      maxMatches: integer(options.maxMatches, this.options.maxMatches, 1, this.options.maxMatches),\n      contextChars: integer(options.contextChars, 80, 0, 512),\n      maxSnippetLength: integer(options.maxSnippetLength, 240, 32, 2048),\n      limit: integer(options.limit, 50, 1, 200),\n    };\n    let expression = null;\n    if (query) {\n      if (normalized.regex) {\n        try { expression = new RegExp(query, normalized.matchCase ? 'g' : 'gi'); }\n        catch (error) { throw new FindError('INVALID_REGEX', error.message); }\n      } else if (!normalized.matchCase && CASED_CHARACTER.test(query)) {\n        const pattern = escapeRegex(query);\n        try { expression = new RegExp(pattern, 'giu'); }\n        catch { expression = new RegExp(pattern, 'gi'); }\n      }\n    }\n    const job = new SearchJob(this, ++this._nextId, query, normalized, expression);\n    this._job = job;\n    return job;\n  }\n\n  async query(query, options = {}, control = {}) {\n    const job = this.createJob(query, options);\n    while (!job.done) {\n      if (control.signal?.aborted) job.cancel('cancelled');\n      job.next();\n      if (!job.done) await yieldTask();\n    }\n    if (job.cancelled) throw new FindError(job.reason === 'superseded' ? 'SUPERSEDED' : 'CANCELLED', job.reason);\n    return job.result();\n  }\n\n  searchSync(query, options = {}) {\n    const job = this.createJob(query, options);\n    while (!job.done) job.next(Infinity);\n    return job.result();\n  }\n\n  page(id, { offset = 0, limit = 50 } = {}) {\n    const record = this._last;\n    if (!record || record.id !== id) throw new FindError('STALE_RESULT', 'Search result is no longer available.');\n    offset = integer(offset, 0, 0, record.total);\n    limit = integer(limit, 50, 1, 200);\n    const items = [];\n    let lastDocIndex = -1;\n    let firstOrdinal = 0;\n    for (let ordinal = offset; ordinal < Math.min(record.total, offset + limit); ordinal++) {\n      const docIndex = record.docIndices[ordinal];\n      const doc = record.documents[docIndex];\n      if (docIndex !== lastDocIndex) {\n        let low = 0;\n        let high = ordinal;\n        while (low < high) {\n          const middle = (low + high) >>> 1;\n          if (record.docIndices[middle] < docIndex) low = middle + 1;\n          else high = middle;\n        }\n        firstOrdinal = low;\n        lastDocIndex = docIndex;\n      }\n      const start = record.starts[ordinal];\n      const length = record.lengths[ordinal];\n      items.push({\n        id: doc.id, docId: doc.id, seq: doc.seq, part: doc.part, role: doc.role, turn: doc.turn, step: doc.step,\n        offset: start, length, occurrence: ordinal - firstOrdinal, ordinal,\n        ...snippet(doc, start, length, record.options),\n      });\n    }\n    return {\n      id: record.id, query: record.query, total: record.total, truncated: record.truncated,\n      truncatedReason: record.truncated ? 'match-limit' : null, matchedDocs: record.matchedDocs,\n      offset, limit, hasMore: offset + items.length < record.total, items, elapsedMs: record.elapsedMs,\n      version: record.version, stats: record.stats,\n    };\n  }\n}\n\nclass SearchJob {\n  constructor(engine, id, query, options, expression) {\n    this.engine = engine;\n    this.id = id;\n    this.query = query;\n    this.options = options;\n    this.expression = expression;\n    this.documents = engine._orderedDocs().filter(doc => options.includeReasoning || doc.role !== 'reasoning');\n    this.totalChars = this.documents.reduce((sum, doc) => sum + doc.text.length, 0);\n    const capacity = query ? options.maxMatches : 0;\n    if (!engine._buffers || engine._buffers.starts.length < capacity) {\n      engine._buffers = { starts: new Uint32Array(capacity), lengths: new Uint32Array(capacity), docIndices: new Uint32Array(capacity) };\n    }\n    this.starts = engine._buffers.starts;\n    this.lengths = engine._buffers.lengths;\n    this.docIndices = engine._buffers.docIndices;\n    this.total = 0;\n    this.matchedDocs = 0;\n    this.docIndex = 0;\n    this.scannedChars = 0;\n    this.cursor = 0;\n    this.block = null;\n    this.started = now();\n    this.done = false;\n    this.cancelled = false;\n    this.reason = null;\n    this.truncated = false;\n    this._matchedCurrent = false;\n    this._record = null;\n    const cased = CASED_CHARACTER.test(query);\n    this.caseSensitiveScan = options.matchCase || !cased;\n    this.foldNeedle = !options.regex && !this.caseSensitiveScan && ASCII_TEXT.test(query) ? query.toLowerCase() : null;\n    this.overlap = Math.max(0, query.length - 1);\n    if (!query) this._finish();\n  }\n\n  cancel(reason) {\n    if (this.done) return;\n    this.reason = reason;\n    this.cancelled = true;\n    this.done = true;\n    this.documents = null;\n    this.starts = this.lengths = this.docIndices = null;\n    this.block = null;\n  }\n\n  progress() {\n    return {\n      docsSearched: this.docIndex, docsTotal: this.documents?.length ?? 0,\n      scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars, matches: this.total,\n    };\n  }\n\n  _advanceDoc() {\n    this.scannedChars += this.documents[this.docIndex].text.length;\n    this.docIndex++;\n    this.cursor = 0;\n    this.block = null;\n    this._matchedCurrent = false;\n    if (this.expression) this.expression.lastIndex = 0;\n  }\n\n  _accept(start, length, doc) {\n    if (this.options.wholeWord && !wholeWord(doc.text, start, length)) return;\n    if (this.total === this.options.maxMatches) {\n      this.truncated = true;\n      this._finish();\n      return;\n    }\n    this.starts[this.total] = start;\n    this.lengths[this.total] = length;\n    this.docIndices[this.total] = this.docIndex;\n    this.total++;\n    if (!this._matchedCurrent) {\n      this.matchedDocs++;\n      this._matchedCurrent = true;\n    }\n  }\n\n  next(budgetMs = this.engine.options.stepBudgetMs) {\n    if (this.done) return { done: true, cancelled: this.cancelled, progress: this.progress() };\n    const deadline = now() + budgetMs;\n    let iterations = 0;\n    do {\n      if (this.docIndex === this.documents.length) { this._finish(); break; }\n      iterations++;\n      const doc = this.documents[this.docIndex];\n      if (this.options.regex) this._stepExpression(doc);\n      else this._stepLiteral(doc);\n    } while (!this.done && ((iterations & 255) !== 0 && this.block !== null || now() < deadline));\n    return { done: this.done, cancelled: this.cancelled, progress: this.progress() };\n  }\n\n  _stepLiteral(doc) {\n    const folded = this.foldNeedle !== null && doc._ascii ? this.engine._fold(doc) : null;\n    const source = folded ?? doc.text;\n    if (!this.block) {\n      if (this.cursor >= source.length) { this._advanceDoc(); return; }\n      const end = Math.min(source.length, this.cursor + this.engine.options.blockChars);\n      this.block = { start: this.cursor, end, text: source.slice(this.cursor, Math.min(source.length, end + this.overlap)), cursor: 0, indexOf: folded !== null || this.caseSensitiveScan };\n    }\n    let found;\n    let length;\n    if (this.block.indexOf) {\n      const needle = folded !== null ? this.foldNeedle : this.query;\n      length = needle.length;\n      found = this.block.text.indexOf(needle, this.block.cursor);\n    } else {\n      this.expression.lastIndex = this.block.cursor;\n      const match = this.expression.exec(this.block.text);\n      found = match ? match.index : -1;\n      length = match ? match[0].length : 0;\n    }\n    if (found < 0 || this.block.start + found >= this.block.end) {\n      this.cursor = this.block.end;\n      this.block = null;\n      return;\n    }\n    const start = this.block.start + found;\n    this.cursor = start + length;\n    this.block.cursor = found + length;\n    this._accept(start, length, doc);\n    if (!this.done && this.cursor >= this.block.end) this.block = null;\n  }\n\n  _stepExpression(doc) {\n    this.expression.lastIndex = this.cursor;\n    const match = this.expression.exec(doc.text);\n    if (!match) { this._advanceDoc(); return; }\n    this.cursor = this.expression.lastIndex;\n    if (!match[0].length) this.cursor = match.index + 1;\n    this._accept(match.index, match[0].length, doc);\n    if (!this.done && this.cursor > doc.text.length) this._advanceDoc();\n  }\n\n  _finish() {\n    this.done = true;\n    this._record = {\n      id: this.id, query: this.query, options: this.options, documents: this.documents,\n      starts: this.starts, lengths: this.lengths, docIndices: this.docIndices,\n      total: this.total, truncated: this.truncated, matchedDocs: this.matchedDocs,\n      elapsedMs: now() - this.started, version: this.engine._version,\n      stats: { docsSearched: this.docIndex, docsTotal: this.documents.length, scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars },\n    };\n    this.block = null;\n    this.engine._last = this._record;\n    if (this.engine._job === this) this.engine._job = null;\n  }\n\n  result() {\n    return this.done && !this.cancelled ? this.engine.page(this.id, { limit: this.options.limit }) : null;\n  }\n}\n\nfunction createSearchEngine(options = {}) {\n  return new SearchEngine(options);\n}\n\n\nfunction createEngineServer(port = globalThis, options = {}) {\n  let engine = new SearchEngine(options);\n  let active = null;\n  let timer = null;\n  let disposed = false;\n  let lastProgress = 0;\n  const post = message => { if (!disposed) port.postMessage(message); };\n  const fail = (requestId, error) => post({ type: 'error', requestId, error: { code: error.code || 'ENGINE_ERROR', message: error.message || String(error) } });\n\n  function cancel(reason = 'cancelled') {\n    if (timer !== null) clearTimeout(timer);\n    timer = null;\n    if (active) {\n      active.job.cancel(reason);\n      post({ type: 'cancelled', requestId: active.requestId, reason });\n      active = null;\n    }\n    engine.cancel(reason);\n  }\n\n  function step() {\n    timer = null;\n    const current = active;\n    if (!current || disposed) return;\n    try {\n      const state = current.job.next();\n      if (current !== active) return;\n      if (state.done) {\n        active = null;\n        if (state.cancelled) post({ type: 'cancelled', requestId: current.requestId, reason: current.job.reason });\n        else post({ type: 'result', requestId: current.requestId, result: current.job.result() });\n      } else {\n        const time = globalThis.performance?.now() ?? Date.now();\n        if (time - lastProgress >= 50) {\n          post({ type: 'progress', requestId: current.requestId, progress: state.progress });\n          lastProgress = time;\n        }\n        timer = setTimeout(step, 0);\n      }\n    } catch (error) {\n      if (current === active) active = null;\n      engine.cancel('error');\n      fail(current.requestId, error);\n    }\n  }\n\n  function receive(data) {\n    if (disposed || !data || typeof data.type !== 'string') return;\n    const { requestId } = data;\n    try {\n      switch (data.type) {\n        case 'reset':\n          cancel('mutation');\n          if (data.options) engine = new SearchEngine(data.options);\n          post({ type: 'ack', requestId, ...engine.reset(data.docs || []) });\n          break;\n        case 'upsert':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.upsert(data.docs || []) });\n          break;\n        case 'remove':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.remove(data.ids || []) });\n          break;\n        case 'clear':\n          cancel('mutation');\n          post({ type: 'ack', requestId, ...engine.clear() });\n          break;\n        case 'query':\n          cancel('superseded');\n          active = { requestId, job: engine.createJob(data.query, data.options || {}) };\n          lastProgress = 0;\n          timer = setTimeout(step, 0);\n          break;\n        case 'page':\n          post({ type: 'page', requestId, result: engine.page(data.id, { offset: data.offset, limit: data.limit }) });\n          break;\n        case 'cancel':\n          cancel('cancelled');\n          if (requestId !== undefined) post({ type: 'ack', requestId });\n          break;\n        case 'stats':\n          post({ type: 'ack', requestId, ...engine.stats() });\n          break;\n        case 'ping':\n          post({ type: 'pong', requestId });\n          break;\n        case 'dispose':\n          cancel('disposed');\n          engine.clear();\n          post({ type: 'ack', requestId });\n          dispose();\n          break;\n        default:\n          fail(requestId, { code: 'UNKNOWN_MESSAGE', message: 'Unknown search worker message.' });\n      }\n    } catch (error) { fail(requestId, error); }\n  }\n\n  const listener = event => receive(event.data);\n  if (typeof port.addEventListener === 'function') {\n    port.addEventListener('message', listener);\n    port.start?.();\n  } else if (typeof port.on === 'function') {\n    port.on('message', receive);\n  } else {\n    port.onmessage = listener;\n  }\n\n  function dispose() {\n    if (disposed) return;\n    cancel('disposed');\n    engine.clear();\n    disposed = true;\n    if (typeof port.removeEventListener === 'function') port.removeEventListener('message', listener);\n    else if (typeof port.off === 'function') port.off('message', receive);\n    else if (port.onmessage === listener) port.onmessage = null;\n  }\n\n  post({ type: 'ready', capabilities: { paging: true, cancellation: 'cooperative', regexWatchdog: 'client', offsets: 'utf16' }, ...engine.stats() });\n  return { receive, dispose, get engine() { return engine; } };\n}\n\nif (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) createEngineServer(globalThis);\n",css:".dsh-find-scopes{display:flex;gap:4px;margin-bottom:10px}.dsh-find-scopes button{flex:1;border:1px solid transparent;border-radius:6px;background:transparent;padding:7px 5px}.dsh-find-scopes button[aria-pressed=true]{border-color:#68aaff;background:var(--dsw-alias-interactive-bg-hover,#303030)}.dsh-find-archives{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#aaa)}.dsh-find-session{display:block;font-size:12px;font-weight:600;margin-bottom:5px;overflow-wrap:anywhere}.dsh-find-session small{display:block;font-weight:400;opacity:.65;margin-top:3px}.dsh-find-cancel{margin:0 14px 8px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:5px;background:transparent;padding:5px}.dsh-find-status{flex-wrap:wrap}.dsh-find-open{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a3a3a3);cursor:pointer}.dsh-find-open:hover{background:var(--dsw-alias-interactive-bg-hover,#282828);color:var(--dsw-alias-label-primary,#eee)}.dsh-find{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#eee);font:14px var(--dsw-font,sans-serif);background:var(--dsw-alias-bg-base,#141414)}.dsh-find *{box-sizing:border-box}.dsh-find-toolbar{padding:16px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#333)}.dsh-find-input{width:100%;height:38px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-layer-2,#242424);color:inherit;font:inherit;outline:none}.dsh-find-input:focus{border-color:#68aaff;box-shadow:0 0 0 1px #68aaff}.dsh-find-options{display:flex;gap:6px;margin-top:10px}.dsh-find button{font:inherit;color:inherit;cursor:pointer}.dsh-find button:disabled{opacity:.4;cursor:default}.dsh-find-toggle{border:1px solid transparent;border-radius:5px;padding:4px 8px;background:transparent;min-width:34px}.dsh-find-toggle:hover,.dsh-find-navigation button:hover,.dsh-find-paging button:hover{background:var(--dsw-alias-interactive-bg-hover,#303030)}.dsh-find-toggle[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#303030);border-color:#68aaff;color:#91baff}.dsh-find-navigation{display:flex;align-items:center;gap:6px;margin-top:8px;min-height:30px}.dsh-find-count{flex:1;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dsh-find-navigation button{border:0;border-radius:5px;background:transparent;width:30px;height:28px}.dsh-find-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);padding:10px 14px}.dsh-find-reload{margin-left:auto;border:0;background:none;color:#91baff!important;font-size:11px!important}.dsh-find-results{flex:1;min-height:0;overflow:auto;padding:0 6px 10px}.dsh-find-result{width:100%;display:block;text-align:left;border:1px solid transparent;border-radius:8px;background:none;padding:10px 8px;margin-bottom:4px;overflow-wrap:anywhere}.dsh-find-result:hover{background:var(--dsw-alias-interactive-bg-hover,#282828)}.dsh-find-result[data-active=true]{border-color:#68aaff;background:var(--dsw-alias-interactive-bg-hover,#282828)}.dsh-find-meta{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:6px}.dsh-find-snippet{display:block;white-space:pre-wrap;font-family:var(--dsw-font-mono,monospace);font-size:12px;line-height:1.65}.dsh-find mark{color:inherit;background:#986b2566;border-radius:2px}.dsh-find-paging{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-top:1px solid var(--dsw-alias-border-l2,#333);font-size:11px}.dsh-find-paging button{border:0;background:none;border-radius:5px;padding:5px;font-size:11px}.dsh-find-footer{padding:10px 14px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888);border-top:1px solid var(--dsw-alias-border-l2,#333)}.dsh-find-error{margin:0 14px 10px;padding:10px;border-radius:6px;color:#ffaaaa;background:#84232340;font-size:12px;line-height:1.6}.dsh-find-note{padding:4px 14px 10px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px;line-height:1.6}.dsh-find-empty{padding:32px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:1.8}::highlight(dsh-session-find){background:#ffbd4580;color:inherit}\n",dictionaries:{"zh":{"meta":{"title":"会话查找","description":"查找当前会话或工作区中可访问的普通会话文字，支持后台搜索、结果分页和安全定位。"},"title":"会话查找","open":"打开会话查找","openTitle":"查找 · Ctrl+F / Cmd+F · 也可通过命令面板打开或自定义快捷键","searchScope":"查找范围","currentScope":"当前会话","allScope":"所有会话","placeholder":"查找当前会话…","globalPlaceholder":"查找所有工作区的会话…","includeArchived":"包括归档会话","archived":"已归档","matchCase":"区分大小写","wholeWord":"全字匹配","regex":"使用正则表达式","includeReasoning":"包括思考文字","reasoning":"思考","user":"你","assistant":"助手","previous":"上一个命中 · Shift+Enter","next":"下一个命中 · Enter","previousPage":"上一页","nextPage":"下一页","pages":"结果分页","indexing":"正在核对并读取历史 · {count} 个文本块","ready":"历史覆盖已核对 · {count} 个文本块","partial":"仅部分历史 · 请查看原因","waiting":"等待会话历史","globalIndexing":"正在扫描会话 · 已完成 {count} / {total}","globalReady":"扫描已完成 · {count} / {total} 个会话","globalPartial":"扫描未完成 · 已完成 {count} / {total} 个会话","globalWaiting":"输入查询后开始扫描所有会话","searching":"查找中…","hint":"Enter 下一个 · Shift+Enter 上一个","refresh":"重新读取","cancel":"取消扫描","incompleteReason":"未完成原因","noMatches":"已读取范围内没有匹配文字","instructions":"选择当前会话或所有会话，再输入文字或代码片段。归档会话需勾选后检索。","locating":"正在核对来源并定位历史消息…","handoffTimeout":"目标会话未及时打开，尚未定位；请打开该会话后重试。","capped":"命中超过 100,000 处，仅保留前 100,000 处，请缩小查询。","globalCapped":"跨会话结果已达到 5,000 处上限，扫描已停止；请缩小查询。","scope":"搜索已完成的用户输入与助手文字；思考可选。回复完成后纳入。工具、附件和注入上下文不在范围内；仅在来源与显示文字核对一致时精确高亮。","globalScope":"扫描当前授权可访问的所有工作区普通会话；归档需勾选，归档命中仅供查看。每次最多保留 5,000 处结果；未完成原因会保留，扫描完成不代表所有会话同一时刻的快照。","unavailable":"当前没有可查找的会话"},"en":{"meta":{"title":"Conversation search","description":"Find text in the current conversation or accessible workspace conversations, with background matching, paged results and verified navigation."},"title":"Conversation search","open":"Open conversation search","openTitle":"Find · Ctrl+F / Cmd+F · Also available in the command palette or with a custom shortcut","searchScope":"Search scope","currentScope":"Current conversation","allScope":"All conversations","placeholder":"Find in this conversation…","globalPlaceholder":"Find across workspace conversations…","includeArchived":"Include archived conversations","archived":"Archived","matchCase":"Match case","wholeWord":"Whole word","regex":"Regular expression","includeReasoning":"Include reasoning","reasoning":"Reasoning","user":"You","assistant":"Assistant","previous":"Previous match · Shift+Enter","next":"Next match · Enter","previousPage":"Previous page","nextPage":"Next page","pages":"Result pages","indexing":"Verifying and reading history · {count} text blocks","ready":"History coverage verified · {count} text blocks","partial":"Partial history · see the reason","waiting":"Waiting for conversation history","globalIndexing":"Scanning conversations · {count} / {total} complete","globalReady":"Scan complete · {count} / {total} conversations","globalPartial":"Scan incomplete · {count} / {total} conversations complete","globalWaiting":"Enter a query to scan all conversations","searching":"Searching…","hint":"Enter next · Shift+Enter previous","refresh":"Reload","cancel":"Cancel scan","incompleteReason":"Incomplete reason","noMatches":"No matches in the history read so far","instructions":"Choose the current conversation or all conversations, then enter words or code. Archived conversations require the archive option.","locating":"Verifying the source and locating the historical message…","handoffTimeout":"The target conversation did not open in time. No navigation was performed; open it and try again.","capped":"More than 100,000 matches. Only the first 100,000 are retained; refine the query.","globalCapped":"The cross-conversation result limit of 5,000 was reached. Scanning stopped; refine the query.","scope":"Searches committed user input and assistant text; reasoning is optional. Replies join when committed. Tools, attachments and injected context are excluded. Exact highlighting requires verified source and displayed text.","globalScope":"Scans accessible ordinary conversations across all workspaces. Archives are opt-in and archived matches are view-only. At most 5,000 matches are retained per scan. Incomplete reasons remain visible; completion is not a single-time snapshot of all conversations.","unavailable":"No conversation is available to search"}}});
}});
