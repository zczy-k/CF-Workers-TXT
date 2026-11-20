// 内存版 R2 / KV mock —— 驱动真实 worker.js
//
// 两种用法：
//   1) 被测试 import：`import { MockR2, MockKV, makeExec } from './mock.mjs'`（纯库，无副作用）
//   2) 直接跑：`node mock.mjs` —— 起一个本地 HTTP 服务，浏览器里就是完整的笔记应用，
//      数据全在内存里，Ctrl+C 即清空。默认 http://127.0.0.1:8787/<ADMIN_UUID=dev>
//      环境变量可覆盖：PORT / ADMIN_UUID / PASSWORD / FILENAME
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

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
    if (opt && opt.onlyIf && typeof opt.onlyIf.etag === 'string') {
      const cur = this.map.get(key);
      const curEtag = cur ? cur.etag : null;
      if (curEtag !== opt.onlyIf.etag) {
        return { key, etag: undefined, preconditionFailed: true };
      }
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
    return { key, size: rec.body.length, uploaded: rec.uploaded, httpEtag: rec.etag,
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
      objects.push({ key: k, size: rec.body.length, uploaded: rec.uploaded,
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

// ===== 本地开发服务器 =====
// 把 node:http 的请求翻成标准 Request 丢给 worker.fetch，再把 Response 翻回去。
// 只为了让 worker.js 能在本机跑起来调试 —— 不模拟 Cloudflare 的边缘行为
// （没有缓存、没有 CPU 时限、没有真实 IP，限速相关的分支要按本地 IP 走）。

async function serve() {
  const PORT = Number(process.env.PORT || 8787);
  const { default: worker } = await import('./worker.js');

  const env = {
    R2: new MockR2(),
    KV: new MockKV(),
    ADMIN_UUID: process.env.ADMIN_UUID || 'dev',
    PASSWORD: process.env.PASSWORD || '',
    FILENAME: process.env.FILENAME || 'CF-Workers-TXT（本地）',
  };

  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

      const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: 'manual',
      });

      const ctx = makeExec();
      const response = await worker.fetch(request, env, ctx);
      const buf = Buffer.from(await response.arrayBuffer());

      const headers = {};
      for (const [k, v] of response.headers) {
        // 这两个交给 node 自己算，照抄会和实际 body 对不上
        if (k === 'transfer-encoding' || k === 'content-length') continue;
        headers[k] = v;
      }
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      if (cookies.length) headers['set-cookie'] = cookies;

      res.writeHead(response.status, headers);
      res.end(buf);
      await Promise.all(ctx.waits);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain;charset=utf-8' });
      res.end('mock 服务器出错：\n' + (e && e.stack ? e.stack : String(e)));
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`本地： http://127.0.0.1:${PORT}/${env.ADMIN_UUID}`);
    if (env.PASSWORD) console.log('已启用密码登录（PASSWORD 环境变量）');
    console.log('数据全在内存里，Ctrl+C 结束即清空。');
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await serve();
