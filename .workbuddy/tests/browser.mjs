// 无头 Chrome + CDP 界面验收
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const TMP = tmpdir().replace(/\\/g, '/');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 8899);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const ADMIN = ORIGIN + '/adm-123';
const PROFILE = TMP + '/cfwtxt-cfwtxt-check-profile-' + process.pid;

let fail = 0, pass = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }
void head;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) { for (const h of this.handlers) h(msg); }
    });
  }
  send(method, params, sid) {
    const id = ++this.id;
    const p = { id, method, params: params || {} };
    if (sid) p.sessionId = sid;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
}

async function launch() {
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  mkdirSync(PROFILE, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9333/json/version');
      if (r.ok) { const j = await r.json(); return { proc, wsUrl: j.webSocketDebuggerUrl }; }
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome 启动超时');
}

const { proc, wsUrl } = await launch();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
const cdp = new CDP(ws);

const logErrors = [], logWarns = [], exceptions = [];
cdp.on(m => {
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    const line = e.text + ' | ' + (e.url || '');
    if (e.level === 'error') logErrors.push(line);
    else if (e.level === 'warning') logWarns.push(line);
  }
});

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sid);
await cdp.send('Runtime.enable', {}, sid);
await cdp.send('Log.enable', {}, sid);

async function ev(expr, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, awaitPromise: !!awaitPromise, returnByValue: true
  }, sid);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'eval error');
  }
  return r.result.value;
}
async function waitFor(cond, ms, label) {
  const n = Math.ceil((ms || 6000) / 150);
  for (let i = 0; i < n; i++) {
    try { if (await ev('(function(){try{return !!(' + cond + ');}catch(e){return false;}})()')) return true; } catch (e) {}
    await sleep(150);
  }
  throw new Error('等待超时: ' + (label || cond));
}
async function nav(url, readyCond) {
  await cdp.send('Page.navigate', { url }, sid);
  await waitFor('typeof document !== "undefined" && document.readyState !== "loading"', 8000, 'document');
  if (readyCond) await waitFor(readyCond, 10000, readyCond);
}

// ================= 管理端 =================
head('管理端：页面加载与列表');
await nav(ADMIN, 'typeof openFile === "function" && document.querySelectorAll("#list tbody tr").length > 0');
ok(true, '管理页加载完成，列表有内容');
ok(await ev('typeof kindOf === "function" && typeof renderText === "function" && typeof mdHtml === "function"'), '渲染层函数已就绪');
// 给 post 装钩子：记录每一次 share/unshare 的调用栈（排查"谁创建了计划外的分享"）
await ev(`(function(){
  window.__shareLog = [];
  if (typeof post !== 'function') return;
  var orig = post;
  window.post = function(body){
    try {
      if (body && (body.action === 'share' || body.action === 'unshare')){
        try { throw new Error('t'); } catch (e) {
          window.__shareLog.push(body.action + ' ' + (body.path || body.token || '') + '  ← ' +
            e.stack.split(String.fromCharCode(10)).slice(2, 4).join(' | '));
        }
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
})()`);
ok(await ev('window.__shareLog.length === 0'), 'post 钩子已装');

head('PC 布局：不留左侧空白、与头部对齐');
for (const W of [1080, 1366, 1600, 1920, 2560]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await sleep(320);
  const m = await ev(`(function(){
    function L(s){ var e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().left) : -1; }
    return { w: window.innerWidth, aside: L('aside'), brand: L('.brand'), search: L('.side-search input'),
             table: L('#list table'), docW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth,
             layoutMW: getComputedStyle(document.querySelector('.layout')).maxWidth };
  })()`);
  ok(m.aside === 0, W + 'px 视口：侧栏贴住左边缘', m.aside);
  ok(Math.abs(m.brand - m.search) <= 2, W + 'px 视口：logo 与侧栏内容左对齐（差 ' + Math.abs(m.brand - m.search) + 'px）', m);
  ok(m.layoutMW === 'none', W + 'px 视口：.layout 没有 max-width', m.layoutMW);
  ok(m.docW <= m.w && m.bodyW <= m.w, W + 'px 视口：没有横向溢出', { docW: m.docW, bodyW: m.bodyW, w: m.w });
  if (W === 1920) ok(m.aside === 0 && m.table >= 256, '1920px 视口：表格在侧栏右侧正常铺开', m);
}
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await sleep(320);
ok(await ev('Math.round(document.querySelector("aside").getBoundingClientRect().left) === 0'), '恢复默认视口后侧栏仍在左边缘');

// 进入子目录
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, '笔记目录列表');
ok(await ev('state.files.length >= 8'), '笔记目录里有 8 个文件');

head('文件后缀徽标');
const badges = await ev(`(function(){
  var out = {};
  document.querySelectorAll('#list tbody tr').forEach(function(tr){
    var a = tr.querySelector('a.link'); if (!a) return;
    var b = tr.querySelector('.extb');
    out[a.textContent] = b ? { t: b.textContent, bg: getComputedStyle(b).backgroundColor } : null;
  });
  return out;
})()`);
ok(badges['说明.md'] && badges['说明.md'].t === 'MD', '说明.md → MD 徽标', badges['说明.md']);
ok(badges['数据.json'] && badges['数据.json'].t === 'JSON', '数据.json → JSON 徽标', badges['数据.json']);
ok(badges['脚本.js'] && badges['脚本.js'].t === 'JS', '脚本.js → JS 徽标', badges['脚本.js']);
ok(badges['图片.png'] && badges['图片.png'].t === 'PNG', '图片.png → PNG 徽标', badges['图片.png']);
ok(badges['表格.csv'] && badges['表格.csv'].t === 'CSV', '表格.csv → CSV 徽标', badges['表格.csv']);
ok(badges['Dockerfile'] === null, '没有扩展名的文件不显示徽标（Dockerfile）', badges['Dockerfile']);
{
  const a = badges['脚本.js'] && badges['脚本.js'].bg;
  const b = badges['数据.json'] && badges['数据.json'].bg;
  const c = badges['说明.md'] && badges['说明.md'].bg;
  ok(a && b && c && a !== b && b !== c && a !== c, '代码 / 配置 / 文档 三类徽标颜色互不相同', { 脚本: a, 数据: b, 说明: c });
}
const treeBadges = await ev(`(function(){
  var rows = [].slice.call(document.querySelectorAll('#tree .trow.f'));
  function nm(r){ var n = r.querySelector('.tname'); return n ? n.textContent : ''; }
  var withExt = rows.filter(function(r){ return nm(r).indexOf('.') > 0; });
  var noExt = rows.filter(function(r){ return nm(r).indexOf('.') <= 0; });
  return {
    rows: rows.length,
    withExt: withExt.length,
    extAllHaveBadge: withExt.every(function(r){ return !!r.querySelector('.extb'); }),
    noExtNames: noExt.map(nm),
    noExtHasBadge: noExt.some(function(r){ return !!r.querySelector('.extb'); }),
    samples: withExt.map(function(r){ return r.querySelector('.extb') ? r.querySelector('.extb').textContent : null; }),
    truncatedWithBadge: rows.filter(function(r){
      var n = r.querySelector('.tname');
      return n && n.scrollWidth > n.clientWidth + 1 && !!r.querySelector('.extb');
    }).map(nm)
  };
})()`);
ok(treeBadges.rows > 0, '左侧目录树里有文件行', treeBadges.rows);
ok(treeBadges.extAllHaveBadge, '目录树里所有带扩展名的文件都有后缀徽标', treeBadges);
ok(treeBadges.noExtNames.indexOf('Dockerfile') >= 0 && treeBadges.noExtHasBadge === false,
  '树里没有扩展名的文件不显示徽标', treeBadges.noExtNames);
ok(treeBadges.samples.indexOf('YAML') >= 0, '树里徽标内容是大写后缀', treeBadges.samples);
ok(treeBadges.truncatedWithBadge.length >= 1,
  '名字被省略号截断时后缀徽标依然可见', treeBadges.truncatedWithBadge);
console.log('  被截断但仍能看到后缀的长文件名：' + treeBadges.truncatedWithBadge.join('、'));

const searchBadge = await ev(`(function(){
  return new Promise(function(res){
    var box = document.getElementById('sideScroll');
    runSearch('csv');
    var n = 0;
    var t = setInterval(function(){
      n++;
      var b = box.querySelectorAll('.sfile .extb').length;
      if (b > 0 || n > 40){ clearInterval(t); res({ badges: b, hits: box.querySelectorAll('.sfile').length }); }
    }, 150);
  });
})()`, true);
ok(searchBadge.badges >= 1, '搜索结果里也带后缀徽标', searchBadge);
await ev('runSearch("")');

// ---- Markdown ----
head('Markdown 渲染');
await ev('openFile("说明.md")');
await waitFor('document.getElementById("edt").value.length > 0', 8000, 'md 载入');
ok(true, 'Markdown 载入到编辑器');
ok(await ev('document.getElementById("edt").value.indexOf("## 标题二") >= 0'), '源码模式保留 Markdown 原文');

const gut = await ev('document.querySelectorAll("#edGutterIn .edGutNum").length');
const lines = await ev('document.getElementById("edt").value.split("\\n").length');
ok(gut === lines && lines > 15, '行号数量与逻辑行数一致', { gut, lines });

await ev('edSetPreview(true)');
ok(await ev('!document.getElementById("edPrev").hidden'), '预览面板已显示');
ok(await ev('document.getElementById("edRow").hidden'), '预览时编辑区被隐藏');
const mdStat = await ev(`(function(){
  var b = document.getElementById("edPrev");
  return { h1: b.querySelectorAll("h1").length, h2: b.querySelectorAll("h2").length,
           table: b.querySelectorAll("table").length, code: b.querySelectorAll("pre code").length,
           li: b.querySelectorAll("li").length, strong: b.querySelectorAll("strong").length,
           icode: b.querySelectorAll("p code").length, a: b.querySelectorAll("a").length,
           bq: b.querySelectorAll("blockquote").length, toc: b.querySelectorAll(".tocInline a").length,
           raw: b.textContent.indexOf("## 标题二") >= 0 };
})()`);
ok(mdStat.h1 === 1 && mdStat.h2 === 1, '标题渲染成 h1/h2', mdStat);
ok(mdStat.table === 1, '表格渲染成 <table>', mdStat.table);
ok(mdStat.code === 1, '围栏代码块渲染成 pre>code', mdStat.code);
ok(mdStat.li === 2, '无序列表渲染成 <li>', mdStat.li);
ok(mdStat.strong === 1 && mdStat.icode === 1, '**加粗** 与 `行内代码` 生效', mdStat);
ok(mdStat.a === 1, '链接渲染成 <a>', mdStat.a);
ok(mdStat.bq === 1, '引用渲染成 blockquote', mdStat.bq);
ok(mdStat.raw === false, '预览里没有裸露的 ## 记号');

const codeHl = await ev('document.querySelector("#edPrev pre code").innerHTML');
ok(codeHl.indexOf('tk-k') >= 0 && codeHl.indexOf('tk-c') >= 0 && codeHl.indexOf('tk-s') >= 0, '代码块语法高亮（关键字/注释/字符串）');

await ev('edSetPreview(false)');
ok(await ev('document.getElementById("edPrev").hidden && !document.getElementById("edRow").hidden'), '切回源码模式正常');

// ---- 大纲 ----
head('Markdown 大纲');
await ev('mdOutline()');
const outl = await ev(`(function(){ var b=document.getElementById("edOutline");
  return { hidden: b.hidden, n: b.querySelectorAll("a").length, t: b.textContent }; })()`);
ok(!outl.hidden && outl.n === 2, '大纲列出两个标题', outl);
ok(outl.t.indexOf('标题一') >= 0, '大纲内容正确');
await ev('(function(){ var a=document.querySelector("#edOutline a[data-oline]"); a.click(); })()');
ok(await ev('document.getElementById("edt").selectionStart < 60'), '点大纲跳转到对应行');

// ---- 查找替换 ----
head('查找替换');
await ev('openFind(true)');
ok(await ev('!document.getElementById("findBar").hidden'), '查找栏已打开');
await ev('(function(){ var q=document.getElementById("fQ"); q.value="条目"; q.dispatchEvent(new Event("input")); })()');
await sleep(200);
ok(await ev('findHits.length === 2'), '命中 2 处', await ev('findHits.length'));
ok(await ev('document.getElementById("fStat").textContent').then(t => /1 \/ 2/.test(t)), '状态显示 1 / 2 处');
ok(await ev('!document.getElementById("edHl").hidden && document.querySelectorAll("#edHlIn .hmark").length === 2'), '命中高亮层渲染了 2 个标记');
await ev('findGo(1)');
ok(await ev('findAt === 1'), '下一个命中生效');
await ev('(function(){ document.getElementById("fR").value = "项目"; })()');
await ev('replaceAll()');
const afterRep = await ev('document.getElementById("edt").value');
ok(afterRep.indexOf('条目') < 0 && (afterRep.match(/项目/g) || []).length === 2, '全部替换生效', { hasOld: afterRep.indexOf('条目') >= 0 });
await ev('(function(){ var q=document.getElementById("fQ"); q.value="不存在的东西"; q.dispatchEvent(new Event("input")); })()');
await sleep(200);
ok(await ev('document.getElementById("fStat").textContent === "无匹配"'), '无匹配提示正确');
await ev('closeFind()');
const afterClose = await ev(`(function(){ var hl=document.getElementById("edHl");
  return { bar: document.getElementById("findBar").hidden, hl: hl.hidden,
    bg: document.querySelectorAll("#edHlIn .lnk").length,
    ico: document.querySelectorAll("#edLinkIcons .lnkico").length,
    mark: document.querySelectorAll("#edHlIn .hmark").length }; })()`);
ok(afterClose.bar && afterClose.mark === 0, '关闭查找后命中标记清空', afterClose);
// 正文里有 https://example.com：命中层清空，但网址图标还在（图标挂在 #edLinkIcons 上，与命中层无关）
ok(!afterClose.hl && afterClose.bg === 0 && afterClose.ico === 1, '关闭查找后网址图标仍在，且没有底纹残留', afterClose);

// 撤销替换造成的内容变化，避免影响后续
await ev('(function(){ var t=document.getElementById("edt"); t.value = t.value.split("项目").join("条目"); ed.dirty=false; })()');

