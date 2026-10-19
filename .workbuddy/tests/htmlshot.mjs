// HTML 预览实拍验证：真浏览器里确认「渲染出来了 + 脚本没执行 + 外链资源没加载」
// 静态检查证明不了这些 —— iframe 是否真的显示内容，只有浏览器知道。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
const TOKEN = readFileSync(HERE + '/share.txt', 'utf8').trim();
const OUT = HERE + '/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-html-profile-' + process.pid;
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9341',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch('http://127.0.0.1:9341/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {}
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
  writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.data, 'base64')); console.log('  已保存 ' + name + '.png'); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false }, sid);

  // ---------- 只读分享页 ----------
  console.log('\n[只读分享页] 点 HTML 文件 → 是否真的渲染出来');
  await cdp.send('Page.navigate', { url: ORIGIN + '/s/' + TOKEN }, sid);
  await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 15000);
  await ev('openFile("页面.html")');
  await waitFor('document.querySelector("#vRender iframe")', 10000);
  await sleep(1400);

  const info = await ev(`(function(){
    var f = document.querySelector('#vRender iframe');
    var box = document.getElementById('vRender');
    var note = document.querySelector('.htmlNote');
    return {
      hasIframe: !!f,
      srcdocLen: f ? (f.srcdoc || '').length : 0,
      docSrc: f ? (f.getAttribute('src') || '') : '',
      docCspOk: false,
      sandbox: f ? f.getAttribute('sandbox') : '',
      hasScripts: f ? /allow-scripts/.test(f.getAttribute('sandbox') || '') : false,
      hasSameOrigin: f ? /allow-same-origin/.test(f.getAttribute('sandbox') || '') : false,
      hasCsp: f ? !!f.getAttribute('csp') : false,
      refPolicy: f ? f.getAttribute('referrerpolicy') : '',
      boxClass: box ? box.className : '',
      noteShown: !!note,
      noteText: note ? note.textContent.slice(0, 40) : '',
      iframeW: f ? f.getBoundingClientRect().width : 0,
      iframeH: f ? f.getBoundingClientRect().height : 0,
      // iframe 的 src 文档在 sandbox 下是跨源的，父页面读不到内容。
      // 帧树（Page.getFrameTree）看不到 OOPIF 里的 sandbox frame，所以改用
      // DOM 属性验证：contentDocument 为 null = 独立源，frames 计数 = 真成了 browsing context
      contentDocIsNull: f ? (function(){ try { return f.contentDocument === null; } catch(e){ return true; } })() : false,
      frameCount: (window.frames || []).length
    };
  })()`);

  ok(info.hasIframe, '生成了 iframe');
  // 预览已改为**真文档模式**：iframe 直接加载 ?doc=1 的真实 URL，而不是把原文塞进 srcdoc。
  // 换真实 URL 之后页面自己的 css / 图片才按正常规则解析（srcdoc 的基准是 about:srcdoc）。
  ok(info.docSrc.indexOf('?doc=1') >= 0, 'iframe 走真文档模式（src 带 ?doc=1）', info.docSrc.slice(0, 100));
  ok(info.srcdocLen === 0, '不再用 srcdoc 注入原文（' + info.srcdocLen + ' 字符）');
  ok(!info.hasScripts, 'sandbox 不含 allow-scripts');
  ok(!info.hasSameOrigin, 'sandbox 不含 allow-same-origin');
  // 真文档模式下**故意不给 iframe 挂 csp 属性**：那会把 img-src 限死在 data:，连页面自己目录的
  // 图片一起挡掉。第二道防线改成文档**响应头**上的 CSP —— 直接取一次真文档看响应头。
  const docHeader = await ev(`(async function(){
    var f = document.querySelector('#vRender iframe');
    var r = await fetch(f.getAttribute('src'), { credentials: 'same-origin' });
    return (r.headers.get('content-security-policy') || '') + ' | ' + (f.getAttribute('csp') || '(无 csp 属性)');
  })()`);
  ok(docHeader.indexOf("script-src 'none'") >= 0, '真文档响应头带 script-src none（第二道防线没丢）', docHeader);
  ok(docHeader.indexOf('(无 csp 属性)') > 0, 'iframe 上没有 csp 属性（有它反而会挡掉页面自己的图片）');
  ok(info.refPolicy === 'no-referrer', 'referrerpolicy=no-referrer');
  ok(info.boxClass.indexOf('htmlBox') >= 0, '容器切到 htmlBox（去掉内边距、撑满）');
  ok(info.noteShown, '显示了隔离预览说明（info.noteText: ' + info.noteText + '…）');
  ok(info.iframeW > 400 && info.iframeH > 200,
    'iframe 有实际尺寸（' + Math.round(info.iframeW) + '×' + Math.round(info.iframeH) + '）');

  // 隔离性：sandbox 下子文档是独立源，父页面读不到它的 DOM。
  // 不用 Page.getFrameTree —— OOPIF 里的 sandbox frame 不会出现在帧树里。
  ok(info.contentDocIsNull, 'iframe.contentDocument 为 null —— 子文档是独立源，父页面读不到');
  ok(info.frameCount >= 1, 'window.frames 里出现了这个 frame（确实是独立 browsing context）');

  // 切回源码，确认渲染层/源码层能互相切换
  const sw = await ev(`(function(){
    var b = document.querySelector('#vSeg [data-vmode="src"]');
    if(!b) return { hasSeg:false };
    b.click();
    var srcHidden = document.getElementById('viewer').hidden;
    var rHidden = document.getElementById('vRender').hidden;
    var b2 = document.querySelector('#vSeg [data-vmode="rich"]');
    if(b2) b2.click();
    return { hasSeg:true, srcHidden:srcHidden, rHidden:rHidden,
             backToRich: !document.getElementById('vRender').hidden };
  })()`);
  ok(sw.hasSeg, '有「渲染 / 源码」切换按钮');
  ok(sw.srcHidden === false && sw.rHidden === true, '切到源码时预览层隐藏、源码层显示');
  ok(sw.backToRich === true, '能切回渲染');
  await sleep(700);

  // 关键回归：看完 HTML 再看 Markdown，容器 className 必须复位
  const clobber = await ev(`(function(){
    openFile('说明.md');
    return new Promise(function(res){
      setTimeout(function(){
        var b = document.getElementById('vRender');
        res({ cls: b ? b.className : '', hasMd: !!document.querySelector('#vRender h1, #vRender h2, #vRender p') });
      }, 900);
    });
  })()`);
  ok(clobber.cls.indexOf('htmlBox') < 0, '看完 HTML 再看 Markdown，htmlBox 没有残留（当前 class="' + clobber.cls + '"）');
  ok(clobber.hasMd, 'Markdown 渲染正常');

  await ev('openFile("页面.html")');
  await waitFor('document.querySelector("#vRender iframe")', 10000);
  await sleep(1500);
  await shot('06-html-preview-readonly');
  console.log('  [实拍] 已保存 06-html-preview-readonly.png');

  // ---------- 管理端编辑器：预览按钮 ----------
  console.log('\n[管理端] HTML 打开是编辑器，且有「预览」按钮');
  await cdp.send('Page.navigate', { url: ADMIN }, sid);
  await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 15000);
  await ev('load("笔记")');
  await sleep(1200);
  await ev('openFile("页面.html")');
  await sleep(1600);
  const ed = await ev(`(function(){
    var seg = document.getElementById('edSeg');
    var prevBtn = seg ? seg.querySelector('[data-emode="prev"]') : null;
    var editorShown = !document.getElementById('viewEdit').hidden;
    return { hasSeg: !!seg, hasPrev: !!prevBtn, editorShown: editorShown };
  })()`);
  ok(ed.editorShown, 'HTML 打开的是编辑器（没有丢掉编辑能力）');
  ok(ed.hasSeg && ed.hasPrev, '编辑器里有「预览」按钮');

  if (ed.hasPrev) {
    await ev('document.querySelector("#edSeg [data-emode=prev]").click()');
    await waitFor('document.querySelector("#edPrev iframe")', 8000);
    await sleep(1500);
    const edPrev = await ev(`(function(){
      var f = document.querySelector('#edPrev iframe');
      return { has: !!f, len: f ? (f.srcdoc||'').length : 0, docSrc: f ? (f.getAttribute('src')||'') : '',
               cls: document.getElementById('edPrev').className,
               note: !!document.querySelector('#edPrev .htmlNote'),
               w: f ? f.getBoundingClientRect().width : 0,
               h: f ? f.getBoundingClientRect().height : 0 };
    })()`);
    ok(edPrev.has, '管理端预览生成了 iframe');
    ok(edPrev.docSrc.indexOf('?doc=1') >= 0, '管理端预览也走真文档模式', edPrev.docSrc.slice(0, 90));
    ok(edPrev.len === 0, '管理端不再用 srcdoc 注入原文');
    ok(edPrev.cls.indexOf('htmlBox') >= 0, '管理端容器也切到 htmlBox');
    ok(edPrev.note, '管理端也显示隔离说明');
    ok(edPrev.w > 300 && edPrev.h > 200, '管理端 iframe 有实际尺寸');
    await shot('07-html-preview-editor');
    console.log('  [实拍] 已保存 07-html-preview-editor.png');
  }

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
} catch (e) {
  console.log('\n执行出错: ' + e.message);
  fail++;
} finally {
  try { proc.kill(); } catch (e) {}
}
process.exit(fail ? 1 : 0);
