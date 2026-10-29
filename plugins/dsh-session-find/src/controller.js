import { clearFindHighlight } from './navigation.js';

const OPTIONS = ['matchCase', 'wholeWord', 'regex', 'includeReasoning'];
const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const sameSource = (hit, source) => ['seq', 'part', 'role', 'offset', 'length'].every((key) => hit[key] === source[key]);

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
