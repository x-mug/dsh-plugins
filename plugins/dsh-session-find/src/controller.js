import { clearFindHighlight } from './navigation.js';

export class SessionFindController {
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