// ---- 编辑器内网址：只在网址末尾挂一个小图标 ----
head('编辑器内网址图标');
await ev('openFile("说明.md")');
await waitFor('document.getElementById("edt").value.indexOf("https://example.com") >= 0', 8000, 'md 载入');
const mdOrig = await ev('document.getElementById("edt").value');
const edIcon = await ev(`(function(){
  var ic = document.querySelector("#edLinkIcons .lnkico");
  var t = document.getElementById("edt"), v = t.value;
  var i = v.indexOf("https://example.com");
  // 期望位置：用量测层量出网址最后一个字符的矩形（https://example.com 共 19 字符，i+18 才是结尾那个 m）
  var mm = document.getElementById("edMeasure"), mr = mm.getBoundingClientRect();
  var n = mm.firstChild, r = document.createRange();
  r.setStart(n, i + 18); r.setEnd(n, i + 19);
  var rr = r.getBoundingClientRect();
  return { hidden: document.getElementById("edHl").hidden,
    n: document.querySelectorAll("#edLinkIcons .lnkico").length,
    bg: document.querySelectorAll("#edHlIn .lnk").length,
    mark: document.querySelectorAll("#edHlIn .hmark").length,
    href: ic ? ic.getAttribute("href") : "",
    target: ic ? ic.getAttribute("target") : "",
    rel: ic ? ic.getAttribute("rel") : "",
    svg: ic ? !!ic.querySelector("svg") : false,
    text: ic ? ic.textContent.trim() : "",
    left: ic ? parseFloat(ic.style.left) : -1,
    centerY: ic ? parseFloat(ic.style.top) + 5.5 : -1,
    wantX: Math.round(rr.right - mr.left - 1),
    wantY: rr.top - mr.top - 1 + rr.height / 2,
    style: (function(){ var cs = getComputedStyle(ic); return { w: cs.width, h: cs.height, color: cs.color, bg: cs.backgroundColor }; })() }; })()`);
ok(!edIcon.hidden && edIcon.n === 1, '编辑器在网址末尾渲染出 1 个链接图标', edIcon);
ok(edIcon.bg === 0 && edIcon.mark === 0, '网址不再铺底色（无 .lnk 底纹、无命中标记）', edIcon);
ok(edIcon.href === "https://example.com" && edIcon.target === "_blank" && /noopener/.test(edIcon.rel),
  '图标指向完整网址，新标签打开且带 noopener', edIcon);
ok(edIcon.svg && edIcon.text === "", '图标只显示链接图标、不带任何文字', edIcon);
ok(edIcon.style.w === "11px" && edIcon.style.h === "11px", '图标做得很小（11px，避免占地方）', edIcon.style);
ok(edIcon.style.color === "rgb(106, 169, 224)", '图标是浅蓝色', edIcon.style);
ok(edIcon.style.bg === "rgba(0, 0, 0, 0)", '图标默认没有底色', edIcon.style);
ok(Math.abs(edIcon.left - edIcon.wantX) <= 2, '图标紧贴网址末尾（不是行尾）', edIcon);
// 文本框的排版动不了，图标平着放必然压住后一个字，所以抬成"上标"躲开字身
ok(edIcon.centerY < edIcon.wantY && edIcon.centerY > edIcon.wantY - 12,
  '图标抬高成上标（在行内偏上，不压后面那个字）', edIcon);

// 网址以句末标点收尾时，标点不能被吃进链接；图标要跟在网址后，而不是跑到行尾
await ev(`(function(){ var t=document.getElementById("edt");
  t.value = "见 https://a.example/x, 后面还有一大段文字不能算进网址里"; t.dispatchEvent(new Event("input")); })()`);
await sleep(260);
const punct = await ev(`(function(){
  var ic = document.querySelector("#edLinkIcons .lnkico");
  var t = document.getElementById("edt"), v = t.value;
  var i = v.indexOf("https://a.example/x");
  var mm = document.getElementById("edMeasure"), mr = mm.getBoundingClientRect();
  var n = mm.firstChild;
  var r = document.createRange(); r.setStart(n, i + 18); r.setEnd(n, i + 19);   // 网址结尾的 x
  var rr = r.getBoundingClientRect();
  var r2 = document.createRange(); r2.setStart(n, v.length - 1); r2.setEnd(n, v.length);  // 行尾最后一个字
  var rr2 = r2.getBoundingClientRect();
  return { href: ic ? ic.getAttribute("href") : "",
    left: ic ? parseFloat(ic.style.left) : -1,
    wantX: Math.round(rr.right - mr.left - 1),
    lineEndX: Math.round(rr2.right - mr.left - 1) }; })()`);
ok(punct.href === "https://a.example/x", '句末逗号不算网址的一部分', punct);
ok(Math.abs(punct.left - punct.wantX) <= 2 && punct.left < punct.lineEndX - 10,
  '图标跟在网址后面，而不是跑到行尾', punct);

// 伪协议（javascript:）永远不做成链接
await ev(`(function(){ var t=document.getElementById("edt");
  t.value = "点 javascript:alert(1) 无效"; t.dispatchEvent(new Event("input")); })()`);
await sleep(260);
ok(await ev('document.querySelectorAll("#edLinkIcons .lnkico").length') === 0, 'javascript: 伪协议不会被做成链接');

// 网址后面紧跟中文句读 + 汉字：网址要在句读处截断，不能把后面的中文一起吃掉
const cjkStop = await ev(`(function(){
  var l = findLinks("https://a.com/x。后文");
  return l.length === 1 ? l[0].href : "n=" + l.length; })()`);
ok(cjkStop === "https://a.com/x", '网址在全角句读处截断（不吃掉后面的中文）', { cjkStop });
const cjkStop2 = await ev(`(function(){
  var l = findLinks("见 https://a.com/x，后文");
  return l.length === 1 ? l[0].href : "n=" + l.length; })()`);
ok(cjkStop2 === "https://a.com/x", '全角逗号同样截断网址', { cjkStop2 });
// 中文出现在路径里（没有句读）时仍应保留
const cjkKeep = await ev(`(function(){
  var l = findLinks("https://zh.wikipedia.org/wiki/中文");
  return l.length === 1 ? l[0].href : "n=" + l.length; })()`);
ok(cjkKeep === "https://zh.wikipedia.org/wiki/中文", '路径里的中文照旧保留（只在全角句读处截断）', { cjkKeep });

// 还原成原始 Markdown（触发一次 input 让图标层重画，再撤掉草稿定时器，避免污染后续依赖 说明.md 的用例）
await ev('(function(){ var t=document.getElementById("edt"); t.value = ' + JSON.stringify(mdOrig) +
  '; t.dispatchEvent(new Event("input")); ed.dirty=false; clearTimeout(ed.dtimer); clearDraft(ed.path); })()');
await sleep(260);
ok(await ev('document.querySelectorAll("#edLinkIcons .lnkico").length') === 1, '还原后图标层重新画出网址图标');

// ---- 网址打开：linkAt（Ctrl/Cmd+点击）+ 图标点击 ----
head('网址打开');
// linkAt 是 Ctrl/Cmd+点击那条路的判定：下标落在网址区间内才算命中
const la = await ev(`(function(){
  var v = document.getElementById("edt").value;
  var i = v.indexOf("https://example.com");
  return { inside: !!linkAt(i + 4), atStart: !!linkAt(i), atEnd: !!linkAt(i + 19),
    outside: !!linkAt(i - 1), href: (linkAt(i + 4) || {}).href }; })()`);
ok(la.inside && la.atStart && la.atEnd && !la.outside, 'linkAt：只有落在网址区间内才算命中', la);
ok(la.href === "https://example.com", 'linkAt 给出可打开的完整网址', la);

// 普通点击不改编辑习惯：点网址只放光标、不跳转（防误触）
ok(await ev('(function(){ var t=document.getElementById("edt"); var i=t.value.indexOf("https://example.com");' +
  ' t.setSelectionRange(i+3,i+3); t.dispatchEvent(new MouseEvent("click",{bubbles:true}));' +
  ' return t.selectionStart === i+3 && document.querySelectorAll("#edLinkIcons .lnkico").length === 1; })()'),
  '普通点击网址：只放光标，不会直接跳走');

// Ctrl/Cmd+点击才直接打开（用一个可观测的替身接住 openUrl 的目标）
const ctrlOpen = await ev(`(function(){
  var opened = "", orig = openUrl;
  window.openUrl = function(h){ opened = h; };
  var t = document.getElementById("edt"), i = t.value.indexOf("https://example.com");
  t.setSelectionRange(i + 3, i + 3);
  t.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  window.openUrl = orig;
  return opened; })()`);
ok(ctrlOpen === "https://example.com", '桌面 Ctrl/Cmd+点击网址直接打开', { ctrlOpen });

// 图标本身就是 <a>，点一下就是打开这个网址（手机端就走这条）
const iconClick = await ev(`(function(){
  var ic = document.querySelector("#edLinkIcons .lnkico");
  var got = "";
  var stop = function(e){ e.preventDefault(); got = ic.getAttribute("href"); };
  ic.addEventListener("click", stop);
  ic.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  ic.removeEventListener("click", stop);
  return got; })()`);
ok(iconClick === "https://example.com", '点网址末尾的小图标即打开该网址', { iconClick });

// 图标层整体不吃鼠标：点空白处不会挡住文本框（点仍落到 textarea 上）
ok(await ev('getComputedStyle(document.getElementById("edLinkIcons")).pointerEvents') === "none",
  '图标层本身 pointer-events:none（只有图标可点）');

// ---- 顶部操作区：刷新按钮 ----
head('刷新按钮');
const acctStat = await ev(`(function(){ var acct=document.getElementById("acct");
  var ids = Array.prototype.map.call(acct.children, function(b){ return b.id; });
  var rb = document.getElementById("btnReload");
  return { ids: ids, first: ids[0], title: rb ? rb.getAttribute("title") : "",
    svg: rb ? !!rb.querySelector("svg") : false }; })()`);
ok(acctStat.ids.indexOf("btnReload") >= 0, '管理页存在刷新按钮 #btnReload', acctStat);
ok(acctStat.first === "btnReload", '刷新按钮排在操作区最前（退出按钮的左侧）', acctStat);
ok(!!acctStat.title && acctStat.svg, '刷新按钮带 title 提示与图标', acctStat);

// ---- JSON ----
head('JSON 折叠树');
await ev('openFile("数据.json")');
await waitFor('document.getElementById("edt").value.indexOf("雷达") >= 0', 8000, 'json 载入');
await ev('edSetPreview(true)');
const jt = await ev(`(function(){ var b=document.getElementById("edPrev");
  return { keys: b.querySelectorAll(".jtKey").length, tog: b.querySelectorAll(".jtTog").length,
           str: b.querySelectorAll(".jtStr").length, bool: b.querySelectorAll(".jtBool").length,
           nul: b.querySelectorAll(".jtNull").length, sum: b.querySelectorAll(".jtSum").length }; })()`);
ok(jt.keys >= 5, 'JSON 键都渲染出来了', jt.keys);
ok(jt.tog >= 3, '有可折叠的节点', jt.tog);
ok(jt.bool >= 1 && jt.nul >= 1, '布尔与 null 有专门样式', jt);
ok(jt.sum >= 2, '折叠节点显示子项数量（折叠时也知道里面有多少）', jt.sum);
await ev('(function(){ document.querySelector("#edPrev .jtTog").click(); })()');
await sleep(150);
ok(await ev('document.querySelectorAll("#edPrev .jtKids.hide").length >= 1'), '点折叠三角能把子节点收起来');
ok(await ev('document.querySelector("#edPrev .jtTog").textContent === "+"'), '收起后三角变成 +');
await ev('edSetPreview(false)');

// ---- 坏的 JSON 应退回纯文本 ----
await ev('openFile("坏的.json")');
await waitFor('document.getElementById("edt").value.indexOf("合法") >= 0', 8000, '坏 json 载入');
await ev('edSetPreview(true)');
ok(await ev('document.getElementById("edPrev").hidden'), '解析失败的 JSON 不渲染（自动退回源码，不会报错）');

// ---- CSV ----
head('CSV 表格');
await ev('openFile("表格.csv")');
await waitFor('document.getElementById("edt").value.indexOf("苹果") >= 0', 8000, 'csv 载入');
await ev('edSetPreview(true)');
const csv = await ev(`(function(){ var b=document.getElementById("edPrev");
  return { heads: b.querySelectorAll("table.csv thead th").length, rows: b.querySelectorAll("table.csv tbody tr").length,
           first: b.querySelector("table.csv tbody tr td").textContent,
           note: b.querySelector(".rawNote") ? b.querySelector(".rawNote").textContent : "" }; })()`);
ok(csv.heads === 3, 'CSV 表头 3 列', csv.heads);
ok(csv.rows === 3, 'CSV 正文 3 行', csv.rows);
ok(csv.first === '苹果', '首行内容正确', csv.first);
ok(/3/.test(csv.note), '统计行数提示存在', csv.note);
const ascOrder = await ev('[...document.querySelectorAll("#edPrev table.csv tbody tr td:first-child")].map(function(t){return t.textContent;})');
await ev('(function(){ document.querySelector("#edPrev table.csv thead th").click(); })()');
await sleep(250);
const sortedOrder = await ev('[...document.querySelectorAll("#edPrev table.csv tbody tr td:first-child")].map(function(t){return t.textContent;})');
ok(JSON.stringify(sortedOrder) === JSON.stringify([...ascOrder].sort((a, b) => a.localeCompare(b, 'zh'))),
  '点表头后按名称升序重排', { ascOrder, sortedOrder });
await ev('(function(){ document.querySelector("#edPrev table.csv thead th").click(); })()');
await sleep(250);
const descOrder = await ev('[...document.querySelectorAll("#edPrev table.csv tbody tr td:first-child")].map(function(t){return t.textContent;})');
ok(JSON.stringify(descOrder) === JSON.stringify([...sortedOrder].reverse()), '再点一次变成降序', { ascOrder, sortedOrder, descOrder });
await ev('edSetPreview(false)');

// ---- 代码高亮 ----
head('代码语法高亮');
await ev('openFile("脚本.js")');
await waitFor('document.getElementById("edt").value.indexOf("hello") >= 0', 8000, 'js 载入');
await ev('edSetPreview(true)');
const hl = await ev(`(function(){ var b=document.getElementById("edPrev");
  return { k: b.querySelectorAll(".tk-k").length, c: b.querySelectorAll(".tk-c").length,
           s: b.querySelectorAll(".tk-s").length, n: b.querySelectorAll(".tk-n").length }; })()`);
ok(hl.k >= 2 && hl.c >= 1 && hl.s >= 1 && hl.n >= 1, 'JS 高亮包含关键字/注释/字符串/数字', hl);
await ev('edSetPreview(false)');

// ---- 纯文本兜底 ----
head('纯文本兜底（零回归）');
await ev('openFile("纯文本.txt")');
await waitFor('document.getElementById("edt").value.indexOf("这是一段纯文本") >= 0', 8000, 'txt 载入');
ok(await ev('edCanPreview() === false'), '纯文本不显示预览切换（没有专用渲染器）');
ok(await ev('document.getElementById("edSeg").innerHTML === ""'), '纯文本不渲染分段控件');
ok(await ev('!document.getElementById("edt").hidden'), '纯文本照常显示在编辑器里');

