const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const ASCII_TEXT = /^[\x00-\x7f]*$/;
const CASED_CHARACTER = /\p{Cased}/u;
const now = () => globalThis.performance?.now() ?? Date.now();
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

export class FindError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FindError';
    this.code = code;
  }
}

function integer(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBefore(text, offset) {
  if (!offset) return false;
  const last = text.charCodeAt(offset - 1);
  const previous = offset > 1 ? text.charCodeAt(offset - 2) : 0;
  const start = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 2 : offset - 1;
  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(start)));
}

function wholeWord(text, offset, length) {
  return !wordBefore(text, offset) &&
    (offset + length >= text.length || !WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(offset + length))));
}

function snippet(doc, offset, length, options) {
  const max = options.maxSnippetLength;
  let start = Math.max(0, offset - Math.min(options.contextChars, Math.floor(max / 3)));
  if (start > 0 && doc.text.charCodeAt(start) >= 0xdc00 && doc.text.charCodeAt(start) <= 0xdfff && doc.text.charCodeAt(start - 1) >= 0xd800 && doc.text.charCodeAt(start - 1) <= 0xdbff) start--;
  let end = Math.min(doc.text.length, Math.max(offset + Math.min(length, max), offset + options.contextChars), start + max);
  if (end < doc.text.length && doc.text.charCodeAt(end - 1) >= 0xd800 && doc.text.charCodeAt(end - 1) <= 0xdbff && doc.text.charCodeAt(end) >= 0xdc00 && doc.text.charCodeAt(end) <= 0xdfff) end = end + 1 - start <= max ? end + 1 : end - 1;
  const matchStart = Math.max(0, offset - start);
  const matchEnd = Math.max(matchStart, Math.min(end - start, offset + length - start));
  return {
    snippet: doc.text.slice(start, end), snippetOffset: start, matchStart, matchEnd,
    matchedText: doc.text.slice(offset, Math.min(offset + length, end)),
    matchTruncated: offset + length > end, clippedBefore: start > 0, clippedAfter: end < doc.text.length,
  };
}

export class SearchEngine {
  constructor(options = {}) {
    this.options = {
      maxTotalChars: integer(options.maxTotalChars, 64 * 1024 * 1024, 1, 1024 * 1024 * 1024),
      maxDocs: integer(options.maxDocs, 100000, 1, 1000000),
      maxMatches: integer(options.maxMatches, 100000, 1, 1000000),
      blockChars: integer(options.blockChars, 256 * 1024, 1024, 4 * 1024 * 1024),
      foldCacheChars: integer(options.foldCacheChars, 16 * 1024 * 1024, 0, 256 * 1024 * 1024),
      stepBudgetMs: integer(options.stepBudgetMs, 8, 1, 50),
      overflowPolicy: options.overflowPolicy === 'evict' ? 'evict' : 'reject',
    };
    this._docs = new Map();
    this._chars = 0;
    this._order = 0;
    this._version = 0;
    this._nextId = 0;
    this._ordered = null;
    this._folds = new Map();
    this._foldChars = 0;
    this._job = null;
    this._last = null;
    this._buffers = null;
  }

  _invalidate() {
    this.cancel('mutation');
    this._last = null;
    this._ordered = null;
    this._version++;
  }

  _dropFold(id) {
    const cached = this._folds.get(id);
    if (cached !== undefined) {
      this._foldChars -= cached.length;
      this._folds.delete(id);
    }
  }

  _orderedDocs() {
    if (!this._ordered) this._ordered = [...this._docs.values()].sort((a, b) => a.seq - b.seq || a.part - b.part || a._order - b._order);
    return this._ordered;
  }

  _fold(doc) {
    let text = this._folds.get(doc.id);
    if (text !== undefined) return text;
    if (!doc._ascii || doc.text.length > this.options.foldCacheChars || doc.text.length > this.options.blockChars) return null;
    if (this._foldChars + doc.text.length > this.options.foldCacheChars) return null;
    text = doc.text.toLowerCase();
    this._folds.set(doc.id, text);
    this._foldChars += text.length;
    return text;
  }

