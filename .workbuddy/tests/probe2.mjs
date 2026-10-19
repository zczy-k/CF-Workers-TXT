// 量证：分享设置下方的空白到底是谁撑出来的
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-p2-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9338', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9338/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(400);
for (let i = 0; i < 60; i++) { try { if (await ev('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length>0')) break; } catch (e) {} await sleep(200); }

// 直接构造一个 200 行的长文件（用户截图里是 142 行）
await ev(`(function(){
  switchView('edit');
  var t = document.getElementById('edt');
  var lines = [];
  for (var i = 1; i <= 200; i++) lines.push('    "第 ' + i + ' 行内容"，这是一段用来把编辑器撑高的文本。');
  t.value = lines.join(String.fromCharCode(10));
  ed.name = '长文件.json'; ed.path = '笔记/长文件.json'; ed.dirty = false;
  syncGutter(); updateCount();
})()`, true);
await sleep(700);

const m = await ev(`(function(){
  var main = document.querySelector('main');
  var mir = document.getElementById('edMirror');
  var edt = document.getElementById('edt');
  var box = function(e){ if(!e) return null; var b=e.getBoundingClientRect(); var cs=getComputedStyle(e);
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height),
             pos: cs.position, vis: cs.visibility, disp: cs.display, ovf: cs.overflow,
             scrollH: e.scrollHeight, clientH: e.clientHeight }; };
  var sec = document.querySelector('#viewEdit .sec');
  return {
    viewport: window.innerHeight,
    main: box(main),
    edt: box(edt),
    mirror: box(mir),
    sharePanelBottom: sec ? Math.round(sec.getBoundingClientRect().bottom) : -1,
    mirrorLines: mir ? mir.children.length : -1,
    docScroll: document.documentElement.scrollHeight,
    bodyScroll: document.body.scrollHeight
  };
})()`);
console.log('\n视口高度 ' + m.viewport);
console.log('main   : clientH=' + m.main.clientH + '  scrollH=' + m.main.scrollH + '  overflow=' + m.main.ovf);
console.log('#edt   : h=' + m.edt.h + ' clientH=' + m.edt.clientH + ' scrollH=' + m.edt.scrollH);
console.log('#mirror: top=' + m.mirror.top + ' bottom=' + m.mirror.bottom + ' h=' + m.mirror.h +
  ' clientH=' + m.mirror.clientH + ' scrollH=' + m.mirror.scrollH + ' pos=' + m.mirror.pos + ' ovf=' + m.mirror.ovf);
console.log('#mirror 行数=' + m.mirrorLines);
console.log('分享设置面板底边 = ' + m.sharePanelBottom);
console.log('\n→ main 可滚动多余高度 = ' + (m.main.scrollH - m.main.clientH) + 'px');
console.log('→ 空白起点 ≈ ' + m.sharePanelBottom + '，可滚到 ' + m.main.scrollH +
  '，即分享设置下方有 ' + (m.main.scrollH - m.sharePanelBottom) + 'px 空白');
console.log('→ 结论：' + (m.mirror.bottom > m.viewport + 50
  ? '镜像层 #edMirror 撑出了 ' + (m.mirror.bottom - m.viewport) + 'px 的可滚动空白'
  : '镜像层不是主因'));

try { ws.close(); proc.kill(); } catch (e) {}
