// 量一下 PC 视口下各容器的实际位置，定位"左侧空白"
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-probe-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9336/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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

for (const W of [1080, 1366, 1440, 1600, 1920]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp.send('Page.navigate', { url: ADMIN }, sid);
  await sleep(300);
  for (let i = 0; i < 50; i++) { try { if (await ev('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length>0')) break; } catch (e) {} await sleep(200); }
  const m = await ev(`(function(){
    function r(sel){ var e = document.querySelector(sel); if(!e) return null;
      var b = e.getBoundingClientRect(); var cs = getComputedStyle(e);
      return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), bg: cs.backgroundColor, mw: cs.maxWidth, mg: cs.marginLeft + '/' + cs.marginRight }; }
    return {
      innerW: window.innerWidth,
      docScrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      header: r('header'),
      layout: r('.layout'),
      aside: r('aside'),
      main: r('main'),
      wrap: r('.wrap'),
      list: r('#list'),
      table: r('#list table'),
      brand: r('.brand'),
      sideSearch: r('.side-search input'),
      tableFirstTd: r('#list tbody tr td')
    };
  })()`);
  console.log('\n===== 视口 ' + W + 'px =====');
  console.log('  innerWidth=' + m.innerW + '  documentElement.scrollWidth=' + m.docScrollW + '  body.scrollWidth=' + m.bodyScrollW);
  for (const k of ['header', 'layout', 'aside', 'main', 'wrap', 'list', 'table', 'brand', 'sideSearch', 'tableFirstTd']) {
    const v = m[k];
    if (!v) { console.log('  ' + k + ': (不存在)'); continue; }
    console.log('  ' + k.padEnd(12) + ' left=' + String(v.l).padStart(5) + ' right=' + String(v.r).padStart(5) +
      ' width=' + String(v.w).padStart(5) + '  bg=' + v.bg + (v.mw !== 'none' ? '  maxWidth=' + v.mw : '') + '  marginL/R=' + v.mg);
  }
  const asideR = m.aside ? m.aside.r : 0;
  const tableL = m.table ? m.table.l : 0;
  console.log('  → 侧栏右边缘 ' + asideR + ' ／ 表格左边缘 ' + tableL + ' ／ 表格与侧栏间隙 ' + (tableL - asideR) + 'px');
  console.log('  → 侧栏左边距（视口左到 aside）: ' + (m.aside ? m.aside.l : -1) + 'px   ← 这一段若是灰底就是"左侧空白"');
  console.log('  → header 内容起始 ' + (m.brand ? m.brand.l : -1) + ' ／ 侧栏内容起始 ' + (m.sideSearch ? m.sideSearch.l : -1) + '  差值 ' + ((m.sideSearch && m.brand) ? (m.sideSearch.l - m.brand.l) : 'n/a'));
}
try { ws.close(); proc.kill(); } catch (e) {}
