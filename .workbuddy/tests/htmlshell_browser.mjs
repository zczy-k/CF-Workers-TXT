// HTML 单文档分享壳页面：无头 Chrome 端到端验收（真文档模式）
// 起 serve.mjs 桥接 → 建单文件分享 → 无头 Chrome 打开 /s/<token>/页面.html
// 验证：壳页面、?doc=1 真文档渲染、页面自己的 CSS 能加载、第三方外链仍被挡、
//       脚本被 sandbox 拦、源码按需取（打开时不打多余请求）、渲染/源码切换。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 8899);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9334;
const PROFILE = TMP + '/cfwtxt-cfwtxt-htmlshell-profile-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) { for (const h of this.handlers) h(msg); }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
}

// ---- 1. 桥接服务 ----
const srv = spawn(process.execPath, ['serve.mjs'], {
  cwd: '.workbuddy/tests', stdio: 'pipe', env: Object.assign({}, process.env, { PORT: String(PORT) })
});
srv.stderr.on('data', d => process.stderr.write('[serve] ' + d));
let ready = false;
srv.stdout.on('data', d => { if (String(d).indexOf('READY') >= 0) ready = true; });
for (let i = 0; i < 80 && !ready; i++) await sleep(250);
ok(ready, '桥接服务已启动');
if (!ready) { srv.kill(); process.exit(1); }

// ---- 2. 建单文件分享（serve.mjs 预置了 笔记/页面.html + 同目录 笔记/outer.css）----
const sh = await fetch(ORIGIN + '/adm-123/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'share', path: '笔记/页面.html' })
}).then(r => r.json());
ok(sh.ok && sh.kind === 'file', '创建单文件分享', sh);
const shareUrl = ORIGIN + '/s/' + sh.token + '/' + encodeURIComponent('页面.html');

