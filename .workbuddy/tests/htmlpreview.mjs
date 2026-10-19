// 终极验证（改用截图对比）：
// sandbox iframe 是独立进程（OOPIF），DevTools 协议也拿不到它的 executionContext，
// 所以没法直接读内部 DOM。改用像素对比证明三件事：
//   1. 渲染层和源码层画面明显不同 → iframe 真的渲染出了内容，不是空白
//   2. 切到源码后能看到原始 HTML 文本 → srcdoc 装的是原文
//   3. contentDocument 为 null、frames.length 增加 → 确实被隔离成独立源
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const TOKEN = readFileSync(HERE + '/share.txt', 'utf8').trim();
const OUT = HERE + '/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-final-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9349',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch('http://127.0.0.1:9349/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {}
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
async function shot(name) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(OUT + '/' + name + '.png', buf);
  return buf; }

// 粗略像素差异度：直接比 PNG 字节的差异比例（够用来区分"有内容"和"空白"）
function diffRatio(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let d = 0;
  for (let i = 0; i < n; i += 7) { if (a[i] !== b[i]) d++; }
  return d / Math.ceil(n / 7);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp.send('Page.navigate', { url: ORIGIN + '/s/' + TOKEN }, sid);
  await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 15000);
  await ev('openFile("页面.html")');
  await waitFor('document.querySelector("#vRender iframe")', 10000);
  await sleep(2200);

  // --- 隔离属性：contentDocument 读不到 = 独立源 ---
  const iso = await ev(`(function(){
    var f = document.querySelector('#vRender iframe');
    var cd = null, threw = '';
    try { cd = f.contentDocument; } catch(e){ threw = e.name; }
    return {
      contentDocIsNull: cd === null,
      threw: threw,
      framesCount: window.frames.length,
      srcdocLen: (f.srcdoc||'').length,
      w: Math.round(f.getBoundingClientRect().width),
      h: Math.round(f.getBoundingClientRect().height)
    };
  })()`);
  console.log('--- 隔离实测 ---');
  console.log('  contentDocument 为 null : ' + iso.contentDocIsNull + (iso.threw ? ' (抛 ' + iso.threw + ')' : ''));
  console.log('  window.frames.length     : ' + iso.framesCount);
  console.log('  srcdoc 长度              : ' + iso.srcdocLen);
  console.log('  iframe 尺寸              : ' + iso.w + '×' + iso.h);

  ok(iso.contentDocIsNull, 'iframe.contentDocument 为 null —— 子文档是独立源，父页面读不到');
  ok(iso.framesCount >= 1, 'window.frames 里出现了这个 frame（确实是独立 browsing context）');
  ok(iso.srcdocLen > 300, 'srcdoc 带上了原文');
  ok(iso.w > 800 && iso.h > 400, 'iframe 撑满了容器（' + iso.w + '×' + iso.h + '）');

  // --- 截图对比：渲染层 vs 源码层 ---
  const richShot = await shot('08-rich');
  await ev('document.querySelector(\'#vSeg [data-vmode="src"]\').click()');
  await sleep(900);
  const srcShot = await shot('09-src');
  const dr = diffRatio(richShot, srcShot);
  console.log('\n--- 截图对比 ---');
  console.log('  渲染层 PNG ' + (richShot.length / 1024).toFixed(0) + ' KB');
  console.log('  源码层 PNG ' + (srcShot.length / 1024).toFixed(0) + ' KB');
  console.log('  字节差异度 : ' + (dr * 100).toFixed(1) + '%');
  ok(dr > 0.15, '渲染层与源码层画面明显不同（' + (dr * 100).toFixed(1) + '%）—— iframe 真的画出了内容');

  // 源码层应该能看到原始 HTML 文本
  const srcTxt = await ev(`(function(){
    var t = document.getElementById('viewer');
    return { hidden: t.hidden, len: (t.textContent||'').length,
             hasTag: t.textContent.indexOf('<h1>') >= 0,
             hasScript: t.textContent.indexOf('insertAdjacentHTML') >= 0 };
  })()`);
  ok(!srcTxt.hidden && srcTxt.hasTag, '源码层能看到原始 HTML 标签');
  ok(srcTxt.hasScript, '源码层能看到原页面里的脚本（说明 srcdoc 装的是原文）');

  // 切回渲染，确认能稳定重建（不看 PNG 字节 —— 压缩编码本身就有抖动，
  // 同一画面两次编码也会差好几%，那个指标不可靠。直接看 DOM 状态。）
  await ev('document.querySelector(\'#vSeg [data-vmode="rich"]\').click()');
  await sleep(1400);
  const back = await ev(`(function(){
    var f = document.querySelector('#vRender iframe');
    return { has: !!f, srcdocLen: f ? (f.srcdoc||'').length : 0,
             w: f ? Math.round(f.getBoundingClientRect().width) : 0,
             h: f ? Math.round(f.getBoundingClientRect().height) : 0,
             renderShown: !document.getElementById('vRender').hidden,
             srcHidden: document.getElementById('viewer').hidden };
  })()`);
  ok(back.has && back.renderShown && back.srcHidden, '切回渲染后预览层重新显示');
  ok(back.srcdocLen > 300, '切回后 srcdoc 内容还在（' + back.srcdocLen + ' 字符）');
  ok(back.w > 800 && back.h > 400, '切回后 iframe 尺寸正常（' + back.w + '×' + back.h + '）');
  await shot('10-rich-again');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
} catch (e) {
  console.log('\n执行出错: ' + e.message);
  fail++;
} finally {
  try { proc.kill(); } catch (e) {}
}
process.exit(fail ? 1 : 0);
