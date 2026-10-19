// HTML 预览的资源消耗 / 渲染速度实测。
// 量三件事：
//   1. 取数延迟（浏览器 → 边缘 → R2 → decodeBytes 转码 → 回传）—— 这是 Worker 侧唯一的 CPU 开销
//   2. srcdoc 渲染耗时（浏览器把原文当独立文档解析 + 布局）—— 纯前端成本
//   3. 老编码（GBK）走 sniffEncoding 候选编码打分时的额外开销
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');

const NODE = process.execPath;
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = s => new TextEncoder().encode(s);

// ---- 启动桥接服务（复用 serve.mjs 的预置数据）----
const srv = spawn(NODE, ['serve.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
let up = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(ADMIN); if (r.status) { up = true; break; } } catch (e) {}
  await sleep(250);
}
if (!up) { console.error('桥接服务未就绪'); srv.kill(); process.exit(1); }
await sleep(600);
const TOKEN = readFileSync('share.txt', 'utf8').trim();
console.log('share token = ' + TOKEN);

const put = (p, ct, body) => fetch(ADMIN + '/api?path=' + encodeURIComponent(p), {
  method: 'PUT', headers: { 'Content-Type': ct }, body
});

// ---- 造不同体积的 HTML（结构足够多，解析成本才有意义）----
// 按 **UTF-8 字节数** 定体积（中文 3 字节/字，按字符数会严重低估），并留出 2MB 上限余量
function makeHtml(targetBytes) {
  const head = ['<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>big</title>',
    '<style>body{font-family:sans-serif;margin:16px}h2{color:#0a4a8b}.c{border:1px solid #bcd;padding:8px;margin:6px 0}</style>',
    '</head><body><h1>大页面压测</h1>'];
  const chunks = [];
  let len = 0;
  let i = 0;
  while (len < targetBytes) {
    const s = '<div class="c"><h2>小节 ' + i + '</h2>\n' +
      '<p>这是第 ' + i + ' 段正文，包含 <b>加粗</b>、<i>斜体</i> 与 <a href="https://example.com/' + i + '">链接</a>。' +
      '中文内容用来撑体积并触发布局计算。'.repeat(3) + '</p>\n' +
      '<ul><li>条目甲 ' + i + '</li><li>条目乙 ' + i + '</li><li>条目丙 ' + i + '</li></ul></div>';
    chunks.push(s);
    len += Buffer.byteLength(s) + 1;
    i++;
  }
  return head.concat(chunks, ['</body></html>']).join('\n');
}

const sizes = [100, 512, 1800];
for (const kb of sizes) {
  const h = makeHtml(kb * 1024);
  await put('笔记/压测-' + kb + 'k.html', 'text/html; charset=utf-8', enc(h));
  console.log('  已上传 压测-' + kb + 'k.html  ' + (Buffer.byteLength(h) / 1024).toFixed(0) + ' KB（字节）');
}
// GBK 老编码：手工构造合法 GBK 字节（"中文" = D6 D0 CE C4），逼出候选编码打分分支
const gbkUnit = [0xD6, 0xD0, 0xCE, 0xC4];
const gbkBody = new Uint8Array(gbkUnit.length * 60000);
for (let i = 0; i < 60000; i++) gbkBody.set(gbkUnit, i * gbkUnit.length);
await put('笔记/压测-gbk.html', 'text/html; charset=utf-8', gbkBody);
console.log('  已上传 压测-gbk.html  ' + (gbkBody.length / 1024).toFixed(0) + ' KB（GBK 编码）');
// 专供「重复打开」对比用：只在这一节打开，保证第一次是冷缓存
const CACHE_DEMO = '压测-300k.html';
await put('笔记/' + CACHE_DEMO, 'text/html; charset=utf-8', enc(makeHtml(300 * 1024)));
console.log('  已上传 ' + CACHE_DEMO + '（重复打开对比用）');

// 分享页读的是已发布影子树 PUB，草稿树的新文件必须发布后才可见
await fetch(ADMIN + '/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'publish', path: '笔记', isDir: true })
});
console.log('  已发布 笔记/ 到影子树');

// ---- 服务端取数延迟（纯 Worker + R2，不含浏览器）----
console.log('\n== 服务端取数延迟（含 decodeBytes 转码）==');
// 分享 API 的 path 相对分享范围（scope=笔记），不带 笔记/ 前缀
const files = ['压测-100k.html', '压测-512k.html', '压测-1800k.html', '压测-gbk.html'];
const serverMs = {};
for (const f of files) {
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    const r = await fetch(ORIGIN + '/s/' + TOKEN + '/api?action=read&path=' + encodeURIComponent(f), { cache: 'no-store' });
    await r.arrayBuffer();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  serverMs[f] = times[2];
  console.log('  ' + f.padEnd(22) + ' 中位 ' + times[2].toFixed(1) + ' ms   (最快 ' + times[0].toFixed(1) + ' / 最慢 ' + times[times.length - 1].toFixed(1) + ')');
}

// ---- 浏览器渲染耗时 ----
const PROFILE = TMP + '/cfwtxt-cfwtxt-htmlperf-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9335', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9335/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }); }
  send(method, params, sid) { const id = ++this.id; const p = { id, method, params: params || {} };
    if (sid) p.sessionId = sid; this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); }
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Page.enable', {}, sid);
const ev = async e => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value; };

