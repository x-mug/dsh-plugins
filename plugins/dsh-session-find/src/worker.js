import { SearchEngine } from './engine.js';

export function createEngineServer(port = globalThis, options = {}) {
  let engine = new SearchEngine(options);
  let active = null;
  let timer = null;
  let disposed = false;
  let lastProgress = 0;
  const post = message => { if (!disposed) port.postMessage(message); };
  const fail = (requestId, error) => post({ type: 'error', requestId, error: { code: error.code || 'ENGINE_ERROR', message: error.message || String(error) } });

  function cancel(reason = 'cancelled') {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active) {
      active.job.cancel(reason);
      post({ type: 'cancelled', requestId: active.requestId, reason });
      active = null;
    }
    engine.cancel(reason);
  }

  function step() {
    timer = null;
    const current = active;
    if (!current || disposed) return;
    try {
      const state = current.job.next();
      if (current !== active) return;
      if (state.done) {
        active = null;
        if (state.cancelled) post({ type: 'cancelled', requestId: current.requestId, reason: current.job.reason });
        else post({ type: 'result', requestId: current.requestId, result: current.job.result() });
      } else {
        const time = globalThis.performance?.now() ?? Date.now();
        if (time - lastProgress >= 50) {
          post({ type: 'progress', requestId: current.requestId, progress: state.progress });
          lastProgress = time;
        }
        timer = setTimeout(step, 0);
      }
    } catch (error) {
      if (current === active) active = null;
      engine.cancel('error');
      fail(current.requestId, error);
    }
  }

  function receive(data) {
    if (disposed || !data || typeof data.type !== 'string') return;
    const { requestId } = data;
    try {
      switch (data.type) {
        case 'reset':
          cancel('mutation');
          if (data.options) engine = new SearchEngine(data.options);
          post({ type: 'ack', requestId, ...engine.reset(data.docs || []) });
          break;
        case 'upsert':
          cancel('mutation');
          post({ type: 'ack', requestId, ...engine.upsert(data.docs || []) });
          break;
        case 'remove':
          cancel('mutation');
          post({ type: 'ack', requestId, ...engine.remove(data.ids || []) });
          break;
        case 'clear':
          cancel('mutation');
          post({ type: 'ack', requestId, ...engine.clear() });
          break;
        case 'query':
          cancel('superseded');
          active = { requestId, job: engine.createJob(data.query, data.options || {}) };
          lastProgress = 0;
          timer = setTimeout(step, 0);
          break;
        case 'page':
          post({ type: 'page', requestId, result: engine.page(data.id, { offset: data.offset, limit: data.limit }) });
          break;
        case 'cancel':
          cancel('cancelled');
          if (requestId !== undefined) post({ type: 'ack', requestId });
          break;
        case 'stats':
          post({ type: 'ack', requestId, ...engine.stats() });
          break;
        case 'ping':
          post({ type: 'pong', requestId });
          break;
        case 'dispose':
          cancel('disposed');
          engine.clear();
          post({ type: 'ack', requestId });
          dispose();
          break;
        default:
          fail(requestId, { code: 'UNKNOWN_MESSAGE', message: 'Unknown search worker message.' });
      }
    } catch (error) { fail(requestId, error); }
  }

  const listener = event => receive(event.data);
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', listener);
    port.start?.();
  } else if (typeof port.on === 'function') {
    port.on('message', receive);
  } else {
    port.onmessage = listener;
  }

  function dispose() {
    if (disposed) return;
    cancel('disposed');
    engine.clear();
    disposed = true;
    if (typeof port.removeEventListener === 'function') port.removeEventListener('message', listener);
    else if (typeof port.off === 'function') port.off('message', receive);
    else if (port.onmessage === listener) port.onmessage = null;
  }

  post({ type: 'ready', capabilities: { paging: true, cancellation: 'cooperative', regexWatchdog: 'client', offsets: 'utf16' }, ...engine.stats() });
  return { receive, dispose, get engine() { return engine; } };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) createEngineServer(globalThis);
