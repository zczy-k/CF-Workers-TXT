// node:http 桥接服务：HTTP 请求 → worker.fetch → 回写响应
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import worker from './t.mjs';
import { MockR2, MockKV, makeExec } from './mock.mjs';

const PORT = Number(process.env.PORT || 8899);

const R2 = new MockR2();
const KV = new MockKV();
const env = { R2, KV, ADMIN_UUID: 'adm-123', FILENAME: '测试盘' };
const ADMIN = '/adm-123';
const enc = s => new TextEncoder().encode(s);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = 'http://127.0.0.1:' + PORT + req.url;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && body.length) init.body = new Uint8Array(body);
  let r;
  try {
    r = await worker.fetch(new Request(url, init), env, makeExec());
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('bridge error: ' + (e && e.message));
    return;
  }
  const out = Buffer.from(await r.arrayBuffer());
  const hdrs = {};
  r.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
    hdrs[k] = v;
  });
  res.writeHead(r.status, hdrs);
  res.end(out);
});

const call = (path, init) => worker.fetch(new Request('http://127.0.0.1:' + PORT + path, init), env, makeExec());
const jpost = (url, obj) => call(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
});

// ---- 预置测试数据 ----
const MD = [
  '# 标题一',
  '',
  '普通段落，包含 **加粗** 与 `行内代码`，还有 [链接](https://example.com)。',
  '',
  '## 标题二',
  '',
  '- 条目 A',
  '- 条目 B',
  '',
  '| 名称 | 数量 |',
  '| --- | --- |',
  '| 苹果 | 3 |',
  '| 香蕉 | 12 |',
  '',
  '```js',
  'const x = 1; // 注释',
  'function f(){ return "字符串"; }',
  '```',
  '',
  '> 引用块',
  ''
].join('\n');

const PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82
]);

await jpost(ADMIN + '/api', { action: 'mkdir', path: '', name: '笔记' });
const put = (p, ct, body) => call(ADMIN + '/api?path=' + encodeURIComponent(p), {
  method: 'PUT', headers: { 'Content-Type': ct }, body
});
await put('笔记/说明.md', 'text/markdown', enc(MD));
await put('笔记/数据.json', 'application/json', enc(JSON.stringify({ name: '雷达', tags: ['a', 'b'], nested: { k: 1, ok: true }, n: null }, null, 2)));
await put('笔记/表格.csv', 'text/csv', enc('名称,数量,备注\n苹果,3,红\n香蕉,12,黄\n橙子,1,橙\n'));
await put('笔记/脚本.js', 'application/javascript', enc('// 注释\nconst a = 42;\nfunction hello(name){ return "hi " + name; }\n'));
await put('笔记/纯文本.txt', 'text/plain', enc('这是一段纯文本。\n第二行。\n'));
await put('笔记/Dockerfile', 'text/plain', enc('FROM node:22\nCMD ["echo","hi"]\n'));
// 超长文件名：用来验证"目录树里被省略号截断，但后缀徽标仍然看得见"
await put('笔记/很长的文件名用来验证目录树截断后缀依然可见.yaml', 'text/yaml', enc('a: 1\n'));
await put('笔记/长行.txt', 'text/plain', enc('LONGSTART-' + 'x'.repeat(3000) + '-LONGEND\n'));
await put('笔记/图片.png', 'image/png', PNG);
await put('笔记/坏的.json', 'application/json', enc('{ 这不是合法 JSON ,,, '));
// HTML 预览验证用：内联样式必须生效（看得见排版），外链 CSS 必须失效（证明是隔离预览），
// 脚本必须不执行（页面上不该出现"脚本已执行"）。这段页面本身就是安全探针。
const HTML_DEMO = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<title>预览探针</title>',
  '<link rel="stylesheet" href="outer.css">',
  '<style>body{font-family:sans-serif;background:#f0f8ff;margin:16px}',
  'h1{color:#0a4a8b;border-bottom:2px solid #0a4a8b;padding-bottom:6px}',
  '.card{border:1px solid #bcd;background:#fff;border-radius:8px;padding:12px;margin:10px 0}',
  '</style></head><body>',
  '<h1>HTML 预览探针</h1>',
  '<div class="card"><b>内联样式：</b>这段应该显示为带蓝色左边框和浅底的卡片。</div>',
  '<div class="card" style="background:#fff8e1">外链 CSS（outer.css）在这里<b>不生效</b>，',
  '说明预览确实被隔离了。</div>',
  '<p><img src="https://example.com/x.png" alt="外链图片" width="1"> 外链图片也不该加载。</p>',
  '<script>document.body.insertAdjacentHTML("afterbegin","<div id=probe>脚本已执行</div>")</script>',
  '<p id="marker">这段文字由 HTML 原文渲染而来。</p>',
  '</body></html>'
].join('\n');
await put('笔记/页面.html', 'text/html; charset=utf-8', enc(HTML_DEMO));
await put('笔记/outer.css', 'text/css', enc('body{background:#f00 !important}'));