await cdp.send('Page.navigate', { url: ORIGIN + '/s/' + TOKEN }, sid);
for (let i = 0; i < 80; i++) { try { if (await ev('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0')) break; } catch (e) {} await sleep(200); }

console.log('\n== 浏览器端：取数 + srcdoc 渲染 ==');
console.log('  文件                   取数(ms)  srcdoc渲染(ms)  原文KB');
for (const f of files) {
  const name = f.split('/').pop();
  const r = await ev(`(function(){
    var p = ${JSON.stringify(f)};
    var url = ${JSON.stringify(ORIGIN + '/s/' + TOKEN + '/api?action=read&path=')} + encodeURIComponent(p);
    return fetch(url, {cache:'no-store'}).then(function(res){ return res.text(); }).then(function(t){
      return new Promise(function(done){
        var fr = document.createElement('iframe');
        fr.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
        fr.setAttribute('referrerpolicy','no-referrer');
        var t0 = performance.now();
        fr.addEventListener('load', function(){
          var ms = performance.now() - t0;
          try { fr.remove(); } catch(e){}
          done({ renderMs: Math.round(ms*10)/10, kb: Math.round(t.length/1024) });
        });
        fr.srcdoc = t;
        document.body.appendChild(fr);
      });
    });
  })()`);
  const fetchMs = serverMs[f];
  console.log('  ' + name.padEnd(20) + '  ' + String(fetchMs.toFixed(1)).padStart(6) + '   ' +
    String(r.renderMs.toFixed(1)).padStart(10) + '      ' + String(r.kb).padStart(6));
}

// 真实交互路径：点文件 → 内容可见（P2 后大 HTML 落到源码，不再等 iframe 渲染）
console.log('\n== 端到端：点开文件 → 内容可见 ==');
for (const f of files) {
  const name = f.split('/').pop();
  const r = await ev(`(function(){
    var t0 = performance.now();
    openFile(${JSON.stringify(f)});
    return new Promise(function(res){
      var n = 0;
      (function poll(){
        var st = document.getElementById('edtStatus');
        var ready = st && st.textContent.indexOf('已载入') === 0;
        if (ready || n > 400) {
          var note = document.getElementById('vNote');
          res({ ms: Math.round((performance.now()-t0)*10)/10, ok: !!ready,
                gated: !!(note && /文件较大/.test(note.textContent)) });
          return;
        }
        n++; setTimeout(poll, 15);
      })();
    });
  })()`);
  console.log('  ' + name.padEnd(20) + '  ' + (r.ok ? r.ms.toFixed(1) + ' ms' : '超时') + (r.gated ? '   [门控→源码]' : ''));
}

// P2：大 HTML 按需渲染 —— 只有点了「渲染」才付这一笔
// 注：这里量的是「点下去 → iframe 就位」（同步建元素 + 赋 srcdoc）；
// 子文档真正解析/布局的耗时另计，见上表「srcdoc 渲染」列。
console.log('\n== 大 HTML 点「渲染」→ iframe 就位（同步部分）==');
await ev('openFile("压测-1800k.html")');
await sleep(1600);
const p2 = await ev(`(function(){
  var btn = document.querySelector('#vSeg [data-vmode=rich]');
  if (!btn) return Promise.resolve({ ok: false, why: 'no btn' });
  var t0 = performance.now();
  btn.click();
  return new Promise(function(res){
    var n = 0;
    (function poll(){
      var fr = document.querySelector('#vRender iframe');
      var ready = fr && fr.srcdoc && fr.srcdoc.length > 0;
      if (ready || n > 800) { res({ ms: Math.round((performance.now()-t0)*10)/10, ok: !!ready }); return; }
      n++; setTimeout(poll, 15);
    })();
  });
})()`);
console.log('  压测-1800k.html       ' + (p2.ok ? p2.ms.toFixed(1) + ' ms' : '超时 ' + (p2.why || '')));

// 重复打开同一个文件：P1（只读查看器接入内存缓存）的效果
console.log('\n== 重复打开同一文件（' + CACHE_DEMO + '）==');
for (let i = 0; i < 3; i++) {
  const r = await ev(`(function(){
    var t0 = performance.now();
    openFile(${JSON.stringify(CACHE_DEMO)});
    return new Promise(function(res){
      var n = 0;
      (function poll(){
        var fr = document.querySelector('#vRender iframe');
        var st = document.getElementById('edtStatus');
        var ready = fr && fr.srcdoc && fr.srcdoc.length > 0 && fr.getBoundingClientRect().height > 100;
        if (ready || n > 400) { res({ ms: Math.round((performance.now()-t0)*10)/10, status: st ? st.textContent : '' }); return; }
        n++; setTimeout(poll, 15);
      })();
    });
  })()`);
  console.log('  第 ' + (i + 1) + ' 次：' + String(r.ms.toFixed(1)).padStart(6) + ' ms   [' + r.status + ']');
}

try { ws.close(); proc.kill(); } catch (e) {}
try { srv.kill(); } catch (e) {}
process.exit(0);