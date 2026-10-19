// 分享直连的**边缘缓存命中**路径回归测试。
// 背景：真实线上事故 —— 分享链接第一次能打开，60 秒内（缓存 TTL）再打开就 500
// （error code: 1101）。根因是 caches.default.match() 返回的 Response 头部不可变，
// 最外层 applySecurity() 却直接在上面 set 安全头，抛 "Can't modify immutable headers"。
// 这个文件把 mock 的 Cache API 装上，专门覆盖"命中缓存"这条之前没有任何测试走过的路。
import worker from './t.mjs';
import { MockR2, MockKV, makeExec, makeCaches } from './mock.mjs';

globalThis.caches = makeCaches();   // worker 用 typeof caches !== 'undefined' 判定

const ORIGIN = 'https://demo.workers.dev';
let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
const call = async (path, init) => {
  const u = /^https?:\/\//.test(path) ? path : ORIGIN + path;
  // 真实运行时 waitUntil 里的 cache.put 会在响应之后继续跑，这里必须 await 掉，
  // 否则下一次请求可能还没写进缓存（测不到命中）
  const res = await worker.fetch(new Request(u, init), env, exec);
  await Promise.all(exec.waits.splice(0));
  return res;
};
const enc = s => new TextEncoder().encode(s);
const share = async (path, kind) => {
  const token = 'tok-' + Math.random().toString(36).slice(2, 8);
  await KV.put('share:' + token, JSON.stringify({ path, kind, at: Date.now() }));
  return token;
};
const putPub = (path, body, ct) => R2.put('__pub__/' + path, enc(body), { httpMetadata: { contentType: ct } });

const HTML = '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head>'
  + '<body><p>缓存命中测试</p></body></html>';
await putPub('c/页面.html', HTML, 'text/html; charset=utf-8');
await putPub('c/s.css', 'body{margin:0}', 'text/css');
await putPub('c/a.txt', '纯文本内容', 'text/plain');
const tokHtml = await share('c/页面.html', 'file');
const tokTxt = await share('c/a.txt', 'file');

// 同一路径请求两次：第 1 次未命中（会写缓存），第 2 次必然命中
async function twice(path, name) {
  const r1 = await call(path);
  const b1 = await r1.text();
  const r2 = await call(path);
  const b2 = await r2.text();
  ok(r1.status === 200 && r2.status === 200,
    name + '：第二次（命中缓存）仍然 200，不再 1101', { first: r1.status, second: r2.status });
  ok(r1.status === 200 && r2.status === 200 && b1 === b2, name + '：两次内容一致', [b1.length, b2.length]);
  ok((r2.headers.get('X-Content-Type-Options') || '') === 'nosniff',
    name + '：缓存命中的响应照样补上了安全头', r2.headers.get('X-Content-Type-Options'));
  ok((r2.headers.get('Cache-Control') || '').length > 0, name + '：Cache-Control 还在', r2.headers.get('Cache-Control'));
  return r2;
}

head('缓存命中：不再抛"不可变头部"');
{
  const shell = await twice('/s/' + tokHtml + '/' + encodeURIComponent('页面.html'), 'HTML 壳页面');
  ok((shell.headers.get('Content-Type') || '').indexOf('text/html') === 0, '壳页面类型正确');
  ok((shell.headers.get('X-Robots-Tag') || '').indexOf('noindex') >= 0, '缓存命中的壳页面也有 noindex');

  const doc = await twice('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?doc=1', '?doc=1 真文档');
  ok((doc.headers.get('Content-Security-Policy') || '').indexOf("script-src 'none'") >= 0,
    '缓存命中的真文档仍然带 CSP（frame-ancestors 检查也走这条路）');
  ok((doc.headers.get('X-Frame-Options') || '') === '', '缓存命中的真文档仍不受 X-Frame-Options 限制');

  await twice('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?raw=1', '?raw=1 原文');
  await twice('/s/' + tokHtml + '/' + encodeURIComponent('页面.html') + '?dl=1', '?dl=1 下载');
  await twice('/s/' + tokTxt + '/' + encodeURIComponent('a.txt'), 'txt 直连');
  await twice('/s/' + tokHtml + '/s.css', '分享内资源 css');
}

head('缓存确实生效（否则上面的断言等于没测）');
{
  const before = globalThis.caches._store.size;
  await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html'));
  ok(globalThis.caches._store.size === before, '反复请求同一 URL 不会往缓存里重复写新条目', globalThis.caches._store.size);
  const keys = [...globalThis.caches._store.keys()];
  ok(keys.some(k => k.indexOf('doc=1') >= 0) && keys.some(k => k.indexOf('raw=1') >= 0) &&
    keys.some(k => k.indexOf('dl=1') >= 0) && keys.some(k => k.indexOf('a.txt') >= 0),
    '壳 / ?doc=1 / ?raw=1 / ?dl=1 / txt 都进了缓存', keys.length);
  ok(keys.some(k => k.indexOf('s.css') >= 0), '分享内资源（白名单那条）也进了缓存', keys.length);
}

head('资源命中缓存时不再读 R2（这次优化的收益）');
{
  const path = '/s/' + tokHtml + '/s.css';
  const g0 = R2.ops.get;
  await call(path);                    // 前面已经缓存过 → 应当命中
  ok(R2.ops.get === g0, '资源命中边缘缓存：0 次 R2 读', { before: g0, after: R2.ops.get });
  // 反证：清掉缓存再打一次，确认这条路本来是要读 R2 的
  await globalThis.caches.default.delete(ORIGIN + path);
  await call(path);
  ok(R2.ops.get === g0 + 1, '清掉缓存后回源：R2 读 +1（说明上面的 0 次确实是缓存换来的）', { before: g0, after: R2.ops.get });
}

head('未命中与命中走的是同一条安全头逻辑');
{
  // 清掉缓存再打一次：确认"重建 Response"没有把安全头弄丢
  const key = ORIGIN + '/s/' + tokHtml + '/' + encodeURIComponent('页面.html');
  await globalThis.caches.default.delete(key);
  const r = await call('/s/' + tokHtml + '/' + encodeURIComponent('页面.html'));
  ok((r.headers.get('X-Content-Type-Options') || '') === 'nosniff', '未命中路径 nosniff 在');
  ok((r.headers.get('Referrer-Policy') || '') === 'strict-origin-when-cross-origin', '未命中路径 Referrer-Policy 在');
  ok((r.headers.get('X-Frame-Options') || '') === 'DENY', '普通页面仍是 DENY（没有 frame-ancestors 时）');
  await r.text();
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : `\n✅ 缓存命中路径全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
