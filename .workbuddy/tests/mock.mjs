// 内存版 R2 / KV mock —— 驱动真实 worker.js
import { createHash } from 'node:crypto';

function bodyToU8(val) {
  if (val == null) return new Uint8Array(0);
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (ArrayBuffer.isView(val)) return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  if (typeof val === 'string') return new TextEncoder().encode(val);
  if (typeof val.getReader === 'function') return val;      // stream，交由调用方 await
  if (ArrayBuffer.isView(val)) return new Uint8Array(val);
  throw new Error('unsupported body: ' + Object.prototype.toString.call(val));
}
async function readStream(s) {
  const chunks = [];
  const rd = s.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export class MockR2 {
  constructor() {
    this.map = new Map();
    this.uploads = new Map();
    this.strictPrefix = false;    // true 时模拟"list 不返回与 prefix 完全相同的占位键"
    this.ops = { get: 0, put: 0, head: 0, del: 0, list: 0 };
    this.mpSeq = 1;
  }
  async _buf(val) {
    if (val && typeof val.getReader === 'function') return readStream(val);
    return bodyToU8(val);
  }
  async put(key, val, opt) {
    this.ops.put++;
    // 模拟 R2 条件写：onlyIf.etag 与当前不符时不写入，返回 preconditionFailed（不抛错）
    const onlyIf = opt && opt.onlyIf;
    if (onlyIf && typeof onlyIf.etag === 'string') {
      const cur = this.map.get(key);
      const curEtag = cur ? cur.etag : null;
      if (curEtag !== onlyIf.etag) {
        return { key, etag: undefined, preconditionFailed: true };
      }
    }
    // etagDoesNotMatch:'*' = S3 If-None-Match:* —— 仅当对象不存在时写入
    if (onlyIf && onlyIf.etagDoesNotMatch === '*' && this.map.has(key)) {
      return { key, etag: undefined, preconditionFailed: true };
    }
    const buf = await this._buf(val);
    const etag = '"' + createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
    this.map.set(key, {
      body: buf, uploaded: new Date(), etag,
      httpMetadata: (opt && opt.httpMetadata) || {},
      customMetadata: (opt && opt.customMetadata) || {}
    });
    return { key, etag };
  }
  _wrap(key, rec) {
    return {
      key, size: rec.body.length, uploaded: rec.uploaded, etag: rec.etag, httpEtag: rec.etag,
      httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {},
      body: new ReadableStream({ start(c) { c.enqueue(rec.body); c.close(); } }),
      arrayBuffer: async () => rec.body.buffer.slice(rec.body.byteOffset, rec.body.byteOffset + rec.body.byteLength),
      text: async () => new TextDecoder().decode(rec.body),
      writeHttpMetadata(headers) {
        const ct = (rec.httpMetadata && rec.httpMetadata.contentType) || 'application/octet-stream';
        headers.set('Content-Type', ct);
      }
    };
  }
  async get(key) {
    this.ops.get++;
    const rec = this.map.get(key);
    return rec ? this._wrap(key, rec) : null;
  }
  async head(key) {
    this.ops.head++;
    const rec = this.map.get(key);
    if (!rec) return null;
    // etag 必须给：真实 R2 的 head 会带，publishSynced（发布状态判定）靠它比内容
    return { key, size: rec.body.length, uploaded: rec.uploaded, etag: rec.etag, httpEtag: rec.etag,
      httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {} };
  }
  async delete(key) { this.ops.del++; this.map.delete(key); }
  async list(opts = {}) {
    this.ops.list++;
    const prefix = opts.prefix || '';
    const all = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const limit = opts.limit || 1000;
    const ps = new Set();
    const objects = [];
    let i = start;
    for (; i < all.length && objects.length < limit; i++) {
      const k = all[i];
      if (this.strictPrefix && k === prefix) continue;
      const rest = k.slice(prefix.length);
      if (opts.delimiter) {
        const d = rest.indexOf(opts.delimiter);
        if (d >= 0) { ps.add(prefix + rest.slice(0, d + opts.delimiter.length)); continue; }
      }
      const rec = this.map.get(k);
      // etag/httpEtag 必须给：真实 R2 的 list 会带，publishSynced（发布状态判定）靠它比内容。
      // 少了这个字段，"内容指纹缺失"会被当成"内容一致"——方向完全错的误判。
      objects.push({ key: k, size: rec.body.length, uploaded: rec.uploaded,
        etag: rec.etag, httpEtag: rec.etag,
        httpMetadata: rec.httpMetadata || {}, customMetadata: rec.customMetadata || {} });
    }
    const truncated = i < all.length;
    return { objects, truncated, cursor: truncated ? String(i) : undefined, delimitedPrefixes: [...ps] };
  }
  // ---- multipart ----
  async createMultipartUpload(key, opt) {
    const uploadId = 'u' + (this.mpSeq++);
    this.uploads.set(uploadId, { key, parts: new Map(), opt: opt || {} });
    return { key, uploadId };
  }
  resumeMultipartUpload(key, uploadId) {
    const self = this, st = this.uploads.get(uploadId);
    if (!st) throw new Error('No such multipart upload');
    return {
      key, uploadId,
      async uploadPart(n, val) {
        const buf = await self._buf(val);
        st.parts.set(Number(n), buf);
        return { partNumber: Number(n), etag: '"p' + n + '-' + buf.length + '"' };
      },
      async complete(parts) {
        parts.sort((a, b) => a.partNumber - b.partNumber);
        let len = 0;
        for (const p of parts) { const b = st.parts.get(p.partNumber); if (!b) throw new Error('missing part ' + p.partNumber); len += b.length; }
        const out = new Uint8Array(len);
        let off = 0;
        for (const p of parts) { const b = st.parts.get(p.partNumber); out.set(b, off); off += b.length; }
        self.uploads.delete(uploadId);
        await self.put(key, out, st.opt);
        return { key };
      },
      async abort() { self.uploads.delete(uploadId); }
    };
  }
}

export class MockKV {
  constructor() { this.map = new Map(); this.ops = { get: 0, put: 0, del: 0, list: 0 }; }
  async get(k) { this.ops.get++; const v = this.map.get(k); return v === undefined ? null : v; }
  async put(k, v, opt) { this.ops.put++; this.map.set(k, String(v)); }
  async delete(k) { this.ops.del++; this.map.delete(k); }
  async list(opts = {}) {
    this.ops.list++;
    const prefix = opts.prefix || '';
    const names = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort();
    return { keys: names.map(n => ({ name: n })), list_complete: true, cursor: undefined };
  }
}

export function makeExec() {
  const waits = [];
  return { waitUntil: p => waits.push(p), waits };
}

// 内存版 Cache API（caches.default）。
// 关键：**必须复现"缓存返回的 Response 头部不可变"** —— 真实运行时里
// caches.default.match() 给出的 Response 头部是冻结的，谁在它上面 set/append/delete
// 都会抛 "Can't modify immutable headers"。线上事故就是这么来的：
// 分享直连命中边缘缓存后再走 applySecurity() 抛异常 → Worker 1101，
// 症状是"分享链接第一次能打开、TTL 内再打开就 500"。
// 之前 Node 里没有全局 caches，这条路径根本没被任何测试覆盖过。
function immutableHeaders(src) {
  const real = new Headers(src);
  const boom = () => { throw new TypeError("Can't modify immutable headers."); };
  const proxy = {
    get: k => real.get(k),
    has: k => real.has(k),
    forEach: (cb, t) => real.forEach(cb, t),
    entries: () => real.entries(),
    keys: () => real.keys(),
    values: () => real.values(),
    [Symbol.iterator]: () => real.entries(),
    set: boom, append: boom, delete: boom
  };
  return proxy;
}

export function makeCaches() {
  const store = new Map();
  return {
    _store: store,
    default: {
      async match(key) {
        const rec = store.get(String(key));
        if (!rec) return null;
        const res = new Response(rec.body, { status: rec.status, headers: rec.headers });
        Object.defineProperty(res, 'headers', { value: immutableHeaders(rec.headers) });
        return res;
      },
      async put(key, resp) {
        const body = new Uint8Array(await resp.arrayBuffer());   // 存一份快照（原响应要回给客户端）
        store.set(String(key), { body, status: resp.status, headers: [...resp.headers] });
      },
      async delete(key) { store.delete(String(key)); }
    }
  };
}