  upsert(documents) {
    if (!Array.isArray(documents)) documents = [documents];
    if (documents.length > this.options.maxDocs) throw new FindError('BATCH_LIMIT', 'Document batch exceeds maxDocs.');
    this._invalidate();
    let added = 0;
    let updated = 0;
    const rejected = [];
    const evictedIds = [];
    for (const input of documents) {
      if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 1024 || typeof input.text !== 'string' ||
          !Number.isFinite(input.seq) || !['user', 'assistant', 'reasoning'].includes(input.role)) {
        rejected.push({ id: typeof input?.id === 'string' ? input.id.slice(0, 1024) : null, code: 'INVALID_DOCUMENT' });
        continue;
      }
      const old = this._docs.get(input.id);
      const nextChars = this._chars - (old?.text.length ?? 0) + input.text.length;
      const nextDocs = this._docs.size + (old ? 0 : 1);
      if (input.text.length > this.options.maxTotalChars ||
          (this.options.overflowPolicy === 'reject' && (nextChars > this.options.maxTotalChars || nextDocs > this.options.maxDocs))) {
        rejected.push({ id: input.id, code: input.text.length > this.options.maxTotalChars || nextChars > this.options.maxTotalChars ? 'TEXT_LIMIT' : 'DOCUMENT_LIMIT' });
        continue;
      }
      if (this.options.overflowPolicy === 'evict') {
        while (this._chars - (old?.text.length ?? 0) + input.text.length > this.options.maxTotalChars || this._docs.size + (old ? 0 : 1) > this.options.maxDocs) {
          const candidate = this._orderedDocs().find(doc => doc.id !== input.id);
          if (!candidate) break;
          this._docs.delete(candidate.id);
          this._chars -= candidate.text.length;
          this._dropFold(candidate.id);
          this._ordered = null;
          evictedIds.push(candidate.id);
        }
      }
      const doc = {
        id: input.id, seq: input.seq, part: integer(input.part, 0, 0, Number.MAX_SAFE_INTEGER), role: input.role, text: input.text,
        turn: typeof input.turn === 'number' ? input.turn : typeof input.turn === 'string' ? input.turn.slice(0, 256) : undefined,
        step: typeof input.step === 'number' ? input.step : typeof input.step === 'string' ? input.step.slice(0, 256) : undefined,
        _order: old?._order ?? this._order++, _ascii: ASCII_TEXT.test(input.text),
      };
      this._docs.set(doc.id, doc);
      this._chars += doc.text.length - (old?.text.length ?? 0);
      this._dropFold(doc.id);
      this._ordered = null;
      if (old) updated++; else added++;
    }
    return { added, updated, rejected, evictedIds, ...this.stats() };
  }

  remove(ids) {
    if (!Array.isArray(ids)) ids = [ids];
    this._invalidate();
    let removed = 0;
    for (const id of ids) {
      const doc = this._docs.get(id);
      if (!doc) continue;
      this._chars -= doc.text.length;
      this._docs.delete(id);
      this._dropFold(id);
      removed++;
    }
    return { removed, ...this.stats() };
  }

  reset(docs = []) {
    this.clear();
    return this.upsert(docs);
  }

  clear() {
    this._invalidate();
    this._docs.clear();
    this._folds.clear();
    this._chars = 0;
    this._foldChars = 0;
    this._order = 0;
    this._buffers = null;
    return this.stats();
  }

  stats() {
    return {
      docs: this._docs.size, chars: this._chars, estimatedTextBytes: this._chars * 2,
      maxTotalChars: this.options.maxTotalChars, maxDocs: this.options.maxDocs, maxMatches: this.options.maxMatches,
      foldedChars: this._foldChars, foldCacheChars: this.options.foldCacheChars,
      resultMatches: this._last?.total ?? 0, resultIndexBytes: this._buffers ? this._buffers.starts.byteLength * 3 : 0,
      version: this._version,
    };
  }

  cancel(reason = 'cancelled') {
    if (this._job && !this._job.done) this._job.cancel(reason);
    this._job = null;
  }

  createJob(query, options = {}) {
    this.cancel('superseded');
    this._last = null;
    if (typeof query !== 'string') throw new FindError('INVALID_QUERY', 'Query must be a string.');
    if (query.length > 16384) throw new FindError('QUERY_LIMIT', 'Query exceeds 16384 UTF-16 code units.');
    const normalized = {
      matchCase: options.matchCase === true, wholeWord: options.wholeWord === true,
      regex: options.regex === true, includeReasoning: options.includeReasoning === true,
      maxMatches: integer(options.maxMatches, this.options.maxMatches, 1, this.options.maxMatches),
      contextChars: integer(options.contextChars, 80, 0, 512),
      maxSnippetLength: integer(options.maxSnippetLength, 240, 32, 2048),
      limit: integer(options.limit, 50, 1, 200),
    };
    let expression = null;
    if (query) {
      if (normalized.regex) {
        try { expression = new RegExp(query, normalized.matchCase ? 'g' : 'gi'); }
        catch (error) { throw new FindError('INVALID_REGEX', error.message); }
      } else if (!normalized.matchCase && CASED_CHARACTER.test(query)) {
        const pattern = escapeRegex(query);
        try { expression = new RegExp(pattern, 'giu'); }
        catch { expression = new RegExp(pattern, 'gi'); }
      }
    }
    const job = new SearchJob(this, ++this._nextId, query, normalized, expression);
    this._job = job;
    return job;
  }

  async query(query, options = {}, control = {}) {
    const job = this.createJob(query, options);
    while (!job.done) {
      if (control.signal?.aborted) job.cancel('cancelled');
      job.next();
      if (!job.done) await yieldTask();
    }
    if (job.cancelled) throw new FindError(job.reason === 'superseded' ? 'SUPERSEDED' : 'CANCELLED', job.reason);
    return job.result();
  }

  searchSync(query, options = {}) {
    const job = this.createJob(query, options);
    while (!job.done) job.next(Infinity);
    return job.result();
  }

  page(id, { offset = 0, limit = 50 } = {}) {
    const record = this._last;
    if (!record || record.id !== id) throw new FindError('STALE_RESULT', 'Search result is no longer available.');
    offset = integer(offset, 0, 0, record.total);
    limit = integer(limit, 50, 1, 200);
    const items = [];
    let lastDocIndex = -1;
    let firstOrdinal = 0;
    for (let ordinal = offset; ordinal < Math.min(record.total, offset + limit); ordinal++) {
      const docIndex = record.docIndices[ordinal];
      const doc = record.documents[docIndex];
      if (docIndex !== lastDocIndex) {
        let low = 0;
        let high = ordinal;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (record.docIndices[middle] < docIndex) low = middle + 1;
          else high = middle;
        }
        firstOrdinal = low;
        lastDocIndex = docIndex;
      }
      const start = record.starts[ordinal];
      const length = record.lengths[ordinal];
      items.push({
        id: doc.id, docId: doc.id, seq: doc.seq, part: doc.part, role: doc.role, turn: doc.turn, step: doc.step,
        offset: start, length, occurrence: ordinal - firstOrdinal, ordinal,
        ...snippet(doc, start, length, record.options),
      });
    }
    return {
      id: record.id, query: record.query, total: record.total, truncated: record.truncated,
      truncatedReason: record.truncated ? 'match-limit' : null, matchedDocs: record.matchedDocs,
      offset, limit, hasMore: offset + items.length < record.total, items, elapsedMs: record.elapsedMs,
      version: record.version, stats: record.stats,
    };
  }
}

