// 一次性实拍：编辑器里"网址末尾的小链接图标"（改样式后肉眼验收用）。
// 只读分享页已按方案 A 移除图标，这里顺带截一张确认它是纯文本。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ADMIN = 'http://127.0.0.1:8899/adm-123';
const OUT = HERE + '/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = TMP + '/cfwtxt-cfwtxt-shotlink-profile-' + process.pid;
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
async function shot(name, clip) {
  const p = { format: 'png', captureBeyondViewport: false };
  if (clip) p.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 1 };
  const r = await cdp.send('Page.captureScreenshot', p, sid);
  writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.data, 'base64'));
  console.log('  已保存 ' + name + '.png');
}

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false }, sid);
await cdp.send('Page.navigate', { url: ADMIN }, sid);
await sleep(400);
await waitFor('typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('load("笔记")');
await waitFor('document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('openFile("纯文本.txt")');
await waitFor('!document.getElementById("viewEdit").hidden && !!document.getElementById("edt")', 12000);
// 直接铺一段带网址的正文，不依赖夹具内容：
// 第一行就是用户反馈的那种"网址后面紧跟中文标点和汉字"（最容易撞在一起的情况），
// 第二行是"网址后跟空格"，第三行是"网址在句子中间"。
await ev(`(function(){
  var t = document.getElementById('edt');
  t.value = 'https://cfbox.fanme.us.ci/cfnext。眼光很独特\\n官网 https://example.com/docs 见详情，后面还有一大段说明文字。\\n备用 www.example.org/x?y=1\\n\\n这是一段普通文字，用来对比。';
  t.dispatchEvent(new Event('input'));
})()`);
await sleep(600);
console.log('  链接识别：' + JSON.stringify(await ev('JSON.stringify(editorLinks(document.getElementById("edt").value))')));
console.log('  图标数量：' + await ev('document.querySelectorAll("#edLinkIcons .lnkico").length'));

const geo = await ev(`(function(){
  var r = document.getElementById('edt').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.min(220, Math.round(r.height)) };
})()`);
// 图标很小，放大拍才能看清"紧贴网址末尾、不是行尾"
await shot('20-editor-link-icons', { ...geo, scale: 2 });
// 再单独放大第一行（网址后面紧跟中文标点+汉字，最容易撞在一起的那种），看有没有重叠
await shot('22-zoom-first-line', { x: geo.x, y: geo.y, width: 460, height: 46, scale: 4 });

const pos = await ev(`(function(){
  var ic = document.querySelectorAll('#edLinkIcons .lnkico');
  var out = [];
  for (var i = 0; i < ic.length; i++){
    var r = ic[i].getBoundingClientRect();
    out.push({ href: ic[i].getAttribute('href'), x: Math.round(r.left), y: Math.round(r.top) });
  }
  return out; })()`);
console.log('  图标位置：' + JSON.stringify(pos));

// 只读分享页：不再挂网址图标（方案 A 已移除），切到"源码"视图看纯文本正文
const token = readFileSync(new URL('./share.txt', import.meta.url), 'utf8').trim();
await cdp.send('Page.navigate', { url: ADMIN.replace(/\/adm-123$/, '/s/' + token) }, sid);
await waitFor('document.querySelectorAll("#list tbody tr").length > 0', 12000);
await ev('openFile("说明.md")');
await waitFor('document.querySelectorAll("#vSeg [data-vmode]").length === 2', 12000);
await ev('(function(){ document.querySelector("#vSeg [data-vmode=src]").click(); })()');
await sleep(600);
const vgeo = await ev(`(function(){
  var r = document.getElementById('viewer').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.min(220, Math.round(r.height)) };
})()`);
await shot('21-share-link-icons', { ...vgeo, scale: 2 });
console.log('  分享页图标数量（应为 0）：' + await ev('document.querySelectorAll("#viewer a.lnkico").length'));

try { ws.close(); proc.kill(); } catch (e) {}
console.log('\n截图目录：' + OUT);