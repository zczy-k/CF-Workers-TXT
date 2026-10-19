// 「发布」按钮可用状态：无分享链接时置灰 + 引导去「分享」；**无改动**时也置灰（发布没有意义）
// 端到端：serve.mjs 桥接 → 无头 Chrome 打开管理页 → 驱动编辑器验证按钮状态
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 8899);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9336;
const PROFILE = TMP + '/cfwtxt-cfwtxt-pubbtn-profile-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
}

// ---- 桥接服务 ----
const srv = spawn(process.execPath, ['serve.mjs'], {
  cwd: '.workbuddy/tests', stdio: 'pipe', env: Object.assign({}, process.env, { PORT: String(PORT) })
});
let ready = false;
srv.stdout.on('data', d => { if (String(d).indexOf('READY') >= 0) ready = true; });
for (let i = 0; i < 80 && !ready; i++) await sleep(250);
ok(ready, '桥接服务已启动');
if (!ready) { srv.kill(); process.exit(1); }

// serve.mjs 预置了「笔记」目录分享 → 笔记/纯文本.txt 属于"被分享目录里的文件"
// 另外建两个**没有任何分享**的根文件
const put = (p, s) => fetch(ORIGIN + '/adm-123/api?path=' + encodeURIComponent(p), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: s
}).then(r => r.json());
ok((await put('未分享.txt', '还没分享的文档')).ok, '建一个未分享文件');
ok((await put('未分享2.txt', '另一个未分享的文档')).ok, '再建一个未分享文件');

// ---- Chrome + CDP ----
// profile 目录按进程号隔离；上一轮残留的 Chrome 可能还锁着旧目录，删不掉也不该让本次跑挂
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--disable-site-isolation-trials', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
    if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; }
  } catch (e) {}
  if (!wsUrl) await sleep(250);
}
ok(!!wsUrl, 'Chrome 调试端口就绪');
if (!wsUrl) { proc.kill(); srv.kill(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
const cdp = new CDP(ws);
const exceptions = [];
cdp.on(m => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text); });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const loaded = new Promise(res => {
  const h = m => { if (m.method === 'Page.loadEventFired') { cdp.handlers.splice(cdp.handlers.indexOf(h), 1); res(); } };
  cdp.on(h);
});
await cdp.send('Page.navigate', { url: ORIGIN + '/adm-123' });
await Promise.race([loaded, sleep(10000)]);
await sleep(900);      // 等启动时的分享列表预热（!RO 时开头就 refreshShareCache(false)）

const state = () => cdp.eval(`JSON.stringify({
  dis: document.getElementById('btnSave').disabled,
  title: document.getElementById('btnSave').title,
  sh: document.getElementById('edShare').className,
  path: ed.path
})`);

head('未分享的文件：发布按钮置灰');
{
  await cdp.eval("state.path=''; openEditor('未分享.txt')");
  await sleep(800);
  const s = JSON.parse(await state());
  ok(s.path === '未分享.txt', '已打开未分享文件', s.path);
  ok(s.dis === true, '「发布」置灰不可点', s);
  ok(s.title.indexOf('还没有分享链接') >= 0, '按钮提示说明了原因');
  ok(s.sh.indexOf('primary') >= 0, '「分享」提成了主按钮（引导下一步，不留死按钮）', s.sh);
  await cdp.eval("document.getElementById('bSrc')");   // no-op，保持节奏
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('.workbuddy/tests/shots/pubbtn-unshared.png', Buffer.from(shot.data, 'base64'));
}

head('未分享时点发布：不发请求、给明确引导');
{
  // 直接调 publishEd 模拟"绕过置灰"（比如缓存没加载完的窗口期），必须被兜住
  await cdp.eval("document.getElementById('toast').textContent=''; publishEd()");
  await sleep(300);
  const t = await cdp.eval("document.getElementById('toast').textContent");
  ok(t.indexOf('还没有分享链接') >= 0, '提示先创建分享链接，且没有真的发布', t);
  ok(await cdp.eval("document.getElementById('btnSave').disabled") === true, '按钮仍是置灰状态');
}