class SearchJob {
  constructor(engine, id, query, options, expression) {
    this.engine = engine;
    this.id = id;
    this.query = query;
    this.options = options;
    this.expression = expression;
    this.documents = engine._orderedDocs().filter(doc => options.includeReasoning || doc.role !== 'reasoning');
    this.totalChars = this.documents.reduce((sum, doc) => sum + doc.text.length, 0);
    const capacity = query ? options.maxMatches : 0;
    if (!engine._buffers || engine._buffers.starts.length < capacity) {
      engine._buffers = { starts: new Uint32Array(capacity), lengths: new Uint32Array(capacity), docIndices: new Uint32Array(capacity) };
    }
    this.starts = engine._buffers.starts;
    this.lengths = engine._buffers.lengths;
    this.docIndices = engine._buffers.docIndices;
    this.total = 0;
    this.matchedDocs = 0;
    this.docIndex = 0;
    this.scannedChars = 0;
    this.cursor = 0;
    this.block = null;
    this.started = now();
    this.done = false;
    this.cancelled = false;
    this.reason = null;
    this.truncated = false;
    this._matchedCurrent = false;
    this._record = null;
    const cased = CASED_CHARACTER.test(query);
    this.caseSensitiveScan = options.matchCase || !cased;
    this.foldNeedle = !options.regex && !this.caseSensitiveScan && ASCII_TEXT.test(query) ? query.toLowerCase() : null;
    this.overlap = Math.max(0, query.length - 1);
    if (!query) this._finish();
  }