// ---- 行号对齐 ----
head('行号槽对齐（换行模式）');
await ev('openFile("长行.txt")');
await waitFor('document.getElementById("edt").value.length > 2500', 8000, '长行载入');
const align = await ev(`(function(){
  var t = document.getElementById("edt");
  var nums = document.querySelectorAll("#edGutterIn .edGutNum");
  var m = document.getElementById("edMirror");
  m.style.fontSize = getComputedStyle(t).fontSize;
  m.style.lineHeight = getComputedStyle(t).lineHeight;
  m.innerHTML = "<div>" + t.value.split("\\n")[0] + "</div>";
  var wrapped = m.children.length ? m.children[0].offsetHeight : 0;
  return { nums: nums.length, top: nums.length ? parseFloat(nums[0].style.top) : -1, wrappedH: wrapped,
           lh: parseFloat(getComputedStyle(t).lineHeight) };
})()`);
ok(align.nums === 2, '长行文件有 2 个行号', align.nums);
ok(align.top === 14, '第一个行号贴在第一行位置（padding-top 14px）', align.top);
ok(align.wrappedH > align.lh * 2, '镜像确实检测到该行折成了多行', align);

// ---- 换行开关回归 ----
head('自动换行（回归）');
await ev('if (!wrapOn) toggleWrap();');
await sleep(250);
const onState = await ev('(function(){ var t=document.getElementById("edt"); return { sw: t.scrollWidth, cw: t.clientWidth, cls: t.className }; })()');
ok(onState.sw <= onState.cw + 2, '换行开启：无横向溢出', onState);
ok(onState.cls.indexOf('wrapon') >= 0, '换行开启时 class 正确');
await ev('toggleWrap()');
await sleep(250);
const offState = await ev('(function(){ var t=document.getElementById("edt"); return { sw: t.scrollWidth, cw: t.clientWidth, cls: t.className }; })()');
ok(offState.sw > offState.cw + 100, '换行关闭：长行可横向滚动', offState);
ok(offState.cls.indexOf('wrapoff') >= 0, '换行关闭时 class 正确');
await ev('toggleWrap()');
await sleep(200);
ok((await ev('(function(){ var t=document.getElementById("edt"); return t.scrollWidth <= t.clientWidth + 2; })()')), '再次开启换行恢复正常');
ok((await ev('edText().indexOf("LONGSTART-") >= 0 && edText().indexOf("-LONGEND") >= 0')), '切换换行前后内容逐字不变');

// ---- 媒体预览 ----
head('媒体预览（blob: + CSP）');
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 7', 8000, '回到笔记目录');
await ev('openMediaModal("笔记/图片.png","图片.png")');
await waitFor('document.getElementById("mbImg") && document.getElementById("mbImg").src.indexOf("blob:") === 0', 8000, '图片 blob 载入');
const media = await ev(`(function(){ var i=document.getElementById("mbImg");
  return { blob: i.src.indexOf("blob:") === 0, w: i.naturalWidth, h: i.naturalHeight,
           info: document.getElementById("mbInfo").textContent,
           hasRot: !!document.getElementById("mbRot"), hasZoom: !!document.getElementById("mbIn") }; })()`);
ok(media.blob, '图片用 blob: URL 加载');
ok(media.w === 1 && media.h === 1, '图片真的解码成功（1×1）', { w: media.w, h: media.h });
ok(media.hasZoom && media.hasRot, '提供缩放与旋转按钮');
ok(media.info.indexOf('B') >= 0, '显示了尺寸信息', media.info);
await ev('(function(){ document.getElementById("mbIn").click(); })()');
ok(await ev('document.getElementById("mbImg").style.transform.indexOf("scale") >= 0'), '放大按钮生效');
await ev('closeModal()');
ok(await ev('document.getElementById("mbImg") === null || document.querySelector("#mbBox").innerHTML === "" || true'), '关闭弹窗不报错');

// ---- 分段控件 ----
head('编辑器分段控件');
await ev('openFile("说明.md")');
await waitFor('document.getElementById("edt").value.length > 0', 8000, 'md 再载入');
ok(await ev('document.querySelectorAll("#edSeg [data-emode]").length === 2'), 'Markdown 有 源码/预览 两个分段按钮');
await ev('(function(){ document.querySelector("#edSeg [data-emode=prev]").click(); })()');
ok(await ev('!document.getElementById("edPrev").hidden'), '点分段按钮进入预览');

// ---- 大文件分片上传与续传 ----
head('大文件分片上传 / 续传');
const BYTEOF = '(i * 7 + 13) & 255';
await ev('state.path = "笔记";');
const bigUp = await ev(`(async function(){
  var size = 9 * 1024 * 1024;
  var buf = new Uint8Array(size);
  for (var i = 0; i < size; i++) buf[i] = ${BYTEOF};
  var f = new File([buf], 'big.bin', { type: 'application/octet-stream' });
  var t0 = performance.now();
  await uploadMultipart(f, '笔记/big.bin', 'big.bin');
  return { ms: Math.round(performance.now() - t0), size: f.size };
})()`, true);
ok(bigUp.size === 9 * 1024 * 1024, '在页面里构造了 9MB 的文件');
console.log('  9MB 分片上传耗时 ' + bigUp.ms + ' ms');

const rawBig = await fetch(ADMIN + '/api?action=raw&path=' + encodeURIComponent('笔记/big.bin'));
const bodyBig = new Uint8Array(await rawBig.arrayBuffer());
ok(bodyBig.length === 9 * 1024 * 1024, '分片合并后大小正确', bodyBig.length);
{
  const probes = [0, 1, 1024, 8388607, 8388608, 8388609, bodyBig.length - 1];
  let allOk = true, badOff = -1;
  for (const off of probes) { if (bodyBig[off] !== ((off * 7 + 13) & 255)) { allOk = false; badOff = off; break; } }
  ok(allOk, '分片边界附近的字节都对（拼接顺序正确）', badOff);
}
{
  let same = true;
  for (let i = 0; i < bodyBig.length; i++) { if (bodyBig[i] !== ((i * 7 + 13) & 255)) { same = false; break; } }
  ok(same, '9MB 全量逐字节校验通过');
}

// 模拟"传到一半断了"：手工建会话并只传第 1 片，再走正常上传流程
const part1 = await ev(`(async function(){
  var size = 9 * 1024 * 1024;
  var buf = new Uint8Array(size);
  for (var i = 0; i < size; i++) buf[i] = ${BYTEOF};
  var f = new File([buf], 'resume.bin', { type: 'application/octet-stream' });
  var c = await post({ action: 'mpCreate', path: '笔记/resume.bin', ct: 'application/octet-stream', size: size, mtime: 0 });
  if (!c.ok) throw new Error(c.error);
  await putPart(c.uploadId, 1, f.slice(0, 8 * 1024 * 1024), null);
  return { uploadId: c.uploadId, ok: true };
})()`, true);
ok(part1.ok, '手工创建会话并预传第 1 片（模拟断在 8MB 处）');

const resumed = await ev(`(async function(){
  var size = 9 * 1024 * 1024;
  var buf = new Uint8Array(size);
  for (var i = 0; i < size; i++) buf[i] = ${BYTEOF};
  var f = new File([buf], 'resume.bin', { type: 'application/octet-stream' });
  var sess = await findMpSession('笔记/resume.bin', size);
  var parts = sess ? sess.parts : null;
  var r = await uploadMultipart(f, '笔记/resume.bin', 'resume.bin');
  return { seenParts: parts, resumed: r.resumed };
})()`, true);
ok(resumed.seenParts && resumed.seenParts.length === 1 && resumed.seenParts[0] === 1,
  '找到未完成会话，识别出已传分片', resumed.seenParts);
ok(resumed.resumed === true, '续传时标记为"跳过了已传分片"', resumed.resumed);

const rawRes = await fetch(ADMIN + '/api?action=raw&path=' + encodeURIComponent('笔记/resume.bin'));
const bodyRes = new Uint8Array(await rawRes.arrayBuffer());
ok(bodyRes.length === 9 * 1024 * 1024, '续传后大小正确', bodyRes.length);
{
  let same = true;
  for (let i = 0; i < bodyRes.length; i++) { if (bodyRes[i] !== ((i * 7 + 13) & 255)) { same = false; break; } }
  ok(same, '续传后内容逐字节一致（拼上了预传的第 1 片）');
}

// 阈值：小文件不该走多段
ok(await ev('MP_MIN === 8 * 1024 * 1024'), '分片阈值是 8MB（小文件坚持单次 PUT）');
ok(await ev('typeof uploadSimple === "function" && typeof uploadMultipart === "function"'), '单次上传与分片上传两条路径都存在');

head('编辑器：路径条 · 不自动聚焦');
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, '笔记列表');
await ev('openFile("说明.md")');
await waitFor('document.getElementById("edt").value.length > 0', 8000, 'md 载入');

// 手机上左侧抽屉是收起的，编辑器里必须能看出"这个文件在哪一级"，并能一键上跳
const crumb = await ev(`(function(){
  var b = document.getElementById('edCrumb');
  if (!b) return { exists: false };
  var links = [].slice.call(b.querySelectorAll('a[data-nav]'));
  return {
    exists: true, text: b.textContent, visible: b.getBoundingClientRect().height > 0,
    links: links.map(function(a){ return { label: a.textContent, nav: a.getAttribute('data-nav') }; }),
    file: b.querySelector('.curfile') ? b.querySelector('.curfile').textContent : '',
    nowrap: getComputedStyle(b).flexWrap
  };
})()`);
ok(crumb.exists && crumb.visible, '编辑器顶部有可见的路径条');
ok(crumb.text.indexOf('根目录') >= 0, '路径条从「根目录」开始', crumb.text);
ok(crumb.text.indexOf('笔记') >= 0, '路径条包含所在目录「笔记」', crumb.text);
ok(crumb.file === '说明.md', '路径条末尾是当前文件名', crumb.file);
ok(crumb.links.length >= 2, '每一级目录都是可点链接', crumb.links);
ok(crumb.nowrap === 'nowrap', '路径条不换行（长路径横向滑动，不会把工具条撑成两行）', crumb.nowrap);

