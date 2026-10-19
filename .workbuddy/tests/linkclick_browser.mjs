// 存档页里的「链接点击」行为验收（无头 Chrome + 真实鼠标事件）。
//
// 为什么单独一套：程序化 element.click() 没有"用户激活"，弹窗会被浏览器拦，结论不可信 ——
// 必须用 Input.dispatchMouseEvent 发真实鼠标事件。
//
// 这套测试锁住的是一条曾被踩坏的行为：注入的 <base> 不带 target="_blank" 时，
// 点一个"没有 target 的外链"会让沙箱 iframe 自身开始导航 → 被壳页面 CSP 的
// frame-src 'self' 拦下 → Chrome 把整个正文帧换成 chrome-error:// 错误页，
// 存档当场废掉（论坛类页面 90% 以上的正文链接都不带 target，命中率极高）。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 8899);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const LIVE_PORT = 8902;
const CDP_PORT = 9342;
const PROFILE = TMP + '/cfwtxt-linkclick-profile-' + process.pid;
const shots = HERE + '/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// ---- "外站"：另一台本地服务，与壳页面不同源，等价于真实外链目标 ----
const liveSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset=utf-8><title>LIVE</title><h1 id=live>原站</h1>');
});
await new Promise(r => liveSrv.listen(LIVE_PORT, '127.0.0.1', r));

// ---- 桥接服务 ----
const srv = spawn(process.execPath, ['serve.mjs'], { cwd: '.workbuddy/tests', stdio: 'pipe', env: process.env });
let ready = false;
srv.stdout.on('data', d => { if (String(d).indexOf('READY') >= 0) ready = true; });
srv.stderr.on('data', d => process.stderr.write('[serve] ' + d));
for (let i = 0; i < 80 && !ready; i++) await sleep(250);
ok(ready, '桥接服务已启动');
if (!ready) { srv.kill(); liveSrv.close(); process.exit(1); }

// ---- Chrome ----
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  // 不开这个，沙箱 iframe 的事件/日志走独立 target，页面会话收不到
  '--disable-site-isolation-trials', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
    if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; }
  } catch (e) {}
  if (!wsUrl) await sleep(250);
}
ok(!!wsUrl, 'Chrome 调试端口就绪');
if (!wsUrl) { proc.kill(); srv.kill(); liveSrv.close(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
let id = 0; const pending = new Map(); const handlers = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method) for (const h of handlers) h(m);
});
const send = (method, params) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 20000); });
};
const logs = [];
handlers.push(m => {
  if (m.method === 'Log.entryAdded') logs.push(m.params.entry.level + ': ' + m.params.entry.text);
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + (m.params.args || []).map(a => a.value || a.description || '').join(' '));
});
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

const targets = async () => await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
let childCtx = null;
async function childFrameId() {
  const t = await send('Page.getFrameTree');
  const cs = t.frameTree.childFrames || [];
  return cs.length ? cs[0].frame.id : null;
}
async function frameTreeText() {
  const t = await send('Page.getFrameTree');
  const out = [];
  (function walk(n, d) { out.push((d ? 'child:' : 'top:') + (n.frame.url || '(empty)')); (n.childFrames || []).forEach(c => walk(c, d + 1)); })(t.frameTree, 0);
  return out.join(' | ');
}
async function evalInChild(expr) {
  const fid = await childFrameId();
  if (!fid) throw new Error('没有子 frame');
  if (!childCtx) { const w = await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'probe' }); childCtx = w.executionContextId; }
  const r = await send('Runtime.evaluate', { expression: expr, contextId: childCtx, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXP';
  return r.result.value;
}
async function mouseClickInChild(sel) {
  const box = await evalInChild('(function(){var a=document.querySelector("' + sel + '");if(!a)return "none";var r=a.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()');
  if (box === 'none') return false;
  const p = JSON.parse(box);
  const pt = { x: p.x, y: p.y + 44 };          // iframe 顶在 44px 工具栏之下
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  return true;
}
async function open(shareUrl) {
  childCtx = null;
  const loaded = new Promise(res => { const h = m => { if (m.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(h), 1); res(); } }; handlers.push(h); });
  await send('Page.navigate', { url: shareUrl });
  await Promise.race([loaded, sleep(8000)]);
  await sleep(1200);
}
async function shot(name) {
  try { mkdirSync(shots, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shots + '/' + name, Buffer.from(r.data, 'base64')); } catch (e) {}
}
const mkShare = async p => (await (await fetch(ORIGIN + '/adm-123/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'share', path: p })
})).json());
void readFileSync;

