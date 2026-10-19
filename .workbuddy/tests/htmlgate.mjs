// P2 回归：大 HTML 不自动渲染，点「渲染」才按需建 iframe。
// 静态检查只能证明代码写着门控，证明不了「真的没自动渲染 + 点了真的能渲染」。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const TOKEN = readFileSync(HERE + '/share.txt', 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-htmlgate-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9343',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch('http://127.0.0.1:9343/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {}
  await sleep(250);
}
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
async function waitFor(c, ms) { const n = Math.ceil((ms || 8000) / 150);
  for (let i = 0; i < n; i++) { try { if (await ev('(function(){try{return !!(' + c + ');}catch(e){return false;}})()')) return; } catch (e) {}
    await sleep(150); } throw new Error('超时 ' + c); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp.send('Page.navigate', { url: ORIGIN + '/s/' + TOKEN }, sid);
  await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 15000);

  // ---------- 大 HTML：应默认落到源码，不自动渲染 ----------
  console.log('\n[大 HTML] 打开后不应自动渲染');
  await ev('openFile("大页面.html")');
  await sleep(1800);
  const g = await ev(`(function(){
    var rbox = document.getElementById('vRender');
    var box = document.getElementById('viewer');
    var note = document.getElementById('vNote');
    var seg = document.getElementById('vSeg');
    var richBtn = seg ? seg.querySelector('[data-vmode="rich"]') : null;
    return {
      hasIframe: !!document.querySelector('#vRender iframe'),
      rboxEmpty: rbox ? rbox.innerHTML.length === 0 : false,
      rboxHidden: rbox ? rbox.hidden : false,
      srcVisible: box ? !box.hidden : false,
      srcLen: box ? box.textContent.length : 0,
      noteText: note ? note.textContent : '',
      hasRichBtn: !!richBtn,
      richOn: richBtn ? richBtn.className.indexOf('on') >= 0 : false,
      srcOn: seg && seg.querySelector('[data-vmode="src"]') ? seg.querySelector('[data-vmode="src"]').className.indexOf('on') >= 0 : false
    };
  })()`);
  ok(!g.hasIframe, '大 HTML 打开后没有 iframe（没有自动渲染）');
  ok(g.rboxEmpty && g.rboxHidden, '渲染层是空的且隐藏');
  ok(g.srcVisible, '源码层可见（默认给源码）');
  ok(g.srcLen > 500000, '源码层装的是完整原文（' + g.srcLen + ' 字符）');
  ok(/文件较大/.test(g.noteText), '提示了「文件较大」（note: ' + g.noteText.slice(0, 30) + '…）');
  ok(g.hasRichBtn && !g.richOn && g.srcOn, '露出「渲染 / 源码」切换，且当前停在「源码」');

  // ---------- 点「渲染」：这时才建 iframe ----------
  console.log('\n[大 HTML] 点「渲染」后按需建 iframe');
  await ev('document.querySelector("#vSeg [data-vmode=rich]").click()');
  await waitFor('document.querySelector("#vRender iframe")', 15000);
  await sleep(1600);
  const r = await ev(`(function(){
    var f = document.querySelector('#vRender iframe');
    var rbox = document.getElementById('vRender');
    var box = document.getElementById('viewer');
    return {
      hasIframe: !!f,
      srcdocLen: f ? (f.srcdoc || '').length : 0,
      src: f ? (f.getAttribute('src') || '') : '',
      sandbox: f ? (f.getAttribute('sandbox') || '') : '',
      cls: rbox ? rbox.className : '',
      rVisible: rbox ? !rbox.hidden : false,
      srcHidden: box ? box.hidden : false,
      w: f ? f.getBoundingClientRect().width : 0,
      h: f ? f.getBoundingClientRect().height : 0
    };
  })()`);
  ok(r.hasIframe, '点「渲染」后建出了 iframe');
  // 预览已改为**真文档模式**：iframe 直接加载服务端的 /?doc=1，而不是把原文塞进 srcdoc。
  // 换成真实 URL 之后，页面自己的 css / 图片才会按正常规则解析并加载（srcdoc 的基准是 about:srcdoc）。
  ok(r.src.indexOf('?doc=1') >= 0, 'iframe 走真文档模式（src 带 ?doc=1）', r.src.slice(0, 90));
  ok(r.srcdocLen === 0, '不再用 srcdoc 注入原文（' + r.srcdocLen + ' 字符）');
  ok(!/allow-scripts|allow-same-origin/.test(r.sandbox), '按需渲染的 iframe 依旧安全（sandbox 不含 scripts/same-origin）');
  ok(r.cls.indexOf('htmlBox') >= 0, '容器切到 htmlBox');
  ok(r.rVisible && r.srcHidden, '渲染层显示、源码层隐藏');
  ok(r.w > 400 && r.h > 200, 'iframe 有实际尺寸（' + Math.round(r.w) + '×' + Math.round(r.h) + '）');

  // ---------- 小 HTML：照旧直接渲染（门控不该误伤） ----------
  console.log('\n[小 HTML] 照旧直接渲染，不受门控影响');
  await ev('openFile("页面.html")');
  await waitFor('document.querySelector("#vRender iframe")', 10000);
  await sleep(1000);
  const s = await ev(`(function(){
    var f = document.querySelector('#vRender iframe');
    var note = document.getElementById('vNote');
    var seg = document.getElementById('vSeg');
    var richBtn = seg ? seg.querySelector('[data-vmode="rich"]') : null;
    return {
      hasIframe: !!f,
      rVisible: !document.getElementById('vRender').hidden,
      richOn: richBtn ? richBtn.className.indexOf('on') >= 0 : false,
      note: note ? note.textContent : ''
    };
  })()`);
  ok(s.hasIframe && s.rVisible, '小 HTML 直接渲染出 iframe（没有门控）');
  ok(s.richOn, '小 HTML 默认停在「渲染」');
  ok(!/文件较大/.test(s.note), '小 HTML 不显示「文件较大」提示');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
} catch (e) {
  console.log('\n执行出错: ' + e.message);
  fail++;
} finally {
  try { proc.kill(); } catch (e) {}
}
process.exit(fail ? 1 : 0);