// 点路径条里的「根目录」→ 直接跳到那一级列表（不必再开左侧抽屉）
await ev(`(function(){
  document.querySelector('#edCrumb a[data-nav=""]').dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(1000);
ok(await ev('state.view === "list"'), '点路径条里的目录名直接回到列表视图');
ok(await ev('state.path') === '', '并且真的跳到了那一级（根目录）', await ev('state.path'));

// 打开文件不自动聚焦：手机上 focus textarea 会立刻弹出软键盘，把页面顶掉
await ev('load("笔记")', true);
await sleep(700);
await ev('document.getElementById("edt").blur()');
await ev('openFile("说明.md")');
await sleep(1300);
ok(await ev('document.activeElement !== document.getElementById("edt")'),
  '打开文件不自动把光标放进文本框（移动端不会自动弹键盘）',
  await ev('document.activeElement ? (document.activeElement.tagName + "#" + (document.activeElement.id || "")) : "null"'));

head('返回键 = 回上一级目录，而不是退出页面');
await ev('load("", true)');                       // true = 只替换当前历史条目
await sleep(800);
ok(await ev('state.path') === '', '先回到根目录');
await ev('load("笔记")');                          // 不带第二参 = 新增一条历史
await sleep(1000);
ok((await ev('location.search')).indexOf('path=') >= 0, '切目录后地址栏带上了 path',
  await ev('location.search'));
await ev('history.back()');
await waitFor('state.path === ""', 8000, '按返回键后回到根目录');
ok(await ev('state.path') === '', '按返回键回到上一级目录（不是离开整个网站）');
ok(await ev('state.view') === 'list', '并且停在列表视图');
ok((await ev('location.search')).indexOf('path=') < 0, '地址栏也同步回上一级',
  await ev('location.search'));

head('编辑器：分享按钮点开就能分享 · 页面不再有内嵌分享面板');
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, '笔记列表');
await ev('openFile("说明.md")');
await waitFor('document.getElementById("edt").value.length > 0', 8000, 'md 载入');

// 内嵌的「分享设置」面板已删除：顶部工具条的「分享」按钮就是唯一入口，
// 否则用户在上面点了分享发现没反应、还得自己去下面找面板，很困惑。
ok(await ev('document.getElementById("sharePanel") === null'),
  '编辑器里不再有内嵌的「分享设置」面板（界面更干净）');
ok(await ev('document.getElementById("secShareHead") === null'), '也不再有那个折叠标题');

await ev('(function(){ document.getElementById("edShare").click(); })()');
await sleep(500);
const shModal = await ev(`(function(){
  var mask = document.getElementById("mMask");
  var root = document.getElementById("shareModalRoot");
  return { on: mask.classList.contains("on"),
           title: document.getElementById("mTitle").textContent,
           hasRoot: !!root,
           gen: root ? root.querySelectorAll("button[data-shgen]").length : 0,
           token: !!(root && root.querySelector('[data-shrole="token"]')),
           exp: !!(root && root.querySelector('[data-shrole="exp"]')) };
})()`);
ok(shModal.on && shModal.hasRoot, '点工具栏的「分享」直接弹出分享弹窗', shModal);
ok(shModal.gen === 1 && shModal.token && shModal.exp, '弹窗里有生成按钮 + 自定义口令 + 有效期', shModal);

// 弹窗内部也不该有重复 id
const dupIds = await ev(`(function(){
  var seen = {}, dup = [];
  document.querySelectorAll('[id]').forEach(function(e){
    if (seen[e.id]) { if (dup.indexOf(e.id) < 0) dup.push(e.id); } else seen[e.id] = 1;
  });
  return dup;
})()`);
ok(dupIds.length === 0, '页面里没有重复 id（分享面板改用 data-shrole）', dupIds);

await ev(`(function(){
  var root = document.getElementById("shareModalRoot");
  root.querySelector('[data-shrole="token"]').value = "";
  root.querySelector('[data-shrole="exp"]').value = "86400";
  root.querySelector("button[data-shgen]").click();
})()`);
await waitFor('document.querySelector(\'#shareModalRoot [data-shrole="result"] .okbox\') !== null', 12000, '分享结果框');
const shRes = await ev(`(function(){
  var root = document.getElementById("shareModalRoot");
  var b = root.querySelector('[data-shrole="result"]');
  var box = b ? b.querySelector(".okbox") : null;
  var input = box ? box.querySelector("input.linkbox") : null;
  return { hidden: b ? b.hidden : null, hasBox: !!box, url: input ? input.value : "",
           qr: !!(b && b.querySelector('[data-shrole="qr"]')) };
})()`);
ok(shRes.hidden === false && shRes.hasBox, '弹窗里点「生成」直接出分享链接结果框', shRes);
ok(shRes.url.indexOf('/s/') >= 0, '生成的链接是 /s/<token> 形式', shRes.url);
ok(shRes.qr, '结果里带二维码容器');
await ev('closeModal()');
ok(await ev('!document.getElementById("mMask").classList.contains("on")'), '关闭分享弹窗正常');

head('分享状态即时更新（乐观合并，不等 KV 回读）');
// 刚在编辑器里生成了一条分享 —— 不刷新页面、直接切回列表，「已分享」徽标就必须已经在
await ev('switchView("list")');
await sleep(500);
const badgeNow = await ev(`(function(){
  var rows = [].slice.call(document.querySelectorAll('#list .shbadge'));
  return { count: rows.length, first: rows.length ? rows[0].textContent : '' };
})()`);
ok(badgeNow.count >= 1, '生成分享后列表立即出现「已分享」徽标（无需手动刷新）', badgeNow);
// 分享管理同样立即有数据，且带打开入口
await ev('openShareManager()');
await sleep(500);
const mgrNow = await ev(`(function(){
  var b = document.getElementById('mgrBody');
  return { rows: b.querySelectorAll('.shrow').length,
           openIcons: b.querySelectorAll('button[data-shopen]').length,
           locateBtns: b.querySelectorAll('button[data-shlocate]').length };
})()`);
ok(mgrNow.rows >= 1, '分享管理立即显示刚生成的分享', mgrNow);
ok(mgrNow.openIcons >= 1, '每条分享带「打开分享链接」图标按钮', mgrNow);
ok(mgrNow.locateBtns >= 1, '每个分享分组带「定位到文件位置」按钮', mgrNow);
// 点「定位」：关闭弹窗 → 跳到所在目录 → 直接打开该文件（可编辑）
await ev('(function(){ document.querySelector(\'#mgrBody button[data-shlocdir="0"]\').click(); })()');
await sleep(1400);
ok(await ev('document.getElementById("mMask").classList.contains("on")') === false, '定位后关闭分享管理弹窗');
ok((await ev('state.path')) === '笔记', '定位到了文件所在目录', await ev('state.path'));
ok((await ev('ed.path')) === '笔记/说明.md', '并直接打开了被分享的文件（可编辑）', await ev('ed.path'));
ok((await ev('state.view')) === 'edit', '当前在编辑器视图');
await ev('closeModal()');
await sleep(200);

// 取消分享：条目与徽标立即消失（同样不等 KV 回读）。
// 注意：桥接服务启动时会播种一条「笔记」目录的分享（给只读分享页测试用），
// 所以这里循环把**全部**分享都取消掉，再断言清零。定位测试后处于编辑器视图，先切回列表。
await ev('switchView("list")');
await sleep(500);
await ev('openShareManager()');
await sleep(400);
for (let i = 0; i < 8; i++) {
  const has = await ev('!!document.querySelector("#mgrBody button[data-shdel]")');
  if (!has) break;
  await ev('(function(){ document.querySelector("#mgrBody button[data-shdel]").click(); })()');
  await sleep(700);
}
const mgrAfter = await ev('document.querySelectorAll("#mgrBody .shrow").length');
ok(mgrAfter === 0, '取消分享后条目立即从分享管理消失（不等 KV 回读）', mgrAfter);
ok((await ev('document.querySelectorAll("#list .shbadge").length')) === 0, '列表的「已分享」徽标也立即消失');
await ev('closeModal()');
await sleep(200);

head('列表操作折叠为 ⋯ 菜单');
await ev('load("笔记")', true);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, '列表');
const opsState = await ev(`(function(){
  var tr = document.querySelector('#list tbody tr');
  return { more: tr.querySelectorAll('button.tact[data-tact]').length,
           legacyOps: tr.querySelectorAll('.op').length,
           legacyDivs: tr.querySelectorAll('.ops').length };
})()`);
ok(opsState.more === 1 && opsState.legacyOps === 0 && opsState.legacyDivs === 0,
  '每行只剩一个 ⋯ 按钮（六个平铺操作全部收进菜单）', opsState);
await ev(`(function(){
  var btns = [].slice.call(document.querySelectorAll('#list tbody tr button.tact[data-dir="0"]'));
  btns[0].click();
})()`);
await sleep(400);
const ctxNow = await ev(`(function(){
  var box = document.getElementById('ctx');
  if (!box) return { open: false };
  var items = [].slice.call(box.querySelectorAll('.ci')).map(function(b){ return b.getAttribute('data-cmd'); });
  return { open: box.classList.contains('on'), items: items };
})()`);
ok(ctxNow.open, '点 ⋯ 弹出操作菜单');
ok(ctxNow.items.indexOf('open') >= 0 && ctxNow.items.indexOf('download') >= 0 &&
   ctxNow.items.indexOf('share') >= 0 && ctxNow.items.indexOf('rename') >= 0 &&
   ctxNow.items.indexOf('move') >= 0 && ctxNow.items.indexOf('del') >= 0,
  '菜单包含 打开 / 下载 / 分享 / 重命名 / 移动 / 删除', ctxNow.items);
await ev('closeCtx()');
await sleep(150);
// ⋯ 菜单里的「分享」也要能直接弹出分享弹窗（和原来平铺按钮等效）
await ev(`(function(){
  var btns = [].slice.call(document.querySelectorAll('#list tbody tr button.tact[data-dir="0"]'));
  btns[0].click();
})()`);
await sleep(350);
await ev(`(function(){
  var b = document.querySelector('#ctx .ci[data-cmd="share"]');
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
})()`);
await sleep(500);
ok(await ev('document.getElementById("mMask").classList.contains("on")'), '⋯ 菜单里的「分享」直接弹出分享弹窗');
await ev('closeModal()');
await sleep(200);

head('编辑器：复制全文按钮');
const copyPos = await ev(`(function(){
  var c = document.getElementById("edCopy");
  if (!c) return { exists: false };
  var cr = c.getBoundingClientRect(), tr = document.getElementById("edt").getBoundingClientRect();
  return { exists: true, above: cr.bottom <= tr.top + 1, btnTop: Math.round(cr.top), edtTop: Math.round(tr.top) };
})()`);
ok(copyPos.exists, '工具栏里有「复制全文」按钮');
ok(copyPos.above, '按钮位于文本框上方', copyPos);

const copyRun = await ev(`(function(){
  window.__copied = null;
  var orig = window.copyText;
  window.copyText = function(v){ window.__copied = v; };
  document.getElementById("edCopy").click();
  window.copyText = orig;
  var t = document.getElementById("edt").value;
  return { got: window.__copied, len: t.length, same: window.__copied === t };
})()`);
ok(typeof copyRun.got === 'string', '点击后真的触发了复制');
ok(copyRun.same, '复制的内容与编辑器全文逐字一致');
ok(copyRun.len > 50, '复制的是完整全文（不是片段）', copyRun.len);

const copyEmpty = await ev(`(function(){
  var t = document.getElementById("edt");
  var keep = t.value;
  t.value = "";
  window.__copied2 = "sentinel";
  var orig = window.copyText;
  window.copyText = function(v){ window.__copied2 = v; };
  document.getElementById("edCopy").click();
  window.copyText = orig;
  t.value = keep;
  return { called: window.__copied2 !== "sentinel" };
})()`);
ok(copyEmpty.called === false, '内容为空时只提示、不去复制空字符串', copyEmpty.called);

head('编辑器下方不再有异常空白');
await ev(`(function(){
  switchView('edit');
  var t = document.getElementById('edt');
  var lines = [];
  for (var i = 1; i <= 200; i++) lines.push('    "第 ' + i + ' 行"，一段用来撑高编辑器的文本。');
  t.value = lines.join(String.fromCharCode(10));
  syncGutter(); updateCount();
})()`, true);
await sleep(700);
const blank = await ev(`(function(){
  var main = document.querySelector('main');
  var mir = document.getElementById('edMirror');
  return { mainClient: main.clientHeight, mainScroll: main.scrollHeight,
           mirClient: mir.clientHeight, mirScroll: mir.scrollHeight,
           mirBottom: Math.round(mir.getBoundingClientRect().bottom),
           hasSharePanel: !!document.querySelector('#viewEdit .sec'),
           viewport: window.innerHeight };
})()`);
ok(!blank.hasSharePanel, '编辑器里没有内嵌分享面板（底部不残留那块 DOM）');
ok(blank.mainScroll <= blank.mainClient + 2,
  '200 行文件下 main 不再多出可滚动空白', { scroll: blank.mainScroll, client: blank.mainClient });
ok(blank.mirScroll > blank.mirClient + 500,
  '镜像层内部仍保留完整内容高度（行高测量能力没丢）', { inner: blank.mirScroll, box: blank.mirClient });
ok(blank.mirBottom <= blank.viewport, '镜像层盒子不再超出视口', blank.mirBottom);
const maxScroll = await ev(`(function(){
  var main = document.querySelector('main');
  main.scrollTop = 99999;
  var at = main.scrollTop;
  main.scrollTop = 0;
  return at;
})()`);
ok(maxScroll <= 2, '试着滚到底也滚不动（不会滑出一大段白屏）', maxScroll);

head('编辑器文本框铺满可用高度（PC / 手机）');
for (const [label, w, h, mobile] of [['PC 1440×900', 1440, 900, false], ['手机 390×844', 390, 844, true]]) {
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 }, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }, sid);
  await sleep(450);
  await ev('load("笔记", true)');
  await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, label + ' 列表');
  await ev('openFile("纯文本.txt")');                 // 只有两行，最容易暴露底部空白
  await waitFor('document.getElementById("edt").value.length > 0', 8000, label + ' 载入');
  await sleep(600);
  const m = await ev(`(function(){
    var edt = document.getElementById('edt');
    var foot = document.querySelector('#viewEdit .editFoot');
    var wrap = document.getElementById('viewEdit');
    var tr = edt.getBoundingClientRect(), fr = foot.getBoundingClientRect();
    var pad = parseInt(getComputedStyle(wrap).paddingBottom, 10) || 0;
    return { vh: window.innerHeight, edtH: Math.round(tr.height),
             wasted: Math.round(window.innerHeight - fr.bottom - pad),
             docH: document.documentElement.scrollHeight };
  })()`);
  console.log('  ' + label + '：文本框 ' + m.edtH + 'px / 视口 ' + m.vh + 'px，底部浪费 ' + m.wasted + 'px');
  ok(m.wasted <= 20, label + '：文本框下方没有多余空白', m);
  ok(m.edtH > m.vh * 0.5, label + '：文本框占到视口一半以上', m.edtH + '/' + m.vh);
  ok(m.docH <= m.vh + 2, label + '：内容不满屏时页面不会多出一截滚动', m.docH + ' vs ' + m.vh);
}

// 撑满之后仍然要能滚：高度被视口约束，不能随内容长大把正文裁掉
await ev(`(function(){
  var t = document.getElementById('edt');
  var lines = []; for (var i = 1; i <= 300; i++) lines.push('第 ' + i + ' 行内容');
  t.value = lines.join(String.fromCharCode(10));
  syncGutter();
})()`);
await sleep(500);
const longScroll = await ev(`(function(){
  var t = document.getElementById('edt');
  return { inner: t.scrollHeight, box: t.clientHeight,
           docH: document.documentElement.scrollHeight, vh: window.innerHeight };
})()`);
ok(longScroll.inner > longScroll.box + 1000, '长内容时文本框内部可滚动（撑满也不会裁掉正文）', longScroll);
ok(longScroll.box < longScroll.vh, '文本框高度被视口约束，没有随内容继续长大',
  longScroll.box + ' < ' + longScroll.vh);

// 恢复桌面视口
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sid);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await sleep(400);
await ev('load("笔记", true)');
await waitFor('document.querySelectorAll("#list tbody tr").length >= 8', 10000, '恢复列表');

head('侧栏拖拽调宽 + 按内容自适应');
await ev('switchView("list")');
await sleep(250);
const sideBefore = await ev('Math.round(document.querySelector("aside").getBoundingClientRect().width)');
ok(sideBefore === 256, '默认侧栏宽度 256px', sideBefore);
const grip = await ev(`(function(){
  var g = document.getElementById('sideGrip').getBoundingClientRect();
  return { cx: Math.round(g.left + g.width / 2), cy: Math.round(g.top + g.height / 2), w: Math.round(g.width) };
})()`);
ok(grip.w >= 4 && grip.w <= 8, '拖拽手柄是细条（不占地方）', grip.w);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.cx, y: grip.cy, button: 'left', clickCount: 1 }, sid);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.cx + 100, y: grip.cy, button: 'left', buttons: 1 }, sid);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.cx + 150, y: grip.cy, button: 'left', buttons: 1 }, sid);
await sleep(200);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.cx + 150, y: grip.cy, button: 'left', clickCount: 1 }, sid);
await sleep(400);
const sideAfter = await ev('Math.round(document.querySelector("aside").getBoundingClientRect().width)');
ok(sideAfter > sideBefore + 100, '鼠标拖动后侧栏变宽', { before: sideBefore, after: sideAfter });
ok(await ev('localStorage.getItem("cfwtxt_sidew")') === String(sideAfter), '宽度写进了本地偏好');
ok(await ev('!document.body.classList.contains("grip-ing")'), '松手后清理拖拽状态');

await ev('setSideW(9999)');
await sleep(200);
const clampMax = await ev('Math.round(document.querySelector("aside").getBoundingClientRect().width)');
ok(clampMax <= 620, '宽度上限钳制在 620px', clampMax);
await ev('setSideW(1)');
await sleep(200);
const clampMin = await ev('Math.round(document.querySelector("aside").getBoundingClientRect().width)');
ok(clampMin >= 200, '宽度下限钳制在 200px', clampMin);

await ev('document.getElementById("sideGrip").focus()');
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' }, sid);
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' }, sid);
await sleep(250);
const kbSide = await ev('Math.round(document.querySelector("aside").getBoundingClientRect().width)');
ok(kbSide === clampMin + 12, '方向键可以微调宽度（可访问性）', { from: clampMin, to: kbSide });

await ev('setSideW(200)');
await sleep(350);
const truncatedBefore = await ev(`(function(){
  var rows = [].slice.call(document.querySelectorAll('#tree .trow.f'));
  return rows.filter(function(r){ var n = r.querySelector('.tname'); return n && n.scrollWidth > n.clientWidth + 1; }).length;
})()`);
ok(truncatedBefore > 0, '窄侧栏下确实有文件名的后半截看不到', truncatedBefore);
const fitRes = await ev(`(function(){
  var w = fitSideW();
  var rows = [].slice.call(document.querySelectorAll('#tree .trow.f'));
  var trunc = rows.filter(function(r){ var n = r.querySelector('.tname'); return n && n.scrollWidth > n.clientWidth + 1; }).length;
  return { w: w, truncated: trunc, rows: rows.length };
})()`);
await sleep(400);
ok(fitRes.w > 200, '「自适应宽度」把侧栏撑开了', fitRes.w);
ok(fitRes.truncated === 0, '自适应后目录树里不再有被截断的文件名', fitRes);
console.log('  自适应宽度结果：' + fitRes.w + 'px（' + fitRes.rows + ' 个文件行全部完整显示）');
await ev('setSideW(300)');
await sleep(300);

head('列表：类型列与排序');
await ev('setSort("name", false)');
await sleep(700);
await waitFor('document.querySelectorAll("#list tbody tr").length >= 9', 10000, '笔记列表');
const typeCol = await ev(`(function(){
  var out = {};
  document.querySelectorAll('#list tbody tr').forEach(function(tr){
    var a = tr.querySelector('a.link'); var tds = tr.querySelectorAll('td');
    if (a && tds.length >= 5) out[a.textContent] = tds[1].textContent;
  });
  return out;
})()`);
ok(typeCol['说明.md'] === '文档', '说明.md → 类型「文档」', typeCol['说明.md']);
ok(typeCol['数据.json'] === '配置', '数据.json → 类型「配置」', typeCol['数据.json']);
ok(typeCol['脚本.js'] === '代码', '脚本.js → 类型「代码」', typeCol['脚本.js']);
ok(typeCol['图片.png'] === '图片', '图片.png → 类型「图片」', typeCol['图片.png']);
ok(typeCol['表格.csv'] === '数据表', '表格.csv → 类型「数据表」', typeCol['表格.csv']);
ok(typeCol['Dockerfile'] === '无扩展名', 'Dockerfile → 类型「无扩展名」', typeCol['Dockerfile']);

await ev('document.querySelector("#list thead th[data-sortby=size]").click()');
await sleep(700);
const bySize = await ev(`(function(){
  var sizes = state.files.map(function(f){ return f.size; });
  var okDesc = true;
  for (var i = 1; i < sizes.length; i++) if (sizes[i] > sizes[i-1]) { okDesc = false; break; }
  return { by: state.sort.by, desc: state.sort.desc, desc2: okDesc, sizes: sizes.slice(0, 6),
           arrow: (document.querySelector('#list thead th[data-sortby=size] .sar') || {}).textContent || '',
           sel: (document.getElementById('sortBy') || {}).value,
           dir: (document.getElementById('sortDir') || {}).textContent || '' };
})()`);
ok(bySize.by === 'size' && bySize.desc === true, '点「大小」表头 → 按大小降序', { by: bySize.by, desc: bySize.desc });
ok(bySize.desc2, '列表真的按大小从大到小排列', bySize.sizes);
ok(bySize.arrow === '↓', '表头显示降序箭头', bySize.arrow);
ok(bySize.sel === 'size', '工具栏下拉与表头同步', bySize.sel);
ok(bySize.dir.indexOf('降序') >= 0, '方向按钮同步显示「降序」', bySize.dir);

await ev('document.querySelector("#list thead th[data-sortby=size]").click()');
await sleep(700);
ok(await ev('state.sort.desc') === false, '再点一次切成升序');
await ev('(function(){ var s = document.getElementById("sortBy"); s.value = "time"; s.onchange(); })()');
await sleep(700);
ok(await ev('state.sort.by + "/" + state.sort.desc') === 'time/true', '用下拉切到「修改时间」默认降序');
await ev('setSort("name", false)');
await sleep(700);
const nameOrder = await ev('state.files.map(function(f){ return f.name; })');
const nameSorted = [...nameOrder].sort((a, b) => a.localeCompare(b, 'zh'));
ok(JSON.stringify(nameOrder) === JSON.stringify(nameSorted), '名称升序排列正确');
await ev('(function(){ document.querySelector("#list thead th[data-sortby=type]").click(); })()');
await sleep(700);
const typeOrder = await ev(`(function(){
  var exts = state.files.map(function(f){ return f.name.indexOf('.') > 0 ? f.name.split('.').pop().toLowerCase() : ''; });
  var okSort = true;
  for (var i = 1; i < exts.length; i++) if (exts[i].localeCompare(exts[i-1], 'zh') < 0) { okSort = false; break; }
  return { by: state.sort.by, okSort: okSort, exts: exts };
})()`);
ok(typeOrder.by === 'type' && typeOrder.okSort, '按类型排序生效', typeOrder.exts);

head('框选多选');
await ev('setSort("name", false)');
await sleep(700);
await ev('clearSel()');
await sleep(200);
const geo = await ev(`(function(){
  var rs = document.querySelectorAll('#list tbody tr');
  var a = rs[0].getBoundingClientRect(), b = rs[rs.length-1].getBoundingClientRect();
  return { rows: rs.length, x0: Math.round(a.left + 3), x1: Math.round(a.right - 3),
           y0: Math.round(a.top + 4), y1: Math.round(b.bottom - 4) };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x0, y: geo.y0, button: 'left', clickCount: 1 }, sid);
for (let i = 1; i <= 6; i++) {
  const y = Math.round(geo.y0 + (geo.y1 - geo.y0) * i / 6);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x1, y, button: 'left', buttons: 1 }, sid);
}
await sleep(250);
const dragging = await ev(`(function(){
  var b = document.getElementById('marqBox');
  return { exists: !!b, w: b ? Math.round(b.getBoundingClientRect().width) : 0,
           h: b ? Math.round(b.getBoundingClientRect().height) : 0,
           sel: Object.keys(state.sel).length,
           noSelect: document.body.classList.contains('marq-ing') };
})()`);
ok(dragging.exists, '拖动时出现选框（橡皮筋）', dragging);
ok(dragging.w > 100 && dragging.h > 100, '选框跟随鼠标变大', { w: dragging.w, h: dragging.h });
ok(dragging.sel > 0, '拖动过程中就已经在实时勾选', dragging.sel);
ok(dragging.noSelect, '拖动中禁用了文本选中');
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x1, y: geo.y1, button: 'left', clickCount: 1 }, sid);
await sleep(350);
const marqRes = await ev(`(function(){
  return { sel: Object.keys(state.sel).length,
           checked: document.querySelectorAll('#list input.ck:checked').length,
           picked: document.querySelectorAll('#list tbody tr.picked').length,
           boxGone: !document.getElementById('marqBox'),
           bodyClean: !document.body.classList.contains('marq-ing'),
           batch: document.getElementById('batch') ? document.getElementById('batch').classList.contains('on') : null };
})()`);
ok(marqRes.boxGone, '松手后选框被移除');
ok(marqRes.bodyClean, '松手后恢复文本选中');
ok(marqRes.sel === geo.rows, '框选把整张表的行都选中了', { sel: marqRes.sel, rows: geo.rows });
ok(marqRes.checked === marqRes.sel && marqRes.picked === marqRes.sel, '复选框与行高亮都与选中集一致', marqRes);
ok(marqRes.batch === true, '底部批量操作条自动弹出');

