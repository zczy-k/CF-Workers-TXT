// 出实拍图：类型列 + 排序 + 侧栏调宽 + 框选 + 编辑器无空白
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const OUT = HERE + '/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-shot-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
try { rmSync(OUT, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9339/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }); }
  send(method, params, sid) { const id = ++this.id; const p = { id, method, params: params || {} }; if (sid) p.sessionId = sid;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); }
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Page.enable', {}, sid);
const ev = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
async function waitFor(c, ms) { const n = Math.ceil((ms || 8000) / 150); for (let i = 0; i < n; i++) { try { if (await ev('(function(){try{return !!(' + c + ');}catch(e){return false;}})()')) return; } catch (e) {} await sleep(150); } throw new Error('超时 ' + c); }
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
  writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.data, 'base64'));
  console.log('  已保存 ' + name + '.png');
}

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 940, deviceScaleFactor: 1, mobile: false }, sid);
await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(400);
await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 9', 12000);
await ev('setSort("name", false)');
await sleep(700);
console.log('\n[列表] 类型列 + 排序控件 + 后缀徽标');
await shot('01-list-type-sort');

console.log('[排序] 按大小降序（表头箭头 + 下拉同步）');
await ev('document.querySelector("#list thead th[data-sortby=size]").click()');
await sleep(800);
await shot('02-sorted-by-size');

console.log('[侧栏] 一键按最长文件名自适应，全名不再被截断');
await ev('setSideW(210)');
await sleep(400);
await shot('03-side-narrow');
await ev('fitSideW()');
await sleep(700);
await shot('04-side-fitted');

console.log('[框选] 拖出橡皮筋批量选择');
await ev('setSort("name", false)');
await sleep(700);
await ev('clearSel()');
const geo = await ev(`(function(){
  var rs = document.querySelectorAll('#list tbody tr');
  var a = rs[0].getBoundingClientRect(), b = rs[4].getBoundingClientRect();
  return { x0: Math.round(a.left + 4), x1: Math.round(a.left + 520),
           y0: Math.round(a.top + 5), y1: Math.round(b.bottom - 5) };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x0, y: geo.y0, button: 'left', clickCount: 1 }, sid);
for (let i = 1; i <= 5; i++) {
  const y = Math.round(geo.y0 + (geo.y1 - geo.y0) * i / 5);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x1, y, button: 'left', buttons: 1 }, sid);
  await sleep(60);
}
await sleep(300);
await shot('05-marquee-select');
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x1, y: geo.y1, button: 'left', clickCount: 1 }, sid);
await sleep(300);

console.log('[操作折叠] 每行一个 ⋯ 按钮，点开弹出完整操作菜单');
await ev('clearSel()');
await ev('load("笔记")', true);
await sleep(900);
const rowGeo = await ev(`(function(){
  var tr = document.querySelectorAll('#list tbody tr')[1];
  var r = tr.getBoundingClientRect();
  var br = tr.querySelector('button.tact').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           bx: Math.round(br.left + br.width / 2), by: Math.round(br.top + br.height / 2) };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowGeo.x, y: rowGeo.y }, sid);
await sleep(350);
await shot('08-row-ellipsis');
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowGeo.bx, y: rowGeo.by, button: 'left', clickCount: 1 }, sid);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowGeo.bx, y: rowGeo.by, button: 'left', clickCount: 1 }, sid);
await sleep(450);
await shot('09-row-menu');
await ev('closeCtx()');
await sleep(250);

console.log('[分享管理] 文件名可点 + ↗ 打开图标');
await ev(`(function(){
  post({ action: 'share', path: '笔记/说明.md', expiresIn: 86400 }).then(function(){ reloadShares(); });
})()`);
await sleep(1600);
await ev('openShareManager()');
await sleep(1300);
await shot('10-share-manager');
await ev('closeModal()');
await sleep(250);

console.log('[搜索] 目录名命中：文件夹本体排最前 + 路径命中如实标注');
await ev('load("", true)');
await sleep(800);
await ev(`(function(){
  document.getElementById('q').value = '笔记';
  runSearch('笔记');
})()`);
await sleep(1500);
await shot('11-search-dir');
await ev(`(function(){ document.getElementById('q').value = ''; })()`);
await sleep(300);

console.log('[编辑器] 短文件：文本框铺满可用高度 + 顶部路径条');
await ev('openFile("纯文本.txt")');            // 只有两行，最能看出下方有没有大片空白
await waitFor('document.getElementById("edt").value.length > 0', 8000);
await sleep(900);
const fill = await ev(`(function(){
  var edt = document.getElementById('edt');
  var foot = document.querySelector('#viewEdit .editFoot');
  var wrap = document.getElementById('viewEdit');
  var pad = parseInt(getComputedStyle(wrap).paddingBottom, 10) || 0;
  return { edtH: Math.round(edt.getBoundingClientRect().height), vh: window.innerHeight,
           wasted: Math.round(window.innerHeight - foot.getBoundingClientRect().bottom - pad),
           crumb: document.getElementById('edCrumb').textContent };
})()`);
console.log('  文本框 ' + fill.edtH + 'px / 视口 ' + fill.vh + 'px；底部浪费 ' + fill.wasted + 'px；路径条「' + fill.crumb + '」');
await shot('06-editor-fill');

console.log('[编辑器] 长文件：撑满之后内部照常滚动，底部依然没有空白');
await ev(`(function(){
  var t = document.getElementById('edt');
  var lines = [];
  for (var i = 1; i <= 300; i++) lines.push('    "id": "169' + i + '4192601261614' + i + '",');
  t.value = lines.join(String.fromCharCode(10));
  syncGutter(); updateCount();
})()`, true);
await sleep(800);
const longInfo = await ev(`(function(){
  var t = document.getElementById('edt');
  var foot = document.querySelector('#viewEdit .editFoot');
  var wrap = document.getElementById('viewEdit');
  var pad = parseInt(getComputedStyle(wrap).paddingBottom, 10) || 0;
  return { box: t.clientHeight, inner: t.scrollHeight,
           wasted: Math.round(window.innerHeight - foot.getBoundingClientRect().bottom - pad) };
})()`);
console.log('  文本框可见高 ' + longInfo.box + 'px，内容高 ' + longInfo.inner + 'px（内部滚动）；底部浪费 ' + longInfo.wasted + 'px');
await shot('07-editor-long');
console.log('  点路径条上的目录能直接跳过去：' + (await ev('!!document.querySelector("#edCrumb a[data-nav]")') ? '是' : '否'));

try { ws.close(); proc.kill(); } catch (e) {}
console.log('\n截图目录：' + OUT);
