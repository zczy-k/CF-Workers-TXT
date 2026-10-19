// 目录分享：真文档（?doc=1）+ 分享内资源通道 + 文档的边缘缓存
// 为什么单独一套：这三条原先是被采集测试顺带覆盖的，采集功能整体移除后就没有人守了。
// 而目录分享的 ?doc=1 与单文件分享的 ?doc=1 是**两段不同的代码**
// （一个走 serveShareDoc()，一个走 serveSharedFile()/buildSharedFile()），不能只测一个。
import worker from './t.mjs';
import { MockR2, MockKV, makeExec, makeCaches } from './mock.mjs';

globalThis.caches = makeCaches();

const ORIGIN = 'https://demo.workers.dev';
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ok  ' + m); }
  else { fail++; console.log('  FAIL ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const head = t => console.log('\n== ' + t + ' ==');

const R2 = new MockR2(), KV = new MockKV(), exec = makeExec();
const r2 = { get: 0 };
const origGet = R2.get.bind(R2);
R2.get = (...a) => { r2.get++; return origGet(...a); };
const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
const call = async (path, init) => {
  const res = await worker.fetch(new Request(ORIGIN + path, init), env, exec);
  await Promise.all(exec.waits.splice(0));
  return res;
};
const enc = s => new TextEncoder().encode(s);
const putPub = (p, b, ct) => R2.put('__pub__/' + p, enc(b), { httpMetadata: { contentType: ct } });
const share = async (path, kind) => {
  const t = 'dok-' + Math.random().toString(36).slice(2, 8);
  await KV.put('share:' + t, JSON.stringify({ path, kind, at: Date.now() }));
  return t;
};

// —— 夹具：一个"页面 + 它自己的资源"的目录 ——
await putPub('site/index.html', '<!doctype html><html><head><meta charset="utf-8">'
  + '<title>目录分享探针</title><link rel="stylesheet" href="assets/style.css"></head>'
  + '<body><h1>目录分享探针</h1><img src="assets/a.png"></body></html>', 'text/html;charset=utf-8');
await putPub('site/assets/style.css', 'h1{color:red;background:url(bg.png)}', 'text/css');
await putPub('site/assets/a.png', 'PNGDATA', 'image/png');
await putPub('site/assets/bg.png', 'PNGBG', 'image/png');
await putPub('site/js/app.js', 'alert(1)', 'application/javascript');
await putPub('site/secret.txt', 'SECRET-DO-NOT-LEAK', 'text/plain');
await putPub('topsecret/x.css', 'TOP-SECRET-CSS', 'text/css');

const tok = await share('site', 'dir');
const B = '/s/' + tok;

head('目录分享：?doc=1 走真文档，base 指向分享根');
{
  const r = await call(B + '/index.html?doc=1');
  const t = await r.text();
  ok(r.status === 200 && (r.headers.get('Content-Type') || '').indexOf('text/html') === 0,
    '200 + text/html', [r.status, r.headers.get('Content-Type')]);
  ok(t.indexOf('<base href="' + B + '/" target="_blank">') >= 0,
    '注入了指向分享根的 base（相对资源才解析得对）', t.slice(0, 100));
  ok((r.headers.get('Content-Security-Policy') || '').indexOf("script-src 'none'") >= 0,
    '真文档带 script-src none');
  ok(!r.headers.get('X-Frame-Options'),
    '没有 X-Frame-Options（由 frame-ancestors 管，否则自己嵌不了）');
}

head('目录分享：分享内资源通道');
{
  const r = await call(B + '/assets/style.css');
  ok(r.status === 200 && (r.headers.get('Content-Type') || '').indexOf('text/css') === 0,
    'CSS 能取到（200 text/css）', r.status);
  await r.text();

  const r2b = await call(B + '/assets/a.png');
  ok(r2b.status === 200 && r2b.headers.get('Content-Type') === 'image/png',
    '图片按白名单类型发出', [r2b.status, r2b.headers.get('Content-Type')]);
  await r2b.text();

  const r3 = await call(B + '/assets/bg.png');
  ok(r3.status === 200, 'CSS 里 url(bg.png) 引用的同目录资源也能取到', r3.status);
  await r3.text();
}

head('目录分享：边界（脚本与目录穿越都拿不到）');
{
  // 目录分享对非白名单路径是"回落成浏览页"（原有设计；单文件分享才是 404）。
  // 真正要守住的不变量是：**脚本内容绝不会被发出去**。
  const r = await call(B + '/js/app.js');
  const t = await r.text();
  ok(t.indexOf('alert(1)') < 0, '脚本内容取不到（回落成浏览页，不会把脚本发出去）', r.status);
  ok(t.indexOf('只读分享') >= 0 || r.status === 404, '回落的是浏览页（或 404），不是文件本身');

  const r2b = await call(B + '/%2e%2e/topsecret/x.css');
  const t2 = await r2b.text();
  ok(t2.indexOf('TOP-SECRET-CSS') < 0, '目录穿越取不到分享目录以外的文件', r2b.status);

  const r3 = await call(B + '/secret.txt');
  const t3 = await r3.text();
  ok(t3.indexOf('SECRET-DO-NOT-LEAK') < 0,
    '根下的 txt 不会被资源通道吐出去（只放行 css / 图片 / 字体）', r3.status);
}

head('目录分享：?doc=1 也走边缘缓存（命中即 0 次 R2 读）');
{
  // 用一个新的分享 token，保证这是这个 URL 的首次请求（否则会测出"冷启动 0 次"的假象）
  const tok2 = await share('site', 'dir');
  const url = '/s/' + tok2 + '/index.html?doc=1';
  let before = r2.get;
  await (await call(url)).text();
  const cold = r2.get - before;
  before = r2.get;
  await (await call(url)).text();
  const hot = r2.get - before;
  console.log('  首次 R2 读 ' + cold + ' 次 / 60 秒内再读 ' + hot + ' 次');
  ok(cold > 0, '首次访问读一次 R2', cold);
  ok(hot === 0, '命中边缘缓存后 0 次 R2 读（serveShareDoc 的意义就在这里）', hot);
}

head('目录分享：首页仍是只读浏览页');
{
  const r = await call(B);
  const t = await r.text();
  ok(r.status === 200 && t.indexOf('只读分享') >= 0, '多余的路径回落成浏览页，不报错', r.status);
  ok(t.indexOf('SECRET-DO-NOT-LEAK') < 0, '浏览页里也不会漏出目录内容');
}

console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 目录分享真文档 / 资源通道 / 缓存全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
