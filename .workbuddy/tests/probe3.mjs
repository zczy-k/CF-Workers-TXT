// 定位"打开文件后焦点为什么在 textarea"
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-probe3-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9343', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9343/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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

const who = () => ev('document.activeElement ? (document.activeElement.tagName + "#" + (document.activeElement.id || "") ) : "null"');
const exists = (c) => ev('(function(){try{return !!(' + c + ');}catch(e){return false;}})()');
async function waitFor(c, ms) { const n = Math.ceil((ms || 8000) / 150); for (let i = 0; i < n; i++) { if (await exists(c)) return; await sleep(150); } throw new Error('超时 ' + c); }

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(500);
await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000);

console.log('--- 打开前 ---');
console.log('  视图 =', await ev('state.view'), '| 焦点 =', await who());

await ev('document.getElementById("edt").blur()');
console.log('  blur 之后焦点 =', await who());

await ev('openFile("说明.md")');
console.log('\n--- 打开文件后 ---');
for (const ms of [0, 30, 60, 120, 300, 700, 1400]) {
  if (ms) await sleep(ms);
  console.log('  +' + ms + 'ms 焦点 =', await who(), '| viewEdit.hidden =', await ev('document.getElementById("viewEdit").hidden'));
}

// 谁在 focus？挂个钩子看调用栈
const hooked = await ev(`(function(){
  var t = document.getElementById('edt');
  if (!t || t.__hooked) return 'already';
  t.__hooked = true;
  window.__focusStack = [];
  var orig = t.focus;
  t.focus = function(){
    try { throw new Error('focus'); } catch (e) { window.__focusStack.push(e.stack.split(String.fromCharCode(10)).slice(1, 4).join(' | ')); }
    return orig.apply(this, arguments);
  };
  return 'ok';
})()`);
console.log('\n钩子安装:', hooked);
await ev('load("笔记")', true);
await sleep(600);
await ev('openFile("说明.md")');
await sleep(1200);
const st = await ev('window.__focusStack || []');
console.log('捕获到的 focus 调用栈：');
if (!st.length) console.log('  （没有捕获到 —— 说明不是 JS 调的 focus）');
st.forEach((s, i) => console.log('  [' + i + '] ' + s));
console.log('\n最终焦点 =', await who());

try { ws.close(); proc.kill(); } catch (e) {}
