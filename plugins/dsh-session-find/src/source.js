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