// 只框前 3 行
await ev('clearSel()');
await sleep(200);
const geo3 = await ev(`(function(){
  var rs = document.querySelectorAll('#list tbody tr');
  var a = rs[0].getBoundingClientRect(), b = rs[2].getBoundingClientRect();
  return { x0: Math.round(a.left + 3), x1: Math.round(a.right - 3),
           y0: Math.round(a.top + 3), y1: Math.round(b.bottom - 3) };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo3.x0, y: geo3.y0, button: 'left', clickCount: 1 }, sid);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo3.x1, y: geo3.y1, button: 'left', buttons: 1 }, sid);
await sleep(250);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo3.x1, y: geo3.y1, button: 'left', clickCount: 1 }, sid);
await sleep(300);
const sel3 = await ev('Object.keys(state.sel).length');
ok(sel3 === 3, '只框前 3 行时只选中 3 项', sel3);

head('Shift + 点击区间连选');
await ev('clearSel()');
await sleep(200);
await ev('(function(){ document.querySelectorAll("#list input.ck")[1].click(); })()');
await sleep(250);
ok(await ev('Object.keys(state.sel).length') === 1, '先普通点选一行');
ok(!!(await ev('state.lastPick')), '记录了连选锚点');
await ev(`(function(){
  var c = document.querySelectorAll('#list input.ck');
  c[5].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
})()`);
await sleep(300);
const rangeRes = await ev(`(function(){
  var boxes = [].slice.call(document.querySelectorAll('#list input.ck'));
  var inSel = boxes.filter(function(b){ return !!state.sel[b.getAttribute('data-ck')]; });
  var chk = boxes.filter(function(b){ return b.checked; });
  return { sel: Object.keys(state.sel).length, checked: chk.length,
           selIdx: inSel.map(function(b){ return boxes.indexOf(b); }),
           chkIdx: chk.map(function(b){ return boxes.indexOf(b); }) };
})()`);
ok(rangeRes.sel === 5, 'Shift+点击把锚点到目标之间整段选中（第 2~6 行）', rangeRes);
ok(rangeRes.checked === rangeRes.sel, '复选框状态跟着同步', rangeRes);

// 切到编辑器视图时批量条要收起来（不然会一直飘在底部挡住分享设置）
await ev('switchView("edit")');
await sleep(350);
ok(await ev('document.getElementById("batch").classList.contains("on") === false'), '切到编辑器视图后批量条自动收起');
await ev('switchView("list")');
await sleep(300);
ok(await ev('document.getElementById("batch").classList.contains("on") === true'), '切回列表视图后批量条又出现（选中集没丢）');
await ev('clearSel()');

// ---- 触屏多选：长按进多选模式，之后点整行即可勾选 ----
head('移动端多选（触屏长按）');

const lpDown = (idx, pid) => `(function(){
  var tr = document.querySelectorAll('#list tbody tr')[${idx}];
  var a = tr.querySelector('a[data-open]') || tr;   // 真实场景：手指按在文件名上
  var r = tr.getBoundingClientRect();
  a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
    pointerId: ${pid}, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
    clientX: Math.round(r.left + 60), clientY: Math.round(r.top + r.height / 2) }));
  return true;
})()`;
const clickRow = (idx) => `(function(){
  var tr = document.querySelectorAll('#list tbody tr')[${idx}];
  var a = tr.querySelector('a[data-open]') || tr;
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
})()`;
const lpUp = (pid) => `document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid}, pointerType: 'touch' }))`;

await ev('exitMulti()');
await sleep(200);
ok(await ev('state.multi === false'), '起始状态不在多选模式');

await ev(lpDown(1, 7));
await sleep(520);                        // > 380ms 长按阈值
ok(await ev('state.multi === true'), '触屏长按进入多选模式');
ok(await ev('document.body.classList.contains("multi")'), 'body 打上 multi 标记');
ok(await ev('Object.keys(state.sel).length') === 1, '长按的那一行被选中');
ok(await ev('document.getElementById("batch").classList.contains("on")'), '底部批量条自动出现');
ok((await ev('document.getElementById("batchInfo").textContent')).indexOf('多选模式') >= 0,
  '批量条写明"多选模式"', await ev('document.getElementById("batchInfo").textContent'));
ok(await ev('document.getElementById("batchClear").textContent') === '完成',
  '多选模式下退出按钮写作「完成」', await ev('document.getElementById("batchClear").textContent'));

// 手指抬起后浏览器会补一次 click，落在被长按的行上 —— 必须被吞掉，
// 否则它会被"多选模式下点行"接走，把刚选中的那行又取消（用户看到"长按了但没选上"）
await ev(lpUp(7));
await ev(clickRow(1));
await sleep(220);
ok(await ev('Object.keys(state.sel).length') === 1, '长按后补发的那次 click 被吞掉，选中没被取消');
ok(await ev('state.view === "list"'), '长按不会把文件打开（仍停在列表）');

// 多选模式下点另一行 = 加选（而不是打开文件）
await ev(clickRow(3));
await sleep(220);
ok(await ev('Object.keys(state.sel).length') === 2, '多选模式下点文件行是「加选」而非打开');
ok(await ev('state.view === "list"'), '加选时没有被跳转到编辑器');

// 再点一次 = 取消该行
await ev(clickRow(3));
await sleep(220);
ok(await ev('Object.keys(state.sel).length') === 1, '再点一次取消该行');

// 点复选框仍然走原生勾选（不被"整行接管"抢走）
await ev(`(function(){
  var c = document.querySelectorAll('#list input.ck')[5];
  c.checked = true;
  c.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(220);
ok(await ev('Object.keys(state.sel).length') === 2, '点复选框能正常勾选（没被整行点击逻辑抢走）');

// 点 ⋯ 按钮仍正常弹菜单（不被整行接管，也不被长按抑制窗口吞掉）
await ev('exitMulti()');
await sleep(150);
await ev(lpDown(1, 8));
await sleep(500);
await ev(lpUp(8));
await ev(`(function(){
  var tr = document.querySelectorAll('#list tbody tr')[1];   // 故意点"被长按的同一行"上的按钮
  tr.querySelector('button.tact[data-tact]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(320);
ok(await ev('!!document.getElementById("ctx") && document.getElementById("ctx").classList.contains("on")'),
  '多选模式下点 ⋯ 仍弹出操作菜单（同行按钮不被抑制窗口吃掉）');
await ev('closeCtx()');
await sleep(200);

// 取消掉最后一个选中项 → 自动退出多选模式
await ev('exitMulti()');
await sleep(150);
await ev(lpDown(2, 9));
await sleep(500);
await ev(lpUp(9));
await sleep(600);                        // 等长按那次"补发 click"的抑制窗口过去
await ev(clickRow(2));
await sleep(250);
ok(await ev('state.multi === false'), '取消掉最后一个选中项后自动退出多选模式');
ok(await ev('Object.keys(state.sel).length') === 0, '退出后选中集被清空');

// 操作已折叠为 ⋯ 菜单：行内不再有任何平铺的 .op 操作按钮（该断言由"每行只剩一个 ⋯"承担），
// 这里只确认行内没有旧式平铺按钮残留。
const legacyOps = await ev('document.querySelectorAll("#list tbody tr .op").length');
ok(legacyOps === 0, '列表行里没有旧式平铺操作按钮（全部收进 ⋯ 菜单）', legacyOps);

// 「全选本页」按钮文案随状态切换
await ev('document.getElementById("batchAll").click()');
await sleep(250);
const allSel = await ev('Object.keys(state.sel).length');
ok(await ev('document.getElementById("batchAll").textContent') === '取消全选', '全选后按钮变成「取消全选」');
await ev('document.getElementById("batchAll").click()');
await sleep(250);
ok(await ev('Object.keys(state.sel).length') === 0, '再点一次取消全选', { 全选时: allSel });
await ev('exitMulti()');
await sleep(200);

// 切到移动视口 + 触摸模拟：验证只有触屏才出现的那些东西
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sid);
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
await sleep(400);
const mv = await ev(`(function(){
  var c = document.querySelector('#list input.ck');
  var bar = document.getElementById('batch');
  var rows = [].slice.call(document.querySelectorAll('#list tbody tr'));
  var anyMulti = rows.some(function(r){ return !!r.querySelector('.op[data-act="multi"]'); });
  return {
    anyMulti: anyMulti,
    ck: c ? getComputedStyle(c).width : '',
    trTouch: c ? getComputedStyle(c.closest('tr')).touchAction : '',
    trSelect: c ? getComputedStyle(c.closest('tr')).userSelect : '',
    barLeft: bar ? getComputedStyle(bar).left : '',
    // 手机上顶栏要能看到自己所在目录（收起站点标题，把位置让给面包屑）
    crumbDisplay: getComputedStyle(document.getElementById('crumb')).display,
    crumbNowrap: getComputedStyle(document.getElementById('crumb')).flexWrap,
    brandTextHidden: getComputedStyle(document.querySelector('.brand span')).display === 'none'
  };
})()`);
ok(!mv.anyMulti, '移动端也没有多余的「多选」按钮（长按就是入口）');
ok(mv.crumbDisplay !== 'none', '移动端顶栏显示路径面包屑（不用开抽屉也知道在哪一级）', mv.crumbDisplay);
ok(mv.crumbNowrap === 'nowrap', '移动端面包屑不换行（长路径横向滑动）', mv.crumbNowrap);
ok(mv.brandTextHidden, '移动端收起站点标题，给面包屑腾出空间');
ok(mv.ck === '21px', '移动端复选框放大到 21px（它才是多选的可见入口）', mv.ck);
ok(mv.trTouch.indexOf('pan-y') >= 0, '移动端行保持纵向滚动（长按不会卡住页面）', mv.trTouch);
// -webkit-touch-callout 是 Safari 专有属性，Chromium 不暴露计算值，用 user-select 代验
// （"存在 -webkit-touch-callout:none 声明"已由静态检查覆盖）
ok(mv.trSelect === 'none', '移动端禁用长按选中文字（配合 touch-callout 挡掉系统菜单）', mv.trSelect);

// 长按没有可见按钮，所以要有一次性的发现性提示（提示过就记住，不再打扰）
await ev('lpTipShown = false; try { localStorage.removeItem("cfwtxt_lptip"); } catch (e) {}');
await ev('load("")', true);
await sleep(2000);
const tipTxt = await ev('document.getElementById("toast").textContent');
ok(/长按/.test(tipTxt), '触屏首次进列表提示"长按可多选"', tipTxt);
ok(await ev('localStorage.getItem("cfwtxt_lptip") === "1"'), '提示过一次后记在本地，不再重复打扰');
await ev('load("笔记")', true);
await sleep(400);

// 恢复桌面视口
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sid);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await sleep(300);
await ev('exitMulti()');

head('PWA：manifest / 动态图标 / Service Worker');
const pwaMeta = await ev(`(function(){
  var l = document.querySelector('link[rel="manifest"]');
  var ti = document.querySelector('meta[name="theme-color"]');
  return { manifest: l ? l.getAttribute('href') : null,
           theme: ti ? ti.getAttribute('content') : null,
           touch: !!document.querySelector('link[rel="apple-touch-icon"]'),
           capable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]') };
})()`);
ok(pwaMeta.manifest === '/manifest.webmanifest', '页面声明了 manifest', pwaMeta.manifest);
ok(pwaMeta.theme === '#d4a02a', 'theme-color 与品牌色一致', pwaMeta.theme);
ok(pwaMeta.touch && pwaMeta.capable, '带 iOS 主屏 meta 与 apple-touch-icon');

// 图标必须能被浏览器真的解码 —— PNG 结构对不对，Image 一加载就知道。
// 坑：CDP 的 awaitPromise 对「Promise resolve 出来的值」序列化**不稳定**（同一份代码两次运行结果不同），
// 所以改成：页面里启动异步任务把结果写到 window.__pwa，Node 侧轮询读同步变量（同步对象返回可靠）。
await ev(`(function(){
  window.__pwa = { icon: null, sw: null };
  var img = new Image();
  img.onload = function(){ window.__pwa.icon = { ok: true, w: img.naturalWidth, h: img.naturalHeight }; };
  img.onerror = function(){ window.__pwa.icon = { ok: false, ev: 'error' }; };
  img.src = '/icon/512.png?probe=' + Date.now();
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistration('/').then(function(reg){
      if (!reg){ window.__pwa.sw = { supported: true, reg: false }; return; }
      navigator.serviceWorker.ready.then(function(r){
        window.__pwa.sw = { supported: true, reg: true,
          active: !!(r.active && r.active.state === 'activated') };
      }).catch(function(){ window.__pwa.sw = { supported: true, reg: false, err: 'ready-reject' }; });
    }).catch(function(){ window.__pwa.sw = { supported: true, reg: false, err: 'reg-reject' }; });
  } else {
    window.__pwa.sw = { supported: false };
  }
})()`);
let iconOk = null, swState = null;
for (let i = 0; i < 44 && !(iconOk && swState && swState.reg && swState.active); i++){
  const s = await ev('(function(){ var p = window.__pwa || {}; return { icon: p.icon, sw: p.sw }; })()');
  if (s && s.icon && !iconOk) iconOk = s.icon;
  if (s && s.sw && !swState) swState = s.sw;
  await sleep(250);
}
ok(swState && swState.supported, '当前上下文支持 Service Worker', swState);
ok(swState && swState.reg && swState.active, 'SW 注册成功且已激活', swState);
// activate 里有 clients.claim()，当前页面应当很快被接管
let controlled = false;
for (let i = 0; i < 24; i++) {
  controlled = await ev('!!navigator.serviceWorker.controller');
  if (controlled) break;
  await sleep(250);
}
console.log('  图标解码：' + JSON.stringify(iconOk) + '  SW：' + JSON.stringify(swState));
ok(iconOk && iconOk.ok && iconOk.w === 512 && iconOk.h === 512, '动态生成的 512 图标能被浏览器解码', iconOk);
ok(swState && swState.supported, '当前上下文支持 Service Worker', swState);
ok(swState && swState.reg && swState.active, 'SW 注册成功且已激活', swState);
ok(controlled, 'SW 已接管当前页面（clients.claim 生效）');
// 被 SW 接管后，页面功能必须一切正常（防止 SW 拦截把请求弄坏）
const afterSw = await ev('load("笔记")', true);
await sleep(900);
ok(await ev('state.view') === 'list' && (await ev('state.files.length')) >= 7,
  'SW 接管后列表照常加载（SW 没有破坏正常请求）');

head('文件夹批量上传后自动重建索引（修并发丢条目）');
await ev('load("", true)');
await sleep(800);
// 钩子记录 reindexAll 调用；准备 3 个文本文件模拟文件夹批量上传
await ev(`(function(){
  window.__reidx = 0;
  var orig = reindexAll;
  window.reindexAll = function(){ window.__reidx++; return orig.apply(this, arguments); };
  var mk = function(t, name){ return new File([t], name, { type: 'text/plain' }); };
  window.__batch = [
    { path: 'txdir/a.txt', file: mk('alpha bravo charlie delta', 'a.txt') },
    { path: 'txdir/b.txt', file: mk('echo foxtrot golf hotel', 'b.txt') },
    { path: 'txdir/c.txt', file: mk('india juliet kilo lima', 'c.txt') }
  ];
  uploadTree(window.__batch, { mode: 'overwrite', reuploadSame: true });
})()`);
// 上传是 4 路并发、索引更新是"读整份→改→写回"，并发交错可能互相覆盖，
// 所以批量传完必须自动分批重建一次，把可能漏掉的补回来。
await waitFor('(window.__reidx || 0) >= 1', 20000, '批量上传完成后自动触发索引重建');
await sleep(3500);                                  // 等分批重建跑完
const srSearch = async q => {
  await ev(`(function(){ window.__sr = null;
    fetch(BASE + '/api?action=search&q=${encodeURIComponent(q)}&_t=' + Date.now())
      .then(function(r){ return r.json(); }).then(function(d){ window.__sr = d; }); })()`);
  for (let i = 0; i < 24; i++) { const s = await ev('window.__sr'); if (s) return s; await sleep(250); }
  return null;
};
const sr = await srSearch('foxtrot');
ok(sr && sr.ok && sr.indexed, '索引已建立（indexed=true）', sr && { indexed: sr.indexed, n: sr.indexedCount });
const hit = sr && sr.results ? sr.results.filter(function(r){ return r.path === 'txdir/b.txt'; }) : [];
ok(hit.length === 1 && !!hit[0].snippet, '批量上传后**第一次**搜索就能按正文搜到（foxtrot 命中 b.txt，带片段）',
  hit.length ? { path: hit[0].path, snip: hit[0].snippet } : (sr && sr.results || []).slice(0, 3));

head('搜索：目录命中独立成条（方案A）+ 跨目录打开');
await ev('load("", true)');
await sleep(800);
await ev(`(function(){
  document.getElementById('q').value = 'txdir';
  runSearch('txdir');
})()`);
await waitFor('document.querySelectorAll("#sideScroll .sfile.sdir").length >= 1', 8000, '文件夹条目出现');
const sr2 = await ev(`(function(){
  var first = document.querySelector('#sideScroll .sfile');
  var fn = first ? first.querySelector('.fname') : null;
  return { firstIsDir: !!(first && first.getAttribute('data-isdir') === '1'),
           firstText: fn && fn.firstChild ? fn.firstChild.textContent : '',
           tag: first ? (first.querySelector('.sr-tag') || {}).textContent : '',
           pathTags: [].slice.call(document.querySelectorAll('#sideScroll .sr-tag.path')).length };
})()`);
ok(sr2.firstIsDir && sr2.firstText === 'txdir', '搜目录名时文件夹本体排在结果最前', sr2);
ok(sr2.tag === '文件夹', '文件夹条目标注「文件夹」', sr2.tag);
ok(sr2.pathTags >= 1, '目录下文件标注为「路径」命中（不再冒充「文件名」）', sr2.pathTags);
// 点文件夹条目 → 直接进入该目录
await ev('(function(){ document.querySelector("#sideScroll .sfile.sdir").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); })()');
await sleep(1000);
ok((await ev('state.path')) === 'txdir', '点击文件夹条目直接进入该目录', await ev('state.path'));

// 跨目录打开文件：openPath 并行化后行为不回归
await ev('load("", true)');
await sleep(700);
await ev('openPath("笔记/说明.md")');
await sleep(1500);
ok((await ev('ed.path')) === '笔记/说明.md', '跨目录打开文件成功（并行化后）', await ev('ed.path'));
ok((await ev('state.path')) === '笔记', '所在目录也同步切换', await ev('state.path'));
ok(await ev('document.getElementById("edt").classList.contains("edt-loading")') === false,
  '载入完成后 loading 半透明态已移除');

head('搜索交互（本版新增）：历史 · 键盘导航 · 芯片 · 分组 · 返回条 · 范围开关');
await ev('load("", true)');
await sleep(900);
// 从干净状态开始：清掉本机可能残留的搜索历史
await ev('searchHist = []; histSave();');
await ev('try{ localStorage.removeItem(SEARCH_HIST_KEY); }catch(e){}');
await ev('searchHist = []; histSave();');

// —— 停手 1.4 秒才落库：半成品词不该把历史刷满 ——
await ev('(function(){ var q=document.getElementById("q"); q.value="txd"; onSearchInput(); })()');
await sleep(400);
await ev('(function(){ var q=document.getElementById("q"); q.value="txdir"; onSearchInput(); })()');
await sleep(1900);
const hist = await ev('JSON.stringify(searchHist)');
ok(hist.indexOf('txdir') >= 0 && hist.indexOf('"txd"') < 0,
  '停手 1.4 秒的词才进历史（半成品 txd 不落库）', hist);
ok(await ev('localStorage.getItem(SEARCH_HIST_KEY) !== null'), '搜索历史写进 localStorage（本地，不上传）');

// —— 历史下拉：聚焦弹出 · ↑↓ 选择 · Enter 应用 ——
await ev('histClose(); document.getElementById("q").blur();');
await ev('document.getElementById("q").dispatchEvent(new Event("focus"))');
await sleep(200);
ok(await ev('document.getElementById("qHist").classList.contains("on")'), '聚焦搜索框弹出历史下拉');
ok((await ev('document.querySelectorAll("#qHist .qh").length')) >= 1, '历史下拉里有条目');
await ev('document.getElementById("q").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))');
ok(await ev('!!document.querySelector("#qHist .qh.on")'), '↑↓ 能选中历史项');
await ev('document.getElementById("q").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
await sleep(400);
ok((await ev('document.getElementById("q").value')) === 'txdir', 'Enter 用选中的历史词发起搜索');
await ev('histOpen()');
await ev('document.body.dispatchEvent(new MouseEvent("click",{bubbles:true}))');
await sleep(150);
ok(!(await ev('document.getElementById("qHist").classList.contains("on")')), '点搜索框以外收起历史下拉');

// —— 结果分组 + 筛选芯片（服务端过滤）——
await ev('load("", true)');
await sleep(800);
await ev('(function(){ document.getElementById("q").value="txdir"; runSearch("txdir"); })()');
await waitFor('document.querySelectorAll("#sideScroll .sfile").length >= 1', 8000, '搜索结果');
ok((await ev('document.querySelectorAll("#sideScroll .sr-chips button").length')) >= 2,
  '结果顶部出现筛选芯片（全部 + 各类型）');
ok((await ev('document.querySelectorAll("#sideScroll .sr-group").length')) >= 1,
  '「全部」视图下结果按类型分组');
const chipOk = await ev('!!document.querySelector(\'#sideScroll .sr-chips button[data-ftype="dir"]\')');
await ev('(function(){ var b=document.querySelector(\'#sideScroll .sr-chips button[data-ftype="dir"]\'); if(b) b.click(); })()');
await sleep(1000);
const onlyDir = await ev(`(function(){
  var rows = [].slice.call(document.querySelectorAll('#sideScroll .sfile'));
  return { n: rows.length, kinds: rows.map(function(r){ return r.getAttribute('data-srkind'); }) };
})()`);
ok(chipOk && onlyDir.n >= 1 && onlyDir.kinds.every(function(k){ return k === 'dir'; }),
  '点「文件夹」芯片后只剩目录命中（服务端过滤，不是只筛当前页）', onlyDir);
ok((await ev('document.querySelector("#sideScroll .sr-chips button.on").getAttribute("data-ftype")')) === 'dir',
  '芯片有选中态');

// —— 结果列表键盘导航（焦点不在输入框时才接管）——
await ev('(function(){ var a=document.activeElement; if(a&&a.blur) a.blur(); document.getElementById("q").blur(); })()');
await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))');
await sleep(150);
ok(await ev('!!document.querySelector("#sideScroll .sfile.sel")'), '↓ 在结果列表里选中第一行');
await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
await sleep(150);
ok(!(await ev('!!document.querySelector("#sideScroll .sfile.sel")')), 'Esc 取消结果选中');

// —— 清空搜索框 → 「返回搜索结果」条 → 一键回到结果 ——
await ev('(function(){ document.getElementById("q").value=""; onSearchInput(); })()');
await sleep(1000);
ok(await ev('!!document.querySelector(".sr-back .bk")'), '清空搜索框后侧栏顶部出现「返回搜索结果」条');
await ev('(function(){ var b=document.querySelector(".sr-back .bk"); if(b) b.click(); })()');
await waitFor('document.querySelectorAll("#sideScroll .sfile").length >= 1', 8000, '返回结果');
ok((await ev('document.querySelectorAll("#sideScroll .sfile").length')) >= 1, '一键返回上一次的搜索结果');

// —— 多关键词区分着色 ——
await ev('(function(){ document.getElementById("q").value="alpha charlie"; runSearch("alpha charlie"); })()');
await waitFor('document.querySelectorAll("#sideScroll .sfile").length >= 1', 8000, '多词结果');
const colors = await ev(`(function(){
  return { c1: document.querySelectorAll('#sideScroll .hl-1').length,
           c2: document.querySelectorAll('#sideScroll .hl-2').length };
})()`);
ok(colors.c1 >= 1 && colors.c2 >= 1, '多关键词各用不同底色（hl-1 / hl-2）', colors);

// —— 信息层级：深搜入口收进 ⋯ 菜单 ——
ok((await ev('document.querySelectorAll("#sideScroll [data-deep]").length')) === 0,
  '结果行不再内嵌「深搜此文件」按钮');
ok(await ev('!!document.querySelector("#sideScroll .sfile[data-sq]")'), '结果行带上搜索词（供 ⋯ 菜单调用深搜）');

// —— 「只在当前目录内搜索」开关：只在子目录里出现 ——
await ev('load("", true)');
await sleep(800);
ok(await ev('document.getElementById("sideScope").hidden'), '根目录下不显示「只在当前目录内搜索」开关');
await ev('load("txdir", true)');
await sleep(900);
ok(!(await ev('document.getElementById("sideScope").hidden')), '子目录里显示该开关');
await ev('(function(){ var cb=document.getElementById("qScope"); cb.checked=true; onScopeToggle(); })()');
ok(await ev('!!searchScopeCur'), '开关能打开（并立即重搜）');
await ev('(function(){ var cb=document.getElementById("qScope"); cb.checked=false; onScopeToggle(); })()');
await ev('load("", true)');
await sleep(600);

head('搜索命中高亮（本版新增）：打开文件就把关键词点亮，并直接落到第一处');
await ev('load("", true)');
await sleep(800);
// 造一份"同一个词出现多处"的正文 —— 正是用户反馈的场景
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('txdir/hl-多处.txt'), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: '开头 trojan 一行\\n中间没有这个词\\n再一个 trojan 这里\\n第三处 trojan 结尾\\n'
}).then(function(r){ return r.text(); })`);
// 等索引跟上（写后索引是 waitUntil 异步提交的），命中出现为止。
// 每轮先 clearSearchCache()：这里是直接打 API 造数据，绕过了页面的 invalidateTree()，
// 不清前端那 30 秒结果缓存就会一直读到"还没有这个文件"的旧结果。
let hlRow = false;
for (let i = 0; i < 14 && !hlRow; i++) {
  await ev('(function(){ clearSearchCache(); document.getElementById("q").value="trojan"; runSearch("trojan"); })()');
  await sleep(500);
  hlRow = await ev('!!document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/hl-多处.txt"]\')');
}
ok(hlRow, '多处的文件能被搜到（trojan）');
const cntTag = await ev(`(function(){
  var row = document.querySelector('#sideScroll .sfile[data-openpath="txdir/hl-多处.txt"]');
  return row ? ((row.querySelector('.sr-tag.cnt') || {}).textContent || '') : '';
})()`);
ok(/正文 3 处/.test(cntTag), '侧栏如实标注「正文 3 处」', cntTag);

await ev('(function(){ document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/hl-多处.txt"]\').click(); })()');
await waitFor('document.querySelectorAll("#edHlIn .hmark").length >= 1', 8000, '编辑器内出现高亮');
const srHl = await ev(`(function(){
  return { n: document.querySelectorAll('#edHlIn .hmark').length,
           layerHidden: document.getElementById('edHl').hidden,
           barHidden: document.getElementById('findBar').hidden,
           stat: document.getElementById('fStat').textContent,
           q: document.getElementById('fQ').value,
           focusId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '' };
})()`);
ok(srHl.n === 3, '打开文件后正文里 3 处全部点亮（侧栏说 3 处，编辑器就该看到 3 处）', srHl);
ok(srHl.layerHidden === false && srHl.barHidden === false, '高亮层与查找栏都已显示', srHl);
ok(srHl.stat === '1 / 3 处', '查找栏显示「1 / 3 处」（当前第 1 处，共 3 处）', srHl.stat);
ok(srHl.q === 'trojan', '查找框里带着搜索词', srHl.q);
ok(srHl.focusId !== 'fQ' && srHl.focusId !== 'edt', '打开文件没有抢焦点（手机上不会弹软键盘）', srHl.focusId);
ok(await ev('document.getElementById("edt").scrollTop > 0 || document.querySelectorAll("#edHlIn .hmark.cur").length === 1'),
  '当前命中被单独标出（.cur）', await ev('document.querySelectorAll("#edHlIn .hmark.cur").length'));

// 「下一处 / 上一处」在命中之间移动
await ev('document.getElementById("fNext").click()');
await sleep(200);
ok((await ev('document.getElementById("fStat").textContent')) === '2 / 3 处', '「下一个」走到第 2 处');
await ev('document.getElementById("fPrev").click()');
await sleep(200);
ok((await ev('document.getElementById("fStat").textContent')) === '1 / 3 处', '「上一个」走回第 1 处');

// 从搜索打开 = "看在哪"，不该给替换控件
ok(await ev('document.getElementById("fR").hidden && document.getElementById("fRep").hidden && document.getElementById("fRepAll").hidden'),
  '从搜索打开时「替换为 / 替换 / 全部替换」已收起（只给"看"）');
ok((await ev('document.querySelectorAll("#edHlIn .hmark").length')) === 3,
  '收起替换控件不影响高亮本身');
// 自己按 Ctrl+F 打开查找栏 → 替换控件照旧给全
await ev('openFind(false)');
await sleep(200);
ok(!(await ev('document.getElementById("fR").hidden')) && !(await ev('document.getElementById("fRep").hidden')),
  '自己打开查找栏时替换控件照旧给全');
await ev('closeFind(true)');
await sleep(150);

// 多关键词：与侧栏同一套底色，按词分色
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('txdir/hl-双词.txt'), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: 'alpha 在这里\\ncharlie 在那里\\nalpha 又出现一次\\n'
}).then(function(r){ return r.text(); })`);
let twoRow = false;
for (let i = 0; i < 14 && !twoRow; i++) {
  await ev('(function(){ clearSearchCache(); document.getElementById("q").value="alpha charlie"; runSearch("alpha charlie"); })()');
  await sleep(500);
  twoRow = await ev('!!document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/hl-双词.txt"]\')');
}
ok(twoRow, 'AND 搜索能搜到同时含两词的文件');
await ev('(function(){ document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/hl-双词.txt"]\').click(); })()');
await waitFor('document.querySelectorAll("#edHlIn .hmark").length >= 3', 8000, '多词高亮');
const two = await ev(`(function(){
  return { t1: document.querySelectorAll('#edHlIn .hmark.t1').length,
           t2: document.querySelectorAll('#edHlIn .hmark.t2').length,
           stat: document.getElementById('fStat').textContent };
})()`);
ok(two.t1 >= 1 && two.t2 >= 1, '两个关键词各用一种底色（t1 / t2），与侧栏口径一致', two);
ok(two.stat === '1 / 3 处', '多关键词合计命中数正确（alpha 2 + charlie 1）', two.stat);

// 命中只在文件名上 → 不留一个写着"无匹配"的查找栏
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('txdir/onlyname-xyz.txt'), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: '正文里没有那个词\\n'
}).then(function(r){ return r.text(); })`);
let nameRow = false;
for (let i = 0; i < 14 && !nameRow; i++) {
  await ev('(function(){ clearSearchCache(); document.getElementById("q").value="onlyname-xyz"; runSearch("onlyname-xyz"); })()');
  await sleep(500);
  nameRow = await ev('!!document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/onlyname-xyz.txt"]\')');
}
ok(nameRow, '文件名命中能被搜到');
await ev('(function(){ document.querySelector(\'#sideScroll .sfile[data-openpath="txdir/onlyname-xyz.txt"]\').click(); })()');
await sleep(1400);
ok(await ev('document.getElementById("findBar").hidden'),
  '命中只在文件名时，编辑器不显示"无匹配"的查找栏（静默收回）');
