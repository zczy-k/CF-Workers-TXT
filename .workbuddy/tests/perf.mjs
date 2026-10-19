// 性能实测：渲染层与编辑器增强在真实浏览器里的耗时
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const ORIGIN = 'http://127.0.0.1:8899';
const ADMIN = ORIGIN + '/adm-123';
let fail = 0, pass = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { spawn } = await import('node:child_process');
const { rmSync, mkdirSync } = await import('node:fs');

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; 
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      else if (m.method) for (const h of this.handlers) h(m); }); }
  send(method, params, sid) { const id = ++this.id; const p = { id, method, params: params || {} }; if (sid) p.sessionId = sid;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); }
  on(f) { this.handlers.push(f); }
}
const PROFILE = TMP + '/cfwtxt-perf-profile';
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:9334/json/version'); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch (e) {} await sleep(250); }
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Page.enable', {}, sid);
const ev = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result.value; };
await cdp.send('Page.navigate', { url: ADMIN }, sid);
for (let i = 0; i < 60; i++) { try { if (await ev('typeof mdHtml === "function" && document.querySelectorAll("#list tbody tr").length>0')) break; } catch (e) {} await sleep(200); }

console.log('\n== 渲染层耗时（真实浏览器） ==');

const mdPerf = await ev(`(function(){
  var parts = [];
  for (var i = 0; i < 1500; i++){
    parts.push('## 小节 ' + i);
    parts.push('');
    parts.push('这是第 ' + i + ' 段正文，含有 **加粗**、*斜体* 与 行内代码，还有一个 [链接](https://example.com/page) 。');
    parts.push('');
    parts.push('- 列表项甲');
    parts.push('- 列表项乙');
    parts.push('');
    parts.push('| 列A | 列B |');
    parts.push('| --- | --- |');
    parts.push('| 值1 | 值2 |');
    parts.push('');
  }
  var md = parts.join(String.fromCharCode(10));
  var t0 = performance.now();
  var r = mdHtml(md);
  var t1 = performance.now();
  return { chars: md.length, ms: Math.round((t1 - t0) * 10) / 10, toc: r.toc.length, htmlLen: r.html.length };
})()`);
console.log('  Markdown ' + (mdPerf.chars / 1024).toFixed(0) + ' KB → ' + mdPerf.ms + ' ms（' + mdPerf.toc + ' 个标题）');
ok(mdPerf.ms < 400, 'Markdown 渲染 200KB 级文档 < 400ms', mdPerf.ms);

const hlPerf = await ev(`(function(){
  var lines = [];
  for (var i = 0; i < 4000; i++) lines.push('const value' + i + ' = ' + i + '; // 行内注释 ' + i);
  var js = lines.join(String.fromCharCode(10));
  var t0 = performance.now();
  hlBlock(js, 'js');
  var t1 = performance.now();
  var lines2 = [];
  for (var j = 0; j < 4000; j++) lines2.push('  name_' + j + ': 值' + j);
  var yaml = lines2.join(String.fromCharCode(10));
  var t2 = performance.now();
  hlBlock(yaml, 'yml');
  var t3 = performance.now();
  return { jsChars: js.length, jsMs: Math.round((t1 - t0) * 10) / 10, yamlMs: Math.round((t3 - t2) * 10) / 10 };
})()`);
console.log('  代码高亮 ' + (hlPerf.jsChars / 1024).toFixed(0) + ' KB → JS ' + hlPerf.jsMs + ' ms / YAML ' + hlPerf.yamlMs + ' ms');
ok(hlPerf.jsMs < 300, 'JS 高亮 150KB 级 < 300ms', hlPerf.jsMs);

const gutPerf = await ev(`(function(){
  switchView('edit');
  var t = document.getElementById('edt');
  var lines = [];
  for (var i = 0; i < 2000; i++) lines.push('第 ' + i + ' 行：一些中文内容用来触发行高与折行计算');
  t.value = lines.join(String.fromCharCode(10));
  t.style.fontSize = '13px';
  var t0 = performance.now();
  syncGutter();
  var t1 = performance.now();
  var n = document.querySelectorAll('#edGutterIn .edGutNum').length;
  return { lines: lines.length, ms: Math.round((t1 - t0) * 10) / 10, nums: n,
           hidden: document.getElementById('edGutter').hidden, w: t.offsetWidth };
})()`);
console.log('  行号槽 2000 行 → ' + gutPerf.ms + ' ms（' + gutPerf.nums + ' 个行号）');
ok(gutPerf.nums === 2000, '2000 行都生成了行号', gutPerf.nums);
ok(gutPerf.ms < 300, '行号槽重建 < 300ms', gutPerf.ms);

const findPerf = await ev(`(function(){
  var t = document.getElementById('edt');
  var lines = [];
  for (var i = 0; i < 4000; i++) lines.push('这一行里有目标词，编号 ' + i);
  t.value = lines.join(String.fromCharCode(10));
  findState.open = true; findState.q = '目标词'; findState.case = false; findState.re = false;
  var t0 = performance.now();
  findRun(false);
  var t1 = performance.now();
  var n = findHits.length;
  var hlT0 = performance.now();
  renderHl();
  var hlT1 = performance.now();
  var marks = document.querySelectorAll('#edHlIn .hmark').length;
  findState.open = false; findHits = []; renderHl();
  return { hits: n, marks: marks, ms: Math.round((t1 - t0) * 10) / 10, hlMs: Math.round((hlT1 - hlT0) * 10) / 10 };
})()`);
console.log('  查找 ' + findPerf.hits + ' 处命中 → 匹配 ' + findPerf.ms + ' ms / 高亮层 ' + findPerf.hlMs + ' ms（画了 ' + findPerf.marks + ' 个标记）');
ok(findPerf.hits === 4000, '4000 处命中都找到了', findPerf.hits);
ok(findPerf.ms < 300, '查找 4000 处命中 < 300ms', findPerf.ms);
ok(findPerf.hlMs < 500, '命中高亮层渲染 < 500ms', findPerf.hlMs);

const bigPerf = await ev(`(function(){
  switchView('edit');
  var t = document.getElementById('edt');
  t.style.fontSize = '13px';
  var lines = [];
  for (var i = 0; i < 40000; i++) lines.push('行 ' + i + ' 内容内容内容内容内容内容内容内容');
  t.value = lines.join(String.fromCharCode(10));
  var t0 = performance.now();
  syncGutter();
  var t1 = performance.now();
  var hidden = document.getElementById('edGutter').hidden;
  return { chars: t.value.length, ms: Math.round((t1 - t0) * 10) / 10, gutterHidden: hidden };
})()`);
console.log('  超大文件 ' + (bigPerf.chars / 1024 / 1024).toFixed(2) + ' MB → 行号' + (bigPerf.gutterHidden ? '已自动关闭' : '仍开启') + '，耗时 ' + bigPerf.ms + ' ms');
ok(bigPerf.chars > 512 * 1024, '构造了 > 512KB 的文件', bigPerf.chars);
ok(bigPerf.gutterHidden, '超过阈值时行号槽自动关闭（不拖慢编辑）');
ok(bigPerf.ms < 100, '大文件降级后开销可忽略', bigPerf.ms);

console.log('\n' + (fail ? `❌ ${fail} 项失败，${pass} 项通过` : `✅ 全部 ${pass} 项性能断言通过`));
try { ws.close(); proc.kill(); } catch (e) {}
process.exit(fail ? 1 : 0);