// 链接探针：验证「在存档页里点一个外链」到底会发生什么。
// 沙箱 iframe 没有 allow-top-navigation（不能顶掉整个页面），但**自身导航**是允许的 ——
// 那么点一下是"顶掉存档页"、"被 CSP 拦"、还是"开新标签"？三种结果对用户的体感完全不同，
// 只能实测。目标地址用另一台本地服务（8901），与壳页面不同源，等价于真实外站。
const LINK_DEMO = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>链接探针</title></head><body>',
  '<h1 id="t">链接探针页</h1>',
  '<p><a id="same" href="http://127.0.0.1:8902/live.html">同一标签打开的外链</a></p>',
  '<p><a id="blank" href="http://127.0.0.1:8902/live2.html" target="_blank">新标签打开的外链</a></p>',
  '<p><a id="frag" href="#t">页内锚点</a></p>',
  '</body></html>'
].join('\n');
await put('笔记/链接.html', 'text/html; charset=utf-8', enc(LINK_DEMO));

// 无 <head> 的文档（SingleFile 抓的页面基本长这样）：验证注入的 <base> 被浏览器"挪进 head"
// 之后是否真的生效 —— 注入点在 <!doctype> 之后、<html> 之前，是"非法位置"，
// 解析器应当把它搬进 head；但如果哪天真不生效，相对资源和 target 会一起失效。
const NOHEAD_DEMO = [
  '<!doctype html>',
  '<html lang="zh"><body>',
  '<h1 id="nh">无 head 文档</h1>',
  '<p><a id="rel" href="live3.html">相对路径外链</a></p>',
  '</body></html>'
].join('\n');
await put('笔记/无head.html', 'text/html; charset=utf-8', enc(NOHEAD_DEMO));

// 大 HTML：验证「超过 VIEW_RENDER_MAX 不自动渲染，点『渲染』才建 iframe」
// 内容以 ASCII 为主，字符数≈字节数，保证确实越过 512K 字符阈值
const BIG_HTML = (function(){
  var head = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>大页面</title>' +
    '<style>body{font-family:sans-serif;margin:16px}h2{color:#0a4a8b}</style></head><body><h1>大页面</h1>\n';
  var chunks = [head], len = head.length, i = 0;
  while (len < 700 * 1024) {
    var s = '<div><h2>section ' + i + '</h2><p>plain ascii filler line ' + i +
      ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p></div>\n';
    chunks.push(s); len += s.length; i++;
  }
  chunks.push('</body></html>');
  return chunks.join('');
})();
await put('笔记/大页面.html', 'text/html; charset=utf-8', enc(BIG_HTML));

const sh = JSON.parse(await (await jpost(ADMIN + '/api', { action: 'share', path: '笔记' })).text());
writeFileSync('share.txt', sh.token);
console.log('share token =', sh.token);

server.listen(PORT, '127.0.0.1', () => console.log('READY ' + PORT));
