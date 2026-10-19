// 量证：编辑器文本框是否铺满可用高度（PC + 移动端），用一个只有两行的文件测最明显
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-probe4-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9345', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9345/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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
async function exists(c) { return await ev('(function(){try{return !!(' + c + ');}catch(e){return false;}})()'); }
async function waitFor(c, ms) { const n = Math.ceil((ms || 8000) / 150); for (let i = 0; i < n; i++) { if (await exists(c)) return; await sleep(150); } throw new Error('超时 ' + c); }

const MEASURE = `(function(){
  var edt = document.getElementById('edt');
  var foot = document.querySelector('#viewEdit .editFoot');
  var wrap = document.getElementById('viewEdit');
  var tr = edt.getBoundingClientRect();
  var fr = foot ? foot.getBoundingClientRect() : { top:0, bottom:0, height:0 };
  return {
    view: state.view, vh: window.innerHeight,
    edtTop: Math.round(tr.top), edtBottom: Math.round(tr.bottom), edtH: Math.round(tr.height),
    footBottom: Math.round(fr.bottom), footH: Math.round(fr.height),
    padBottom: parseInt(getComputedStyle(wrap).paddingBottom, 10) || 0,
    bodyScrollH: document.body.scrollHeight, docScrollH: document.documentElement.scrollHeight,
    gapBelowEdt: Math.round(window.innerHeight - tr.bottom),
    wastedAtBottom: Math.round(window.innerHeight - fr.bottom - (parseInt(getComputedStyle(wrap).paddingBottom, 10) || 0))
  };
})()`;

async function setupAndMeasure(label, w, h, mobile) {
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 }, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }, sid);
  await sleep(400);
  await ev('load("笔记", true)');
  await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000);
  await ev('openFile("纯文本.txt")');            // 只有两行 —— 最容易看出底部空白
  await waitFor('document.getElementById("edt").value.length > 0', 8000);
  await sleep(700);
  const d = await ev(MEASURE);
  console.log('\n[' + label + '] 视口 ' + w + 'x' + h);
  console.log('  #edt 高 ' + d.edtH + 'px（顶 ' + d.edtTop + ' → 底 ' + d.edtBottom + '）');
  console.log('  文本框下方到状态栏底部：' + d.gapBelowEdt + 'px（状态栏本身 ' + d.footH + 'px + 内边距 ' + d.padBottom + 'px）');
  console.log('  底部"纯浪费"的空白 = ' + d.wastedAtBottom + 'px');
  console.log('  文档高 ' + d.docScrollH + ' / 视口 ' + d.vh + ' → ' + (d.docScrollH <= d.vh + 2 ? '没有多余滚动 ✅' : '多出 ' + (d.docScrollH - d.vh) + 'px 滚动 ❌'));
  console.log('  ' + (d.wastedAtBottom <= 20 ? '✅ 文本框基本铺满' : '❌ 底部还空着 ' + d.wastedAtBottom + 'px'));
  return d;
}

await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(500);
await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 12000);

const pc = await setupAndMeasure('PC 1440×900', 1440, 900, false);
const ph = await setupAndMeasure('手机 390×844', 390, 844, true);
const small = await setupAndMeasure('小窗口 1024×620', 1024, 620, false);

try { ws.close(); proc.kill(); } catch (e) {}
console.log('\n结论：' + ((pc.wastedAtBottom <= 20 && ph.wastedAtBottom <= 20 && small.wastedAtBottom <= 20)
  ? '三种尺寸下文本框都铺满了可用高度 ✅' : '仍有尺寸没铺满 ❌'));
