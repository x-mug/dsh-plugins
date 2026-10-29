export class SearchWorkerBridge {
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