// ---- 3. Chrome + CDP ----
// profile 目录按进程号隔离；上一轮残留的 Chrome 可能还锁着旧目录，删不掉也不该让本次跑挂
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  // 站点隔离开启时 iframe 的 console / Network 事件走独立 target，页面会话收不到
  // （被测的是 HTML sandbox 属性本身，与 Chrome 进程模型无关；这个 flag 只为让断言收得到）
  '--disable-site-isolation-trials',
  '--window-size=1280,900', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
    if (r.ok) {
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    }
  } catch (e) {}
  if (!wsUrl) await sleep(250);
}
ok(!!wsUrl, 'Chrome 调试端口就绪');
if (!wsUrl) { proc.kill(); srv.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
const cdp = new CDP(ws);
const exceptions = [];
const logEntries = [];
const reqs = [];
cdp.on(m => {
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
  if (m.method === 'Log.entryAdded') logEntries.push(m.params.entry.level + ': ' + m.params.entry.text);
  if (m.method === 'Runtime.consoleAPICalled') logEntries.push('console.' + m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
  if (m.method === 'Network.responseReceived') reqs.push({ url: m.params.response.url, status: m.params.response.status });
});

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');
const navLoaded = new Promise(res => {
  const h = m => { if (m.method === 'Page.loadEventFired') { cdp.handlers.splice(cdp.handlers.indexOf(h), 1); res(); } };
  cdp.on(h);
});
await cdp.send('Page.navigate', { url: shareUrl });
await Promise.race([navLoaded, sleep(10000)]);
await sleep(1500);   // 等 iframe 里的真文档 + 它引用的 css 加载完

const hit = sub => reqs.filter(r => r.url.indexOf(sub) >= 0);

head('壳页面本体');
{
  ok(await cdp.eval('document.title') === '页面.html · 分享预览', '标题是「文件名 · 分享预览」', await cdp.eval('document.title'));
  ok(await cdp.eval("document.getElementById('frame') !== null"), '有预览 iframe');
  const sb = await cdp.eval("document.getElementById('frame').getAttribute('sandbox')");
  ok(sb === 'allow-popups allow-popups-to-escape-sandbox',
    'iframe sandbox 只有 allow-popups（无 allow-scripts / allow-same-origin）', sb);
  const info = await cdp.eval("JSON.stringify({r:document.getElementById('frame').getBoundingClientRect(), ih:innerHeight, iw:innerWidth})");
  const o = JSON.parse(info);
  ok(o.r.width >= o.iw - 2 && Math.abs(o.r.height - (o.ih - 44)) <= 2,
    'iframe 撑满可视区（高 = 视口 − 顶栏 44px）', info);
  ok(await cdp.eval("document.getElementById('tip').hidden") === true, '文档加载完成后提示区收起');
  ok(await cdp.eval("document.getElementById('nm').textContent") === '页面.html', '文件名正确显示');
  ok(await cdp.eval("document.querySelectorAll('script').length === 1"), '壳页面只有一个自己的内联脚本（无用户脚本）');
}

head('真文档渲染 + 页面自己的资源能加载');
{
  const doc = hit('doc=1')[0];
  ok(!!doc && doc.status === 200, 'iframe 请求的 ?doc=1 拿到 200', doc);
  const css = hit('outer.css')[0];
  ok(!!css && css.status === 200, '页面自己的 outer.css 加载成功（200）—— 旧版这里是加载不了的', css);
  ok(!logEntries.some(t => t.indexOf('outer.css') >= 0 && t.indexOf('Content Security Policy') >= 0),
    '不再有"outer.css 被 CSP 挡掉"的报错');
  ok(logEntries.some(t => t.indexOf('example.com/x.png') >= 0 && t.indexOf('Content Security Policy') >= 0),
    '第三方外链图片仍被 CSP 挡掉（只放行本分享内的资源）');
}

head('脚本仍然被挡死');
{
  ok(logEntries.some(t => t.indexOf('Blocked script execution in') >= 0),
    '浏览器确认页面脚本被 sandbox 拦截（没有 allow-scripts）', logEntries.find(t => t.indexOf('Blocked script') >= 0));
  ok(['inaccessible-null', 'inaccessible-throw'].indexOf(await cdp.eval("(()=>{try{var d=document.getElementById('frame').contentDocument; return d===null?'inaccessible-null':'accessible'}catch(e){return 'inaccessible-throw'}})()")) >= 0,
    '父页面读不到 iframe 内容（跨源隔离）');
}

head('源码按需取：打开页面时不打多余请求');
{
  ok(hit('raw=1').length === 0, '打开分享页只请求了 ?doc=1（没有预先拉全文）', hit('raw=1').map(r => r.url));
  await cdp.eval("document.getElementById('bSrc').click()");
  await sleep(800);
  ok(await cdp.eval("document.getElementById('src').hidden") === false, '点「源码」显示源码视图');
  ok(await cdp.eval("document.getElementById('frame').hidden") === true, '源码视图下 iframe 隐藏');
  ok(hit('raw=1').length > 0, '这时才请求 ?raw=1');
  const srcText = await cdp.eval("document.getElementById('src').textContent");
  ok(srcText.indexOf('HTML 预览探针') >= 0, '源码里有正文');
  ok(srcText.indexOf('<script>') >= 0, '源码里能看到原始 script 标签（纯文本，不执行）');
  ok(srcText.indexOf('<base ') < 0, '源码是"没有 base 的原文"（base 只加在渲染用的真文档上）');
  await cdp.eval("document.getElementById('bView').click()");
  await sleep(400);
  ok(await cdp.eval("document.getElementById('frame').hidden") === false, '点「渲染」切回预览');
}

head('?raw=1 / ?dl=1 / ?doc=1');
{
  const raw = await fetch(shareUrl + '?raw=1');
  ok((raw.headers.get('content-type') || '').indexOf('text/plain') === 0, '?raw=1 是纯文本', raw.headers.get('content-type'));
  const rawTxt = await raw.text();
  ok(rawTxt.indexOf('<script>') >= 0 && rawTxt.indexOf('HTML 预览探针') >= 0, '?raw=1 返回原始源码');
  const dl = await fetch(shareUrl + '?dl=1');
  ok(/attachment/.test(dl.headers.get('content-disposition') || ''), '?dl=1 是下载', dl.headers.get('content-disposition'));
  await dl.arrayBuffer();
  const docResp = await fetch(shareUrl + '?doc=1');
  const csp = docResp.headers.get('content-security-policy') || '';
  ok(docResp.headers.get('x-frame-options') === null, '?doc=1 没有 X-Frame-Options（改由 CSP 的 frame-ancestors 管）');
  ok(csp.indexOf("script-src 'none'") >= 0, '?doc=1 带 script-src none 的 CSP', csp.slice(0, 60));
  await docResp.text();
}

head('截图与异常');
{
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('.workbuddy/tests/shots/html-share-shell.png', Buffer.from(shot.data, 'base64'));
  ok(true, '截图已存 shots/html-share-shell.png（背景变红 = outer.css 生效）');
  ok(exceptions.length === 0, '页面无 JS 异常', exceptions);
}

// ---- 清理 ----
try { ws.close(); } catch (e) {}
proc.kill();
srv.kill();
rmSync(PROFILE, { recursive: true, force: true });

console.log(fail ? `\n❌ 失败 ${fail} 项` : `\n✅ 浏览器验收全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