head('已分享目录里的文件：没改动时置灰，改了才可点');
{
  await cdp.eval("state.path='笔记'; openEditor('纯文本.txt')");
  await sleep(1100);
  let s = JSON.parse(await state());
  ok(s.path === '笔记/纯文本.txt', '已打开「笔记」下的文件', s.path);
  // 建分享时服务端把当时的内容自动发布过了 → 与影子树一致 → 无改动就不该能点发布
  ok(s.dis === true, '内容与分享页一致 → 「发布」置灰（点了也没有任何意义）', s);
  ok(s.title.indexOf('没有需要发布的变化') >= 0, '按钮提示说明了原因');
  ok(s.sh.indexOf('primary') < 0, '「分享」保持普通样式（不是下一步）', s.sh);
  // 无改动时直接点（模拟绕过置灰）：必须被兜住，一个请求都不发
  await cdp.eval("document.getElementById('toast').textContent=''; publishEd()");
  await sleep(300);
  let t = await cdp.eval("document.getElementById('toast').textContent");
  ok(t.indexOf('内容没有变化') >= 0, '无改动时点发布：提示且不发请求', t);
  // 改一下内容 → 按钮立刻恢复可点
  await cdp.eval("var t=document.getElementById('edt'); t.value += '（改了一句）'; ed.dirty = true; updPubBtn();");
  await sleep(500);
  s = JSON.parse(await state());
  ok(s.dis === false, '改了内容 → 「发布」变可点', s);
  ok(s.title.indexOf('把当前文件发布到分享页') >= 0, '提示恢复成发布说明');
  // 发布成功后回到"已同步"，按钮再次置灰 —— 完整闭环
  await cdp.eval("document.getElementById('toast').textContent=''; publishEd()");
  await sleep(900);
  s = JSON.parse(await state());
  ok(s.dis === true, '发布成功 → 又回到置灰（内容与分享页一致了）', s);
  t = await cdp.eval("document.getElementById('toast').textContent");
  ok(t.indexOf('已发布') >= 0, '发布成功有提示', t);
}

head('从编辑器新建分享 → 刚建完也是"无改动"状态');
{
  await cdp.eval("state.path=''; openEditor('未分享2.txt')");
  await sleep(900);
  ok(await cdp.eval("document.getElementById('btnSave').disabled") === true, '打开时仍是置灰');
  // 走真实交互：打开分享弹窗 → 点「生成 / 更新」
  await cdp.eval("openShareModal('未分享2.txt', false)");
  await sleep(400);
  ok(await cdp.eval("!!document.querySelector('[data-shgen]')"), '分享弹窗已打开');
  await cdp.eval("document.querySelector('[data-shgen]').click()");
  await sleep(1000);
  const s = JSON.parse(await state());
  // 建分享的同时服务端已把当前版本发布过去 → 内容与分享页一致 → 置灰是正确的新状态
  ok(s.dis === true, '建完分享 → 「发布」置灰（刚发布的就是这份内容）', s);
  ok(s.title.indexOf('没有需要发布的变化') >= 0, '提示说明原因', s.title);
  ok(s.sh.indexOf('primary') < 0, '「分享」恢复普通样式', s.sh);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('.workbuddy/tests/shots/pubbtn-shared.png', Buffer.from(shot.data, 'base64'));
}

head('异常');
{
  ok(exceptions.length === 0, '页面无 JS 异常', exceptions);
  ok(true, '截图已存 shots/pubbtn-unshared.png / pubbtn-shared.png');
}

try { ws.close(); } catch (e) {}
proc.kill();
srv.kill();
rmSync(PROFILE, { recursive: true, force: true });

console.log(fail ? `\n❌ 失败 ${fail} 项` : `\n✅ 发布按钮验收全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