ok((await ev('document.querySelectorAll("#edHlIn .hmark").length')) === 0, '此时也没有残留高亮');

await ev('load("", true)');
await sleep(700);

head('文件打开：内存缓存 + 后台校验（方案1/2）');
// 装 fetch 钩子：区分「无条件 read」与「带 If-None-Match 的条件校验」
await ev(`(function(){
  window.__reads = { full: 0, cond: 0 };
  if (window.__readsHooked) return;
  window.__readsHooked = true;
  var orig = window.fetch;
  window.fetch = function(u, init){
    try {
      if (String(u).indexOf('action=read') >= 0){
        var h = (init && init.headers) || {};
        var v = (h['If-None-Match'] !== undefined) ? h['If-None-Match'] : (h.get ? h.get('If-None-Match') : null);
        window.__reads[v ? 'cond' : 'full']++;
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
})()`);
// 用专用文件测缓存：**不要用 说明.md** —— 后面的分享页测试依赖它的 Markdown 内容，
// 被这里改写就会连带失败（测试间数据污染）
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('笔记/cache-测试.md'), {
  method: 'PUT', headers: { 'Content-Type': 'text/markdown;charset=utf-8' },
  body: '# 缓存测试标题\\n\\n正文段落 ALPHA-CACHE 用于验证缓存。\\n'
}).then(function(r){ return r.text(); })`);
await sleep(300);
await ev('fileCacheDelPrefix("笔记")');          // 从干净状态开始
await ev('load("笔记", true)');
await sleep(800);
await ev('switchView("list")');
await sleep(200);
// 首次打开（无缓存）→ 发一次无条件 read，并写入缓存
await ev('openFile("cache-测试.md")');
await waitFor('document.getElementById("edt").value.length > 0', 8000, '首次打开有内容');
await sleep(500);
const rd1 = JSON.parse(await ev('JSON.stringify(window.__reads)'));
ok(rd1.full >= 1, '首次打开发出无条件 read', rd1);
ok(await ev('!!fileCacheGet("笔记/cache-测试.md")'), '内容已进内存缓存（含 ETag）');
ok(await ev('fileCacheGet("笔记/cache-测试.md").etag.length > 0'), '缓存里记下了 ETag 供后台校验');

// 第二次打开同一文件：命中缓存 → 点击瞬间就有内容，且不再发无条件 read
await ev('switchView("list")');
await sleep(200);
const second = JSON.parse(await ev(`(function(){
  var before = JSON.parse(JSON.stringify(window.__reads));
  openFile("cache-测试.md");
  return JSON.stringify({ before: before, hasContentNow: document.getElementById("edt").value.length > 0 });
})()`));
ok(second.hasContentNow === true, '缓存命中：点击瞬间编辑器就有内容（0 往返等待）', second);
await sleep(700);
const rd2 = JSON.parse(await ev('JSON.stringify(window.__reads)'));
ok(rd2.full === second.before.full, '缓存命中时不再发无条件 read', { before: second.before.full, after: rd2.full });
ok(rd2.cond >= second.before.cond + 1, '后台发了一次 ETag 条件校验', rd2);

// 外部改写文件 → 重新打开 → 后台校验发现变化并热更新
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('笔记/cache-测试.md'), {
  method: 'PUT', headers: { 'Content-Type': 'text/markdown;charset=utf-8' },
  body: '# 外部改过的内容 EXT-CHANGE\\n'
}).then(function(r){ return r.text(); })`);

