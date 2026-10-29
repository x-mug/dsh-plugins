import { extractSearchDocuments } from './source.js';

export const DEFAULT_GLOBAL_BUDGETS = Object.freeze({
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

export function createGlobalSource(options) {
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