  cancel(reason) {
    if (this.done) return;
    this.reason = reason;
    this.cancelled = true;
    this.done = true;
    this.documents = null;
    this.starts = this.lengths = this.docIndices = null;
    this.block = null;
  }

  progress() {
    return {
      docsSearched: this.docIndex, docsTotal: this.documents?.length ?? 0,
      scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars, matches: this.total,
    };
  }

  _advanceDoc() {
    this.scannedChars += this.documents[this.docIndex].text.length;
    this.docIndex++;
    this.cursor = 0;
    this.block = null;
    this._matchedCurrent = false;
    if (this.expression) this.expression.lastIndex = 0;
  }

  _accept(start, length, doc) {
    if (this.options.wholeWord && !wholeWord(doc.text, start, length)) return;
    if (this.total === this.options.maxMatches) {
      this.truncated = true;
      this._finish();
      return;
    }
    this.starts[this.total] = start;
    this.lengths[this.total] = length;
    this.docIndices[this.total] = this.docIndex;
    this.total++;
    if (!this._matchedCurrent) {
      this.matchedDocs++;
      this._matchedCurrent = true;
    }
  }

  next(budgetMs = this.engine.options.stepBudgetMs) {
    if (this.done) return { done: true, cancelled: this.cancelled, progress: this.progress() };
    const deadline = now() + budgetMs;
    let iterations = 0;
    do {
      if (this.docIndex === this.documents.length) { this._finish(); break; }
      iterations++;
      const doc = this.documents[this.docIndex];
      if (this.options.regex) this._stepExpression(doc);
      else this._stepLiteral(doc);
    } while (!this.done && ((iterations & 255) !== 0 && this.block !== null || now() < deadline));
    return { done: this.done, cancelled: this.cancelled, progress: this.progress() };
  }

  _stepLiteral(doc) {
    const folded = this.foldNeedle !== null && doc._ascii ? this.engine._fold(doc) : null;
    const source = folded ?? doc.text;
    if (!this.block) {
      if (this.cursor >= source.length) { this._advanceDoc(); return; }
      const end = Math.min(source.length, this.cursor + this.engine.options.blockChars);
      this.block = { start: this.cursor, end, text: source.slice(this.cursor, Math.min(source.length, end + this.overlap)), cursor: 0, indexOf: folded !== null || this.caseSensitiveScan };
    }
    let found;
    let length;
    if (this.block.indexOf) {
      const needle = folded !== null ? this.foldNeedle : this.query;
      length = needle.length;
      found = this.block.text.indexOf(needle, this.block.cursor);
    } else {
      this.expression.lastIndex = this.block.cursor;
      const match = this.expression.exec(this.block.text);
      found = match ? match.index : -1;
      length = match ? match[0].length : 0;
    }
    if (found < 0 || this.block.start + found >= this.block.end) {
      this.cursor = this.block.end;
      this.block = null;
      return;
    }
    const start = this.block.start + found;
    this.cursor = start + length;
    this.block.cursor = found + length;
    this._accept(start, length, doc);
    if (!this.done && this.cursor >= this.block.end) this.block = null;
  }

  _stepExpression(doc) {
    this.expression.lastIndex = this.cursor;
    const match = this.expression.exec(doc.text);
    if (!match) { this._advanceDoc(); return; }
    this.cursor = this.expression.lastIndex;
    if (!match[0].length) this.cursor = match.index + 1;
    this._accept(match.index, match[0].length, doc);
    if (!this.done && this.cursor > doc.text.length) this._advanceDoc();
  }

  _finish() {
    this.done = true;
    this._record = {
      id: this.id, query: this.query, options: this.options, documents: this.documents,
      starts: this.starts, lengths: this.lengths, docIndices: this.docIndices,
      total: this.total, truncated: this.truncated, matchedDocs: this.matchedDocs,
      elapsedMs: now() - this.started, version: this.engine._version,
      stats: { docsSearched: this.docIndex, docsTotal: this.documents.length, scannedChars: Math.min(this.totalChars, this.scannedChars + this.cursor), totalChars: this.totalChars },
    };
    this.block = null;
    this.engine._last = this._record;
    if (this.engine._job === this) this.engine._job = null;
  }

  result() {
    return this.done && !this.cancelled ? this.engine.page(this.id, { limit: this.options.limit }) : null;
  }
}

export function createSearchEngine(options = {}) {
  return new SearchEngine(options);
}