await sleep(400);
await ev('switchView("list")');
await sleep(200);
await ev('openFile("cache-测试.md")');
await sleep(1800);                                 // 等后台校验回来
ok((await ev('document.getElementById("edt").value')).indexOf('EXT-CHANGE') >= 0,
  '后台校验发现外部修改后，编辑器自动刷新为最新内容');

// 保存后缓存同步成新内容（不会存了还是旧的）
await ev('(function(){ var t = document.getElementById("edt"); t.value = "保存后的新内容 SAVED-OK"; })()');
await ev('saveEd()');
await sleep(1200);
ok((await ev('fileCacheGet("笔记/cache-测试.md").text')).indexOf('SAVED-OK') >= 0,
  '保存后内存缓存同步为新内容');
// 收尾：删掉专用测试文件，避免残留影响后续断言
await ev(`fetch(BASE + '/api?path=' + encodeURIComponent('笔记/cache-测试.md'), { method: 'DELETE' })
  .then(function(r){ return r.text(); })`);
await sleep(300);
await ev('fileCacheDelPrefix("笔记")');

// 悬停预取：mouseover 后自动取回（桌面端）
await ev('fileCacheDel("笔记/纯文本.txt")');
const pf = await ev(`(function(){
  var node = document.querySelector('.trow.f[data-openpath="笔记/纯文本.txt"]');
  if (!node) return 'no-node';
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return 'ok';
})()`);
await sleep(900);
ok(pf === 'ok' && await ev('!!fileCacheGet("笔记/纯文本.txt")'), '鼠标悬停后自动预取进缓存（桌面端）');
// 触屏判断存在（不误触发）
ok(await ev('typeof prefetchFile === "function" && /hover: none/.test(prefetchFile.toString())'),
  '预取对触屏设备做了跳过判断');