// ============ 1) 带 <head> 的文档 ============
const s1 = await mkShare('笔记/链接.html');
const u1 = ORIGIN + '/s/' + s1.token + '/' + encodeURIComponent('链接.html');
head('单文件分享 → 壳页面 + 真文档 iframe');
await open(u1);
{
  const tree = await frameTreeText();
  ok(tree.indexOf('?doc=1') >= 0, 'iframe 加载的是 ?doc=1 真文档（不是 srcdoc）', tree);
  ok(await evalInChild('document.title') === '链接探针', '子文档正常渲染');
  ok((await evalInChild('document.baseURI')).indexOf('/s/' + s1.token + '/') >= 0,
    '注入的 base 生效（baseURI 指向分享目录）', await evalInChild('document.baseURI'));
}

head('无 target 的外链：必须开新标签，正文帧绝不能被顶掉');
{
  const before = await evalInChild('location.href');
  const n0 = (await targets()).length;
  const from = logs.length;
  ok(await mouseClickInChild('#same'), '鼠标点到了链接');
  await sleep(2500);
  const after = await evalInChild('location.href + "|" + document.title');
  ok(after === before + '|链接探针', '正文帧纹丝不动（不再是 chrome-error:// 错误页）', after);
  ok(after.indexOf('chrome-error') < 0, '没有出现 chrome-error');
  const n1 = (await targets()).length;
  ok(n1 > n0, '确实开了新标签（target=_blank 生效）', [n0, n1]);
  const urls = (await targets()).map(t => t.url || '');
  ok(urls.some(u => u.indexOf(':' + LIVE_PORT + '/live.html') >= 0), '新标签打开的是外链目标', urls.filter(u => u.indexOf('live') >= 0));
  const csp = logs.slice(from).filter(l => l.indexOf('frame-src') >= 0);
  ok(csp.length === 0, '没有 frame-src 拦截日志（说明根本没去导航本帧）', csp);
  await shot('linkclick-unshared-newtab.png');
}

head('原本带 target=_blank 的外链：照常开新标签');
{
  await open(u1);
  const n0 = (await targets()).length;
  await mouseClickInChild('#blank');
  await sleep(2500);
  const n1 = (await targets()).length;
  ok(n1 > n0, '开了新标签', [n0, n1]);
  ok((await evalInChild('document.title')) === '链接探针', '正文帧不受影响');
}

// ============ 2) 无 <head> 的文档（SingleFile 抓的页面就长这样）============
head('无 <head> 的文档：注入点在 <!doctype> 之后，base 仍须生效');
{
  const s2 = await mkShare('笔记/无head.html');
  await open(ORIGIN + '/s/' + s2.token + '/' + encodeURIComponent('无head.html'));
  ok((await evalInChild('document.baseURI')) === ORIGIN + '/s/' + s2.token + '/',
    '浏览器把 <base> 挪进了 head，baseURI 正确', await evalInChild('document.baseURI'));
  ok((await evalInChild('document.getElementById("rel").href')) === ORIGIN + '/s/' + s2.token + '/live3.html',
    '相对链接按分享目录解析', await evalInChild('document.getElementById("rel").href'));
  const n0 = (await targets()).length;
  await mouseClickInChild('#rel');
  await sleep(2500);
  ok((await targets()).length > n0, '相对外链也走新标签');
  ok((await evalInChild('document.title || ""')) !== 'LIVE', '正文帧没有变成外站');
}

console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 链接点击验收全部通过（' + pass + ' 项）');
ws.close(); proc.kill(); srv.kill(); liveSrv.close();
process.exit(fail ? 1 : 0);
