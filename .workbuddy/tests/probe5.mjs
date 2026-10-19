// 调试：图标解码与 SW 状态，在页面内先 JSON.stringify 再回传，排除 CDP 序列化干扰
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-probe5-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9347', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9347/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
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
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(c, ms) { const n = Math.ceil((ms || 8000) / 150); for (let i = 0; i < n; i++) { try { if (await ev('(function(){try{return !!(' + c + ');}catch(e){return false;}})()')) return; } catch (e) {} await sleep(150); } throw new Error('超时 ' + c); }

await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(500);
await waitFor('typeof openFile === "function"', 12000);
await sleep(800);

const raw = await ev(`(function(){
  function ser(v){ try { return JSON.stringify(v); } catch (e) { return 'SER_FAIL: ' + e; } }
  return new Promise(function(res){
    var out = {};
    out.swSupported = ser('serviceWorker' in navigator);
    out.proto = location.protocol;
    out.host = location.hostname;
    var img = new Image();
    img.onload = function(){ out.icon = ser({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); done(); };
    img.onerror = function(ev2){ out.icon = ser({ ok: false, ev: 'error' }); done(); };
    setTimeout(function(){ if (!out.icon){ out.icon = ser({ ok: false, ev: 'timeout' }); done(); } }, 9000);
    img.src = '/icon/512.png?probe=' + Date.now();
    function done(){
      if (!('serviceWorker' in navigator)){ out.sw = 'unsupported'; return res(JSON.stringify(out)); }
      navigator.serviceWorker.getRegistration('/').then(function(reg){
        out.regExists = ser(!!reg);
        if (!reg) return res(JSON.stringify(out));
        navigator.serviceWorker.ready.then(function(r){
          out.ready = ser({ scope: r.scope, state: r.active && r.active.state });
          setTimeout(function(){
            out.controlled = ser(!!navigator.serviceWorker.controller);
            res(JSON.stringify(out));
          }, 1200);
        }).catch(function(e){ out.ready = 'ERR ' + e; res(JSON.stringify(out)); });
      }).catch(function(e){ out.regExists = 'ERR ' + e; res(JSON.stringify(out)); });
    }
  });
})()`);
console.log('页面内序列化结果：');
const o = JSON.parse(raw);
for (const k of Object.keys(o)) console.log('  ' + k + ' = ' + o[k]);

try { ws.close(); proc.kill(); } catch (e) {}
