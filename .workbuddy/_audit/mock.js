// 浏览器版 R2 / KV mock —— 驱动真实 worker.js（由 mock.mjs 移植，去掉 node:crypto）
(function () {
  function fnv1a(u8) {
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  function bodyToU8(val) {
    if (val == null) return new Uint8Array(0);
    if (val instanceof Uint8Array) return val;
    if (val instanceof ArrayBuffer) return new Uint8Array(val);
    if (ArrayBuffer.isView(val)) return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
    if (typeof val === 'string') return new TextEncoder().encode(val);
    if (typeof val.getReader === 'function') return val;
    throw new Error('unsupported body: ' + Object.prototype.toString.call(val));
  }
  async function readStream(s) {
    const chunks = []; const rd = s.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value)); }
    let len = 0; for (const c of chunks) len += c.length;
    const out = new Uint8Array(len); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  class MockR2 {
    constructor() { this.map = new Map(); this.uploads = new Map(); this.strictPrefix = false; this.ops = { get: 0, put: 0, head: 0, del: 0, list: 0 }; this.mpSeq = 1; }
    async _buf(val) { if (val && typeof val.getReader === 'function') return readStream(val); return bodyToU8(val); }
    async put(key, val, opt) {
      this.ops.put++;
      const onlyIf = opt && opt.onlyIf;
      if (onlyIf && typeof onlyIf.etag === 'string') { const cur = this.map.get(key); const ce = cur ? cur.etag : null; if (ce !== onlyIf.etag) return { key, etag: undefined, preconditionFailed: true }; }
      if (onlyIf && onlyIf.etagDoesNotMatch === '*' && this.map.has(key)) return { key, etag: undefined, preconditionFailed: true };
      const buf = await this._buf(val);
      const etag = '"' + fnv1a(buf) + '"';
      this.map.set(key, { body: buf, uploaded: new Date(), etag, httpMetadata: (opt && opt.httpMetadata) || {}, customMetadata: (opt && opt.customMetadata) || {} });
      return { key, etag };
    }
    _wrap(key, rec) {
      return {
        key, size: rec.body.length, uploaded: rec.uploaded, etag: rec.etag, httpEtag: rec.etag,
        httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {},
        body: new ReadableStream({ start(c) { c.enqueue(rec.body); c.close(); } }),
        arrayBuffer: async () => rec.body.buffer.slice(rec.body.byteOffset, rec.body.byteOffset + rec.body.byteLength),
        text: async () => new TextDecoder().decode(rec.body),
        writeHttpMetadata(headers) { headers.set('Content-Type', (rec.httpMetadata && rec.httpMetadata.contentType) || 'application/octet-stream'); }
      };
    }
    async get(key) { this.ops.get++; const rec = this.map.get(key); return rec ? this._wrap(key, rec) : null; }
    async head(key) { this.ops.head++; const rec = this.map.get(key); if (!rec) return null; return { key, size: rec.body.length, uploaded: rec.uploaded, etag: rec.etag, httpEtag: rec.etag, httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {} }; }
    async delete(key) { this.ops.del++; this.map.delete(key); }
    async list(opts = {}) {
      this.ops.list++;
      const prefix = opts.prefix || '';
      const all = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const limit = opts.limit || 1000;
      const ps = new Set(); const objects = [];
      let i = start;
      for (; i < all.length && objects.length < limit; i++) {
        const k = all[i];
        if (this.strictPrefix && k === prefix) continue;
        const rest = k.slice(prefix.length);
        if (opts.delimiter) { const d = rest.indexOf(opts.delimiter); if (d >= 0) { ps.add(prefix + rest.slice(0, d + opts.delimiter.length)); continue; } }
        const rec = this.map.get(k);
        objects.push({ key: k, size: rec.body.length, uploaded: rec.uploaded, etag: rec.etag, httpEtag: rec.etag, httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {} });
      }
      const truncated = i < all.length;
      return { objects, truncated, cursor: truncated ? String(i) : undefined, delimitedPrefixes: [...ps] };
    }
    async createMultipartUpload(key, opt) { const uploadId = 'u' + (this.mpSeq++); this.uploads.set(uploadId, { key, parts: new Map(), opt: opt || {} }); return { key, uploadId }; }
    resumeMultipartUpload(key, uploadId) {
      const self = this, st = this.uploads.get(uploadId);
      if (!st) throw new Error('No such multipart upload');
      return {
        key, uploadId,
        async uploadPart(n, val) { const buf = await self._buf(val); st.parts.set(Number(n), buf); return { partNumber: Number(n), etag: '"p' + n + '-' + buf.length + '"' }; },
        async complete(parts) { parts.sort((a, b) => a.partNumber - b.partNumber); let len = 0; for (const p of parts) { const b = st.parts.get(p.partNumber); if (!b) throw new Error('missing part ' + p.partNumber); len += b.length; } const out = new Uint8Array(len); let off = 0; for (const p of parts) { const b = st.parts.get(p.partNumber); out.set(b, off); off += b.length; } self.uploads.delete(uploadId); await self.put(key, out, st.opt); return { key }; },
        async abort() { self.uploads.delete(uploadId); }
      };
    }
  }

  class MockKV {
    constructor() { this.map = new Map(); this.ops = { get: 0, put: 0, del: 0, list: 0 }; }
    async get(k) { this.ops.get++; const v = this.map.get(k); return v === undefined ? null : v; }
    async put(k, v, opt) { this.ops.put++; this.map.set(k, String(v)); }
    async delete(k) { this.ops.del++; this.map.delete(k); }
    async list(opts = {}) { this.ops.list++; const prefix = opts.prefix || ''; const names = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort(); return { keys: names.map(n => ({ name: n })), list_complete: true, cursor: undefined }; }
  }

  function makeExec() { const waits = []; return { waitUntil: p => waits.push(p), waits }; }

  window.__mock = { MockR2, MockKV, makeExec };
})();