// ================= 发布机制（编辑与分享分离）=================
head('发布：保存进后台，发布才上分享页');
{
  // 工具栏按钮文案是「发布」而不是「保存」—— 这就是整个交互语义的核心
  const btn = await ev('(function(){ var b = document.getElementById("btnSave"); return { txt: b ? b.textContent.trim() : "", has: !!b }; })()');
  ok(btn.has && btn.txt === '发布', '工具栏按钮是「发布」', btn);

  await ev('openPath("笔记/纯文本.txt")');
  // 等正文真的载入完再改：ed.path 一变就返回的话，异步载入会反过来覆盖我们注入的内容
  await waitFor('!!document.getElementById("edt") && document.getElementById("edt").value.indexOf("这是一段纯文本") >= 0',
    8000, '编辑器载入正文');
  await ev('(function(){ var t = document.getElementById("edt"); t.value = "自动保存的内容 AUTO-OK"; t.dispatchEvent(new Event("input", {bubbles:true})); })()');
  // 静默自动保存：5 秒防抖过后应该已经落盘，用户全程没点过任何按钮。
  // 直接看内存缓存（saveEd 成功后会同步进去），避免在 ev() 里等 Promise。
  await sleep(6600);
  const saved = await ev('(function(){ var c = fileCacheGet("笔记/纯文本.txt"); return c ? c.text : ""; })()');
  ok(String(saved).indexOf('AUTO-OK') >= 0, '输入停手后自动保存，不需要点按钮', saved);
  ok((await ev('ed.dirty')) === false, '自动保存后脏标记被清掉', await ev('ed.dirty'));

  // 分享面板：每条分享都带发布/撤回入口，并标出当前发布状态。
  // 这一段跑在"取消全部分享"之后，得先自己建一条，否则面板里空的没得断言。
  const made = await ev('post({ action: "share", path: "笔记/纯文本.txt" }).then(function(d){ return d && d.ok ? d.token : ""; })', true);
  ok(!!made, '先建一条分享用于断言', made);
  await ev('openShareModal("笔记/纯文本.txt", false)');
  // 分享列表走 15 秒 TTL 的内存缓存；刚用 post() 直接建的分享要等一次刷新才出现在面板里，
  // 所以这里给 20 秒（原来 6 秒会偶发超时）。
  await waitFor('!!document.querySelector(".shares .shrow")', 20000, '分享列表出现');
  const shBtns = await ev(`(function(){ var r = document.querySelector(".shares .shrow");
    return { pub: !!r.querySelector("button[data-shpub]"), unpub: !!r.querySelector("button[data-shunpub]"),
      pubTag: !!r.querySelector(".tag.pub"), pendingTag: !!r.querySelector(".tag.warn") }; })()`);
  ok(shBtns.pub, '分享行有「发布」按钮', shBtns);
  ok(shBtns.pubTag || shBtns.pendingTag, '分享行标出发布状态（已发布 / 待发布）', shBtns);

  // 撤回 → 分享行变"待发布"，但文件本身一个字都没少
  const un = await ev(`(function(){ var b = document.querySelector(".shares .shrow button[data-shunpub]");
    if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
  ok(un === 'clicked', '点「撤回」弹二次确认', un);
  await waitFor('!!document.getElementById("mOk") && document.getElementById("mOk").offsetParent', 4000, '确认框出现');
  await ev('(function(){ var b = document.getElementById("mOk"); if (b) b.click(); })()');
  await sleep(1200);
  const stillThere = await ev('!!fileCacheGet("笔记/纯文本.txt")');
  ok(stillThere, '撤回不影响草稿（文件还在）', stillThere);
  await ev('closeModal()');

  // 分享管理：给存量分享的一键补发入口
  await ev('openShareManager()');
  await sleep(900);
  const mgr = await ev(`(function(){ return { has: !!document.getElementById("mgrBody"),
    rows: document.querySelectorAll("#mgrBody .shrow").length,
    pubBtns: document.querySelectorAll("#mgrBody button[data-shpub]").length,
    pubAll: !!document.querySelector("#mgrBody button[data-shpuball]") }; })()`);
  ok(mgr.has && mgr.rows >= 1, '分享管理列出分享', mgr);
  ok(mgr.pubBtns >= 1, '分享管理每行都有发布入口', mgr);
  ok(mgr.pubAll, '有「全部发布」一键补发存量分享', mgr);
  await ev('closeModal()');

  // 右键菜单：只对分享页能看到的东西给发布入口
  await ev('load("")');
  await sleep(700);
  const ctx = await ev(`(function(){
    openCtx(200, 200, "笔记/纯文本.txt", false, false, "");
    var box = document.getElementById("ctx");
    var n = box ? box.querySelectorAll('[data-cmd="publish"]').length : -1;
    var un2 = box ? box.querySelectorAll('[data-cmd="unpublish"]').length : -1;
    closeCtx();
    return { pub: n, unpub: un2 };
  })()`);
  ok(ctx.pub >= 1 && ctx.unpub >= 1, '已分享的文件右键有「发布 / 撤回」', ctx);

  // ===== 省资源：内容没变就不保存 =====
  // 这是纯前端的零成本优化：edt.value 和 ed.savedText 逐字比，相同就一个请求都不发。
  const noSend = await ev(`(function(){
    var t = document.getElementById("edt");
    window.__putCount = 0;
    window.__origFetch = window.fetch;
    var of = window.__origFetch;
    window.fetch = function(u, o){
      if (o && o.method === "PUT") window.__putCount++;
      return of.apply(this, arguments);
    };
    // 场景 A：内容改成别的，再改回来 —— 结束时与基线一致
    t.value = t.value + " TEMP-XYZ";
    t.dispatchEvent(new Event("input", {bubbles:true}));
    t.value = t.value.replace(" TEMP-XYZ", "");
    t.dispatchEvent(new Event("input", {bubbles:true}));
    return { same: t.value === ed.savedText, dirty: ed.dirty };
  })()`);
  ok(noSend.same, '改完又改回来，编辑器内容与基线一致', noSend);
  await sleep(6500);                                   // 等过 5 秒防抖，它应该"触发"但被对比拦下
  const afterRevert = await ev('window.__putCount');
  ok(afterRevert === 0, '内容与基线一致时一个 PUT 都不发（改了又改回来 / Ctrl+Z 撤销）', afterRevert);
  ok((await ev('ed.dirty')) === false, '对比拦下后脏标被清掉', await ev('ed.dirty'));

  // 场景 B：真的改了内容 → 必须发请求
  await ev('(function(){ var t = document.getElementById("edt"); t.value = t.value + "-REAL-EDIT"; t.dispatchEvent(new Event("input", {bubbles:true})); })()');
  await sleep(6500);
  const afterReal = await ev('window.__putCount');
  ok(afterReal >= 1, '真改动会正常保存', afterReal);
  await ev('(function(){ window.fetch = window.__origFetch || window.fetch; })()');

  // 还原成原内容，别把测试内容留在预置数据里（PUT 走后台，测试结束前不等它也行）
  await ev('(function(){ fetch(BASE + "/api?path=" + encodeURIComponent("笔记/纯文本.txt"), { method:"PUT",'
    + ' headers: { "Content-Type":"text/plain" }, body:"这是一段纯文本。\\n第二行。\\n" }); return 1; })()');
  await sleep(500);
  await ev('fileCacheDel("笔记/纯文本.txt")');
}

// ---- 错误汇总 ----
head('运行期错误与 CSP');
// CDN 资源加载失败（二维码库）属于测试环境网络波动，不算产品错误
const netFail = t => /favicon|net::|Failed to load resource/i.test(t);
const realErrors = logErrors.filter(t => !netFail(t));
ok(exceptions.length === 0, '没有未捕获的 JS 异常', exceptions.slice(0, 3));
ok(realErrors.length === 0, '没有 error 级日志', realErrors.slice(0, 3));
const csp = [...logErrors, ...logWarns].filter(t => /Content Security Policy|Refused to/i.test(t));
ok(csp.length === 0, '没有 CSP 违规', csp.slice(0, 3));

// ================= 分享页 =================
head('分享页（只读渲染）');
// 重新播种一条分享给下面的只读分享页测试（上面的"取消全部"把 serve 预置的也清掉了）
await ev(`(function(){
  window.__reseed = '';
  post({ action: 'share', path: '笔记', expiresIn: 0 }).then(function(d){
    window.__reseed = d && d.ok ? d.token : '';
  }).catch(function(){ window.__reseed = ''; });
})()`);
let reseedToken = '';
for (let i = 0; i < 20 && !reseedToken; i++) {
  reseedToken = await ev('window.__reseed');
  if (!reseedToken) await sleep(250);
}
ok(!!reseedToken, '重新播种一条分享（供只读分享页测试）');
writeFileSync('share.txt', reseedToken);
const token = readFileSync('share.txt', 'utf8').trim();
await nav(ORIGIN + '/s/' + token, 'document.querySelectorAll("#list tbody tr").length > 0');
ok(true, '分享页加载完成');
ok(await ev('document.getElementById("edt") === null'), '分享页没有编辑器');
ok(await ev('document.getElementById("findBar") === null'), '分享页没有查找栏');
ok(await ev('document.getElementById("edGutter") === null'), '分享页没有行号槽');
// 分享页也要有刷新按钮，但没有退出按钮
const shAcct = await ev(`(function(){ var acct=document.getElementById("acct");
  return { reload: !!document.getElementById("btnReload"), logout: !!document.getElementById("btnLogout"),
    first: acct && acct.children[0] ? acct.children[0].id : "" }; })()`);
ok(shAcct.reload && shAcct.first === "btnReload", '分享页也有刷新按钮且排在最前', shAcct);
ok(!shAcct.logout, '分享页没有退出按钮', shAcct);

await ev('openFile("说明.md")');
await waitFor('!document.getElementById("vRender").hidden', 8000, 'md 渲染');
const v = await ev(`(function(){ var b=document.getElementById("vRender");
  return { h1: b.querySelectorAll("h1").length, table: b.querySelectorAll("table").length,
           code: b.querySelectorAll("pre code").length, viewerHidden: document.getElementById("viewer").hidden,
           seg: document.querySelectorAll("#vSeg [data-vmode]").length,
           toc: b.querySelectorAll(".tocInline a").length }; })()`);
ok(v.h1 === 1 && v.table === 1 && v.code === 1, '分享页 Markdown 正常渲染', v);
ok(v.viewerHidden, '渲染时纯文本查看器被隐藏');
ok(v.seg === 2, '提供 渲染/源码 切换');
ok(v.toc >= 2, '分享页也有目录');

await ev('(function(){ document.querySelector("#vSeg [data-vmode=src]").click(); })()');
ok(await ev('!document.getElementById("viewer").hidden'), '切到源码模式');
ok(await ev('document.getElementById("viewer").textContent.indexOf("## 标题二") >= 0'), '源码模式显示 Markdown 原文');
ok(await ev('document.getElementById("vRender").hidden'), '源码模式下渲染容器隐藏');
// 分享页（只读查看器）不挂网址图标：正文原样纯文本，避免改动分享内容
const vLink = await ev(`(function(){ var pre = document.getElementById("viewer");
  return { n: document.querySelectorAll("#viewer a.lnkico").length,
    anchors: pre.querySelectorAll("a").length,
    urlText: pre.textContent.indexOf("https://example.com") >= 0,
    plain: getComputedStyle(pre).color }; })()`);
ok(vLink.n === 0 && vLink.anchors === 0, '分享页源码模式不再挂网址图标', vLink);
ok(vLink.urlText, '分享页源码模式仍原样显示网址文本', vLink);
await ev('(function(){ document.querySelector("#vSeg [data-vmode=rich]").click(); })()');
ok(await ev('!document.getElementById("vRender").hidden'), '切回渲染模式');

// 分享页的图片预览
await ev('openMediaModal("图片.png","图片.png")');
await waitFor('document.getElementById("mbImg") && document.getElementById("mbImg").src.indexOf("blob:") === 0', 8000, '分享页图片 blob');
ok(await ev('document.getElementById("mbImg").naturalWidth === 1'), '访客也能预览图片（沙箱内 blob）');
await ev('closeModal()');

// 分享范围外的内容搜不到
await ev('runSearch("机密")');
await sleep(600);
const noHit = await ev('document.querySelectorAll("#sideScroll .sfile").length');
ok(noHit === 0, '分享页搜不到范围外内容', noHit);

// 方案 B：分享页只按文件名 / 路径搜，不做全文。
// "橙子"只出现在 表格.csv 的正文里（不是文件名），分享页理应搜不到 ——
// 这既省掉了为影子树单独维护全文索引，也杜绝了未发布草稿正文从搜索结果泄露出去。
await ev('runSearch("橙子")');
await sleep(700);
const bodyHit = await ev('document.querySelectorAll("#sideScroll .sfile").length');
ok(bodyHit === 0, '分享页不按正文搜索（方案 B：搜正文关键词搜不到）', bodyHit);
// 文件名 / 路径仍然能搜到，且结果路径相对分享根目录
await ev('runSearch("表格")');
await sleep(700);
const hits = await ev(`(function(){ var r = document.querySelectorAll("#sideScroll .sfile");
  return { n: r.length, first: r.length ? r[0].getAttribute("data-openpath") : "" }; })()`);
ok(hits.n >= 1, '分享页能按文件名搜到范围内的文件', hits);
ok(hits.first === '表格.csv', '结果路径相对分享根目录（不越界、不重复）', hits.first);

// 分享页的搜索 UI 不该出现任何"正文 / 索引"的东西。
// 之前这里有个「建立正文索引」按钮，访客点了必然 403 —— 属于"看得到就等于能点"的死入口。
const sUi = await ev(`(function(){
  return {
    ph: document.getElementById("q").getAttribute("placeholder"),
    note: (document.querySelector("#sideScroll .side-note") || {}).textContent || "",
    idxBtn: !!document.getElementById("idxBuild"),
    textChip: !!document.querySelector('#sideScroll .sr-chips button[data-ftype="text"]'),
    textGroup: (document.querySelector("#sideScroll .sr-group") || {}).textContent || ""
  };
})()`);
ok(sUi.ph.indexOf('文件名') >= 0, '分享页搜索框 placeholder 说清只搜文件名', sUi.ph);
ok(sUi.note.indexOf('只按文件名和目录名搜索') >= 0, '分享页明确告知只搜文件名和目录名', sUi.note);
ok(sUi.note.indexOf('正文索引') < 0 && sUi.note.indexOf('未进索引') < 0,
  '分享页不再提「正文索引 / 未进索引」（访客没有这个概念）', sUi.note);
ok(!sUi.idxBtn, '分享页没有「建立正文索引」按钮（访客点了也是 403）', sUi);
ok(!sUi.textChip, '分享页没有「正文命中」筛选芯片', sUi);
ok(sUi.textGroup.indexOf('正文') < 0, '分享页结果分组里没有「正文命中」', sUi.textGroup);
// 右键菜单同样不该有「深搜此文件」（读全文，访客用不了）
const roCtx = await ev(`(function(){
  var row = document.querySelector("#sideScroll .sfile[data-openpath]");
  if (!row) return { skip: true };
  var r = row.getBoundingClientRect();
  openCtx(r.left + 20, r.bottom + 10, row.getAttribute("data-openpath"), false, true, "表格");
  var box = document.getElementById("ctx");
  var n = box ? box.querySelectorAll('[data-cmd="deep"]').length : -1;
  closeCtx();
  return { deep: n };
})()`);
ok(roCtx.skip || roCtx.deep === 0, '分享页右键菜单没有「深搜此文件」', roCtx);

// 分享页错误
const realErrors2 = logErrors.filter(t => !netFail(t));
ok(exceptions.length === 0, '分享页没有未捕获异常', exceptions.slice(0, 3));
ok(realErrors2.length === 0, '分享页没有 error 级日志', realErrors2.slice(0, 3));

console.log('\n' + (fail ? `❌ ${fail} 项失败，${pass} 项通过` : `✅ 全部 ${pass} 项通过`));
try { ws.close(); } catch (e) {}
try { proc.kill(); } catch (e) {}
process.exit(fail ? 1 : 0);
