// 出移动端实拍图：长按进多选 → 点行勾选 → 底部批量条
// 用 CDP 的真实触摸事件（Input.dispatchTouchEvent），不是脚本伪造的 PointerEvent，
// 这样长按走的是浏览器完整的手势识别链路，能顺带验证"长按补发的 click 会被吞掉"。
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
const PROFILE = TMP + '/cfwtxt-cfwtxt-shot-m-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9341', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9341/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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
// 行内某点的坐标（默认取文件名链接中心，也就是手指最可能按的地方）
async function ptOf(idx, sel) {
  return await ev(`(function(){
    var tr = document.querySelectorAll('#list tbody tr')[${idx}];
    var el = tr.querySelector(${JSON.stringify(sel || 'a[data-open]')}) || tr;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 70)), y: Math.round(r.top + r.height / 2) };
  })()`);
}
async function longPress(idx) {
  const p = await ptOf(idx);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }, sid);
  await sleep(600);                                   // > 380ms 长按阈值
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
  await sleep(450);
}
async function tap(idx) {
  const p = await ptOf(idx);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 2 }] }, sid);
  await sleep(60);                                    // 短按，不会触发长按
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
  await sleep(300);
}

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(500);
await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 9', 12000);
await ev('setSort("name", false)');
await sleep(700);

console.log('\n[手机] 列表本身：复选框放大到 21px 作为多选的常驻可见入口，操作区只有 6 个按钮');
await shot('m1-list');

console.log('[手机] 长按文件名 → 进入多选模式（该行已选中 + 底部批量条弹出）');
await longPress(1);
const st1 = await ev('({ multi: state.multi, sel: Object.keys(state.sel).length, view: state.view })');
console.log('  长按后状态：' + JSON.stringify(st1) + (st1.multi && st1.sel === 1 && st1.view === 'list' ? '  ✅ 长按生效且没打开文件' : '  ❌ 异常'));
await shot('m2-longpress-multi');

console.log('[手机] 多选模式下点其它行 = 加选（不会打开文件）');
await tap(3);
await tap(5);
const st2 = await ev('({ multi: state.multi, sel: Object.keys(state.sel).length, view: state.view })');
console.log('  加选两行后：' + JSON.stringify(st2) + (st2.sel === 3 && st2.view === 'list' ? '  ✅ 共 3 项' : '  ❌ 异常'));
await shot('m3-multi-three');

console.log('[手机] 编辑器：顶栏面包屑 + 顶部路径条（点任一目录级即可跳过去）');
await ev('exitMulti()');
await sleep(400);
await tap(1);                                  // 点第一行的文件名打开它
await sleep(1800);
const ed = await ev(`(function(){
  return { view: state.view,
           crumbText: (document.getElementById('edCrumb') || {}).textContent || '',
           crumbLinks: document.querySelectorAll('#edCrumb a[data-nav]').length,
           topCrumbVisible: getComputedStyle(document.getElementById('crumb')).display !== 'none',
           noSharePanel: document.getElementById('sharePanel') === null,
           focused: document.activeElement === document.getElementById('edt') };
})()`);
console.log('  ' + JSON.stringify(ed));
console.log('  ' + (ed.view === 'edit' ? '✅ 已进入编辑器' : '❌ 没进编辑器') +
  ' / ' + (ed.crumbLinks >= 2 ? '✅ 路径条有可点目录' : '❌ 路径条异常') +
  ' / ' + (ed.noSharePanel ? '✅ 已无分享设置面板' : '❌ 面板还在') +
  ' / ' + (ed.focused ? '❌ 自动聚焦了（会弹键盘）' : '✅ 没有自动弹键盘'));
await shot('m4-editor-crumb');

try { ws.close(); proc.kill(); } catch (e) {}
console.log('\n截图目录：' + OUT);
