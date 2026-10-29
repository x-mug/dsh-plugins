export const DEFAULT_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_SOURCE_MAX_DOCS = 100000;
export const DEFAULT_SOURCE_PAGE_SIZE = 500;

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

export function extractSearchDocuments(entry) {
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

export function createSessionSource(options) {
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
