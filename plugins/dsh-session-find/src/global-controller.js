import { createGlobalSource } from './global-source.js';
import { SearchWorkerBridge } from './bridge.js';

export class GlobalFindController {
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
