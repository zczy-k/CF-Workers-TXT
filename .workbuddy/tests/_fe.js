
var BASE = "/admin-x";
var RO = false;
var HAS_PW = false;
var SESS_DAYS = 0;
var SHARE_NAME = "";

var state = { path: '', folders: [], files: [], sel: {}, view: 'list', q: '',
              more: '', total: 0, lastPick: null, sort: { by: 'name', desc: false },
              multi: false, suppressClickUntil: 0, suppressRowKey: '' };
// savedText = 最近一次「已确认与云端一致」的正文（载入时或保存成功后更新）。
// dirty 只是个"用户可能改过"的粗标志：打过字就置 true，撤销也不会撤销回来。
// 所以真正决定"要不要发请求"的，是 edt.value 和 ed.savedText 的**逐字比较**——
// 打了错字又删掉、Ctrl+Z 撤销回原样，这些"改了个寂寞"的操作一个请求都不该发。
// 这层比较纯在浏览器里做，不消耗任何 Cloudflare 资源。
var ed = { path: '', name: '', dirty: false, timer: null, savedText: null };
// 自动换行：默认开启（打开文本主要是为了读），偏好记在本地，和字号一样
var wrapOn = true;
try { if (localStorage.getItem('cfwtxt_wrap') === '0') wrapOn = false; } catch (e) {}

function applyWrap(){
  var t = document.getElementById('edt');
  if (t){
    t.setAttribute('wrap', wrapOn ? 'soft' : 'off');
    // 保留 withGut：换行状态变化不能把"有行号槽"这件事一起抹掉
    var gut = t.classList.contains('withGut');
    t.className = (wrapOn ? 'wrapon' : 'wrapoff') + (gut ? ' withGut' : '');
  }
  var v = document.getElementById('viewer');
  if (v) v.className = 'viewer' + (wrapOn ? ' wrapon' : ' wrapoff');
  var btns = [document.getElementById('btnWrap'), document.getElementById('vWrap')];
  for (var i = 0; i < btns.length; i++){
    var b = btns[i];
    if (!b) continue;
    b.classList[wrapOn ? 'add' : 'remove']('on');
    b.setAttribute('aria-pressed', wrapOn ? 'true' : 'false');
    b.title = (wrapOn ? '自动换行：已开启' : '自动换行：已关闭（长行可横向滚动）') + ' · 快捷键 Alt+Z';
  }
  // 换行方式变了，行号定位与命中高亮的排版都要跟着重算
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}

function toggleWrap(){
  wrapOn = !wrapOn;
  try { localStorage.setItem('cfwtxt_wrap', wrapOn ? '1' : '0'); } catch (e) {}
  applyWrap();
  toast(wrapOn ? '已开启自动换行' : '已关闭自动换行（长行可横向滚动）');
}

var edFont = 13;
try { var savedFont = parseInt(localStorage.getItem('cfwtxt_font'), 10); if (savedFont >= 10 && savedFont <= 28) edFont = savedFont; } catch (e) {}

var E = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };

var ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
var ICON_LINK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
var ICON_OPEN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
var ICON_LOCATE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
var ICON_MORE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
var ICON_FOLDER_S = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#d4a02a"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
// 目录图标按层级配色：根目录琥珀、一级蓝、二级紫、三级绿、四级橙，循环
var DIR_COLORS = ['#d4a02a', '#378ADD', '#7F77DD', '#1D9E75', '#D85A30'];
function depthOf(path){
  if (!path) return 0;
  var n = 0;
  for (var i = 0; i < path.length; i++) if (path.charAt(i) === '/') n++;
  return n;
}
function dirIcon(path, open){
  // 根目录单独占一个色位，下面每深一层换一个颜色：
  // 根=琥珀，一级=蓝，二级=紫，三级=绿 …（这样根与它的一级子目录也不会撞色）
  var idx = path ? depthOf(path) + 1 : 0;
  var c = DIR_COLORS[idx % DIR_COLORS.length];
  var path2 = open
    ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1"/><path d="M3 9h16.5a1.5 1.5 0 0 1 1.45 1.9l-1.6 6A2 2 0 0 1 17.4 18.5H5a2 2 0 0 1-2-2z"/>'
    : '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + c +
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path2 + '</svg>';
}

// ===== 文件后缀徽标 =====
// 目录树里长文件名会被省略号截断（"节点链接_主要…"），用户就不知道它是什么类型了。
// 所以把后缀单独做成一个小徽标挂在名字旁边、按类别着色 —— 名字可以截断，后缀始终看得见。
var EXT_DOC = kwSet('md markdown mdx txt text rst adoc asciidoc org log srt vtt tex bib cls sty');
var EXT_DATA = kwSet('csv tsv psv xls xlsx ods');
var EXT_CFG = kwSet('json json5 jsonc jsonl ndjson geojson yml yaml toml ini cfg conf config cnf properties env editorconfig rc lock prefs');
var EXT_WEB = kwSet('html htm xhtml css scss sass less styl xml xsl xslt svg rss atom vue svelte astro');
var EXT_MEDIA = kwSet('png jpg jpeg gif webp avif bmp ico pdf mp3 wav ogg m4a flac aac mp4 webm mov m4v mkv');
// 「类型」列用的细分集合（比大类更具体：图片 / 视频 / 音频 / 压缩包）
var EXT_MEDIA_IMG = kwSet('png jpg jpeg gif webp avif bmp ico svg');
var EXT_MEDIA_VID = kwSet('mp4 webm mov m4v mkv avi');
var EXT_MEDIA_AUD = kwSet('mp3 wav ogg m4a flac aac oga opus');
var EXT_ARCHIVE = kwSet('zip rar 7z gz tgz tar bz2 xz zst');
var EXT_CODE = kwSet('js mjs cjs jsx ts tsx mts cts py pyw rb go rs java kt kts scala groovy gradle ' +
  'c h cc cpp cxx hpp hh cs m mm swift dart lua pl pm php sql sh bash zsh fish ksh bat cmd ps1 psm1 psd1 ' +
  'graphql gql proto thrift diff patch pem crt cer key pub asc ipynb');

var EXT_STYLE = {
  doc: 'background:#eaf3fe;color:#0969da',
  data: 'background:#e3f7f0;color:#0f6e56',
  cfg: 'background:#fdf1e0;color:#9a6700',
  web: 'background:#fdeaea;color:#c0392b',
  media: 'background:#eaf7ee;color:#1a7f37',
  code: 'background:#f0ecfe;color:#6f42c1',
  other: 'background:#f0f2f4;color:#6e7781'
};

function extCat(name, ct){
  var e = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (e){
    if (EXT_DOC[e]) return 'doc';
    if (EXT_DATA[e]) return 'data';
    if (EXT_CFG[e]) return 'cfg';
    if (EXT_WEB[e]) return 'web';
    if (EXT_MEDIA[e]) return 'media';
    if (EXT_CODE[e]) return 'code';
    return 'other';
  }
  if (c.indexOf('image/') === 0 || c.indexOf('video/') === 0 || c.indexOf('audio/') === 0) return 'media';
  return 'other';
}

// 输出徽标 HTML；没有扩展名就返回空串（避免到处冒出一堆灰块）
// 直接输出大写文本（而不是靠 CSS text-transform），这样复制出来、读屏软件读到的也是大写
function extBadge(name, ct){
  var e = extOf(name);
  if (!e) return '';
  var label = e.length > 5 ? e.slice(0, 5) : e;
  var style = EXT_STYLE[extCat(name, ct)] || EXT_STYLE.other;
  return '<span class="extb" style="' + style + '" title="' + E(e) + ' 格式">' + E(label.toUpperCase()) + '</span>';
}

var ICON_CARET = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
var ICON_MORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
var ICON_EXPAND = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l5 5 5-5"/><path d="M7 13l5 5 5-5"/></svg>';
var ICON_COLLAPSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13l5-5 5 5"/><path d="M7 20l5-5 5 5"/></svg>';
var ICON_FITW = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>';

// ===== 文本格式识别 =====
var TEXT_EXT = ('txt text md markdown mdx rst adoc asciidoc org log csv tsv psv json json5 jsonc jsonl ndjson geojson ' +
'ipynb js mjs cjs jsx ts tsx mts cts vue svelte astro css scss sass less styl html htm xhtml svg xml xsl xslt rss atom plist ' +
'yml yaml toml ini cfg conf config cnf properties env editorconfig prefs rc lock exp ' +
'sh bash zsh fish ksh bat cmd ps1 psm1 psd1 ' +
'py pyw rb erb gemspec go mod sum rs java kt kts scala groovy gradle ' +
'c h cc cpp cxx hpp hh hxx cs m mm swift dart lua pl pm r jl php phtml ' +
'sql graphql gql proto thrift avsc ' +
'tex bib cls sty srt vtt ass ssa sub m3u m3u8 pls cue oxt ' +
'diff patch pem crt cer key pub asc ' +
'gitignore gitattributes gitmodules dockerfile makefile cmake mk tf tfvars hcl nomad bicep nix dhall ' +
'desktop service socket rules sln csproj vcxproj pom launch manifest webmanifest').split(' ');

var TEXT_APP = ['application/json','application/xml','application/javascript','application/x-javascript',
'application/ecmascript','application/x-sh','application/x-yaml','application/yaml','application/toml',
'application/sql','application/graphql','application/x-httpd-php','application/x-python','application/x-ruby',
'application/x-perl','application/x-latex','application/ld+json','application/manifest+json',
'application/x-ndjson','application/csv'];   // x-yaml 已在上一行组里出现，不再重复

var BIN_PREFIX = ['image/','video/','audio/','font/','binary/'];
var BIN_APP = ['application/pdf','application/zip','application/gzip','application/x-gzip','application/x-tar',
'application/x-rar','application/x-7z-compressed','application/msword','application/vnd.ms-excel',
'application/vnd.ms-powerpoint','application/x-msdownload','application/x-msdos-program',
'application/x-apple-diskimage','application/x-bzip2','application/x-xz','application/wasm'];

function isBinaryMime(c){
  if (!c) return false;
  for (var i = 0; i < BIN_PREFIX.length; i++) { if (c.indexOf(BIN_PREFIX[i]) === 0) return true; }
  if (c.indexOf('application/vnd.openxmlformats') === 0) return true;
  return BIN_APP.indexOf(c) >= 0;
}

function isText(name, ct){
  var c = String(ct || '').toLowerCase().split(';')[0].trim();
  if (c === 'application/octet-stream') c = '';
  if (c && TEXT_APP.indexOf(c) >= 0) return true;
  if (c && c.indexOf('text/') === 0) return true;
  if (c && isBinaryMime(c)) return false;
  var s = String(name || '');
  var i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return !isBinaryMime(c);
  return TEXT_EXT.indexOf(s.slice(i + 1).toLowerCase()) >= 0;
}

function fmtSize(n){
  if (n == null || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtTime(s){
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  var p = function(x){ return (x < 10 ? '0' : '') + x; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

var toastTimer = null;
function toast(msg){
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('on'); }, 2300);
}

async function req(url, init){
  var r = await fetch(url, init);
  if (r.status === 401){ location.reload(); throw new Error('登录已过期'); }
  return r;
}

async function api(action, params){
  var q = new URLSearchParams();
  q.set('action', action);
  if (params){
    for (var k in params){
      if (k === 'action') continue;
      if (params[k] == null) continue;
      q.set(k, params[k]);
    }
  }
  var r = await req(BASE + '/api?' + q.toString());
  if (!r.ok) { var t = await r.text(); throw new Error(t || ('HTTP ' + r.status)); }
  return r.json();
}

function post(obj){
  return req(BASE + '/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  }).then(function(r){ return r.json(); });
}

function joinPath(dir, name){ return dir ? dir + '/' + name : name; }
function metaFor(name){
  for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === name) return state.files[i]; }
  return {};
}

// ===== 视图切换 =====
function switchView(v){
  state.view = v;
  document.getElementById('viewList').hidden = (v !== 'list');
  document.getElementById('viewEdit').hidden = (v !== 'edit');
  if (v === 'edit') {
    document.body.classList.remove('side-open');
    // 这里**故意不自动 focus**：
    // 手机上 focus 一个 textarea 会立刻弹出软键盘，半个屏幕被盖住 ——
    // 用户只是想"看一眼这个文件"，结果页面被键盘顶掉，非常烦；
    // 桌面同理，打开文件通常先读，光标闪在正文里反而容易误输入。
    // 真要编辑，点一下正文就能开始输入。
  }
  if (typeof refreshTreeSel === 'function') refreshTreeSel();
  // 切到编辑器就退出多选模式：留着选中状态，返回列表时会突然冒出一堆勾选，很突兀
  if (v !== 'list' && state.multi) exitMulti();
  // 切回列表要重绘一次：比如在编辑器里生成了分享（乐观更新只改了缓存），
  // 回到列表时如果沿用旧 DOM，「已分享」徽标就看不见，像没生效一样
  if (v === 'list' && typeof renderList === 'function') renderList();
  // 批量条只在列表视图出现。切到编辑器时不清一下，它会一直飘在底部挡住分享设置。
  if (typeof syncSelection === 'function') syncSelection();
}

// ===== 左侧目录树 =====
// 数据：一次 treeFull 拿到整棵结构（含每层子项数量），之后展开/折叠零请求
// 渲染：折叠时 DOM 里只留一行，展开时才把子节点建出来
// 动画：.tkids 用 grid-template-rows 0fr→1fr 过渡，不需要测量高度，也不整块重绘
var treeData = null;      // 完整树数据
var treeIdx = {};         // path -> 节点
var treeRefs = {};        // path -> { row, wrap, caret }
var treeOpen = { '': true };
var treeTotal = 0;
var treeLoading = null;
var TREE_NODE_CAP = 1200; // "展开全部"时的安全上限

function indexTree(node){
  treeIdx[node.p] = node;                      // 文件夹
  treeTotal++;
  for (var i = 0; i < node.f.length; i++){
    var f = node.f[i];
    // 服务端为了省体积只发文件名，这里补出完整路径
    if (f.p == null) f.p = node.p ? node.p + '/' + f.n : f.n;
    treeIdx[f.p] = f;                          // 文件也进索引，路径 -> 节点 保持统一
    treeTotal++;
  }
  for (var j = 0; j < node.d.length; j++) indexTree(node.d[j]);
}

function loadTree(force){
  if (treeData && !force) return Promise.resolve(treeData);
  if (treeLoading) return treeLoading;
  var box = document.getElementById('sideScroll');
  if (!treeData && box) box.innerHTML = '<div class="side-label"><span>目录</span></div><div class="side-hint">加载中…</div>';
  treeLoading = api('treeFull', {}).then(function(d){
    treeData = d.tree || { n: '根目录', p: '', d: [], f: [], c: 0, z: 0, x: 0 };
    treeData.t = !!d.truncated;
    treeIdx = {}; treeTotal = 0;
    indexTree(treeData);
    treeLoading = null;
    return treeData;
  }).catch(function(){
    treeLoading = null;
    if (box) box.innerHTML = '<div class="side-label"><span>目录</span></div><div class="side-hint">目录加载失败，请刷新页面</div>';
    return null;
  });
  return treeLoading;
}

function invalidateTree(){
  // 文件系统变了（上传 / 删除 / 重命名 / 移动），搜索结果缓存必须一起作废，
  // 否则刚删掉的文件还会在搜索结果里"活着"最多 30 秒。
  clearSearchCache();
  loadTree(true).then(function(d){ if (d) renderSide(); });
}

// 把某个路径及其所有上级标记为展开
function markOpen(path){
  treeOpen[''] = true;
  var parts = path ? path.split('/') : [];
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    treeOpen[acc] = true;
  }
}

// ---- 生成节点 HTML ----
function rowHtml(node, isDir, hasKids, open){
  var p = node.p;
  var isCur = isDir ? (p === state.path) : (state.view === 'edit' && p === ed.path);
  var h = '<div class="trow' + (isDir ? ' d' : ' f') + (isCur ? ' cur' : '') + '" data-p="' + E(p) + '"' +
    (isDir ? ' data-goto="' + E(p) + '"' : ' data-openpath="' + E(p) + '"') + '>';
  if (isDir){
    h += hasKids
      ? '<span class="tcar' + (open ? ' open' : '') + '" data-tog="' + E(p) + '">' + ICON_CARET + '</span>'
      : '<span class="tcar none"></span>';
    h += '<span class="tico">' + dirIcon(p, open) + '</span>';
  } else {
    h += '<span class="tcar none"></span>';
    h += '<span class="tico f">' + ICON_FILE + '</span>';
  }
  h += '<span class="tname" title="' + E(node.p || node.n) + '">' + E(node.n) + '</span>';
  if (!isDir) h += extBadge(node.n);
  h += shDot(node.p);
  if (isDir){
    if (node.c > 0) h += '<span class="tcnt">' + node.c + '</span>';
    else h += '<span class="tcnt dim" title="空文件夹">0</span>';
  } else {
    h += '<span class="tcnt dim">' + fmtSize(node.s) + '</span>';
  }
  // 行尾的操作入口：悬停（触屏常显）出现，也可直接右键。访客没有写操作，就不给这个入口
  if (p && !RO) h += '<button class="tact" data-tact="1" data-p="' + E(p) + '" data-dir="' + (isDir ? 1 : 0) +
    '" title="更多操作（右键也可以）" tabindex="-1">' + ICON_MORE + '</button>';
  return h + '</div>';
}

function kidsHtml(node){
  var h = '';
  for (var i = 0; i < node.d.length; i++){
    var c = node.d[i];
    var hasKids = c.c > 0;
    var open = !!treeOpen[c.p];
    h += '<div class="tnode" data-n="' + E(c.p) + '">' + rowHtml(c, true, hasKids, open) +
      '<div class="tkids' + (open ? ' open' : '') + '"><div class="tkids-in">' +
      (open ? kidsHtml(c) : '') + '</div></div></div>';
  }
  for (var j = 0; j < node.f.length; j++){
    h += '<div class="tnode" data-n="' + E(node.f[j].n) + '">' + rowHtml(node.f[j], false, false, false) + '</div>';
  }
  if (node.x > 0){
    h += '<div class="side-hint">还有 ' + node.x + ' 个文件未列出，请在右侧查看</div>';
  }
  return h;
}

function renderSide(){
  var box = document.getElementById('sideScroll');
  if (!box) return;
  if (!treeData){ loadTree().then(function(){ renderSide(); }); return; }

  var st = box.scrollTop;
  treeRefs = {};

  var h = '<div class="side-label"><span>目录</span><span class="sw">' +
    '<button class="mini" data-fitw="1" title="按最长的文件名自适应侧栏宽度（双击分隔条也行）">' + ICON_FITW + '</button>' +
    '<button class="mini" data-treeall="1" title="展开全部">' + ICON_EXPAND + '</button>' +
    '<button class="mini" data-treeall="0" title="收起全部">' + ICON_COLLAPSE + '</button>' +
    '</span></div>';

  var rootOpen = !!treeOpen[''];
  var rootHasKids = treeData.c > 0;
  h += '<div class="tnode" data-n="__root__">' + rowHtml(treeData, true, rootHasKids, rootOpen) +
    '<div class="tkids' + (rootOpen ? ' open' : '') + '"><div class="tkids-in">' +
    (rootOpen ? kidsHtml(treeData) : '') + '</div></div></div>';

  if (treeData.t) h += '<div class="side-hint">目录过大，仅显示了前 ' + treeTotal + ' 项</div>';

  box.innerHTML = backBarHtml() + '<div id="tree">' + h + '</div>';
  syncScopeRow();                     // 「只在当前目录内搜索」开关只在子目录里才有意义

  registerRefs(box);
  box.scrollTop = st;
}

// 登记 path -> 元素 的引用（避免用属性选择器拼名字，中文/引号都不用转义）
function registerRefs(scope){
  var rows = scope.querySelectorAll('.trow[data-p]');
  for (var i = 0; i < rows.length; i++){
    var row = rows[i];
    var path = row.getAttribute('data-p');
    var wrap = row.nextElementSibling;
    if (wrap && wrap.className.indexOf('tkids') < 0) wrap = null;
    treeRefs[path] = { row: row, wrap: wrap, caret: row.querySelector('.tcar') };
  }
}

// 展开/折叠（只改 class，不重建 DOM —— 这是"丝滑"的关键）
function toggleNode(path, force){
  var ref = treeRefs[path];
  if (!ref || !ref.wrap) return;
  var open = (force == null) ? !ref.wrap.classList.contains('open') : !!force;
  if (open && !ref.wrap.getAttribute('data-built')){
    var node = treeIdx[path];
    var inner = ref.wrap.firstElementChild;
    inner.innerHTML = node ? kidsHtml(node) : '';
    ref.wrap.setAttribute('data-built', '1');
    registerRefs(inner);          // 新长出来的行也要登记，否则下一级三角点了没反应
  }
  if (open) treeOpen[path] = true; else delete treeOpen[path];
  if (ref.caret) ref.caret.classList.toggle('open', open);
  ref.wrap.classList.toggle('open', open);
  // 展开的节点若里面已有展开的子节点，折叠时其"已展开"状态要保留（下次再点开还是原样）
}

function treeAll(open){
  if (!treeData) return;
  if (open){
    if (treeTotal > TREE_NODE_CAP){ toast('目录项太多（' + treeTotal + '），请逐级展开'); return; }
    for (var k in treeIdx) if (treeIdx[k].c > 0) treeOpen[k] = true;
  } else {
    treeOpen = { '': true };
  }
  renderSide();
}

// ===== 目录树操作菜单（右键 / ⋯ 按钮）=====
var ctxEl = null;

function closeCtx(){
  if (!ctxEl) return;
  if (ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
  ctxEl = null;
}

// withReveal=true 时多一项「在目录中显示」—— 搜索结果行专用：
// 搜到文件后想看看它周围还有什么，比"打开它"更常用的下一步。
// deepQ 非空时再补一项「深搜此文件」（读全文精确匹配，正文命中被 8K 索引截断时用）。
var ctxDeepQ = '';                    // 当前右键菜单对应的搜索词（深搜要用）
function openCtx(x, y, path, isDir, withReveal, deepQ){
  closeCtx();
  if (!path) return null;                       // 根目录不给操作
  ctxDeepQ = deepQ || '';
  var items = [{ c: 'open', t: '打开' }];
  if (withReveal) items.push({ c: 'reveal', t: '在目录中显示' });
  if (ctxDeepQ && !isDir && !RO) items.push({ c: 'deep', t: '深搜此文件（读全文精确匹配）' });
  var pk = isDir ? '' : kindOf(path.split('/').pop(), '');
  if (!isDir && (pk === 'image' || pk === 'av' || pk === 'pdf')) items.push({ c: 'preview', t: '预览' });
  if (!isDir) items.push({ c: 'download', t: '下载' });
  // 打包下载：文件夹本来就不能单文件下载，给它一个 zip 出口；
  // 文件也提供这一项，方便"连目录结构一起带走"。
  items.push({ c: 'pack', t: isDir ? '打包下载本目录（zip）' : '下载为 zip' });
  if (!RO){
    items.push({ c: 'sep' });
    items.push({ c: 'rename', t: '重命名' });
    items.push({ c: 'move', t: '移动到…' });
    items.push({ c: 'share', t: isDir ? '分享本目录…' : '分享…' });
    // 发布只对"分享页能看到的路径"有意义：路径本身被分享，或在某个被分享的目录里。
    // 否则点下去只是往影子树里拷一份没人会读的内容，纯属浪费请求。
    if (isSharedPath(path)){
      items.push({ c: 'sep' });
      items.push({ c: 'publish', t: (isDir ? '发布本目录' : '发布') + '到分享页' + (pubStale[path] ? '（有未发布的改动）' : '') });
      items.push({ c: 'unpublish', t: '撤回发布（分享页先隐藏）' });
    }
    items.push({ c: 'sep' });
    items.push({ c: 'del', t: '删除', danger: true });
  }
  var h = '<div class="ctop">' + E(path.split('/').pop()) + '</div>';
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    if (it.c === 'sep'){ h += '<div class="csep"></div>'; continue; }
    h += '<button class="ci' + (it.danger ? ' danger' : '') + '" data-cmd="' + it.c +
      '" data-cp="' + E(path) + '" data-cdir="' + (isDir ? 1 : 0) + '">' + it.t + '</button>';
  }
  var box = document.createElement('div');
  box.id = 'ctx';
  box.innerHTML = h;
  box.classList.add('on');            // 必须先显示，否则测到的宽高是 0，夹边会失效
  document.body.appendChild(box);
  var r = box.getBoundingClientRect();
  var left = (x + r.width > innerWidth - 8) ? x - r.width : x;
  var top = (y + r.height > innerHeight - 8) ? y - r.height : y;
  box.style.left = Math.max(8, Math.min(left, innerWidth - r.width - 8)) + 'px';
  box.style.top = Math.max(8, Math.min(top, innerHeight - r.height - 8)) + 'px';
  ctxEl = box;
  return box;
}

function openCtxAt(btn, withReveal){
  var r = btn.getBoundingClientRect();
  // 搜索结果行的 ⋯ 按钮：从所在行取搜索词，菜单里才带得出「深搜此文件」
  var dq = '';
  if (withReveal){
    var row = (btn.closest ? btn.closest('.sfile[data-openpath]') : null);
    if (row && row.getAttribute('data-snip') === '1') dq = row.getAttribute('data-sq') || '';
  }
  // 贴着按钮右侧展开；超出视口时 openCtx 会自动夹回来
  var box = openCtx(r.right + 4, r.bottom + 4, btn.getAttribute('data-p'),
    btn.getAttribute('data-dir') === '1', withReveal, dq);
  if (box) box.__owner = btn;
}

function runCtx(cmd, path, isDir){
  if (cmd === 'open'){
    if (isDir){ document.body.classList.remove('side-open'); load(path); }
    else openPath(path);
    return;
  }
  if (cmd === 'reveal'){ revealInTree(path, isDir); return; }
  if (cmd === 'deep'){ deepSearch(path, ctxDeepQ, false); return; }
  if (cmd === 'download'){ location.href = dlUrl('', path); return; }
  if (cmd === 'pack'){ packOne(path, isDir); return; }
  if (cmd === 'preview'){ openMediaModal(path, path.split('/').pop()); return; }
  if (cmd === 'rename'){ openRename(path, isDir); return; }
  if (cmd === 'move'){ openMove(path, isDir); return; }
  if (cmd === 'share'){ openShareModal(path, isDir); return; }
  if (cmd === 'publish'){ doPublish(path, isDir); return; }
  if (cmd === 'unpublish'){ doUnpublish(path, isDir); return; }
  if (cmd === 'del'){ doDelete(path, isDir); return; }
}

// 发布 / 撤回发布（列表右键、行菜单、分享面板共用）。
// 发布是"把草稿当前版本复制到影子树"，分享页立刻可见；撤回只删影子树副本，草稿不动。
function doPublish(path, isDir){
  toast('正在发布…');
  return post({ action: 'publish', path: path, isDir: !!isDir })
    .then(function(d){
      if (!d.ok) throw new Error(d.error || '发布失败');
      pubStale[path] = false;
      toast('已发布 ' + d.published + ' 个对象');
      if (ed.path && (ed.path === path || ed.path.indexOf(path + '/') === 0)) setStatus('已发布 ' + hhmm());
      reloadShares();
    })
    .catch(function(e){ toast('发布失败：' + e.message); });
}
// 一键补发：老版本没有影子树，历史分享记录对应的内容只在草稿树里，分享页会打不开。
// 这个动作把"还没发布过"的那些分享补一遍，已发布的跳过（不会重复拷、也不会覆盖更新的版本）。
function doPublishAll(){
  showModal({
    title: '全部发布', small: true, okText: '开始发布',
    body: '<div class="msg">把还没有发布过的分享内容复制到分享页。<b>已发布的不会重复发布</b>，' +
      '所以正在编辑、还没点发布的版本不会被这里覆盖。</div>',
    onOk: function(){
      return post({ action: 'publishAll' })
        .then(function(d){
          if (!d.ok) throw new Error(d.error || '发布失败');
          var msg = '新发布 ' + d.published + ' 条';
          if (d.skipped) msg += '，跳过已发布/无需发布 ' + d.skipped + ' 条';
          if (d.failed && d.failed.length) msg += '，失败 ' + d.failed.length + ' 条（内容可能已删除）';
          toast(msg);
          if (d.failed && d.failed.length) console.warn('publishAll 失败路径', d.failed);
          reloadShares();
        })
        .catch(function(e){ toast('发布失败：' + e.message); return false; });
    }
  });
}

function doUnpublish(path, isDir){
  showModal({
    title: '撤回发布', small: true, okText: '撤回',
    body: '<div class="msg">撤回后 <b>' + E(path) + '</b> 会先从分享页隐藏，<b>草稿内容不受影响</b>；' +
      '随时可以再发布回来。</div>',
    onOk: function(){
      return post({ action: 'unpublish', path: path, isDir: !!isDir })
        .then(function(d){
          if (!d.ok) throw new Error(d.error || '撤回失败');
          toast('已撤回 ' + d.removed + ' 个对象');
          reloadShares();
        })
        .catch(function(e){ toast('撤回失败：' + e.message); return false; });
    }
  });
}

// 「在目录中显示」：展开左侧目录树到目标所在层级，把目标行滚进视野。
// 搜索结果是个"扁平列表"，看完之后用户常想知道"这文件在哪个目录、旁边还有什么"。
function revealInTree(path, isDir){
  closeCtx();
  rememberSearch();                     // 离开搜索结果前留快照，侧栏顶部给「返回搜索结果」
  var dir = isDir ? path : path.split('/').slice(0, -1).join('/');
  markOpen(dir);                        // 逐级展开祖先目录
  var q = document.getElementById('q');
  if (q) q.value = '';
  state.q = '';
  searchState = null;
  abortSearch();
  var done = function(){
    var ref = treeRefs[path];
    if (ref && ref.row && ref.row.scrollIntoView) ref.row.scrollIntoView({ block: 'center' });
    toast('已定位到「' + (path || '根目录') + '」');
  };
  if (!treeData){ loadTree().then(function(){ renderSide(); done(); }); return; }
  renderSide();
  done();
}

document.addEventListener('contextmenu', function(ev){
  var t = ev.target;
  if (RO) return;                       // 访客只用左侧浏览，不需要操作菜单
  var row = (t && t.closest) ? t.closest('#tree .trow[data-p]') : null;
  if (row){
    var p = row.getAttribute('data-p');
    if (!p) return;
    ev.preventDefault();
    openCtx(ev.clientX, ev.clientY, p, row.hasAttribute('data-goto'));
    return;
  }
  // 搜索结果行：右键直接出同一套操作菜单，并且多一项「在目录中显示」
  var srow = (t && t.closest) ? t.closest('#sideScroll .sfile[data-openpath]') : null;
  if (!srow) return;
  var sp = srow.getAttribute('data-openpath');
  if (!sp) return;
  ev.preventDefault();
  var sdq = (srow.getAttribute('data-snip') === '1') ? (srow.getAttribute('data-sq') || '') : '';
  openCtx(ev.clientX, ev.clientY, sp, srow.getAttribute('data-isdir') === '1', true, sdq);
});
document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') closeCtx(); });
window.addEventListener('resize', closeCtx);
(function(){
  var sc = document.getElementById('sideScroll');
  if (sc) sc.addEventListener('scroll', closeCtx);
})();

// 只切换高亮，不重建 DOM（打开文件时用，避免整棵树重绘）
function refreshTreeSel(){
  for (var p in treeRefs){
    var r = treeRefs[p];
    if (!r.row) continue;
    var isDir = r.row.hasAttribute('data-goto');
    var cur = isDir ? (p === state.path) : (state.view === 'edit' && p === ed.path);
    if (r.row.classList.contains('cur') !== cur) r.row.classList.toggle('cur', cur);
  }
}

// ===== 搜索结果 =====
var searchTimer = null;
var SEARCH_PAGE = 60;              // 一页 60 条：够看，又不会一次渲染几百行把侧栏拖卡
var SEARCH_CACHE_TTL = 30000;      // 结果缓存 30 秒：来回改词 / 退回上一个词不再打服务器
var SEARCH_CACHE_MAX = 24;         // 缓存上限（LRU），防止无限增长
var searchCache = {};              // key = 查询 + 目录 + 类型 + 偏移 → { at, data }
var searchCacheKeys = [];
var searchAbort = null;            // 正在飞的搜索请求（新搜索 / 清空输入时取消掉）
var searchSeq = 0;                 // 请求序号：只有最后一次的结果允许上屏
var searchState = null;            // { q, pq, dir, ftype, terms, results, total, hasMore, meta }
var lastSearch = null;             // 上一次搜索的快照：清空搜索框后还能一键"返回搜索结果"
var srSel = -1;                    // 结果列表里键盘选中的行号（↑↓ 移动，-1 = 未选）
var srFilter = '';                 // 结果类型筛选：'' | name | path | text | dir
var searchScopeCur = false;        // 「只在当前目录内搜索」开关

// ---- 搜索历史（只存浏览器本地，不上传）----
var SEARCH_HIST_KEY = 'cfw_srch_hist';
var SEARCH_HIST_MAX = 12;
var searchHist = [];
var qhSel = -1;                    // 历史下拉里键盘选中的项
var histTimer = null;
function histLoad(){
  searchHist = [];
  try {
    var a = JSON.parse(localStorage.getItem(SEARCH_HIST_KEY) || '[]');
    if (Object.prototype.toString.call(a) === '[object Array]'){
      for (var i = 0; i < a.length && searchHist.length < SEARCH_HIST_MAX; i++){
        if (typeof a[i] === 'string' && a[i]) searchHist.push(a[i]);
      }
    }
  } catch (e) {}
}
function histSave(){
  try { localStorage.setItem(SEARCH_HIST_KEY, JSON.stringify(searchHist)); } catch (e) {}
}
function histPush(q){
  q = String(q || '').trim();
  if (!q) return;
  var i = searchHist.indexOf(q);
  if (i >= 0) searchHist.splice(i, 1);
  searchHist.unshift(q);
  if (searchHist.length > SEARCH_HIST_MAX) searchHist.length = SEARCH_HIST_MAX;
  histSave();
}
function histRender(){
  var box = document.getElementById('qHist');
  if (!box) return;
  if (!searchHist.length){
    box.innerHTML = '<div class="qempty">还没有搜索记录，搜过的词会自动留在这里</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < searchHist.length; i++){
    h += '<div class="qh' + (i === qhSel ? ' on' : '') + '" data-hq="' + E(searchHist[i]) + '">' +
      '<span class="qt">' + E(searchHist[i]) + '</span></div>';
  }
  h += '<div class="qsep"></div><button class="qclr" data-hclr="1">清除搜索记录</button>';
  box.innerHTML = h;
}
function histOpen(){
  var box = document.getElementById('qHist');
  if (!box) return;
  qhSel = -1;
  histRender();
  box.classList.add('on');
}
function histClose(){
  var box = document.getElementById('qHist');
  if (box) box.classList.remove('on');
  qhSel = -1;
}
// 输入停下来 1.4 秒才把词记进历史 —— 否则 f / fn / fni / fnia 这些半成品会全被记下来
function histSchedule(q){
  clearTimeout(histTimer);
  histTimer = setTimeout(function(){ if (state.q === q) histPush(q); }, 1400);
}

function clearSearchCache(){
  searchCache = {};
  searchCacheKeys = [];
}
function searchCacheGet(key){
  var c = searchCache[key];
  if (!c) return null;
  if (Date.now() - c.at > SEARCH_CACHE_TTL){ delete searchCache[key]; return null; }
  return c.data;
}
function searchCacheSet(key, data){
  if (!searchCache[key]) searchCacheKeys.push(key);
  searchCache[key] = { at: Date.now(), data: data };
  while (searchCacheKeys.length > SEARCH_CACHE_MAX){
    delete searchCache[searchCacheKeys.shift()];
  }
}
function abortSearch(){
  if (searchAbort){ try { searchAbort.abort(); } catch (e) {} searchAbort = null; }
}

// 搜索视图栈：清空搜索框 / 点「在目录中显示」会离开搜索结果，
// 这里留一份快照，侧栏顶部给一条「返回搜索结果」，不用把词重新敲一遍。
function rememberSearch(){
  if (searchState && searchState.results && searchState.results.length){
    lastSearch = { q: searchState.q, filter: srFilter, total: searchState.total };
  }
}
function restoreSearch(){
  if (!lastSearch) return;
  var q = document.getElementById('q');
  if (q) q.value = lastSearch.q;
  srFilter = lastSearch.filter || '';
  runSearch(lastSearch.q);
}
function dismissRestore(){
  lastSearch = null;
  renderSide();
}
function backBarHtml(){
  if (!lastSearch) return '';
  return '<div class="sr-back"><button class="bk" data-srback="1" title="回到上一次的搜索结果">' +
    '返回搜索结果：' + E(lastSearch.q) + '</button>' +
    '<button class="x" data-srbackx="1" title="不再显示">×</button></div>';
}

// 结果类型筛选芯片：切换只重跑搜索（服务端 ftype 过滤），不重新渲染整棵树。
function setSrFilter(f){
  f = (f === 'name' || f === 'path' || f === 'text' || f === 'dir') ? f : '';
  if (f === srFilter) return;
  srFilter = f;
  srSel = -1;
  if (state.q) runSearch(state.q);
}

// 「只在当前目录内搜索」：勾选后给搜索补一个 dir 参数（服务端本来就支持 dir 过滤）。
// 框里手打的 path:xxx 优先 —— 用户明确写的意图不该被一个复选框悄悄改掉。
function effDir(pq){
  if (pq.dir) return pq.dir;
  if (searchScopeCur && state.path) return state.path;
  return '';
}
function syncScopeRow(){
  var row = document.getElementById('sideScope');
  if (!row) return;
  var on = !!state.path;                       // 根目录 = 全库，这个开关没有意义
  row.hidden = !on;
  var cb = document.getElementById('qScope');
  if (cb) cb.checked = searchScopeCur;
  var nm = document.getElementById('qScopeName');
  if (nm) nm.textContent = on ? '（' + state.path.split('/').pop() + '）' : '';
}
function onScopeToggle(){
  var cb = document.getElementById('qScope');
  searchScopeCur = !!(cb && cb.checked);
  var q = document.getElementById('q');
  if (q && q.value.trim()) runSearch(q.value.trim());
}

function onSearchInput(){
  clearTimeout(searchTimer);
  clearTimeout(histTimer);
  histClose();
  var v = document.getElementById('q').value.trim();
  if (v !== state.q) srFilter = '';            // 换了词就从「全部」重新看，别让上一轮的筛选把人挡在门外
  if (v) histSchedule(v);                      // 停手 1.4 秒才记进历史，半成品词不落库
  searchTimer = setTimeout(function(){ runSearch(v); }, 260);
}

// 解析搜索框里的轻量语法：
//   ext:md      → 只搜 Markdown（后缀过滤，可带点）
//   path:笔记    → 只搜「笔记」目录下的内容
//   "cat"       → 双引号包裹 = 整词匹配（cat 不再命中 category）
// 剩余部分按空白拆成**多个关键词，全部命中才算匹配（AND）** ——
// 搜「fniao 去重」返回同时含这两个词的文件，而不是去找「fniao 去重」这个整串。
// 语法可混用：ext:log path:日志 timeout 失败
function parseSearchQuery(raw){
  var ext = '', dir = '', word = false, q = raw || '';
  q = q.replace(/(^|\s)ext:(\S+)/i, function(m, sp, v){ ext = v.replace(/^\./, ''); return sp; });
  q = q.replace(/(^|\s)path:(\S+)/i, function(m, sp, v){ dir = v; return sp; });
  q = q.replace(/^\s+|\s+$/g, '');
  if (q.length >= 2 && q.charAt(0) === '"' && q.charAt(q.length - 1) === '"'){
    word = true; q = q.slice(1, -1);
  }
  var terms = q.split(/\s+/).filter(function(x){ return !!x; });
  if (terms.length > 8) terms = terms.slice(0, 8);   // 与服务端同一个上限
  return { q: q, terms: terms, ext: ext, dir: dir, word: word };
}

// 片段里的关键词高亮。用 indexOf 扫描而不是正则替换 —— 关键词可能含正则元字符。
// terms 可以是字符串（单关键词）或数组（多关键词 AND 查询）。
// 多关键词的命中区间会互相重叠（比如 "abc" 与 "bc"），所以先收集区间 → 排序 →
// 合并重叠部分再输出；否则会嵌套出 <span class="hl"><span class="hl"> 这种脏 DOM。
function hlText(s, terms){
  if (!s) return E(s || '');
  if (typeof terms === 'string') terms = terms ? [terms] : [];
  if (!terms || !terms.length) return E(s);
  var multi = terms.length > 1;              // 单关键词不必换色，多关键词才按词轮换底色
  var low = s.toLowerCase();
  var iv = [];
  for (var ti = 0; ti < terms.length; ti++){
    var ql = String(terms[ti] || '').toLowerCase();
    if (!ql) continue;
    var i = 0, guard = 0;
    while (guard++ < 200){
      var k = low.indexOf(ql, i);
      if (k < 0) break;
      iv.push([k, k + ql.length, ti]);        // 记下"这一命中属于第几个关键词"
      i = k + ql.length;
    }
  }
  if (!iv.length) return E(s);
  iv.sort(function(a, b){ return a[0] - b[0] || b[1] - a[1]; });
  var out = '', pos = 0;
  for (var j = 0; j < iv.length; j++){
    var a = iv[j][0], b = iv[j][1], t = iv[j][2];
    if (a < pos){ if (b > pos) pos = b; continue; }   // 与上一段重叠 → 直接合并（保留先出现那个词的底色）
    if (a > pos) out += E(s.slice(pos, a));
    out += '<span class="hl' + (multi ? ' hl-' + (t % 3 + 1) : '') + '">' + E(s.slice(a, b)) + '</span>';
    pos = b;
  }
  out += E(s.slice(pos));
  return out;
}

function idxBtnHtml(hasIdx){
  return '<button class="idxBtn" id="idxBuild">' +
    (hasIdx ? '重建 / 更新正文索引' : '建立正文索引') + '</button>';
}

// more=true 表示「加载更多」：在现有结果后面追加下一页，而不是从头搜一遍。
function runSearch(q, more){
  state.q = q;
  var box = document.getElementById('sideScroll');
  if (!box) return;
  if (!q){ abortSearch(); rememberSearch(); searchState = null; renderSide(); return; }
  var pq = parseSearchQuery(q);
  if (!pq.q && !pq.ext && !pq.dir){ abortSearch(); rememberSearch(); searchState = null; renderSide(); return; }

  var fresh = !more || !searchState || searchState.q !== q;
  var offset = fresh ? 0 : searchState.results.length;
  var useDir = effDir(pq);                       // path: 手写优先，其次「只在当前目录内搜索」开关
  if (fresh){
    searchState = { q: q, pq: pq, terms: pq.terms, results: [], total: 0, hasMore: false, meta: null };
    srSel = -1;                                // 新查询 → 清掉上一轮的键盘选中
  }
  // 同一查询（含分页 + 类型筛选 + 目录范围）30 秒内直接命中缓存 ——
  // 反复改词 / 切筛选芯片不再打服务器，既省一次 R2 list 补扫 + 评分，又让侧栏"秒出"。
  var key = q + '' + offset + '' + srFilter + '' + useDir;
  var hit = searchCacheGet(key);
  if (hit){ applySearchData(hit, fresh); return; }

  abortSearch();                                   // 上一笔还没回来就取消掉，别浪费配额
  searchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var seq = ++searchSeq;
  if (fresh) box.innerHTML = '<div class="side-hint">搜索中…</div>';
  var url = BASE + '/api?action=search&q=' + encodeURIComponent(pq.q) +
    (pq.ext ? '&ext=' + encodeURIComponent(pq.ext) : '') +
    (useDir ? '&dir=' + encodeURIComponent(useDir) : '') +
    (pq.word ? '&word=1' : '') +
    (srFilter ? '&ftype=' + srFilter : '') + '&offset=' + offset + '&limit=' + SEARCH_PAGE;
  req(url, searchAbort ? { signal: searchAbort.signal } : undefined)
    .then(function(r){ return r.json(); }).then(function(d){
    if (seq !== searchSeq || state.q !== q) return;   // 已被更新的输入取代 → 丢弃
    searchAbort = null;
    searchCacheSet(key, d);
    applySearchData(d, fresh);
  }).catch(function(e){
    if (seq !== searchSeq || state.q !== q) return;
    searchAbort = null;
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;
    var b = document.getElementById('sideScroll');
    if (b) b.innerHTML = '<div class="side-hint">搜索失败：' + E(e.message) + '</div>';
  });
}

function applySearchData(d, fresh){
  if (!searchState) return;
  var list = d.results || [];
  searchState.results = fresh ? list.slice() : searchState.results.concat(list);
  searchState.total = d.total || 0;
  searchState.hasMore = !!d.hasMore;
  searchState.meta = d;
  if (d.terms && d.terms.length) searchState.terms = d.terms;
  renderSearchResults();
}

// 结果归类：文件夹 / 文件名命中 / 路径命中 / 正文命中。
// 分组和筛选芯片都按这套归类，前后端口径一致。
function srKind(it){
  if (it.isDir) return 'dir';
  if (it.nameHit) return 'name';
  if (it.pathHit) return 'path';
  return 'text';
}
var SR_KINDS = [
  { k: 'name', t: '文件名命中', n: 'nameHits' },
  { k: 'path', t: '路径命中', n: 'pathHits' },
  { k: 'text', t: '正文命中', n: 'textHits' },
  { k: 'dir', t: '文件夹', n: 'dirHits' }
];

// 一条搜索结果行。信息层级：文件名（主）→ 目录 → 正文片段 → 修改时间。
// 深搜入口不再挤在行里（一行三个按钮太吵），收进 ⋯ / 右键菜单。
function srRowHtml(it, terms, q, idx){
  var segs = it.path.split('/');
  var nm = segs.pop();
  var dirPart = segs.join('/');
  var kind = srKind(it);
  var tag = kind === 'dir' ? '<span class="sr-tag dir">文件夹</span>'
    : (kind === 'name' ? '<span class="sr-tag">文件名</span>'
    : (kind === 'path' ? '<span class="sr-tag path">路径</span>' : ''));
  var cut = (kind === 'text' && it.cut === 1)
    ? '<span class="sr-cut" title="该文件较大，只索引了前 8K 正文，命中可能被截断；可右键「深搜此文件」读全文">可能截断</span>' : '';
  // 正文命中次数：告诉用户"这个词在这份文件里出现了几处"，不用点进去数
  var cntTag = (kind === 'text' && it.cnt > 1)
    ? '<span class="sr-tag cnt">正文 ' + it.cnt + ' 处</span>' : '';
  var meta = (!it.isDir && it.mtime) ? ('修改 ' + fmtTime(it.mtime)) : '';
  var icon = it.isDir ? '<span class="ico f">' + ICON_FOLDER_S + '</span>' : '<span class="ico f">' + ICON_FILE + '</span>';
  return '<div class="sfile' + (it.isDir ? ' sdir' : '') + (idx === srSel ? ' sel' : '') +
    '" data-openpath="' + E(it.path) + '" data-srkind="' + kind + '"' +
    (it.isDir ? ' data-isdir="1"' : '') + ' data-sq="' + E(q) + '"' +
    (it.snippet ? ' data-snip="1"' : '') +
    ' title="' + E(it.path) + '">' +
    icon +
    '<span class="fname">' + hlText(nm, (it.nameHit || it.pathHit) ? terms : null) + extBadge(nm, it.ct) + tag + cntTag + cut +
    (dirPart ? '<span class="sr-dir">' + hlText(dirPart, terms) + '</span>' : '') +
    (it.snippet ? '<span class="sr-snip">' + hlText(it.snippet, terms) + '</span>' : '') +
    (meta ? '<span class="sr-meta">' + E(meta) + '</span>' : '') +
    '</span>' +
    '<span class="fsz">' + (it.isDir ? '' : fmtSize(it.size)) + '</span>' +
    (RO ? '' : '<button class="tact" data-sact="1" data-p="' + E(it.path) + '" data-dir="' +
      (it.isDir ? 1 : 0) + '" title="更多操作（右键也可以）" tabindex="-1">' + ICON_MORE + '</button>') +
    '</div>';
}

function renderSearchResults(){
  var box = document.getElementById('sideScroll');
  if (!box || !searchState) return;
  var st = searchState, d = st.meta || {}, list = st.results, terms = st.terms || [], q = st.pq.q;
  var shown = list.length;
  var head = '<div class="side-label"><span>搜索结果</span><span>' +
    (st.hasMore ? shown + ' / ' + st.total : shown) + '</span></div>';

  // 筛选芯片：各类型数量来自服务端计数（筛选前的真实总量），点一下只看那一类。
  // 分享页没有正文命中这一类（textHits 恒为 0），显式跳过 —— 万一以后有人加了别的路径，
  // 也不会凭空冒出一个点下去永远空白的芯片。
  var chips = '';
  if (d.indexed !== undefined){
    var cAll = '<button data-ftype="" class="' + (srFilter === '' ? 'on' : '') + '">全部 ' + (d.total || 0) + '</button>';
    var cRest = '';
    for (var ci = 0; ci < SR_KINDS.length; ci++){
      var kd = SR_KINDS[ci], cn = d[kd.n] || 0;
      if (RO && kd.k === 'text') continue;
      if (!cn) continue;
      cRest += '<button data-ftype="' + kd.k + '" class="' + (srFilter === kd.k ? 'on' : '') + '">' +
        kd.t + ' ' + cn + '</button>';
    }
    chips = '<div class="sr-chips">' + cAll + cRest + '</div>';
  }

  // 分享页（访客）：只搜文件名 / 路径，没有全文索引这回事。
  // 所以这里**刻意不提**索引、正文、"未进索引"、容量上限那些词 ——
  // 访客既没有建索引的权限（reindex 只对管理员开放），提了只会让人点一个必然失败的按钮。
  // 直接一句话说清"搜不了正文"，比让他自己撞一次 404 更好。
  var note;
  if (RO){
    note = '<div class="side-note">此分享页<b>只按文件名和目录名搜索</b>，不搜索文件内容。' +
      '<br><span style="color:#8c959f">语法：ext:后缀 · path:目录 · 空格=多个关键词（都要命中） · "整词匹配"' +
      (shown ? '　·　↑↓ 选择 · Enter 打开' : '') + '</span></div>';
  } else {
    note = '<div class="side-note">' +
      (d.indexed
        ? ('索引 ' + d.indexedCount + ' 个文件' +
           (srFilter ? '　已筛选：' + (srFilter === 'name' ? '文件名' : srFilter === 'path' ? '路径' : srFilter === 'text' ? '正文' : '文件夹') : ''))
        : '未建立正文索引，目前只匹配文件名') +
      (terms.length > 1 ? '<br><span style="color:#8c959f">按 <b>' + terms.length +
        '</b> 个关键词同时匹配（AND）：' + E(terms.join(' + ')) + '（底色按词区分）</span>' : '') +
      (d.stale ? '<br><span style="color:#b35900">另有 ' + d.stale + ' 个文件未进索引' +
        '（仍可按文件名搜到，但正文搜不到）；点下方按钮重建索引即可补上</span>' : '') +
      (d.capFull ? '<br><span style="color:#b35900">正文索引容量已满，之后的新文件只按文件名搜索' +
        '（单文件正文片段已自动缩短）；可在环境变量里调大 INDEX_TEXT_CAP 后重建索引</span>' : '') +
      '<br><span style="color:#8c959f">语法：ext:后缀 · path:目录 · 空格=多个关键词（都要命中） · "整词匹配"' +
      (shown ? '　·　↑↓ 选择 · Enter 打开' : '') + '</span></div>';
  }
  // 重建入口只对管理员有意义（reindex 需要管理端权限），访客点了必然 403
  var extra = RO ? '' : idxBtnHtml(d.indexed);

  if (!shown){
    box.innerHTML = head + chips + '<div class="side-hint">没有找到匹配的内容</div>' + note + extra;
    bindIdxBtn();
    return;
  }
  var h = head + chips + note;
  var i, it;

  // 「全部」视图下按类型分组；已经用芯片筛选过就平铺，不再重复分组。
  // 分组的**先后**不写死，而是按"该类型在结果里第一次出现的位置"排 ——
  // 服务端已按相关度排好（文件夹条目 > 文件名 > 路径 > 正文），
  // 分组只做归拢、不许把服务端排好的名次打乱（否则搜目录名时文件夹会被挤到末尾）。
  var group = (srFilter === '') && list.length > 1;
  if (group){
    var buckets = {}, order = [];
    for (i = 0; i < list.length; i++){
      var k = srKind(list[i]);
      if (!buckets[k]){ buckets[k] = []; order.push(k); }
      buckets[k].push(list[i]);
    }
    var label = {};
    for (var li = 0; li < SR_KINDS.length; li++) label[SR_KINDS[li].k] = SR_KINDS[li].t;
    var gi = 0;
    for (var oi = 0; oi < order.length; oi++){
      var bk = buckets[order[oi]];
      h += '<div class="sr-group">' + (label[order[oi]] || order[oi]) + ' <b>' + bk.length + '</b></div>';
      for (var bj = 0; bj < bk.length; bj++){ h += srRowHtml(bk[bj], terms, q, gi); gi++; }
    }
  } else {
    for (i = 0; i < list.length; i++) h += srRowHtml(list[i], terms, q, i);
  }

  h += '<div class="moreRow">' + (st.hasMore
    ? '<button id="srMore">加载更多（还有 ' + (st.total - shown) + ' 条）</button>'
    : '<span class="sr-end">已显示全部 ' + shown + ' 条</span>') + '</div>';
  box.innerHTML = h + extra;
  bindIdxBtn();
  var mb = document.getElementById('srMore');
  if (mb) mb.onclick = function(){
    mb.disabled = true;
    mb.textContent = '加载中…';
    runSearch(st.q, true);
  };
}

// 结果列表键盘导航：↑↓ 移动选中行（自动滚进视野），Enter 打开，Esc 取消选中。
function srRows(){
  var box = document.getElementById('sideScroll');
  if (!box || !searchState) return [];
  return box.querySelectorAll('.sfile[data-openpath]');
}
function srSelect(next){
  var rows = srRows();
  if (!rows.length) return false;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i === next);
  srSel = next;
  try { rows[next].scrollIntoView({ block: 'nearest' }); } catch (e) {}
  return true;
}
function srOpenSelected(){
  var rows = srRows();
  if (srSel < 0 || srSel >= rows.length) return false;
  rows[srSel].click();
  return true;
}
function srClearSel(){
  var rows = srRows();
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('sel');
  srSel = -1;
}

// 深搜：索引只留了前 8K，对"可能截断"的文件读全文精确验证。
// 结果是**行号列表弹窗** —— 点击任意一行直接打开文件并跳到那一行；
// 超大文件（>512KB）服务端不给行号（省 CPU），只显示命中总数。
var pendingGoLine = null;   // 点击深搜结果后记录待跳行号，openEditor 载入完成后消费
function deepSearch(path, q, word){
  toast('正在读取全文…');
  req(BASE + '/api?action=deepsearch&path=' + encodeURIComponent(path) + '&q=' + encodeURIComponent(q) + (word ? '&word=1' : ''))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      if (!d.found){ toast('读完全文也没有找到（编码 ' + (d.enc || '未知') + '）'); return; }
      var terms = (d.terms && d.terms.length) ? d.terms : [q];
      var list = d.hits || [];
      var rows = list.map(function(h){
        return '<div class="dlrow" data-dl="' + E(path) + '" data-line="' + h.n + '" title="点击打开文件并跳到这一行">' +
          '<span class="dln">第 ' + h.n + ' 行</span>' +
          '<span class="dlt">' + hlText(h.t, terms) + '</span>' +
          (h.c > 1 ? '<span class="dlc">' + h.c + ' 处</span>' : '') +
          '</div>';
      }).join('');
      var extra = d.hits
        ? (d.hitsMore ? '<div class="hint dim">命中行较多，仅列出前 ' + list.length + ' 行</div>' : '')
        : '<div class="hint dim">文件较大，未列出具体行号（仅统计首个关键词的出现次数）</div>';
      showModal({
        title: '深搜「' + (path.split('/').pop()) + '」：' + (d.hits
          ? '共 ' + d.count + ' 处命中（' + (d.lines || list.length) + ' 行）' +
            (list.length ? '，下列前 ' + list.length + ' 行' : '')
          : '共 ' + d.count + ' 处命中（近似）'),
        small: true, noOk: true, cancelText: '关闭',
        body: '<div class="dllist">' + rows + '</div>' + extra +
          '<div class="hint dim" style="margin-top:8px">' +
          (terms.length > 1 ? '只列出同时含全部 ' + terms.length + ' 个关键词的行；' : '') +
          '片段以命中位置为中心截取，关键词已高亮；点击任意一行，直接打开文件并跳到该位置</div>'
      });
    }).catch(function(e){ toast('深搜失败：' + e.message); });
}

function bindIdxBtn(){
  var b = document.getElementById('idxBuild');
  if (b) b.onclick = reindexAll;
}

// 分批建索引：免费版每次请求只有 10ms CPU，一次解码几百个文件必然超限，
// 所以前端循环调用、直到服务端回 done。
// **不传 limit** —— 批大小由服务端按索引体积自适应决定（索引越大批越小，避开 1102）。
// 这里只保留一个兜底上限，防止服务端异常时前端无限循环。
function reindexAll(){
  var b = document.getElementById('idxBuild');
  if (b){ b.disabled = true; b.textContent = '正在建立索引…'; }
  var lastKey = '', round = 0;
  var step = function(){
    round++;
    return post({ action: 'reindex', lastKey: lastKey }).then(function(d){
      if (!d.ok) throw new Error(d.error || '建立索引失败');
      if (d.lastKey) lastKey = d.lastKey;
      if (b) b.textContent = '正在建立索引… 已处理 ' + d.files + ' 个文件';
      if (!d.done && round < 300) return step();
      return d;
    });
  };
  step().then(function(d){
    if (b){ b.disabled = false; b.textContent = '正文索引已就绪（' + d.files + ' 个文件）'; }
    toast('索引已建立：' + d.files + ' 个文件，正文合计 ' + fmtSize(d.textBytes));
    clearSearchCache();               // 索引变了，旧结果（尤其"未进索引"提示）已过时
    if (state.q) runSearch(state.q);
  }).catch(function(e){
    if (b){ b.disabled = false; b.textContent = '建立索引失败，点此重试'; }
    toast('建立索引失败：' + e.message);
  });
}

// ===== 目录导航与历史记录 =====
// 目录跳转要进历史栈，这样手机/浏览器的返回键才是"回上一级目录"，
// 而不是直接退出整个网站。
// 之前用的是 replaceState，历史里永远只有一条 —— 用户一按返回就直接离开，
// 想回上一级只能去开左侧抽屉，非常别扭。
function navUrl(path){
  return BASE + (path ? '?path=' + encodeURIComponent(path) : '');
}

// push=true 时新增一条历史；首次加载（history.state 还是 null）只能用 replace ——
// 本次页面导航本身已经产生了一条记录，再 push 会出现两条 URL 完全相同的记录，
// 用户按返回看着像"没反应"。
function setUrl(path, push){
  try {
    var st = { p: path || '' };
    if (push && history.state != null) history.pushState(st, '', navUrl(path));
    else history.replaceState(st, '', navUrl(path));
  } catch (e) {}
}

// 返回键 / 前进键：回到历史里那一级目录，而不是离开整个网站
window.addEventListener('popstate', function(ev){
  var st = ev.state || {};
  var p = (typeof st.p === 'string') ? st.p : '';
  if (typeof st.p !== 'string'){
    // 少数情况（比如用户手动改了地址栏）拿不到 state，退回解析 query
    try { p = new URLSearchParams(location.search).get('path') || ''; } catch (e) { p = ''; }
  }
  load(p, true);                  // true = 不要再往历史里塞一条
});

// ===== 编辑器顶部的路径条 =====
// 手机上左侧抽屉是收起来的，在编辑器里"不知道自己在这个文件的哪一级、想换目录得先去开抽屉"
// 很别扭。这里把当前文件的完整路径铺出来，**每一级目录都可点** ——
// 点一下直接跳到那一级的列表（切视图由 load 负责）。
// 复用列表页面包屑的 data-nav 属性，所以点击逻辑走同一套事件委托，不用另写分支。
function renderEdCrumb(pathOverride){
  var box = document.getElementById('edCrumb');
  if (!box) return;
  var p = pathOverride || ed.path || '';
  if (!p){ box.innerHTML = ''; return; }
  var parts = p.split('/');
  var file = parts.pop();
  var rootLabel = RO ? (SHARE_NAME || '分享内容') : '根目录';
  var h = '<a href="#" data-nav="">' + E(rootLabel) + '</a>';
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    h += '<span class="sep">/</span><a href="#" data-nav="' + E(acc) + '">' + E(parts[i]) + '</a>';
  }
  h += '<span class="sep">/</span><span class="curfile" title="' + E(file) + '">' + E(file) + '</span>' +
       shBadge(p, false);
  box.innerHTML = h;
}

// ===== 列表视图 =====
// 大目录分页：一次最多取 PAGE_SIZE 项，剩下的给一个「加载更多」按钮，
// 避免上千个文件一次性灌进 DOM 造成首屏卡顿。
var PAGE_SIZE = 300;

function load(path, noHist){
  if (state.multi) exitMulti();       // 换目录就退出多选，免得"选中的还是上个目录里的东西"
  state.path = path || '';
  state.sel = {};
  state.lastPick = null;
  state.more = '';
  if (state.view === 'edit') switchView('list');
  markOpen(state.path);                       // 展开到当前目录，树里能直接看到它在哪
  var sp = {
    path: state.path, pageSize: PAGE_SIZE,
    sort: state.sort.by, desc: state.sort.desc ? 1 : 0
  };
  return Promise.all([ api('list', sp), loadTree() ]).then(function(res){
    var d = res[0];
    state.folders = d.folders || [];
    state.files = d.files || [];
    state.more = d.cursor || '';
    state.total = d.total || 0;
    renderList();
    renderSide();
    lpTipOnce();
    setUrl(state.path, !noHist);
    revealInTree(state.path);
  }).catch(function(e){
    document.getElementById('list').innerHTML = '<div class="empty">读取失败：' + E(e.message) + '</div>';
  });
}

function loadMore(){
  if (!state.more) return;
  var cursor = state.more;
  state.more = '';                       // 先清掉，防连点重复请求
  api('list', {
    path: state.path, pageSize: PAGE_SIZE, cursor: cursor,
    sort: state.sort.by, desc: state.sort.desc ? 1 : 0
  }).then(function(d){
    state.folders = state.folders.concat(d.folders || []);
    state.files = state.files.concat(d.files || []);
    state.more = d.cursor || '';
    renderList();
  }).catch(function(e){
    toast('加载更多失败：' + e.message);
    state.more = cursor;
  });
}

function renderAcct(){
  var acct = document.getElementById('acct');
  if (!acct) return;
  // 刷新：放在「退出」左侧，两页都给 —— 只读分享页没有退出，但同样需要"拉最新的内容"
  var h = '<button class="btn ghost sm" id="btnReload" title="刷新页面">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
    '刷新</button>';
  if (!RO && HAS_PW){
    h += '<button class="btn ghost sm" id="btnLogout" title="退出登录">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>' +
      '退出</button>';
  }
  acct.innerHTML = h;
  document.getElementById('btnReload').onclick = function(){ location.reload(); };
  if (!RO && HAS_PW) document.getElementById('btnLogout').onclick = doLogout;
}

function renderList(){
  var parts = state.path ? state.path.split('/') : [];
  var rootLabel = RO ? (SHARE_NAME || '分享内容') : '根目录';
  var cr = '<a href="#" data-nav="">' + E(rootLabel) + '</a>';
  var acc = '';
  for (var i = 0; i < parts.length; i++){
    acc = acc ? acc + '/' + parts[i] : parts[i];
    cr += '<span class="sep">/</span><a href="#" data-nav="' + E(acc) + '">' + E(parts[i]) + '</a>';
  }
  document.getElementById('crumb').innerHTML = cr;

  var bar = '';
  if (!RO){
    bar = '<button class="btn" id="btnUp">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>上传文件</button>' +
      '<button class="btn" id="btnUpDir">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14l3-3 3 3"/></svg>上传文件夹</button>' +
      '<button class="btn" id="btnNewTxt">新建文本</button>' +
      '<button class="btn" id="btnNewDir">新建文件夹</button>' +
      '<button class="btn" id="btnCollect">采集网页</button>' +
      '<button class="btn" id="btnShareDir">分享本目录</button>' +
      '<button class="btn" id="btnShareMgr">分享管理</button>';
  } else {
    bar = '<span class="tip" style="margin:0">' + state.folders.length + ' 个文件夹 · ' +
      state.files.length + ' 个文件</span>';
  }
  bar += sortBarHtml();
  document.getElementById('listBar').innerHTML = bar;
  renderAcct();

  var rows = '';
  for (var f = 0; f < state.folders.length; f++){
    var nm = state.folders[f];
    rows += '<tr>' +
      '<td><div class="nm">' + ckHtml(nm, true) + '<span class="ico dir">' + dirIcon(joinPath(state.path, nm), false) + '</span>' +
      '<a class="link" href="#" data-open="' + E(nm) + '" data-type="dir">' + E(nm) + '</a>' +
      shBadge(joinPath(state.path, nm), true) + '</div></td>' +
      '<td class="hide-s" style="color:#8c959f">文件夹</td>' +
      '<td class="hide-s"></td><td class="hide-s"></td>' +
      '<td><button class="tact" data-tact="1" data-p="' + E(joinPath(state.path, nm)) + '" data-dir="1" title="操作：打开 / 下载 / 分享 / 重命名 / 移动 / 删除">' + ICON_MORE + '</button></td></tr>';
  }
  for (var k = 0; k < state.files.length; k++){
    var it = state.files[k];
    rows += '<tr>' +
      '<td><div class="nm">' + ckHtml(it.name, false) + '<span class="ico f">' + ICON_FILE + '</span>' +
      '<a class="link" href="#" data-open="' + E(it.name) + '" data-type="file">' + E(it.name) + '</a>' +
      extBadge(it.name, it.ct) +
      shBadge(joinPath(state.path, it.name), false) + '</div></td>' +
      '<td class="hide-s" style="color:#6e7781">' + E(typeLabel(it.name, it.ct)) + '</td>' +
      '<td class="hide-s">' + fmtSize(it.size) + '</td>' +
      '<td class="hide-s">' + fmtTime(it.mtime) + '</td>' +
      '<td><button class="tact" data-tact="1" data-p="' + E(joinPath(state.path, it.name)) + '" data-dir="0" title="操作：打开 / 预览 / 下载 / 分享 / 重命名 / 移动 / 删除">' + ICON_MORE + '</button></td></tr>';
  }
  var COLS = 5;
  if (state.more){
    rows += '<tr><td colspan="' + COLS + '"><div class="moreRow"><button id="moreBtn">加载更多（这个目录还有未显示的内容）</button></div></td></tr>';
  }
  if (!rows){
    rows = '<tr><td colspan="' + COLS + '" class="empty">这里还是空的 — ' + (RO ? '' : '点右上角「上传文件」或「新建文本」开始吧') + '</td></tr>';
  }

  document.getElementById('list').innerHTML =
    '<table><thead><tr>' +
      sortTh('name', '名称') +
      sortTh('type', '类型', 'width:104px') +
      sortTh('size', '大小', 'width:110px') +
      sortTh('time', '修改时间', 'width:152px') +
      '<th style="width:1%;white-space:nowrap;text-align:right">操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';

  var tip = document.getElementById('tip');
  tip.textContent = RO ? '' : ('共 ' + state.folders.length + ' 个文件夹 / ' + state.files.length + ' 个文件' +
    (state.more ? '（已显示部分）' : '') + ' · 在列表空白处按住拖动可框选，Shift+点击可连选');

  var mbtn = document.getElementById('moreBtn');
  if (mbtn) mbtn.onclick = loadMore;
  bindSortBar();

  if (!RO){
    document.getElementById('btnUp').onclick = function(){ document.getElementById('fileInput').click(); };
    document.getElementById('btnUpDir').onclick = function(){ document.getElementById('dirInput').click(); };
    document.getElementById('btnNewTxt').onclick = newText;
    document.getElementById('btnNewDir').onclick = newDir;
    document.getElementById('btnCollect').onclick = openCollect;
    document.getElementById('btnShareDir').onclick = function(){ openShareModal(state.path, true); };
    document.getElementById('btnShareMgr').onclick = openShareManager;
    syncShareMgr();
  }
  syncSelection();
}

function dlUrl(name, path){
  return BASE + '/api?action=download&path=' + encodeURIComponent(path || joinPath(state.path, name));
}

// ===== ZIP 打包（手写，不引第三方库）=====
// 为什么自己写：整个 Worker 是单文件内联的，塞一个 zip 库会明显增大体积，
// 而"不压缩（store 模式）"的 ZIP 只需要 CRC32 + 四个固定头，几百行就够。
// 为什么在浏览器端打包：Worker 只有 10ms CPU / 128MB 内存，
// 而浏览器有整台机器的内存和网络 —— 后端只给清单（packList），内容逐个取回。
var CRC_TBL = (function(){
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++){
    var c = i;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf, seed){
  var c = seed === undefined ? 0xFFFFFFFF : seed;
  for (var i = 0; i < buf.length; i++) c = CRC_TBL[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// DOS 时间/日期：固定值即可（ZIP 不要求真实时间，浏览器解压后不影响使用）
var DOS_TIME = 0, DOS_DATE = 0x21;

// 组一个 store 模式的 ZIP。items: [{ name, data }]，
// data 为 null 的条目当作**目录**（名字以 / 结尾、内容为空）——
// ZIP 用这种方式记录空目录，解压器才会把这一层建出来。
function buildZip(items){
  var enc = new TextEncoder();
  var parts = [], central = [], offset = 0;
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    var isDir = it.data == null;
    var name = isDir && it.name.charAt(it.name.length - 1) !== '/' ? it.name + '/' : it.name;
    var nameB = enc.encode(name);
    var data = isDir ? new Uint8Array(0) : it.data;
    var crc = crc32(data);
    // 本地文件头
    var lfh = new Uint8Array(30 + nameB.length);
    var dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);          // 标志位第 11 位 = 文件名是 UTF-8（中文不乱码的关键）
    dv.setUint16(8, 0, true);               // 方法 0 = 不压缩
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    lfh.set(nameB, 30);
    parts.push(lfh, data);
    // 中央目录项
    var cdh = new Uint8Array(46 + nameB.length);
    var cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(38, isDir ? 0x10 : 0, true);         // 外部属性：目录位（MS-DOS 目录标志）
    cv.setUint32(42, offset, true);
    cdh.set(nameB, 46);
    central.push(cdh);
    offset += lfh.length + data.length;
  }
  var cdSize = 0;
  for (var j = 0; j < central.length; j++) cdSize += central[j].length;
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
}

// 触发浏览器保存
function saveBlob(blob, filename){
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){
    URL.revokeObjectURL(a.href);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 4000);
}
// zip 里的条目名：正斜杠、去掉开头的斜杠、**清掉 .. 与 . 这些路径穿越片段**。
// 【坑】整段代码在 appHtml 的模板字符串里，反斜杠字面量会被模板引擎当成转义序列吃掉，
// 写进正则就成了非法表达式。所以一个反斜杠字面量都不写：反斜杠用字符码取。
var ZIP_BS = String.fromCharCode(92);
function zipEntryName(p){
  var raw = String(p).split(ZIP_BS).join('/').split('/');
  var out = [];
  for (var i = 0; i < raw.length; i++){
    var seg = raw[i];
    if (!seg || seg === '.') continue;          // 空段与当前目录：跳过
    if (seg === '..'){ out.pop(); continue; }   // 上跳一段（弹掉已收集的）
    out.push(seg);
  }
  return out.join('/');
}

// 取一个文件的原始字节（复用现成的下载接口）
// attempts > 1 时对 429 退避重试：打包动辄几百个请求，很容易撞上每分钟限速，
// 不重试的话后面的文件会**静默全部失败**（用户只看到 zip 里少了一堆文件）。
function fetchFileBytes(path, attempts){
  var tries = attempts || 1;
  var run = function(left){
    return fetch(BASE + '/api?action=download&path=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function(r){
        if (r.status === 401){ location.reload(); throw new Error('登录已过期'); }
        if (r.status === 429 && left > 0){
          var ra = parseInt(r.headers.get('Retry-After'), 10) || 0;
          var wait = ra > 0 ? Math.min(ra * 1000, 8000) : Math.min(1000 * Math.pow(2, tries - left), 8000);
          return new Promise(function(res){ setTimeout(res, wait); }).then(function(){ return run(left - 1); });
        }
        if (!r.ok) return r.text().then(function(t){ throw new Error(t || ('HTTP ' + r.status)); });
        return r.arrayBuffer();
      })
      .then(function(b){ return new Uint8Array(b); });
  };
  return run(tries - 1);
}

// ===== 打包下载：把若干文件/文件夹打成一个 zip =====
// progressEl 用来实时显示进度（可省略）
function packDownload(paths, zipName, progressEl){
  return Promise.all(paths.map(function(p){ return api('packList', { path: p }); }))
    .then(function(lists){
      // 汇总要打的文件清单。
      // zip 里的**条目名**（entry）决定了解压后的目录结构，这里有三条规则：
      //   1) 打包单个文件夹时去掉它的顶层目录名 —— 打 a/ 就得到 a/same.txt，
      //      这样同时打 a/ 和 b/ 也不会出现两个 same.txt 互相覆盖；
      //   2) 打包单个**文件**时只取文件名，不带任何目录；
      //   3) 多选且不是"仅一个文件夹"时，全部条目都带顶层目录名，同样避免同名覆盖。
      var files = [], seen = {}, dirEntries = [];
      var dirsCut = false;                                 // 目录条目是否因为总量上限被截断
      var multi = paths.length > 1;
      var onlyOneDir = paths.length === 1 && !lists[0].isFile;
      for (var i = 0; i < lists.length; i++){
        var L = lists[i];
        if (!L.ok) throw new Error(L.error || ('读取 ' + paths[i] + ' 失败'));
        // 真空目录（连一个子目录、一个文件都没有）：用户明确要下载它，
        // 所以把**这个目录自己**作为一个条目放进 zip —— 否则 zip 是空的，
        // 用户拿到的压缩包连解压都解压不出东西，等于什么都没下到。
        if (!L.isFile && !L.files.length && !(L.dirs && L.dirs.length)){
          var self = zipEntryName(L.dir ? (L.dir.split('/').pop() || L.dir) : '根目录');
          if (self && !seen[self]){ seen[self] = 1; dirEntries.push(self); }
        }
        // 空目录也要打进 zip（以 / 结尾的条目），否则解压后少了这些层
        // 目录条目也要有**总量**上限：ZIP 的中央目录用 16 位存条目数，超过 65535 个
        // 整个压缩包会损坏（实测每个目录条目约 96 字节、约 200 字节内存）。
        // 单个 packList 的 dirs 有 300 上限，但多选时是各列表相加 —— 这里统一封顶。
        if (L.dirs && L.dirs.length && !L.isFile){
          for (var q = 0; q < L.dirs.length; q++){
            if (dirEntries.length >= ZIP_MAX_DIRS){ dirsCut = true; break; }
            var base2 = L.dir ? L.dir + '/' : '';
            var drel = L.dirs[q].slice(base2.length) || L.dirs[q].split('/').pop();
            var dentry = zipEntryName((multi || !onlyOneDir) ? L.dirs[q] : drel);
            if (dentry && !seen[dentry]){ seen[dentry] = 1; dirEntries.push(dentry); }
          }
        }
        for (var j = 0; j < L.files.length; j++){
          var f = L.files[j];
          var entry;
          if (L.isFile){
            entry = f.p.split('/').pop();                 // 单个文件：只要文件名
          } else {
            var base = L.dir ? L.dir + '/' : '';
            var rel = f.p.slice(base.length) || f.p.split('/').pop();
            entry = (multi || !onlyOneDir) ? f.p : rel;  // 见上面三条规则
          }
          entry = zipEntryName(entry);
          if (!entry) continue;
          if (seen[entry]) continue;                     // 同名只留一份（多选重叠时会发生）
          seen[entry] = 1;
          files.push({ p: f.p, s: f.s, entry: entry });
        }
      }
      // 走到这里说明所有条目都被去重/清洗掉了（正常情况不会发生，因为真空目录会补上自己）。
// 措辞要说清是「打不出内容」而不是「无法下载」—— 空目录本来是允许下载的。
if (!files.length && !dirEntries.length) throw new Error('这个路径里没有可打包的内容');
      var truncated = lists.some(function(L){ return L.truncated; }) || dirsCut;

      if (progressEl) progressEl('开始下载 ' + files.length + ' 个文件…');
      // 并发逐个取内容（3 路：打包本身请求量大，再高容易撞限速）
      var items = new Array(files.length);
      var done = 0, failed = [], gotBytes = 0;
      var pool = 3, next = 0;
      var lane = function(){
        if (next >= files.length) return Promise.resolve();
        var i = next++;
        return fetchFileBytes(files[i].p, 5).then(function(d){
          items[i] = { name: files[i].entry, data: d };
          gotBytes += d.length;
        }).catch(function(e){
          failed.push(files[i].p + '（' + e.message + '）');
        }).then(function(){
          done++;
          if (progressEl) progressEl('已下载 ' + done + '/' + files.length + '（累计 ' + fmtSize(gotBytes) + '）');
          return lane();
        });
      };
      var lanes = [];
      for (var k = 0; k < pool; k++) lanes.push(lane());
      return Promise.all(lanes).then(function(){
        var okItems = items.filter(Boolean);
        // 全部文件都失败、但有空目录可打时仍然算成功（那个空目录本身就是用户要的）
        if (!okItems.length && !dirEntries.length) throw new Error('全部文件都下载失败' + (failed.length ? '：' + failed[0] : ''));
        if (progressEl) progressEl('正在生成 zip…');
        // 空目录条目放在文件前面（解压器按顺序建目录，先建好层再放文件更稳）
        var dirItems = dirEntries.map(function(d){ return { name: d, data: null }; });
        var blob = buildZip(dirItems.concat(okItems));
        saveBlob(blob, zipName);
        return { total: files.length, ok: okItems.length, dirs: dirEntries.length, failed: failed, truncated: truncated };
      });
    });
}

// ===== 网页采集（仅管理端）=====
// 两条路线，最后都汇进 collectRun()：
//   ① 服务端抓取：填网址 → Worker 把页面抓回来 → 前端解析资源清单 → 逐个抓回落盘
//   ② 采集书签：在目标页面点一下，把**渲染后的 DOM** 送进来
//      （SPA / 聊天记录 / 需登录的页面，服务端只能抓到空壳，必须靠这条）
// 结果存成 采集/<站点-时间>/index.html + assets/*，引用一律改写成相对路径 ——
// 渲染侧一行都不用改：真文档模式 + 资源通道天然就能服务它们。
// 脚本文件会照常采下来（存档完整），但在我们的预览里永远不执行（sandbox + CSP 挡着）。
var collectBusy = false;
var collectTook = false;

// 哪些标签的哪些属性算"要落地的资源"
var COLLECT_ATTRS = {
  img: ['src', 'data-src'], script: ['src'], link: ['href'],
  video: ['src', 'poster'], audio: ['src'], source: ['src'],
  embed: ['src'], object: ['data'], input: ['src'], track: ['src']
};

// 哪些扩展名算"值得跟着存档的附件"。必须与服务端的 SHARE_FILE_MIME **同一套口径** ——
// 抓下来却不在白名单里，分享页点开就是 404。
// 注意：**这里永远不能出现 html / xhtml / js** —— 抓页面等于在项目里塞一个爬虫（明确不做）。
var COLLECT_DOC_EXT = {
  pdf: 1, txt: 1, md: 1, csv: 1, tsv: 1, json: 1, log: 1, yaml: 1, yml: 1,
  doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, ods: 1, odp: 1, rtf: 1, epub: 1,
  zip: 1, rar: 1, '7z': 1, tar: 1, gz: 1, tgz: 1, bz2: 1, xz: 1, apk: 1
};
// 一次采集最多跟进多少个附件：论坛帖常年挂几十个附件，不设上限会变成意外的大流量。
// 超出的一律"只保留原链接"，并在日志和清单里如实说明。
var COLLECT_MAX_DOCS = 12;
// 采集选项（面板上的勾选框；书签路线走默认值）
var collectOpts = { docs: true };

function collectLog(msg, cls){
  var el = document.getElementById('colLog');
  if (!el) return;
  var d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function collectNonce(){
  var s = 'abcdefghijklmnopqrstuvwxyz0123456789', o = '';
  for (var i = 0; i < 12; i++) o += s.charAt(Math.floor(Math.random() * s.length));
  return o;
}

// 采集书签：在目标页面上执行，把渲染后的 DOM 送到**刚打开的**管理页窗口。
// 为什么不用跨域 POST：那会撞上 SameSite=Lax（跨站不带 Cookie）和我们自己的 CSRF 校验。
// 改成 window.open + postMessage：打开的是我们自己的页面，之后的请求全是同源、天然带会话。
function collectBookmarklet(nonce){
  var target = location.origin + BASE + '?collect=1&n=' + nonce;
  return 'javascript:(function(){' +
    'var t=' + JSON.stringify(target) + ',n=' + JSON.stringify(nonce) + ',o=' + JSON.stringify(location.origin) + ';' +
    'var w=window.open(t,"_blank");' +
    'if(!w){alert("请允许本站弹窗，然后再点一次书签");return}' +
    'var c=0,iv=setInterval(function(){' +
      'try{w.postMessage({cfwtxtCollect:1,n:n,u:location.href,t:document.title,h:document.documentElement.outerHTML},o)}catch(e){}' +
      'if(++c>25)clearInterval(iv)' +
    '},400)' +
  '})()';
}

function openCollect(){
  if (RO) return;
  var nonce = collectNonce();
  showModal({
    title: '采集网页',
    noOk: true, cancelText: '关闭',
    body: '<div class="hint">填网址直接采集；需要登录或内容由 JS 渲染的页面，用<b>采集书签</b>——' +
      '把它拖到浏览器书签栏，在目标页面点一下即可。结果存成 <code>采集/&lt;站点-时间&gt;/index.html</code>，' +
      '页面自己的 css / 图片 / <b>附件</b>会一并落地。</div>' +
      '<div class="shform"><input type="text" id="colUrl" placeholder="https://example.com/article" autocomplete="off" spellcheck="false">' +
      '<button class="btn primary" id="colGo">开始采集</button>' +
      '<a class="btn sm" id="colBm" href="" draggable="true" title="拖我到浏览器书签栏">采集书签</a></div>' +
      '<label class="colopt"><input type="checkbox" id="colDocs"' + (collectOpts.docs ? ' checked' : '') + '>' +
      '一并抓取页面里的附件链接（文档 / 压缩包，单次最多 ' + COLLECT_MAX_DOCS + ' 个；抓不到的原链接会保留并列进「附件清单.md」）</label>' +
      '<div id="colLog" class="collect-log">等待开始…</div>',
    after: function(){
      var bm = document.getElementById('colBm');
      if (bm) bm.href = collectBookmarklet(nonce);
      var input = document.getElementById('colUrl');
      var go = document.getElementById('colGo');
      var cb = document.getElementById('colDocs');
      if (cb) cb.onchange = function(){ collectOpts.docs = !!cb.checked; };
      if (go) go.onclick = function(){
        if (cb) collectOpts.docs = !!cb.checked;
        collectRun(input.value, '');
      };
      if (input) input.onkeydown = function(e){ if (e.key === 'Enter' && go) go.click(); };
    }
  });
}

// 采集页模式：书签脚本把 DOM postMessage 过来。
// 用一次性 nonce 认领 —— 别的页面猜到 nonce 才能往这里灌数据，而它只值"一次上传"。
var collectPageNonce = (function(){
  if (!/[?&]collect=1/.test(location.search)) return '';
  try { return new URLSearchParams(location.search).get('n') || ''; } catch (e) { return ''; }
})();
if (collectPageNonce){
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || d.cfwtxtCollect !== 1 || d.n !== collectPageNonce || collectTook) return;
    if (typeof d.h !== 'string' || !d.h) return;
    collectTook = true;
    if (document.getElementById('colLog')) collectLog('已收到页面数据，开始采集…', 'ok');
    collectRun(d.u || '', d.h);
  }, false);
}

function collectDirFor(finalUrl){
  var host = 'page';
  try { host = new URL(finalUrl).hostname.replace(/^www\./, '') || 'page'; } catch (e) {}
  host = host.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  var d = new Date(), p2 = function(n){ return (n < 10 ? '0' : '') + n; };
  return '采集/' + host + '-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
    '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

// URL 路径里最后一段的扩展名（小写，不含点）。手写扫描而不是正则 —— 本项目页面脚本
// 拼在模板字符串里，源码中的反斜杠会被吞掉（写成 . 就变成普通字符 .）。
function collectExtOfUrl(u){
  var p = '';
  try { p = new URL(u).pathname; } catch (e) { return ''; }
  var parts = String(p).split('/');
  var last = parts[parts.length - 1] || '';
  var dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  return last.slice(dot + 1).toLowerCase();
}

// 把"看起来像附件"的链接聚成一份清单 —— 目的是**抓不到的部分也要看得见**：
// 论坛附件经常要登录（Discourse 的 /uploads/ 匿名就是 403），静默丢掉才是最糟的结果。
function collectLinkManifest(sourceUrl, doc, docs, assetMap){
  var ok = [], bad = [];
  for (var i = 0; i < docs.length; i++){
    var d = docs[i];
    var local = assetMap[d.url];
    if (local) ok.push('- [' + d.label + '](' + local + ') ← ' + d.url);
    else bad.push('- [' + d.label + '](' + d.url + ') —— ' + (d.err || '未抓取') +
      (d.skipped ? '（超出单次上限 ' + COLLECT_MAX_DOCS + ' 个）' : ''));
  }
  var title = '';
  try { title = String(doc.title || '').trim().slice(0, 120); } catch (e) {}
  var L = ['# 附件清单', '',
    '- 来源：' + sourceUrl,
    '- 页面标题：' + (title || '（无）'),
    '- 记录时间：' + new Date().toLocaleString(),
    '- 结果：共 ' + docs.length + ' 个附件，已存档 ' + ok.length + ' 个，未存档 ' + bad.length + ' 个', ''];
  if (ok.length){
    L.push('## 已存档（点开就是本地文件，离线可用）', '');
    L = L.concat(ok);
    L.push('');
  }
  if (bad.length){
    L.push('## 未存档（页面里的原链接仍然保留，点开会回到原站）', '');
    L = L.concat(bad);
    L.push('', '> 常见原因：对方要求登录 / 链接带签名已过期 / 站点禁止外链（防盗链）。',
      '> 这些内容没法自动存下来，需要的话先手动下载，再拖进这个目录。');
  }
  // 注意：这段代码整体在模板字符串里，源码里写 
 会被当成真换行把字符串截断，
  // 所以一律写 \n（编译后才是换行符）。
  return L.join('\n') + '\n';
}

// 资源文件名：取 URL 末段并清洗，重名加序号。
// 扩展名尽量保留 —— 分享页的资源通道是**按扩展名**放行被动类型的。
function collectName(url, used){
  var last = '';
  try { last = new URL(url).pathname.split('/').pop() || ''; } catch (e) {}
  try { last = decodeURIComponent(last); } catch (e) {}
  last = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 60);
  if (!last) last = 'asset';
  var dot = last.lastIndexOf('.');
  var base = dot > 0 ? last.slice(0, dot) : last;
  var ext = dot > 0 ? last.slice(dot) : '';
  var name = last, n = 0;
  while (used[name]) { n++; name = base + '-' + n + ext; }
  used[name] = 1;
  return name;
}

// 扫 CSS 里的 url(...)：**故意不用正则** —— 本项目的页面脚本拼在模板字符串里，
// 源码中的反斜杠会被吞掉（写成 s 就变成普通字符 s），所以一律手写扫描。
function cssUrlHits(css){
  var out = [], i = 0, low = String(css).toLowerCase();
  while (true){
    var k = low.indexOf('url(', i);
    if (k < 0) break;
    var j = k + 4;
    while (j < css.length && css.charAt(j) === ' ') j++;
    var q = css.charAt(j);
    if (q === '"' || q === "'"){
      var e = css.indexOf(q, j + 1);
      if (e < 0) break;
      out.push({ s: j + 1, e: e, v: css.slice(j + 1, e) });
      i = e + 1;
    } else {
      var e2 = css.indexOf(')', j);
      if (e2 < 0) break;
      var raw = css.slice(j, e2), v = raw.trim();
      var s2 = j + (raw.length - raw.replace(/^ +/, '').length);
      out.push({ s: s2, e: s2 + v.length, v: v });
      i = e2 + 1;
    }
  }
  return out;
}
// 从后往前替换，下标才不会失效
function cssRewrite(css, mapFn){
  var hits = cssUrlHits(css);
  for (var i = hits.length - 1; i >= 0; i--){
    var h = hits[i], nv = mapFn(h.v);
    if (!nv || nv === h.v) continue;
    css = css.slice(0, h.s) + nv + css.slice(h.e);
  }
  return css;
}
function collectSrcsetUrls(v){
  var out = [], parts = String(v).split(',');
  for (var i = 0; i < parts.length; i++){
    var seg = parts[i].trim();
    if (!seg) continue;
    var sp = seg.indexOf(' ');
    out.push(sp < 0 ? seg : seg.slice(0, sp));
  }
  return out;
}

// 抓一个资源。CSS 要单独处理：它内部的 url() 也得跟着落地，所以按文本取回、
// 只把文本先存内存，等所有资源都落地、名字都定下来之后统一改写再上传。
async function collectOne(job, ctx, assetMap, used, queue, seen, failList){
  if (job.isCss){
    var r = null, err = '';
    try { r = await post({ action: 'collectText', url: job.url }); } catch (e) { err = e.message; }
    if (!r || !r.ok){
      job.err = err || (r && r.error) || '失败';
      failList.push(job.url + '（' + job.err + '）');
      return false;
    }
    job.text = r.text;
    job.base = r.finalUrl || job.url;
    var hits = cssUrlHits(r.text);
    for (var i = 0; i < hits.length; i++){
      var abs = '';
      try { abs = new URL(hits[i].v, job.base).toString(); } catch (e) { continue; }
      if (!/^https?:/i.test(abs) || seen[abs]) continue;
      seen[abs] = 1;
      queue.push({ url: abs, name: collectName(abs, used), isCss: /\.css($|[?#])/i.test(abs) });
    }
    job.ok = true;
    return true;
  }
  var r2 = null, err2 = '';
  // 资源统一落在 <采集目录>/<assetsSub>/ 下 —— 页面里改写成的相对路径正是 <assetsSub>/xxx，
  // 两边不一致的话分享页就会 404（这个坑踩过一次）。
  try { r2 = await post({ action: 'collectAsset', url: job.url, dir: ctx.assetsDir, name: job.name }); } catch (e) { err2 = e.message; }
  if (!r2 || !r2.ok){
    job.err = err2 || (r2 && r2.error) || '失败';
    failList.push(job.url + '（' + job.err + '）');
    return false;
  }
  assetMap[job.url] = ctx.assetsSub + '/' + String(r2.path || '').split('/').pop();
  job.ok = true;
  return true;
}

// 把文档里的引用换成相对路径（替换成功的才算落地；没抓到的保持原样，不做假）
function collectRewrite(doc, base, assetMap){
  var map = function(raw){
    if (!raw) return '';
    var abs = '';
    try { abs = new URL(String(raw).trim(), base).toString(); } catch (e) { return ''; }
    if (!/^https?:/i.test(abs)) return '';
    return assetMap[abs] || '';
  };
  var els = doc.querySelectorAll('img,script,link,video,audio,source,embed,object,input,track');
  for (var i = 0; i < els.length; i++){
    var el = els[i], tag = el.tagName.toLowerCase();
    if (tag === 'link'){
      var rel = (el.getAttribute('rel') || '').toLowerCase();
      if (!rel || !/stylesheet|icon|preload/.test(rel) || /alternate|canonical|manifest|preconnect|dns-prefetch/.test(rel)) continue;
    }
    var attrs = COLLECT_ATTRS[tag];
    if (!attrs) continue;
    for (var a = 0; a < attrs.length; a++){
      var v = el.getAttribute(attrs[a]);
      if (!v) continue;
      var nv = map(v);
      if (nv) el.setAttribute(attrs[a], nv);
    }
    var ss = el.getAttribute('srcset');
    if (ss){
      var parts = String(ss).split(','), arr = [];
      for (var p = 0; p < parts.length; p++){
        var seg = parts[p].trim();
        if (!seg) continue;
        var sp = seg.indexOf(' ');
        var uu = sp < 0 ? seg : seg.slice(0, sp);
        arr.push((map(uu) || uu) + (sp < 0 ? '' : seg.slice(sp)));
      }
      el.setAttribute('srcset', arr.join(', '));
    }
  }
  var sts = doc.querySelectorAll('style');
  for (var s = 0; s < sts.length; s++){
    sts[s].textContent = cssRewrite(sts[s].textContent || '', map);
  }
  var ws = doc.querySelectorAll('[style]');
  for (var w = 0; w < ws.length; w++){
    ws[w].setAttribute('style', cssRewrite(ws[w].getAttribute('style') || '', map));
  }
  // 附件链接：抓下来的改成本地相对路径（点开就是本地文件），**没抓到的保持原样** ——
  // 不做假、也不丢链接。抓不到的原因由 collectLinkManifest 如实写进清单。
  var anchors = doc.querySelectorAll('a[href]');
  for (var n = 0; n < anchors.length; n++){
    var to = map(anchors[n].getAttribute('href'));
    if (to) anchors[n].setAttribute('href', to);
  }
}

// 逐级建目录占位对象。采集只写文件是不够的：本项目的"目录"由零字节占位对象表示，
// 缺了它，目录树显示不出来、"分享本目录"会直接报"目标不存在"（踩过一次）。
async function collectEnsureDir(rel){
  var segs = String(rel || '').split('/').filter(Boolean), cur = '';
  for (var i = 0; i < segs.length; i++){
    var parent = cur;
    cur = cur ? cur + '/' + segs[i] : segs[i];
    try { await post({ action: 'mkdir', path: parent, name: segs[i] }); } catch (e) {}
    // 已存在时服务端返回 {ok:false,error:'同名文件夹已存在'}，忽略即可
  }
}

async function collectRun(sourceUrl, html, target){
  if (RO) return;
  if (collectBusy) { toast('已有采集任务在跑，等它结束'); return; }
  collectBusy = true;
  var srcLabel = (target && target.label) || sourceUrl;
  try {
    if (!document.getElementById('colLog')){
      showModal({ title: (target && target.title) || '采集网页', noOk: true, cancelText: '关闭', body: '<div id="colLog" class="collect-log"></div>' });
    }
    if (!html){
      var u = String(sourceUrl || '').trim();
      if (!/^https?:/i.test(u)) { collectLog('请填 http:// 或 https:// 开头的网址', 'bad'); return; }
      collectLog('正在抓取页面…');
      var pr = null, err = '';
      try { pr = await post({ action: 'collectPage', url: u }); } catch (e) { err = e.message; }
      if (err || !pr || !pr.ok){ collectLog('抓取失败：' + (err || (pr && pr.error) || '未知错误'), 'bad'); return; }
      html = pr.html;
      sourceUrl = pr.finalUrl || u;
      collectLog('页面已抓取：' + fmtSize(pr.size) + '（原编码 ' + pr.enc + '）', 'ok');
    } else {
      collectLog('收到页面数据：' + fmtSize(html.length));
    }

    // target 只在"给已有文件补抓附件"时给：直接写回原文件、附件放 <目录>/附件/。
    // 新采集则落到 采集/<站点-时间>/，资源放 assets/。
    var dir = (target && target.dir) || collectDirFor(sourceUrl);
    var outPath = (target && target.outPath) || (dir ? dir + '/index.html' : 'index.html');
    var assetsSub = (target && target.assetsSub) || 'assets';
    var assetsDir = dir ? dir + '/' + assetsSub : assetsSub;
    var ctx = { assetsDir: assetsDir, assetsSub: assetsSub };
    collectLog(target ? ('目标文件：' + outPath) : ('采集目录：' + dir + '/'));
    await collectEnsureDir(assetsDir);
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { collectLog('解析 HTML 失败：' + e.message, 'bad'); return; }

    // 基准地址：优先用页面自己的 <base href>，然后**把它删掉** ——
    // 我们渲染时会注入自己的 base，留着会打架。
    var base = sourceUrl;
    var bEl = doc.querySelector('base[href]');
    if (bEl){
      try { base = new URL(bEl.getAttribute('href'), sourceUrl).toString(); } catch (e) {}
      bEl.parentNode.removeChild(bEl);
    }

    var used = {}, assetMap = {}, queue = [], seen = {};
    var add = function(raw){
      if (!raw) return;
      var abs = '';
      try { abs = new URL(String(raw).trim(), base).toString(); } catch (e) { return; }
      if (!/^https?:/i.test(abs) || seen[abs]) return;
      seen[abs] = 1;
      queue.push({ url: abs, name: collectName(abs, used), isCss: /\.css($|[?#])/i.test(abs) });
    };
    var els = doc.querySelectorAll('img,script,link,video,audio,source,embed,object,input,track');
    for (var i = 0; i < els.length; i++){
      var el = els[i], tag = el.tagName.toLowerCase();
      if (tag === 'link'){
        var rel = (el.getAttribute('rel') || '').toLowerCase();
        if (!rel || !/stylesheet|icon|preload/.test(rel) || /alternate|canonical|manifest|preconnect|dns-prefetch/.test(rel)) continue;
      }
      var attrs = COLLECT_ATTRS[tag];
      if (attrs){
        for (var a = 0; a < attrs.length; a++) add(el.getAttribute(attrs[a]));
      }
      var ss = el.getAttribute('srcset');
      if (ss){ var su = collectSrcsetUrls(ss); for (var p = 0; p < su.length; p++) add(su[p]); }
    }
    var sts = doc.querySelectorAll('style');
    for (var s = 0; s < sts.length; s++){
      var hh = cssUrlHits(sts[s].textContent || '');
      for (var h = 0; h < hh.length; h++) add(hh[h].v);
    }
    var ws = doc.querySelectorAll('[style]');
    for (var w = 0; w < ws.length; w++){
      var h2 = cssUrlHits(ws[w].getAttribute('style') || '');
      for (var h3 = 0; h3 < h2.length; h3++) add(h2[h3].v);
    }
    collectLog('待采集资源：' + queue.length + ' 个');

    // 第二遍：扫 <a href>，把"附件"也当成资源抓下来。
    // 为什么值得做：论坛帖子的干货往往在附件里（下载链接），只存 HTML 等于只存了个目录页。
    // 判定偏保守，只看三件事：扩展名在 COLLECT_DOC_EXT 里 / 带 download 属性或 dl=1 / class 含 attachment。
    // **绝不抓 .html**：那会牵出一串页面级依赖，等于在项目里塞一个爬虫（整站抓取明确不做）。
    var allDocs = [], skipped = 0;
    if (collectOpts.docs){
      var as = doc.querySelectorAll('a[href]');
      for (var q = 0; q < as.length; q++){
        var a = as[q];
        var abs2 = '';
        try { abs2 = new URL(String(a.getAttribute('href') || '').trim(), base).toString(); } catch (e) { continue; }
        if (!/^https?:/i.test(abs2) || seen[abs2]) continue;
        var cls = String(a.getAttribute('class') || '').toLowerCase();
        var looksDoc = !!COLLECT_DOC_EXT[collectExtOfUrl(abs2)] ||
          a.hasAttribute('download') || cls.indexOf('attachment') >= 0 ||
          abs2.indexOf('dl=1') >= 0 || abs2.indexOf('download=1') >= 0;
        if (!looksDoc) continue;
        seen[abs2] = 1;
        var label = String(a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || abs2;
        label = label.replace(/[\[\]()]/g, ' ');
        var jb = { url: abs2, name: collectName(abs2, used), isDoc: true, label: label };
        if (allDocs.length >= COLLECT_MAX_DOCS){ jb.skipped = true; allDocs.push(jb); skipped++; continue; }
        allDocs.push(jb);
        queue.push(jb);
      }
      if (allDocs.length){
        collectLog('页面里的附件链接：' + allDocs.length + ' 个' +
          (skipped ? '（单次上限 ' + COLLECT_MAX_DOCS + ' 个，超出 ' + skipped + ' 个只保留原链接）' : ''));
      }
    }

    var idx = 0, okN = 0, failList = [];
    var lane = function(){
      if (idx >= queue.length) return Promise.resolve();
      var job = queue[idx++];
      var step = function(okFlag){
        if (okFlag) okN++;      // 失败清单由 collectOne 自己记（带原因），这里只点数
        return lane();
      };
      return collectOne(job, ctx, assetMap, used, queue, seen, failList).then(step, step);
    };
    var lanes = [];
    for (var L = 0; L < 3; L++) lanes.push(lane());
    await Promise.all(lanes);
    collectLog('资源落地完成：成功 ' + okN + ' 个' + (failList.length ? '，失败 ' + failList.length + ' 个' : ''), failList.length ? 'bad' : 'ok');
    if (allDocs.length){
      var docOk = 0, docBad = 0;
      for (var d3 = 0; d3 < allDocs.length; d3++){
        if (assetMap[allDocs[d3].url]) docOk++;
        else if (!allDocs[d3].skipped) docBad++;
      }
      collectLog('附件：已存档 ' + docOk + ' 个' +
        (docBad ? '，未存档 ' + docBad + ' 个（原链接保留在页面里，详情见清单）' : ''),
        docBad ? 'bad' : 'ok');
    }

    // CSS：等名字都定下来再改写 url()（两边同在一个目录下，所以只写文件名）
    for (var c = 0; c < queue.length; c++){
      var j = queue[c];
      if (!j.text) continue;
      var txt = cssRewrite(j.text, function(v){
        var abs = '';
        try { abs = new URL(v, j.base).toString(); } catch (e) { return ''; }
        var to = assetMap[abs];
        return to ? to.replace(ctx.assetsSub + '/', '') : '';
      });
      try {
        var putR = await req(BASE + '/api?path=' + encodeURIComponent(assetsDir + '/' + j.name) + '&idx=0', {
          method: 'PUT', headers: { 'Content-Type': 'text/css;charset=utf-8' }, body: txt
        });
        if (putR.ok) assetMap[j.url] = ctx.assetsSub + '/' + j.name;
        else { j.err = 'CSS 写入失败'; failList.push(j.url + '（CSS 写入失败）'); }
      } catch (e) { j.err = 'CSS 写入失败'; failList.push(j.url + '（CSS 写入失败）'); }
    }

    collectRewrite(doc, base, assetMap);
    var out = (/^\s*<!doctype/i.test(html) ? '<!doctype html>\n' : '') + doc.documentElement.outerHTML;
    var putH = await req(BASE + '/api?path=' + encodeURIComponent(outPath), {
      method: 'PUT', headers: { 'Content-Type': 'text/html;charset=utf-8' }, body: out
    });
    if (!putH.ok) { collectLog('保存 HTML 失败：HTTP ' + putH.status, 'bad'); return; }

    // 附件清单：抓到了什么、没抓到什么、为什么 —— 只在这页真的出现过附件时才写，
    // 免得每个采集目录都多一个空文件。
    if (allDocs.length){
      var mPath = (dir ? dir + '/' : '') + '附件清单.md';
      try {
        var putM = await req(BASE + '/api?path=' + encodeURIComponent(mPath), {
          method: 'PUT', headers: { 'Content-Type': 'text/markdown;charset=utf-8' },
          body: collectLinkManifest(srcLabel, doc, allDocs, assetMap)
        });
        if (putM.ok) collectLog('附件清单：' + mPath, 'ok');
      } catch (e) {}
    }

    if (failList.length){
      collectLog('失败清单（这些引用保持原样，不影响已落地的部分）：', 'bad');
      for (var f = 0; f < failList.length && f < 30; f++) collectLog('· ' + failList[f], 'bad');
      if (failList.length > 30) collectLog('…还有 ' + (failList.length - 30) + ' 条', 'bad');
    }
    collectLog('已保存：' + outPath, 'ok');
    if (!target) collectLog('要分享这一页：右键这个采集目录 →「分享本目录」——这样 css / 图片 / 附件会和页面一起发布', 'ok');
    invalidateTree();
    if (target && target.reopen){
      // 改写后的内容写回了原文件：让编辑器重新加载它（先失效缓存，否则会拿到旧的）
      try { fileCacheDel(outPath); } catch (e) {}
      state.path = dir;
      await load(dir);
      openEditor(outPath.split('/').pop());
      toast('已抓取附件：' + outPath);
      return;
    }
    state.path = dir;
    await load(dir);
    toast('采集完成：' + dir);
  } finally {
    collectBusy = false;
  }
}

// 给**已经存进来**的 HTML 补抓附件。存在的意义：用户以前用别的插件（SingleFile 之类）存了
// 一堆论坛存档，那些页面的附件链接当时没跟下来 —— 现在可以逐个补。
// 只写**草稿树**：要用户自己点「发布」才对外生效，所以天然可回退。
async function collectAttach(){
  if (RO || !ed.path) return;
  if (ed.dirty){ toast('先保存当前改动，再抓附件'); return; }
  var rel = ed.path;
  var cut = rel.lastIndexOf('/');
  var dir = cut >= 0 ? rel.slice(0, cut) : '';
  var fileUrl = BASE + '/f/' + encPath(rel);
  showModal({ title: '抓附件', noOk: true, cancelText: '关闭',
    body: '<div class="hint">把这个页面里"看起来像附件"的链接（文档 / 压缩包）抓下来，存到同目录的 ' +
      '<code>附件/</code> 下，并把链接改指向本地文件。抓不到的会保留原链接，并列进 <code>附件清单.md</code>。</div>' +
      '<div id="colLog" class="collect-log">正在读取文件…</div>' });
  var html = '';
  try {
    var r = await req(fileUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    html = await r.text();
  } catch (e) {
    collectLog('读取失败：' + e.message, 'bad');
    return;
  }
  collectLog('已读取：' + fmtSize(html.length));
  await collectRun(fileUrl, html, {
    title: '抓附件', label: rel, dir: dir, outPath: rel, assetsSub: '附件', reopen: true
  });
}

// ===== 多选（不重建表格，避免卡顿）=====
function selKey(name, isDir){ return (isDir ? 'd:' : 'f:') + name; }
function selCount(){ var n = 0; for (var k in state.sel) { if (state.sel[k]) n++; } return n; }
function selItems(){ var o = []; for (var k in state.sel) { if (state.sel[k]) o.push(state.sel[k]); } return o; }

function ckHtml(name, isDir){
  if (RO) return '';
  var key = selKey(name, isDir);
  return '<input type="checkbox" class="ck"' + (state.sel[key] ? ' checked' : '') +
    ' data-ck="' + E(key) + '" data-ckname="' + E(name) + '" data-ckdir="' + (isDir ? 1 : 0) + '">';
}

function paintSel(){
  var boxes = document.querySelectorAll('input.ck');
  for (var i = 0; i < boxes.length; i++){
    var on = !!state.sel[boxes[i].getAttribute('data-ck')];
    if (boxes[i].checked !== on) boxes[i].checked = on;
    var tr = boxes[i].closest('tr');
    if (tr) tr.classList[on ? 'add' : 'remove']('picked');
  }
}

function syncSelection(){
  var bar = document.getElementById('batch');
  if (!bar) return;                       // 只读分享页没有批量条
  var n = selCount();
  document.getElementById('batchInfo').textContent =
    state.multi ? ('多选模式 · 已选 ' + n + ' 项') : ('已选 ' + n + ' 项');
  // 「全选本页」按当前状态换文案，兼作"反选"的入口（先全选、再取消掉不要的几项）
  var ba = document.getElementById('batchAll');
  if (ba){
    var all = state.folders.length + state.files.length;
    ba.textContent = (all > 0 && n >= all) ? '取消全选' : '全选本页';
  }
  // 多选模式下这个按钮的语义是"退出多选"，写「完成」比「取消选择」更贴用户直觉
  var bc = document.getElementById('batchClear');
  if (bc) bc.textContent = state.multi ? '完成' : '取消选择';
  if ((n > 0 || state.multi) && !RO && state.view === 'list'){
    bar.classList.add('on');
    document.body.classList.add('has-batch');
  } else {
    bar.classList.remove('on');
    document.body.classList.remove('has-batch');
  }
}

function clearSel(){ state.sel = {}; paintSel(); syncSelection(); }
function selectAll(){
  for (var i = 0; i < state.folders.length; i++) state.sel[selKey(state.folders[i], true)] = { path: joinPath(state.path, state.folders[i]), isDir: true };
  for (var j = 0; j < state.files.length; j++) state.sel[selKey(state.files[j].name, false)] = { path: joinPath(state.path, state.files[j].name), isDir: false };
  paintSel(); syncSelection();
}

// ===== 多选模式 =====
// 桌面靠"框选 + Shift 连选"；触屏上手指拖拽天生就是滚页面（拖框根本不成立，
// 硬做会和滚动打架），所以移动端改用【长按任意一行 → 进入多选模式 → 之后点哪行就勾哪行】。
// 这比框选更贴合手指的操作习惯，也不用非得戳中那个小方框。
function enterMulti(){
  if (RO || state.multi) return;
  state.multi = true;
  document.body.classList.add('multi');
  syncSelection();
}
function exitMulti(){
  if (state.multi){
    state.multi = false;
    document.body.classList.remove('multi');
  }
  clearSel();
}
// 把某一行设成"选中 / 未选中"（不派发 change，避免与原生勾选双触发）
function rowPick(tr, on){
  if (!tr || !tr.querySelector) return false;
  var cb = tr.querySelector('input.ck');
  if (!cb) return false;
  var key = cb.getAttribute('data-ck');
  cb.checked = !!on;
  state.lastPick = key;
  if (on) {
    state.sel[key] = { path: joinPath(state.path, cb.getAttribute('data-ckname')),
                       isDir: cb.getAttribute('data-ckdir') === '1' };
  } else {
    delete state.sel[key];
  }
  tr.classList[on ? 'add' : 'remove']('picked');
  syncSelection();
  return true;
}
// 多选模式下"点整行"= 勾选 / 取消
function toggleRowPick(tr){
  if (!tr || !tr.querySelector) return false;
  var cb = tr.querySelector('input.ck');
  if (!cb) return false;
  var on = !state.sel[cb.getAttribute('data-ck')];
  rowPick(tr, on);
  // 取消掉最后一个选中项就自动退出多选模式 —— 省得用户再去点一次「完成」
  if (state.multi && !selCount()) exitMulti();
  return true;
}
// ===== 触屏长按 = 进入多选 =====
// 按住 380ms 不动即触发；中途划动超过 10px 视为"想滚动"，立刻取消。
var lp = null;
function lpEnd(){
  if (lp && lp.timer) clearTimeout(lp.timer);
  lp = null;
  window.removeEventListener('pointermove', lpMove);
  window.removeEventListener('pointerup', lpEnd);
  window.removeEventListener('pointercancel', lpEnd);
}
function lpMove(e){
  if (!lp) return;
  if (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10) lpEnd();
}
function lpStart(e){
  if (RO || state.view !== 'list') return;
  var t = e.target;
  if (!t || !t.closest) return;
  // 注意：这里**不能排除 a** —— 移动端一行里大部分面积就是文件名那个链接，
  // 排掉它等于"长按文件名没反应"。真正要排除的是按钮/输入框/操作区这些控件。
  if (t.closest('button,input,select,label,option,#list .ops')) return;
  var tr = t.closest('#list tbody tr');
  if (!tr || !tr.querySelector('input.ck')) return;
  lpEnd();
  lp = { x: e.clientX, y: e.clientY, tr: tr, timer: setTimeout(function(){
    var row = lp ? lp.tr : tr;
    lpEnd();
    // 手指抬起后浏览器还会补一次 click，就落在"被长按的这一行"上。
    // 不吞掉的话，这次 click 会被下面的"多选模式点行"接走，正好把刚选中的行又取消
    // —— 用户看到的现象是"长按了但没选上"。
    // 只吞"这一行"的、且只在很短的窗口内（真实补发是紧跟着 pointerup 的），
    // 否则会连用户随后点的「重命名」等按钮一起吃掉，变成"点了没反应"。
    var cb0 = row && row.querySelector ? row.querySelector('input.ck') : null;
    state.suppressRowKey = cb0 ? cb0.getAttribute('data-ck') : '';
    state.suppressClickUntil = Date.now() + 400;
    enterMulti();
    rowPick(row, true);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (x) {}
  }, 380) };
  window.addEventListener('pointermove', lpMove);
  window.addEventListener('pointerup', lpEnd);
  window.addEventListener('pointercancel', lpEnd);
}

// 触屏上"长按进多选"没有可见的按钮，第一次进列表时提示一次。
// 用一次性提示而不是常驻按钮：常驻按钮会和长按完全重复，
// 还会把每行操作区从 6 个挤到 7 个 —— 手机上本来就已经很挤了。
var lpTipShown = false;
var LP_TIP_KEY = 'cfwtxt_lptip';
function lpTipOnce(){
  if (lpTipShown) return;
  var coarse = false;
  try { coarse = !!(window.matchMedia && matchMedia('(hover:none) and (pointer:coarse)').matches); } catch (e) {}
  if (!coarse) return;                       // 桌面有框选和 Shift 连选，不用提示
  lpTipShown = true;
  var seen = false;
  try { seen = localStorage.getItem(LP_TIP_KEY) === '1'; } catch (e) {}
  if (seen) return;
  setTimeout(function(){
    toast('小提示：长按任意一行可进入多选模式');
    try { localStorage.setItem(LP_TIP_KEY, '1'); } catch (e) {}
  }, 1500);
}

// ===== 全局点击：全部走事件委托 =====
document.addEventListener('change', function(ev){
  var c = ev.target;
  if (!c || !c.getAttribute || !c.getAttribute('data-ck')) return;
  var key = c.getAttribute('data-ck');
  state.lastPick = key;                    // 供 Shift+点击做区间连选
  if (c.checked) {
    state.sel[key] = { path: joinPath(state.path, c.getAttribute('data-ckname')), isDir: c.getAttribute('data-ckdir') === '1' };
  } else {
    delete state.sel[key];
  }
  var tr = c.closest('tr');
  if (tr) tr.classList[c.checked ? 'add' : 'remove']('picked');
  syncSelection();
  // 多选模式下取消掉最后一个，就退出多选模式（和点整行取消的行为保持一致）
  if (state.multi && !selCount()) exitMulti();
});

document.addEventListener('click', function(ev){
  var t = ev.target;
  var pick = function(sel){ return t.closest ? t.closest(sel) : null; };

  // 表头点击排序（再点一次切换升降序）
  var sth = pick('#list thead th[data-sortby]');
  if (sth){ ev.preventDefault(); setSort(sth.getAttribute('data-sortby'), null); return; }

  // 长按刚触发那一瞬，手指抬起还会补一次 click（落在被长按的那一行上）。
  // 不吞掉的话，这次 click 会被下面的"多选模式点行"接走，
  // 正好把刚选中的行又取消 —— 用户看到的就是"长按了但没选上"。
  // 三个条件同时满足才吞：① 时间窗口内（真实补发紧跟 pointerup）
  // ② 落在被长按的同一行 ③ 没点在按钮上（否则用户随后点「重命名」也会被吃掉）
  if (state.suppressClickUntil){
    var supTr = pick('#list tbody tr');
    var supCb = (supTr && supTr.querySelector) ? supTr.querySelector('input.ck') : null;
    var sameRow = !!(supCb && supCb.getAttribute('data-ck') === state.suppressRowKey);
    var inWindow = Date.now() < state.suppressClickUntil;
    var onControl = !!pick('button,input,select,label,option');
    state.suppressClickUntil = 0;
    if (inWindow && sameRow && !onControl){
      state.suppressRowKey = '';
      ev.preventDefault();
      return;
    }
  }

  // 多选模式：点整行 = 勾选 / 取消（不再打开文件）
  // 点在复选框上的不接管 —— 那是原生勾选，交给 change 事件；
  // 点在行内任何按钮（如 ⋯ 操作菜单）上的也不接管，按钮该干自己的活。
  if (state.multi && !RO && state.view === 'list'){
    var mtr = pick('#list tbody tr');
    if (mtr && !pick('#list input.ck') && !pick('#list button')){
      ev.preventDefault();
      toggleRowPick(mtr);
      return;
    }
  }

  // Shift + 点击勾选框 = 从上次点到这次之间整段选中
  var ckb = pick('#list input.ck');
  if (ckb && ev.shiftKey && state.lastPick){
    ev.preventDefault();
    var shiftKey = ckb.getAttribute('data-ck');
    if (rangeSelect(shiftKey)){
      // 关键：勾选框的"激活"发生在 click 派发**之前**。我们 preventDefault 取消 click 后，
      // 浏览器会执行"取消后的激活行为"，把被点那一个恢复成点击前的值 ——
      // 正好把 rangeSelect 刚设好的勾选抹掉（现象：选中集有 N 项，但只有 N-1 个勾上）。
      // 所以等这一轮事件彻底走完，再按 state.sel 重刷一遍。
      setTimeout(function(){ paintSel(); syncSelection(); }, 0);
      return;
    }
  }

  // 侧栏"按内容自适应宽度"
  var fitw = pick('[data-fitw]');
  if (fitw){ ev.preventDefault(); toast('已按内容自适应到 ' + fitSideW() + 'px'); return; }

  var ci = pick('#ctx .ci');
  if (ci){
    ev.preventDefault();
    var cmd = ci.getAttribute('data-cmd');
    var cpath = ci.getAttribute('data-cp');
    var cdir = ci.getAttribute('data-cdir') === '1';
    closeCtx();
    runCtx(cmd, cpath, cdir);
    return;
  }

  var tac = pick('[data-tact]');
  if (tac){
    ev.preventDefault();
    if (ctxEl && ctxEl.__owner === tac){ closeCtx(); return; }
    openCtxAt(tac);
    return;
  }
  closeCtx();

  var all = pick('[data-treeall]');
  if (all){ treeAll(all.getAttribute('data-treeall') === '1'); return; }

  var car = pick('[data-tog]');
  if (car){ ev.preventDefault(); toggleNode(car.getAttribute('data-tog')); return; }

  var gt = pick('[data-goto]');
  if (gt){ ev.preventDefault(); load(gt.getAttribute('data-goto') || ''); document.body.classList.remove('side-open'); return; }

  // 行内按钮必须先于整行判定 —— 搜索结果行本身带 data-openpath，
  // 若先判整行，「⋯」永远会被"打开文件"抢走。
  var sac = pick('[data-sact]');
  if (sac){
    ev.preventDefault();
    if (ctxEl && ctxEl.__owner === sac){ closeCtx(); return; }
    openCtxAt(sac, true);
    return;
  }

  // 结果筛选芯片：只看文件名 / 路径 / 正文 / 文件夹
  var ftc = pick('[data-ftype]');
  if (ftc){ ev.preventDefault(); setSrFilter(ftc.getAttribute('data-ftype') || ''); return; }
  // 「返回搜索结果」条
  var srb = pick('[data-srback]');
  if (srb){ ev.preventDefault(); restoreSearch(); return; }
  var srbx = pick('[data-srbackx]');
  if (srbx){ ev.preventDefault(); dismissRestore(); return; }

  // 深搜结果弹窗里的某一行 → 打开文件并跳到那一行
  var dlr0 = pick('.dlrow');
  if (dlr0){
    ev.preventDefault();
    var dlp0 = dlr0.getAttribute('data-dl') || '';
    var dln0 = parseInt(dlr0.getAttribute('data-line'), 10) || 1;
    pendingGoLine = dln0;
    closeModal();
    var segs0 = dlp0.split('/');
    var nm0 = segs0.pop();
    var dd0 = segs0.join('/');
    if (RO) openViewer(dlp0);
    else if (state.path === dd0 && state.view === 'list') openFile(nm0);
    else load(dd0).then(function(){ openFile(nm0); });
    return;
  }

  var op = pick('[data-openpath]');
  if (op){
    ev.preventDefault();
    var p = op.getAttribute('data-openpath');
    // 搜索结果里的「文件夹」条目：点击直接进入该目录
    if (op.getAttribute('data-isdir') === '1'){
      load(p);
      document.body.classList.remove('side-open');
      return;
    }
    openPath(p);
    return;
  }

  var so = pick('[data-open]');
  if (so){
    ev.preventDefault();
    var nm = so.getAttribute('data-open');
    if (so.getAttribute('data-type') === 'dir') load(joinPath(state.path, nm));
    else openFile(nm);
    return;
  }

  var nav = pick('a[data-nav]');
  if (nav){ ev.preventDefault(); load(nav.getAttribute('data-nav')); return; }

  // ---- 渲染层与编辑器增强的委托入口 ----
  var em = pick('[data-emode]');
  if (em){ ev.preventDefault(); edSetPreview(em.getAttribute('data-emode') === 'prev'); return; }

  var vm = pick('[data-vmode]');
  if (vm){
    ev.preventDefault();
    var want = vm.getAttribute('data-vmode');
    if (want === 'rich') viewerRenderNow();     // 大文件按需渲染：点「渲染」才建 iframe
    viewerState.mode = want;
    applyViewerMode();
    return;
  }

  var ol = pick('[data-oline]');
  if (ol){ ev.preventDefault(); editorGoLine(parseInt(ol.getAttribute('data-oline'), 10) || 0); return; }

  var mg = pick('[data-mdgo]');
  if (mg){
    ev.preventDefault();
    var anchor = document.getElementById(mg.getAttribute('data-mdgo'));
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  var cth = pick('table.csv th[data-col]');
  if (cth){ ev.preventDefault(); csvSort(cth); return; }

  // JSON 折叠树的展开/收起
  var jtg = pick('.jtTog[data-jt]');
  if (jtg){
    ev.preventDefault();
    var kid = document.getElementById(jtg.getAttribute('data-jt'));
    if (kid){
      var hid = kid.classList.toggle('hide');
      jtg.textContent = hid ? '+' : '-';
    }
    return;
  }

  var mv = pick('[data-mvgo]');
  if (mv){ if (!mvState) return; mvState.dir = mv.getAttribute('data-mvgo'); renderMove(); return; }

  var bm = pick('[data-bmvgo]');
  if (bm){ bmvDir = bm.getAttribute('data-bmvgo'); renderBatchMove(); return; }

  var sbtn = pick('button[data-act]');
  if (sbtn){
    var act = sbtn.getAttribute('data-act');
    var name = sbtn.getAttribute('data-name');
    var isDir = sbtn.getAttribute('data-dir') === '1';
    if (act === 'download') {
      if (isDir) { toast('文件夹暂不支持打包下载'); return; }
      location.href = dlUrl(name);
    } else if (act === 'edit') { openFile(name); }
    else if (act === 'preview') { openMediaModal(joinPath(state.path, name), name); }
    else if (act === 'share') { openShareModal(joinPath(state.path, name), isDir); }
    else if (act === 'rename') { openRename(joinPath(state.path, name), isDir); }
    else if (act === 'move') { openMove(joinPath(state.path, name), isDir); }
    else if (act === 'del') { doDelete(joinPath(state.path, name), isDir); }
    return;
  }

  var sh = pick('button[data-shopen]');
  if (sh){ window.open(sh.getAttribute('data-shopen'), '_blank'); return; }
  var sl = pick('button[data-shlocate]');
  if (sl){
    locateShared(sl.getAttribute('data-shlocate'), sl.getAttribute('data-shlocdir') === '1');
    return;
  }
  var sc = pick('button[data-shcopy]');
  if (sc){ copyText(sc.getAttribute('data-shcopy')); return; }
  var sp = pick('button[data-shpub]');
  if (sp){ doPublish(sp.getAttribute('data-shpub'), sp.getAttribute('data-shdir') === '1'); return; }
  var su = pick('button[data-shunpub]');
  if (su){ doUnpublish(su.getAttribute('data-shunpub'), su.getAttribute('data-shdir') === '1'); return; }
  var spa = pick('button[data-shpuball]');
  if (spa){ doPublishAll(); return; }
  var sd = pick('button[data-shdel]');
  if (sd){
    var delToken = sd.getAttribute('data-shdel');
    post({ action: 'unshare', token: delToken }).then(function(d){
      if (!d.ok) throw new Error(d.error);
      // 同创建一样：KV 删除有延迟，乐观移除，界面上立刻消失
      shareCache.pending = shareCache.pending.filter(function(p){ return p.token !== delToken; });
      if (shareCache.removed.indexOf(delToken) < 0) shareCache.removed.push(delToken);
      shareCache.byPath = buildShareIndex(shareListMerged());
      applyShareUi();
      toast('已取消该分享链接');
      reloadShares();
    }).catch(function(e){ toast('取消失败：' + e.message); });
    return;
  }

  var gen = pick('button[data-shgen]');
  if (gen){
    var root = gen.closest('.share-root');
    doShare(root.getAttribute('data-target'), root.getAttribute('data-isdir') === '1', root);
    return;
  }
  var cp = pick('button[data-shresultcopy]');
  if (cp){ copyText(cp.getAttribute('data-shresultcopy')); return; }
  var lb = pick('input[data-linkbox]');
  if (lb){
    try { lb.focus(); lb.select(); lb.setSelectionRange(0, lb.value.length); } catch (e) {}
    copyText(lb.value);
    return;
  }
});

// ================= 统一渲染层 =================
// 把"打开文件后怎么显示"从"一律塞进 <pre>"改成"按类型分派到对应渲染器"。
// 两条硬约定：
//   1) 所有渲染器都先做 HTML 转义，只输出我们自己生成的标签 —— 没有原始 HTML 透传，杜绝 XSS；
//   2) 任何解析失败一律退回纯文本，所以最差情况就是原来的效果，不会出现"打不开的文件"。
var CH_BT = String.fromCharCode(96);        // 反引号（模板字符串里不能出现裸反引号，统一走常量）
var CH_BS = String.fromCharCode(92);        // 反斜杠（同理：源码里写 '\' 会被模板字符串吞成一个反斜杠，
                                            // 导致字符串字面量未闭合，所以一律用字符码比较）
// Markdown 允许用反斜杠转义的标点集合。用字符码建表，彻底绕开转义问题。
var MD_ESC = (function(){
  var s = '!"#$%&()*+,-./:;<=>?@[]^_{|}~' + CH_BT + CH_BS;
  var o = {};
  for (var i = 0; i < s.length; i++) o[s.charCodeAt(i)] = 1;
  return o;
})();

function extOf(name){
  var s = String(name || '');
  var i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
}
function isWs(c){ var k = c.charCodeAt(0); return k === 32 || k === 9 || k === 10 || k === 13; }
// 去左空白。故意用扫描而不是 /^s+/ —— 这段代码在模板字符串里，
// 正则的 s 会被模板字符串吃掉变成 s，那就成了"把开头的 s 删掉"，是个很隐蔽的 bug。
function ltrim(s){
  var i = 0;
  while (i < s.length && isWs(s.charAt(i))) i++;
  return i ? s.slice(i) : s;
}
function startsAt(s, i, t){
  if (i + t.length > s.length) return false;
  for (var k = 0; k < t.length; k++) if (s.charCodeAt(i + k) !== t.charCodeAt(k)) return false;
  return true;
}
function kwSet(str){ var o = {}, a = String(str).split(' '); for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1; return o; }

// ---- 类型分派表：扩展名 → 渲染器（Markdown 只是其中一格）----
var KIND_BY_EXT = {
  md: 'md', markdown: 'md', mdx: 'md', rst: 'md', adoc: 'md', asciidoc: 'md', org: 'md',
  json: 'json', json5: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
  csv: 'csv', tsv: 'csv', psv: 'csv',
  svg: 'svg', html: 'html', htm: 'html', xhtml: 'html',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp3: 'av', wav: 'av', ogg: 'av', m4a: 'av', flac: 'av', aac: 'av', mp4: 'av', webm: 'av', mov: 'av', m4v: 'av', mkv: 'av',
  pdf: 'pdf'
};
// 能直接看到的东西（不需要下载）—— 决定列表里给「预览」还是「下载」
var PREVIEW_KINDS = { image: 1, av: 1, pdf: 1, svg: 1, html: 1, md: 1, json: 1, csv: 1, code: 1, text: 1 };

function kindOf(name, ct){
  var ext = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (c.indexOf('image/') === 0) return 'image';
  if (c.indexOf('video/') === 0 || c.indexOf('audio/') === 0) return 'av';
  if (c === 'application/pdf') return 'pdf';
  if (c.indexOf('text/html') === 0) return 'html';
  if (c.indexOf('image/svg') === 0) return 'svg';
  if (c === 'application/json' || c.indexOf('+json') > 0) return 'json';
  if (HL_SPECS[hlLangOf(ext)]) return 'code';
  return 'text';
}

// ---- 语法高亮 ----
// 手写扫描器而不是正则：模板字符串会吃掉正则里的反斜杠，这是本项目最容易踩的坑，
// 干脆一个正则都不用，全走 charCodeAt / indexOf。
var HL_SPECS = {
  js:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('var let const function return if else for while do break continue new delete typeof instanceof in of class extends super this null undefined true false try catch finally throw switch case default import export from async await yield static get set void with debugger interface type enum implements public private protected readonly declare namespace module') },
  json:{ lc: [], bc: [], str: ['"'], kw: kwSet('true false null') },
  py:  { lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal del assert in is not and or None True False async await print self') },
  go:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('package import func var const type struct interface map chan go defer return if else for range break continue switch case default select nil true false make new len cap append copy delete panic recover string int int64 float64 bool byte rune error') },
  rs:  { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('fn let mut const struct enum impl trait pub use mod match if else for while loop break continue return self Self super where as dyn ref move async await unsafe static type crate box true false Some None Ok Err String Vec') },
  java:{ lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('public private protected class interface extends implements new return if else for while do break continue switch case default try catch finally throw throws static final void int long double float boolean char byte short String import package this super null true false abstract synchronized instanceof enum record var') },
  c:   { lc: ['//'], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('int long short char float double void struct union enum typedef static const unsigned signed return if else for while do break continue switch case default goto sizeof extern register volatile inline NULL true false class public private protected namespace template typename using new delete this nullptr auto') },
  css: { lc: [], bc: [['/*', '*/']], str: ['"', "'"], kw: kwSet('important media supports keyframes import charstate font-face from to unset inherit initial revert var calc rgb rgba hsl hsla linear-gradient') },
  sh:  { lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('if then else elif fi for while do done case esac function return export local readonly declare unset shift source alias set cd echo printf read exit test trap eval exec sudo') },
  sql: { lc: ['--'], bc: [['/*', '*/']], str: ["'", '"'], kw: kwSet('select from where insert update delete create drop alter table view index into values set join left right inner outer on group by having order limit offset union all distinct as and or not null is in like between count sum avg min max case when then else end primary key foreign references default unique constraint begin commit rollback'), ci: true },
  yaml:{ lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('true false null yes no on off') },
  toml:{ lc: ['#'], bc: [], str: ['"', "'"], kw: kwSet('true false') },
  ini: { lc: ['#', ';'], bc: [], str: ['"', "'"], kw: kwSet('true false') },
  md:  { lc: [], bc: [], str: ['"', "'", CH_BT], kw: kwSet('') },
  _:   { lc: ['//', '#'], bc: [['/*', '*/']], str: ['"', "'", CH_BT], kw: kwSet('true false null if else for while return function class new import export') }
};
var HL_ALIAS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  json: 'json', json5: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', ipynb: 'json',
  py: 'py', pyw: 'py', rb: 'py', pl: 'py', php: 'py', lua: 'py',
  go: 'go', mod: 'go',
  rs: 'rs',
  java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', gradle: 'java', cs: 'java', swift: 'java', dart: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', go_h: 'c',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ksh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh', psm1: 'sh', psd1: 'sh',
  sql: 'sql', graphql: 'sql', gql: 'sql', proto: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', config: 'ini', properties: 'ini', env: 'ini',
  dockerfile: 'sh', makefile: 'sh', cmake: 'sh', mk: 'sh', tf: 'sh', tfvars: 'sh', hcl: 'sh', nix: 'sh', service: 'ini', desktop: 'ini',
  md: 'md', markdown: 'md', mdx: 'md', txt: 'text'
};
function hlLangOf(ext){
  var l = HL_ALIAS[String(ext || '').toLowerCase()];
  return l === 'text' ? '' : (l || '');
}

function hlEscapeCh(c){ return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c; }

function hlCode(src, lang){
  var spec = HL_SPECS[lang] || HL_SPECS._;
  var out = [], i = 0, n = src.length;
  var lc = spec.lc || [], bc = spec.bc || [], sq = spec.str || [];
  while (i < n){
    var c = src.charAt(i);
    var hitLc = null;
    for (var a = 0; a < lc.length; a++) if (startsAt(src, i, lc[a])) { hitLc = lc[a]; break; }
    if (hitLc){
      var le = src.indexOf('\n', i);
      if (le < 0) le = n;
      out.push('<span class="tk-c">' + E(src.slice(i, le)) + '</span>');
      i = le; continue;
    }
    var hitBc = null;
    for (var b = 0; b < bc.length; b++) if (startsAt(src, i, bc[b][0])) { hitBc = bc[b]; break; }
    if (hitBc){
      var ce = src.indexOf(hitBc[1], i + hitBc[0].length);
      var bend = ce < 0 ? n : ce + hitBc[1].length;
      out.push('<span class="tk-c">' + E(src.slice(i, bend)) + '</span>');
      i = bend; continue;
    }
    if (sq.indexOf(c) >= 0){
      var q = c, j = i + 1;
      while (j < n){
        var cj = src.charAt(j);
        if (cj.charCodeAt(0) === 92) { j += 2; continue; }
        if (cj === q) { j++; break; }
        if (cj === '\n' && q !== CH_BT) break;
        j++;
      }
      if (j > n) j = n;
      out.push('<span class="tk-s">' + E(src.slice(i, j)) + '</span>');
      i = j; continue;
    }
    var k1 = c.charCodeAt(0);
    if (k1 >= 48 && k1 <= 57){
      var pk = src.charCodeAt(i - 1);
      var prevWord = (pk >= 48 && pk <= 57) || (pk >= 65 && pk <= 90) || (pk >= 97 && pk <= 122) || pk === 95 || pk === 36;
      if (!prevWord){
        var kk = i;
        while (kk < n){
          var ck = src.charAt(kk), nk = ck.charCodeAt(0);
          var isNum = (nk >= 48 && nk <= 57) || (nk >= 65 && nk <= 70) || (nk >= 97 && nk <= 102) ||
            ck === '.' || ck === '_' || ck === 'x' || ck === 'X' || ck === '+' || ck === '-';
          if (!isNum) break;
          kk++;
        }
        out.push('<span class="tk-n">' + E(src.slice(i, kk)) + '</span>');
        i = kk; continue;
      }
    }
    var isWordStart = (k1 >= 65 && k1 <= 90) || (k1 >= 97 && k1 <= 122) || k1 === 95 || k1 === 36;
    if (isWordStart){
      var m = i;
      while (m < n){
        var cm = src.charCodeAt(m);
        if ((cm >= 48 && cm <= 57) || (cm >= 65 && cm <= 90) || (cm >= 97 && cm <= 122) || cm === 95 || cm === 36) m++;
        else break;
      }
      var word = src.slice(i, m);
      var lw = spec.ci ? word.toLowerCase() : word;
      if (spec.kw && spec.kw[lw]) out.push('<span class="tk-k">' + E(word) + '</span>');
      else out.push(E(word));
      i = m; continue;
    }
    out.push(hlEscapeCh(c));
    i++;
  }
  return out.join('');
}

// HTML / XML 单独一套：标签名与属性名上色，属性值当字符串
function hlHtmlTag(tag){
  var out = '<span class="tk-p">&lt;</span>';
  var i = 1, n = tag.length;
  if (tag.charAt(1) === '/'){ out += '<span class="tk-p">/</span>'; i = 2; }
  var s0 = i;
  while (i < n && !isWs(tag.charAt(i)) && tag.charAt(i) !== '>' && tag.charAt(i) !== '/') i++;
  if (i > s0) out += '<span class="tk-k">' + E(tag.slice(s0, i)) + '</span>';
  while (i < n){
    var c = tag.charAt(i);
    if (c === '>'){ out += '<span class="tk-p">&gt;</span>'; i++; continue; }
    if (c === '/'){ out += '<span class="tk-p">/</span>'; i++; continue; }
    if (c === '='){ out += '<span class="tk-p">=</span>'; i++; continue; }
    if (isWs(c)){ out += c; i++; continue; }
    if (c === '"' || c === "'"){
      var q = c, j = i + 1;
      while (j < n && tag.charAt(j) !== q) j++;
      j = Math.min(n, j + 1);
      out += '<span class="tk-s">' + E(tag.slice(i, j)) + '</span>';
      i = j; continue;
    }
    var s1 = i;
    while (i < n && !isWs(tag.charAt(i)) && tag.charAt(i) !== '=' && tag.charAt(i) !== '>' && tag.charAt(i) !== '/') i++;
    if (i > s1) out += '<span class="tk-a">' + E(tag.slice(s1, i)) + '</span>';
    else { out += hlEscapeCh(c); i++; }
  }
  return out;
}
function hlHtml(src){
  var out = [], i = 0, n = src.length;
  while (i < n){
    if (startsAt(src, i, '<!--')){
      var e1 = src.indexOf('-->', i + 4);
      e1 = e1 < 0 ? n : e1 + 3;
      out.push('<span class="tk-c">' + E(src.slice(i, e1)) + '</span>');
      i = e1; continue;
    }
    if (src.charAt(i) === '<'){
      var gt = -1, q = '';
      for (var j = i + 1; j < n; j++){
        var cj = src.charAt(j);
        if (q){ if (cj === q) q = ''; continue; }
        if (cj === '"' || cj === "'"){ q = cj; continue; }
        if (cj === '>'){ gt = j; break; }
      }
      if (gt < 0){ out.push(E(src.slice(i))); break; }
      out.push(hlHtmlTag(src.slice(i, gt + 1)));
      i = gt + 1; continue;
    }
    out.push(hlEscapeCh(src.charAt(i)));
    i++;
  }
  return out.join('');
}

// 代码块统一出口：<pre><code> 包裹，带语言标记
function hlBlock(code, lang){
  var l = HL_ALIAS[String(lang || '').toLowerCase()];
  var body;
  if (l === 'html') body = hlHtml(code);
  else if (l && HL_SPECS[l]) body = hlCode(code, l);
  else body = E(code);
  return '<pre>' + (lang ? '<code data-lang="' + E(lang) + '">' : '<code>') + body + '</code></pre>';
}

// ---- Markdown ----
function safeUrl(u){
  var s = String(u == null ? '' : u).trim().replace(/^<|>$/g, '');
  if (!s) return '#';
  if (s.charAt(0) === '#') return s;
  if (s.charAt(0) === '/') return s;
  var lower = s.toLowerCase();
  if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0 || lower.indexOf('mailto:') === 0) return s;
  if (s.indexOf(':') >= 0) return '#';           // 挡掉 javascript: / data: 之类
  if (lower.indexOf('//') === 0) return '#';     // 协议相对 URL 也不放行
  return s;                                      // 相对路径
}

// 读 [text](url) —— i 指向 '['
function mdReadLink(s, i){
  if (s.charAt(i) !== '[') return null;
  var depth = 0, j = i;
  for (; j < s.length; j++){
    var c = s.charAt(j);
    if (c === '[') depth++;
    else if (c === ']'){ depth--; if (depth === 0) break; }
  }
  if (j >= s.length) return null;
  var text = s.slice(i + 1, j);
  if (s.charAt(j + 1) !== '(') return null;
  var d2 = 0, e = j + 1;
  for (; e < s.length; e++){
    var c2 = s.charAt(e);
    if (c2 === '(') d2++;
    else if (c2 === ')'){ d2--; if (d2 === 0) break; }
  }
  if (e >= s.length) return null;
  var url = s.slice(j + 2, e).trim();
  var sp = url.indexOf(' ');
  if (sp > 0) url = url.slice(0, sp);
  return { text: text, url: url, end: e + 1 };
}

function mdInline(raw){
  var out = '', i = 0, n = raw.length;
  while (i < n){
    var c = raw.charAt(i);
    if (c === CH_BS && i + 1 < n && MD_ESC[raw.charCodeAt(i + 1)]){
      out += E(raw.charAt(i + 1)); i += 2; continue;
    }
    if (c === CH_BT){
      var j = raw.indexOf(CH_BT, i + 1);
      if (j > i){ out += '<code>' + E(raw.slice(i + 1, j)) + '</code>'; i = j + 1; continue; }
    }
    if (c === '!' && raw.charAt(i + 1) === '['){
      var im = mdReadLink(raw, i + 1);
      if (im){ out += '<img src="' + E(safeUrl(im.url)) + '" alt="' + E(im.text) + '" loading="lazy">'; i = im.end; continue; }
    }
    if (c === '['){
      var lk = mdReadLink(raw, i);
      if (lk){ out += '<a href="' + E(safeUrl(lk.url)) + '" target="_blank" rel="noopener noreferrer">' + mdInline(lk.text) + '</a>'; i = lk.end; continue; }
    }
    if (c === '<'){
      var gt = raw.indexOf('>', i + 1);
      if (gt > i){
        var inner = raw.slice(i + 1, gt);
        if (inner.indexOf('http://') === 0 || inner.indexOf('https://') === 0){
          out += '<a href="' + E(safeUrl(inner)) + '" target="_blank" rel="noopener noreferrer">' + E(inner) + '</a>';
          i = gt + 1; continue;
        }
      }
      out += '&lt;'; i++; continue;
    }
    if (c === '*' || c === '_'){
      var dbl = raw.charAt(i + 1) === c;
      var tok = dbl ? c + c : c;
      var from = i + tok.length;
      var end = raw.indexOf(tok, from);
      if (end > from){
        out += (dbl ? '<strong>' : '<em>') + mdInline(raw.slice(from, end)) + (dbl ? '</strong>' : '</em>');
        i = end + tok.length; continue;
      }
    }
    if (c === '~' && raw.charAt(i + 1) === '~'){
      var e2 = raw.indexOf('~~', i + 2);
      if (e2 > i + 2){ out += '<del>' + mdInline(raw.slice(i + 2, e2)) + '</del>'; i = e2 + 2; continue; }
    }
    if (c === '&'){ out += '&amp;'; i++; continue; }
    if (c === '>'){ out += '&gt;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

// 表格分隔行：|---|---| 或 |:--:| 这种
function mdIsDelim(line){
  var s = line.trim();
  if (s.indexOf('-') < 0) return false;
  for (var i = 0; i < s.length; i++){
    var c = s.charAt(i);
    if (c !== '-' && c !== '|' && c !== ':' && c !== ' ') return false;
  }
  return true;
}
function mdCells(line){
  var s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function(x){ return x.trim(); });
}

function mdHtml(src){
  var lines = String(src == null ? '' : src).split('\n');
  for (var z = 0; z < lines.length; z++){
    if (lines[z].charAt(lines[z].length - 1) === '\r') lines[z] = lines[z].slice(0, -1);
  }
  var out = [], toc = [], usedIds = {};
  var i = 0, n = lines.length;

  function headingId(text, lv){
    var base = text.replace(/[^A-Za-z0-9_一-龥-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || ('h' + lv);
    var id = base, k = 1;
    while (usedIds[id]) { id = base + '-' + (k++); }
    usedIds[id] = 1;
    return id;
  }

  while (i < n){
    var line = lines[i];

    // 围栏代码块
    if (startsAt(ltrim(line), 0, CH_BT + CH_BT + CH_BT)){
      var indent = line.length - ltrim(line).length;
      var fenceChar = CH_BT;
      var rawHead = line.slice(indent);
      var k2 = 0;
      while (k2 < rawHead.length && rawHead.charAt(k2) === fenceChar) k2++;
      var info = rawHead.slice(k2).trim().split(' ')[0];
      var buf = [], closed = false;
      i++;
      while (i < n){
        var t2 = ltrim(lines[i]);
        if (startsAt(t2, 0, CH_BT + CH_BT + CH_BT)) { closed = true; i++; break; }
        buf.push(lines[i]); i++;
      }
      out.push(hlBlock(buf.join('\n'), info));
      continue;
    }

    // 标题
    if (line.charAt(0) === '#'){
      var lv = 0;
      while (lv < 6 && line.charAt(lv) === '#') lv++;
      if (lv > 0 && (isWs(line.charAt(lv)) || line.charAt(lv) === '')){
        var htext = line.slice(lv).trim();
        var hid = headingId(htext, lv);
        toc.push({ lv: lv, text: htext, id: hid });
        out.push('<h' + lv + ' id="' + E(hid) + '">' + mdInline(htext) + '</h' + lv + '>');
        i++; continue;
      }
    }

    // 分割线
    var tl = line.trim();
    if (tl === '---' || tl === '***' || tl === '___'){
      out.push('<hr>'); i++; continue;
    }

    // 引用
    if (line.charAt(0) === '>' || (line.charAt(0) === ' ' && tl.charAt(0) === '>')){
      var qbuf = [];
      while (i < n && (lines[i].charAt(0) === '>' || ltrim(lines[i]).charAt(0) === '>')){
        var ql = ltrim(lines[i]);
        ql = ql.charAt(0) === '>' ? ql.slice(1) : ql;
        if (ql.charAt(0) === ' ') ql = ql.slice(1);
        qbuf.push(ql); i++;
      }
      out.push('<blockquote>' + mdHtml(qbuf.join('\n')).html + '</blockquote>');
      continue;
    }

    // 表格
    if (line.indexOf('|') >= 0 && i + 1 < n && mdIsDelim(lines[i + 1])){
      var head = mdCells(line);
      i += 2;
      var rowsHtml = '';
      while (i < n && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rowsHtml += '<tr>' + mdCells(lines[i]).map(function(c){ return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; i++; }
      out.push('<table><thead><tr>' + head.map(function(c){ return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>');
      continue;
    }

    // 列表（含任务列表）
    var lm = ltrim(line);
    var lIndent = line.length - lm.length;
    var isUl = (lm.charAt(0) === '-' || lm.charAt(0) === '*' || lm.charAt(0) === '+') && isWs(lm.charAt(1));
    var olNum = 0, isOl = false;
    if (!isUl){
      var d = 0;
      while (d < lm.length && lm.charCodeAt(d) >= 48 && lm.charCodeAt(d) <= 57) d++;
      if (d > 0 && (lm.charAt(d) === '.' || lm.charAt(d) === ')') && isWs(lm.charAt(d + 1))){
        isOl = true; olNum = parseInt(lm.slice(0, d), 10) || 1;
      }
    }
    if (isUl || isOl){
      var items = [];
      var baseIndent = lIndent;
      while (i < n){
        var cur = lines[i];
        var curT = ltrim(cur);
        var curI = cur.length - curT.length;
        if (!curT) break;
        var curUl = (curT.charAt(0) === '-' || curT.charAt(0) === '*' || curT.charAt(0) === '+') && isWs(curT.charAt(1));
        var cd = 0;
        while (cd < curT.length && curT.charCodeAt(cd) >= 48 && curT.charCodeAt(cd) <= 57) cd++;
        var curOl = cd > 0 && (curT.charAt(cd) === '.' || curT.charAt(cd) === ')') && isWs(curT.charAt(cd + 1));
        if (!curUl && !curOl){
          // 续行：缩进比本级深就当上一项的延续
          if (curI > baseIndent && items.length) items[items.length - 1].raw.push(cur.slice(baseIndent));
          else break;
          i++; continue;
        }
        if (curI < baseIndent) break;
        var off = curUl ? 1 : cd + 1;
        items.push({ raw: [ltrim(curT.slice(off))], sub: curT.slice(off) });
        i++;
      }
      var lis = '';
      for (var x = 0; x < items.length; x++){
        var txt = items[x].raw.join('\n');
        var task = null;
        if (startsAt(txt, 0, '[ ]')) task = false;
        else if (startsAt(txt, 0, '[x]') || startsAt(txt, 0, '[X]')) task = true;
        if (task !== null) txt = txt.slice(3).trim();
        var cls = task !== null ? ' class="task"' : '';
        var cb = task !== null ? '<input type="checkbox" disabled' + (task ? ' checked' : '') + '>' : '';
        lis += '<li' + cls + '>' + cb + mdInline(txt) + '</li>';
      }
      out.push(isOl ? '<ol start="' + olNum + '">' + lis + '</ol>' : '<ul>' + lis + '</ul>');
      continue;
    }

    // 空行
    if (!tl){ i++; continue; }

    // 段落（连续非空行合并）
    var pbuf = [];
    while (i < n){
      var pl = lines[i];
      var pt = pl.trim();
      if (!pt) break;
      if (pl.charAt(0) === '#' || pl.charAt(0) === '>') break;
      if (startsAt(ltrim(pl), 0, CH_BT + CH_BT + CH_BT)) break;
      if (pt === '---' || pt === '***' || pt === '___') break;
      var plm = ltrim(pl);
      if ((plm.charAt(0) === '-' || plm.charAt(0) === '*' || plm.charAt(0) === '+') && isWs(plm.charAt(1))) break;
      if (i + 1 < n && mdIsDelim(lines[i + 1]) && pl.indexOf('|') >= 0) break;
      pbuf.push(pt);
      i++;
    }
    if (pbuf.length) out.push('<p>' + pbuf.map(mdInline).join('<br>') + '</p>');
  }
  return { html: out.join('\n'), toc: toc };
}

// ---- JSON 折叠树 ----
function jsonTreeHtml(val, depth){
  var d = depth || 0;
  if (val === null) return '<span class="jtNull">null</span>';
  var t = typeof val;
  if (t === 'string') return '<span class="jtStr">"' + E(val) + '"</span>';
  if (t === 'number') return '<span class="jtNum">' + E(String(val)) + '</span>';
  if (t === 'boolean') return '<span class="jtBool">' + val + '</span>';
  if (t !== 'object') return '<span class="jtStr">' + E(String(val)) + '</span>';

  var isArr = Object.prototype.toString.call(val) === '[object Array]';
  var keys = isArr ? null : Object.keys(val);
  var size = isArr ? val.length : keys.length;
  var open = isArr ? '[' : '{', close = isArr ? ']' : '}';
  if (!size) return '<span class="jtP">' + open + close + '</span>';

  var n = isArr ? size : keys.length;
  var h = '<span class="jtP">' + open + '</span><span class="jtSum"> ' + n + ' 项</span>';
  var kids = '';
  if (isArr){
    for (var i = 0; i < val.length; i++) kids += '<div class="jtRow">' + jsonTreeHtml(val[i], d + 1) + (i < val.length - 1 ? '<span class="jtP">,</span>' : '') + '</div>';
  } else {
    for (var k = 0; k < keys.length; k++){
      kids += '<div class="jtRow"><span class="jtKey">"' + E(keys[k]) + '"</span><span class="jtP">: </span>' +
        jsonTreeHtml(val[keys[k]], d + 1) + (k < keys.length - 1 ? '<span class="jtP">,</span>' : '') + '</div>';
    }
  }
  var id = 'jt' + (jtSeq++);
  var collapsed = d >= 2;
  return h +
    '<span class="jtTog" data-jt="' + id + '">' + (collapsed ? '+' : '-') + '</span>' +
    '<span class="jtP">' + close + '</span>' +
    '<div class="jtKids' + (collapsed ? ' hide' : '') + '" id="' + id + '">' + kids + '</div>';
}
var jtSeq = 1;
// CSV 表头排序：直接重排 DOM 行，不动数据，简单且够快
function csvSort(th){
  var table = th.closest ? th.closest('table') : null;
  if (!table || table.className.indexOf('csv') < 0) return;
  var col = parseInt(th.getAttribute('data-col'), 10);
  if (!(col >= 0)) return;
  var tbody = table.tBodies[0];
  if (!tbody) return;
  var rows = [].slice.call(tbody.rows);
  var asc = th.getAttribute('data-asc') !== '1';
  th.setAttribute('data-asc', asc ? '1' : '0');
  var numeric = true;
  for (var q = 0; q < rows.length; q++){
    var cell = rows[q].cells[col];
    var v = cell ? cell.textContent : '';
    if (v !== '' && isNaN(v)) { numeric = false; break; }
  }
  rows.sort(function(a, b){
    var x = a.cells[col] ? a.cells[col].textContent : '';
    var y = b.cells[col] ? b.cells[col].textContent : '';
    var r;
    if (numeric) r = (parseFloat(x) || 0) - (parseFloat(y) || 0);
    else r = x.localeCompare(y, 'zh');
    return asc ? r : -r;
  });
  for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
  toast('已按「' + th.textContent + '」' + (asc ? '升序' : '降序') + '排列');
}

// ---- CSV / TSV ----
function csvParse(text, delim){
  var rows = [], row = [], cur = '', i = 0, n = text.length, q = false;
  while (i < n){
    var c = text.charAt(i);
    if (q){
      if (c === '"'){
        if (text.charAt(i + 1) === '"'){ cur += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '"'){ q = true; i++; continue; }
    if (c === delim){ row.push(cur); cur = ''; i++; continue; }
    if (c === '\n'){ row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
    if (c === '\r'){ i++; continue; }
    cur += c; i++;
  }
  if (cur !== '' || row.length){ row.push(cur); rows.push(row); }
  return rows;
}
function csvTableHtml(text, delim, maxRows){
  var rows = csvParse(text, delim);
  if (!rows.length) return null;
  var cap = maxRows || 2000;
  var shown = rows.slice(0, cap);
  var head = shown[0] || [];
  var bodyRows = shown.slice(1);
  var h = '<div class="rawNote">共 <b>' + (rows.length - 1) + '</b> 行 · <b>' + head.length + '</b> 列' +
    (rows.length > cap ? '（为保证流畅只显示前 ' + cap + ' 行）' : '') + '　点表头可排序</div>';
  h += '<div class="csvWrap"><table class="csv"><thead><tr>';
  for (var c = 0; c < head.length; c++) h += '<th data-col="' + c + '">' + E(head[c]) + '</th>';
  h += '</tr></thead><tbody>';
  for (var r = 0; r < bodyRows.length; r++){
    h += '<tr>';
    for (var k = 0; k < head.length; k++){
      var v = bodyRows[r][k] == null ? '' : bodyRows[r][k];
      var isNum = v !== '' && !isNaN(v) && String(parseFloat(v)) === String(v).trim();
      h += '<td' + (isNum ? ' class="num"' : '') + '>' + E(v) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  return { html: h, rows: rows.length - 1, cols: head.length };
}

// ===== 渲染分派：把文本/字节交给正确的渲染器 =====
// HTML 预览用的 iframe 标签。Q 是单引号、IMG_SRC 是 data: 图片源 —— 都单独定义，
// 因为 appHtml 是模板字符串，源码里任何反斜杠转义写法都会被模板引擎吃掉，
// 把外层字符串提前截断（编译报 Unexpected string）。只能用变量拼接，彻底绕开转义。
var Q = String.fromCharCode(39);
var IMG_SRC = 'data:';
// 返回 { ok, html } —— ok=false 时调用方退回纯文本
function renderText(name, ct, text, docSrc){
  var kind = kindOf(name, ct);
  try {
    if (kind === 'md'){
      var r = mdHtml(text);
      return { ok: true, kind: kind, html: r.html, toc: r.toc };
    }
    if (kind === 'json'){
      var parsed = null, bad = false;
      try { parsed = JSON.parse(text); } catch (e) { bad = true; }
      if (bad || parsed === null || typeof parsed !== 'object'){
        // 可能是 jsonl/ndjson：逐行解析
        var lines = text.split('\n'), objs = [], allOk = true;
        for (var i = 0; i < lines.length; i++){
          var ln = lines[i].trim();
          if (!ln) continue;
          try { objs.push(JSON.parse(ln)); } catch (e2) { allOk = false; break; }
        }
        if (!allOk || !objs.length) return { ok: false };
        parsed = objs;
      }
      jtSeq = 1;
      return { ok: true, kind: kind, html: '<div class="jt">' + jsonTreeHtml(parsed, 0) + '</div>' };
    }
    if (kind === 'csv'){
      var ex = extOf(name);
      var delim = ex === 'tsv' ? '\t' : (ex === 'psv' ? '|' : ',');
      var t = csvTableHtml(text, delim, 2000);
      if (!t) return { ok: false };
      return { ok: true, kind: kind, html: t.html };
    }
    if (kind === 'code'){
      var lang = hlLangOf(extOf(name));
      if (!lang) return { ok: false };
      return { ok: true, kind: kind, html: hlBlock(text, extOf(name)) };
    }
    if (kind === 'html'){
      // 两种模式，都关在 sandbox iframe 里（不给 allow-scripts / allow-same-origin）：
      //   ① docSrc 有值 → iframe 直接加载服务端的"真文档"（/?doc=1，注入过 base）。
      //      相对路径这才解析得对，页面自己的 css / 图片能加载；**此时不能再挂 csp 属性** ——
      //      那会把 img-src 限死在 data:，连自己目录的图片一起挡掉（分享页踩过同一个坑）。
      //      脚本安全由 sandbox + 文档响应头里的 CSP 双重保证，与分享页完全一致。
      //   ② 没有 docSrc（老路径）→ 原文走 srcdoc，只能看到裸结构 + 内联样式。
      // 为什么必须 sandbox 而不是直接 innerHTML：innerHTML 插入的 <script> 虽然被主站
      // CSP 的 nonce 挡住，但 <img onerror> / <svg onload> 这类事件属性照样会执行 ——
      // 那就等于让别人的页面脚本跑在你的管理员会话里。
      if (docSrc){
        return {
          ok: true, kind: kind, docSrc: docSrc,
          html: '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"' +
                ' referrerpolicy="no-referrer" title="HTML 预览（隔离）" src="' + E(docSrc) + '"></iframe>',
          note: '这是<b>隔离预览</b>：页面脚本不会执行（防止上传的页面偷你的登录态）。' +
                '页面<b>自己的</b> css / 图片会正常加载，第三方外链不加载。'
        };
      }
      return {
        ok: true, kind: kind,
        // CSP 里的 none / unsafe-inline 需要单引号，但这段代码位于 appHtml 模板字符串里，
        // 源码里写反斜杠会被模板引擎吃掉、把外层字符串字面量提前截断（编译报 Unexpected
        // identifier）。项目约定：一律用 CH_BS 拼单引号，不在注释或字面量里写反斜杠。
        // 另外别把两个双引号字符串挨着写：前一段以双引号收尾、后一段以双引号开头时，
        // JS 会把它们看成同一个字符串，中间的内容就成了语法错误。
        html: '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"' +
              ' csp="default-src ' + Q + 'none' + Q + '; img-src ' + IMG_SRC + '; ' +
              'style-src ' + Q + 'unsafe-inline' + Q + '; font-src data:; ' +
              'form-action ' + Q + 'none' + Q + '; base-uri ' + Q + 'none' + Q +
              '; frame-src ' + Q + 'none' + Q + '"' +
              ' title="HTML 预览（隔离）"></iframe>',
        srcdoc: text,
        note: '这是<b>隔离预览</b>：页面脚本不会执行（防止上传的页面偷你的登录态），' +
              '所以需要外链 CSS / 图片 / JS 的页面只能看到裸结构。要看完整效果请下载后用浏览器打开。'
      };
    }
  } catch (e) {
    return { ok: false };
  }
  return { ok: false };
}

// 路径按段转义（保留 /，其余按需编码）—— 真文档 / 资源 URL 要用它拼
function encPath(p){
  return String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// 渲染进一个容器（Markdown 用）
function renderInto(box, name, ct, text, docSrc){
  var r = renderText(name, ct, text, docSrc);
  if (!r.ok){ box.hidden = true; return null; }
  box.innerHTML = r.html;
  box.hidden = false;
  // HTML 预览：单独设 class 是为了让 CSS 把容器的 padding 去掉、让 iframe 撑满 ——
  // 预览要尽量接近真实页面。docSrc 模式下由浏览器自己去加载，不是我们塞 srcdoc。
  if (r.srcdoc != null || r.docSrc){
    box.className = 'rBox htmlBox';
    var fr = box.querySelector('iframe');
    // 高度不靠脚本同步：sandbox 没给 allow-same-origin，子文档是跨源的，
    // contentDocument 一定读不到（之前那段 try/catch 永远走 catch，是死代码）。
    // iframe 用 flex:1 撑满容器，自身滚动 —— 和 PDF 预览一个思路，简单且可靠。
    if (fr){
      if (r.docSrc) fr.src = r.docSrc;      // 真文档：真实 URL 才解析得对相对路径
      else fr.srcdoc = r.srcdoc;
    }
    if (r.note) box.insertAdjacentHTML('beforeend', '<div class="htmlNote">' + r.note + '</div>');
  } else if (r.kind === 'md' && r.toc && r.toc.length >= 2){
    var t = '<div class="tocInline"><b>目录</b>';
    for (var i = 0; i < r.toc.length; i++){
      var it = r.toc[i];
      t += '<a href="#" data-mdgo="' + E(it.id) + '" class="lv' + it.lv + '">' + E(it.text) + '</a>';
    }
    t += '</div>';
    box.insertAdjacentHTML('afterbegin', t);
  }
  return r;
}

// ================= 编辑器增强（第二档）=================
// 行号槽 / 查找替换 / Markdown 大纲 / 字数统计 / 草稿自动保存 / 编辑快捷键。
// 一律做成"叠加增强"：任何一项失效都不影响原有的输入与保存流程。
var ED_BIG = 512 * 1024;        // 超过这个体积就关掉高亮与行号，优先保证不卡
var ED_DRAFT_MAX = 400 * 1024;  // 草稿体积上限（localStorage 总共就几 MB）

function edText(){ var t = document.getElementById('edt'); return t ? t.value : ''; }
function edIsBig(){ return edText().length > ED_BIG; }

// 把文本框的字体/内边距/滚动条宽度同步给镜像与高亮层。
// 不同步滚动条宽度的话，换行位置会和正文错开，行号与高亮就全歪了。
function mirrorSync(){
  var t = document.getElementById('edt');
  var m = document.getElementById('edMirror');
  if (!t || !m) return null;
  var cs = getComputedStyle(t);
  var lh = parseFloat(cs.lineHeight);
  if (!(lh > 0)) lh = (parseFloat(cs.fontSize) || 13) * 1.7;
  var sbw = t.offsetWidth - t.clientWidth;
  var padRight = 16 + (sbw > 0 ? sbw : 0);
  // 三个隐形层必须和文本框同字体、同内边距：镜像层量行高、量测层量网址坐标、高亮层叠在文字上
  ['edMirror', 'edMeasure', 'edHlIn'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    el.style.fontSize = cs.fontSize;
    el.style.lineHeight = cs.lineHeight;
    el.style.paddingRight = padRight + 'px';
  });
  return { t: t, m: m, lh: lh };
}

function gutScroll(){
  var t = document.getElementById('edt');
  var gi = document.getElementById('edGutterIn');
  if (!t || !gi) return;
  gi.style.transform = 'translateY(' + (-t.scrollTop) + 'px)';
}
function hlScroll(){
  var t = document.getElementById('edt');
  var inEl = document.getElementById('edHlIn');
  var icons = document.getElementById('edLinkIcons');
  if (!t) return;
  var tr = 'translate(' + (-t.scrollLeft) + 'px,' + (-t.scrollTop) + 'px)';
  if (inEl) inEl.style.transform = tr;
  if (icons) icons.style.transform = tr;   // 网址图标层跟着正文一起滚
}

// 行号槽：换行开启时逻辑行可能占多个视觉行，所以用镜像元素实测每行高度再定位，
// 这样行号永远贴在它那一行的第一视觉行上，不会因为折行而错位。
function syncGutter(){
  var g = document.getElementById('edGutter');
  var gi = document.getElementById('edGutterIn');
  var t = document.getElementById('edt');
  if (!g || !gi || !t || RO) return;
  var text = t.value;
  var lines = text.split('\n');
  if (edIsBig() || lines.length > 4000 || !t.offsetWidth){
    g.hidden = true;
    t.classList.remove('withGut');
    gi.innerHTML = '';
    return;
  }
  var mm = mirrorSync();
  if (!mm) return;
  g.hidden = false;
  t.classList.add('withGut');

  var heights = null;
  if (wrapOn){
    var buf = '';
    for (var i = 0; i < lines.length; i++) buf += '<div>' + (lines[i] ? E(lines[i]) : '&nbsp;') + '</div>';
    mm.m.innerHTML = buf;
    var kids = mm.m.children;
    heights = [];
    for (var k = 0; k < kids.length; k++) heights.push(kids[k].offsetHeight);
  }
  var cur = -1;
  try { cur = text.slice(0, t.selectionStart).split('\n').length - 1; } catch (e) {}

  var out = '', y = 14;
  var vis = mm.lh;
  for (var n = 0; n < lines.length; n++){
    var bh = heights ? (heights[n] || vis) : vis;
    out += '<div class="edGutNum' + (n === cur ? ' cur' : '') + '" style="top:' + y + 'px;height:' + bh +
      'px;line-height:' + vis + 'px">' + (n + 1) + '</div>';
    y += bh;
  }
  gi.innerHTML = out;
  gutScroll();
}

// ---- 查找替换 ----
// terms 不为空时是"从搜索结果带进来的高亮会话"：多个关键词各自扫描（AND 语义）、按词分色；
// 用户一旦在查找框里自己敲字，就退回普通单串查找（terms 置空）。
var findState = { open: false, q: '', case: false, re: false, terms: null, word: false };
var findHits = [], findAt = -1;

function updateFindStat(){
  var s = document.getElementById('fStat');
  if (!s) return;
  if (!findState.q){ s.textContent = '未查找'; return; }
  if (!findHits.length){ s.textContent = '无匹配'; return; }
  s.textContent = (findAt + 1) + ' / ' + findHits.length + ' 处';
}

// 整词模式（搜索框里写了 "cat"）下的词边界判断：cat 不该在 category 里点亮
function wordOkAt(text, start, end){
  var isW = function(c){ return !!c && /[0-9A-Za-z_]/.test(c); };
  if (isW(start > 0 ? text.charAt(start - 1) : '')) return false;
  if (isW(end < text.length ? text.charAt(end) : '')) return false;
  return true;
}

function findRun(keepAt){
  var t = document.getElementById('edt');
  if (!t || !findState.open) { findHits = []; findAt = -1; renderHl(); return; }
  findHits = [];
  if (!edIsBig()){
    var text = t.value;
    var terms = (findState.terms && findState.terms.length) ? findState.terms : null;
    if (terms){
      // 多关键词：逐词扫描，命中记下"属于第几个词"，供高亮层分色
      var hay = findState.case ? text : text.toLowerCase();
      for (var ti = 0; ti < terms.length; ti++){
        var raw = String(terms[ti] || '');
        var needle = findState.case ? raw : raw.toLowerCase();
        if (!needle) continue;
        var from = 0, guard = 0;
        while (guard++ < 4000){
          var k = hay.indexOf(needle, from);
          if (k < 0) break;
          if (!findState.word || wordOkAt(text, k, k + needle.length)) findHits.push({ start: k, end: k + needle.length, t: ti });
          from = k + Math.max(1, needle.length);
        }
      }
      findHits.sort(function(a, b){ return a.start - b.start || b.end - a.end; });
    } else {
      var q = findState.q;
      if (q){
        if (findState.re){
          try {
            var re = new RegExp(q, findState.case ? 'g' : 'gi');
            var m, guard3 = 0;
            while ((m = re.exec(text)) !== null && guard3++ < 4000){
              if (m[0] === ''){ re.lastIndex++; continue; }
              findHits.push({ start: m.index, end: m.index + m[0].length, t: 0 });
            }
          } catch (e) { findHits = []; }
        } else {
          var hay2 = findState.case ? text : text.toLowerCase();
          var needle2 = findState.case ? q : q.toLowerCase();
          var from2 = 0, guard2 = 0;
          while (guard2++ < 4000){
            var i2 = hay2.indexOf(needle2, from2);
            if (i2 < 0) break;
            findHits.push({ start: i2, end: i2 + needle2.length, t: 0 });
            from2 = i2 + Math.max(1, needle2.length);
          }
        }
      }
    }
  }
  if (!keepAt) findAt = findHits.length ? 0 : -1;
  if (findAt >= findHits.length) findAt = findHits.length - 1;
  updateFindStat();
  renderHl();
}

// ===== 正文里的完整网址：识别 + 可点击 =====
// 只认 http/https（裸 www. 自动补 https://）—— javascript: 之类的伪协议永远
// 不会被做成可点的链接。结尾的标点不算网址的一部分，否则"见 https://a.com。"
// 会把句号一起染进链接里。
// 模式串用字符码拼：模板字符串会把源码里的 '' 和 ''' 吞掉，直接写正则字面量会烂掉。
var URL_RE = new RegExp(CH_BS + 'b(?:https?://|www' + CH_BS + '.)[^' + CH_BS + 's<>' +
  String.fromCharCode(34, 39) + CH_BT + ']+', 'gi');
var ED_LINK_MAX = 256 * 1024;      // 超过这个体积就不在编辑器里画链接（重建覆盖层有成本）

// 网址结尾该丢掉的标点（ASCII + 全角）。用字符码建表 —— 源码里若写正则字面量，
// 模板字符串会吞掉反斜杠，导致字符类提前闭合、语义全变（结尾逗号就再也去不掉了）。
var URL_TAIL = (function(){
  var codes = [46, 44, 59, 58, 33, 63, 39, 34, 125, 62, 93,           // . , ; : ! ? ' " } > ]
    0x3002, 0xFF0C, 0xFF1B, 0xFF1A, 0xFF01, 0xFF1F, 0x3001,           // 。 ， ； ： ！ ？ 、
    0x300B, 0x300D, 0x3011, 0xFF09, 0x2019, 0x201D, 0x300F, 0x3009];  // 》 」 】 ） ’ ” 〗 〉
  var o = {};
  for (var i = 0; i < codes.length; i++) o[codes[i]] = 1;
  return o;
})();

function trimUrlEnd(u){
  var t = u;
  while (t.length && URL_TAIL[t.charCodeAt(t.length - 1)]) t = t.slice(0, -1);
  // 维基百科那种 .../foo_(bar)：只有右括号比左括号多时，末尾的 ) 才算标点
  while (t.charAt(t.length - 1) === ')'){
    var op = t.split('(').length - 1, cl = t.split(')').length - 1;
    if (cl > op) t = t.slice(0, -1); else break;
  }
  return t;
}
// 全角句读（。，；：！？、）绝不会出现在网址里。只靠"从尾部删标点"是不够的：
// "https://a.com/x。后文" 里那个句号不在结尾，整串会被当成一个网址、把后面中文也吃进去。
// 所以匹配到之后先在第一个全角句读处截断，再走尾部的 trimUrlEnd。
var URL_STOP = (function(){
  var codes = [0x3002, 0xFF0C, 0xFF1B, 0xFF1A, 0xFF01, 0xFF1F, 0x3001];
  var o = {};
  for (var i = 0; i < codes.length; i++) o[codes[i]] = 1;
  return o;
})();
function cutUrlAtStop(u){
  for (var i = 0; i < u.length; i++){ if (URL_STOP[u.charCodeAt(i)]) return u.slice(0, i); }
  return u;
}
function findLinks(text){
  var out = [];
  if (!text) return out;
  URL_RE.lastIndex = 0;
  var m, guard = 0;
  while ((m = URL_RE.exec(text)) !== null){
    if (guard++ > 1000) break;
    var raw = trimUrlEnd(cutUrlAtStop(m[0]));
    if (raw.length < 5) continue;
    out.push({ s: m.index, e: m.index + raw.length,
      href: raw.slice(0, 4).toLowerCase() === 'www.' ? 'https://' + raw : raw });
    if (raw.length < m[0].length) URL_RE.lastIndex = m.index + raw.length;   // 别把结尾标点再吃一遍
  }
  return out;
}

// 编辑器覆盖层：只画「查找命中」。网址不再铺底色 —— 改成在网址末尾挂图标（见 renderLinkIcons），
// 底色块一旦和文本框的子像素对不齐就会变成"贴了一层"的重影，图标没有这个问题。
// 命中区间按起点排好序后，用两个指针扫一遍端点即可。
function overlayHtml(text, hits, curIdx, multi){
  if (!hits.length) return E(text);
  hits.sort(function(a, b){ return a.start - b.start || b.end - a.end; });
  var pts = [0, text.length], i;
  for (i = 0; i < hits.length; i++){ pts.push(hits[i].start, hits[i].end); }
  pts.sort(function(a, b){ return a - b; });
  var out = '', hi = 0;
  for (i = 0; i < pts.length - 1; i++){
    var a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    var mid = (a + b) / 2;
    while (hi < hits.length && hits[hi].end <= mid) hi++;
    var seg = E(text.slice(a, b));
    var hh = (hi < hits.length && hits[hi].start <= mid && hits[hi].end > mid) ? hits[hi] : null;
    if (hh){
      out += '<span class="hmark' + (multi ? ' t' + ((hh.t || 0) % 3 + 1) : '') +
        (hh.i === curIdx ? ' cur' : '') + '">' + seg + '</span>';
      continue;
    }
    out += seg;
  }
  return out;
}

// 网址末尾那个小图标。同一份 SVG 给编辑器图标层和只读查看器共用。
var LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
var LINK_ICON_SIZE = 11;   // 与 .lnkico 的宽高一致
var LINK_ICON_RAISE = 4;   // 在"行内居中"的基础上再往上抬 4px，抬成上标，躲开后面那个字的字身
var ED_ICON_MAX = 200;     // 一屏之外也点不到，网址太多时只画前 N 个，省 DOM

function makeLinkIcon(href){
  var a = document.createElement('a');
  a.className = 'lnkico';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = '在新标签页打开 ' + href;
  a.setAttribute('aria-label', '打开网址 ' + href);
  a.innerHTML = LINK_ICON;
  return a;
}

// ---- 编辑器内网址的"快捷打开" ----
// 链接区间按正文内容缓存：光标每动一下都重扫一遍正文太浪费，而正文是不可变字符串，直接拿它当 key。
var linkCacheText = null, linkCacheList = [];
function editorLinks(text){
  if (linkCacheText === text) return linkCacheList;
  linkCacheList = (edIsBig() || text.length > ED_LINK_MAX) ? [] : findLinks(text);
  linkCacheText = text;
  return linkCacheList;
}

// 某个下标（光标位）落在哪个网址里。桌面 Ctrl/Cmd+点击、以及"打开"小按钮都用它。
function linkAt(pos){
  var t = document.getElementById('edt');
  if (!t) return null;
  var ls = editorLinks(t.value);
  for (var i = 0; i < ls.length; i++){
    if (pos >= ls[i].s && pos <= ls[i].e) return ls[i];
  }
  return null;
}

// findLinks 只认 http/https（裸 www. 也已补成 https://），所以这里没有伪协议风险
function openUrl(href){
  if (!href) return;
  var a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---- 编辑器里"每个网址末尾一个小图标" ----
// 难点是坐标：文本框里的字符位置拿不到 DOM，所以借 #edMeasure（与文本框同宽同字体同换行的隐形层）
// 用 Range 量出"网址最后一个字符"的矩形，再换算成相对叠层的坐标。
// 缓存键 = 正文 + 字号 + 换行开关：光标移动/滚动不重算，只有这三者变了才重建。
var iconCacheText = null, iconCacheFont = 0, iconCacheWrap = null;
function renderLinkIcons(text, links){
  var box = document.getElementById('edLinkIcons');
  var mm = document.getElementById('edMeasure');
  if (!box) return;
  if (iconCacheText === text && iconCacheFont === edFont && iconCacheWrap === wrapOn) return;
  iconCacheText = text; iconCacheFont = edFont; iconCacheWrap = wrapOn;
  box.innerHTML = '';
  if (!links.length || !mm || edIsBig() || text.length > ED_LINK_MAX) return;
  // 量测层必须和文本框的换行口径一致，否则量出来的 x/y 全是错的
  mm.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
  mm.style.overflowWrap = wrapOn ? 'anywhere' : 'normal';
  mm.textContent = text;                       // 单个文本节点：Range 可以直接按下标取
  var node = mm.firstChild;
  if (!node) return;
  var mr = mm.getBoundingClientRect();
  if (!mr.width) return;
  var lim = Math.min(links.length, ED_ICON_MAX);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < lim; i++){
    var l = links[i];
    var r = document.createRange();
    try { r.setStart(node, l.e - 1); r.setEnd(node, l.e); } catch (e){ continue; }
    var rr = r.getBoundingClientRect();
    if (!rr.height && !rr.width) continue;
    var ic = makeLinkIcon(l.href);
    // -1 是 #edHl 的 1px 透明边框：镜像层和叠层的边框盒对齐，内容盒差这 1px
    ic.style.left = Math.round(rr.right - mr.left - 1) + 'px';
    ic.style.top = Math.round(rr.top - mr.top - 1 + (rr.height - LINK_ICON_SIZE) / 2 - LINK_ICON_RAISE) + 'px';
    frag.appendChild(ic);
  }
  box.appendChild(frag);
}

// 命中高亮层：叠在文本框上方的一层透明文字层，只在查找时画命中。
// 网址不在这层画（那层只铺底色、会和文字错位），改由 #edLinkIcons 在网址末尾挂图标。
// 既没开查找、正文里也没有网址时整层 hidden，平时不产生任何开销。
function renderHl(){
  var hl = document.getElementById('edHl');
  var inEl = document.getElementById('edHlIn');
  var t = document.getElementById('edt');
  if (!hl || !inEl || !t) return;
  var big = edIsBig();
  var text = t.value;
  var links = editorLinks(text);
  var hits = [];
  if (!big && findState.open && findHits.length){
    var lim = Math.min(findHits.length, 600);
    for (var k = 0; k < lim; k++){
      hits.push({ start: findHits[k].start, end: findHits[k].end, t: findHits[k].t, i: k });
    }
  }
  if (!links.length && !hits.length){
    hl.hidden = true; inEl.innerHTML = '';
    renderLinkIcons(text, links);     // 网址被删光了也要走一趟，把残留的旧图标清掉
    return;
  }
  hl.hidden = false;
  mirrorSync();                       // 先把字体/内边距同步给量测层，网址图标定位要用它量
  inEl.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
  inEl.style.overflowWrap = wrapOn ? 'anywhere' : 'normal';
  // 多关键词才分色；单关键词保持原来的统一黄色（与侧栏 hlText 的口径一致）
  var multi = !!(findState.terms && findState.terms.length > 1);
  inEl.innerHTML = hits.length ? overlayHtml(text, hits, findAt, multi) : '';
  renderLinkIcons(text, links);
  hlScroll();
}

// 把光标与滚动位置对到"当前命中"上。
// noFocus=true 用于"从搜索结果打开文件"：那时只是替用户指出位置，
// 不该抢焦点（手机上会立刻弹软键盘，正是全局都在避免的那件事）。
function findScrollToCurrent(noFocus){
  var t = document.getElementById('edt');
  if (!t || findAt < 0 || findAt >= findHits.length) return;
  var m = findHits[findAt];
  if (!noFocus){ try { t.focus(); } catch (e) {} }
  try { t.setSelectionRange(m.start, m.end); } catch (e) {}
  // 近似滚动定位：按命中位置之前的行数 × 行高
  var linesBefore = t.value.slice(0, m.start).split('\n').length - 1;
  var mm = mirrorSync();
  var lh = mm ? mm.lh : 22;
  var target = 14 + linesBefore * lh;
  if (target < t.scrollTop + 12 || target > t.scrollTop + t.clientHeight - 44){
    t.scrollTop = Math.max(0, target - Math.round(t.clientHeight / 3));
  }
  updateFindStat(); renderHl(); syncGutter(); hlScroll(); gutScroll();
}
function findGo(dir){
  if (!findHits.length){ toast('没有匹配项'); return; }
  findAt = (findAt + dir + findHits.length) % findHits.length;
  findScrollToCurrent(false);
}

// 替换相关的三个控件（替换为 / 替换 / 全部替换）只在真的要替换时才出现。
// "从搜索结果打开文件"属于"看"，不是"改"：把它们收起来，
// 查找栏就只剩「查找框 + N 处 + 上一处/下一处」，意图一目了然。
function setRepCtl(on){
  var ids = ['fR', 'fRep', 'fRepAll'];
  for (var i = 0; i < ids.length; i++){
    var el = document.getElementById(ids[i]);
    if (el) el.hidden = !on;
  }
}

// 从搜索结果打开文件时，把搜索词一并带进编辑器高亮。
// 侧栏已经告诉用户"这份文件里有 18 处"，真正缺的是"在哪一处" —— 这里补上。
// 复用查找栏的高亮层与「上一处 / 下一处」，不另造一套 UI。
function highlightSearchTerms(terms, opts){
  opts = opts || {};
  var t = document.getElementById('edt');
  var bar = document.getElementById('findBar');
  if (!t || !bar || !terms || !terms.length) return 0;
  if (edIsBig()) return 0;                 // 超大文件本来就不开高亮层（省 CPU）
  findState.open = true;
  findState.terms = terms;
  findState.re = false;
  findState.case = false;
  findState.word = !!opts.word;
  findState.q = terms.join(' ');
  bar.hidden = false;
  setRepCtl(false);            // 只是"看在哪"，不给替换控件
  var fq = document.getElementById('fQ');
  if (fq) fq.value = findState.q;
  findRun(false);
  // 正文里一处都没有（命中其实在文件名 / 路径上，或索引只截了前 8K）——
  // 那就别留一个写着"无匹配"的查找栏在编辑器顶上，静默收回去。
  if (!findHits.length){
    findState.open = false; findState.terms = null; findState.word = false;
    findState.q = ''; findHits = []; findAt = -1;
    bar.hidden = true;
    var fq0 = document.getElementById('fQ'); if (fq0) fq0.value = '';
    renderHl();
    return 0;
  }
  if (opts.scroll !== false) findScrollToCurrent(true);
  return findHits.length;
}

function markEdited(){
  ed.dirty = true;
  setStatus('未保存');
  updateCount();
  syncGutter();
  if (findState.open) findRun(true);
  saveDraftSoon();
  outlineSoon();
}

function findReplaceOne(){
  if (!findHits.length || findAt < 0){ toast('没有匹配项'); return; }
  var t = document.getElementById('edt');
  var m = findHits[findAt];
  var ins = document.getElementById('fR').value;
  if (findState.re){
    try {
      var re = new RegExp(findState.q, findState.case ? '' : 'i');
      ins = t.value.slice(m.start, m.end).replace(re, ins);
    } catch (e) {}
  }
  t.value = t.value.slice(0, m.start) + ins + t.value.slice(m.end);
  var caret = m.start + ins.length;
  try { t.setSelectionRange(caret, caret); } catch (e) {}
  markEdited();
  findRun(true);
  renderHl();
}

function replaceAll(){
  if (!findHits.length){ toast('没有匹配项'); return; }
  var t = document.getElementById('edt');
  var ins = document.getElementById('fR').value;
  var text = t.value, out = '', last = 0, done = 0;
  for (var i = 0; i < findHits.length; i++){
    var m = findHits[i];
    if (m.start < last) continue;
    out += text.slice(last, m.start) + ins;
    last = m.end;
    done++;
  }
  out += text.slice(last);
  t.value = out;
  markEdited();
  findRun(false);
  renderHl();
  toast('已替换 ' + done + ' 处');
}

function openFind(withReplace){
  var bar = document.getElementById('findBar');
  var t = document.getElementById('edt');
  if (!bar || !t) return;
  findState.open = true;
  bar.hidden = false;
  setRepCtl(true);             // 用户自己打开的查找栏，替换控件照旧给全
  var q = document.getElementById('fQ');
  try {
    if (t.selectionEnd > t.selectionStart){
      var sel = t.value.slice(t.selectionStart, t.selectionEnd);
      if (sel.length <= 120 && sel.indexOf('\n') < 0) q.value = sel;
    }
  } catch (e) {}
  // 当前若是"从搜索结果带进来的高亮"，Ctrl+F 不该把它抹掉：
  // 保持多关键词会话、输入框继续显示这组词；用户一敲字就会自动切回单串查找。
  if (!(findState.terms && findState.terms.length)) findState.q = q.value;
  q.focus();
  try { q.select(); } catch (e) {}
  findRun(false);
  if (withReplace){ var r = document.getElementById('fR'); if (r){ r.focus(); } }
}

// 关掉查找栏。
// noFocus=true 表示"只是顺带清理一下状态"，别去抢焦点 ——
// 打开文件前就是用它收尾的，若在这里 focus 编辑器，
// 手机上会立刻弹出软键盘（正是要避免的那件事）。
function closeFind(noFocus){
  var bar = document.getElementById('findBar');
  findState.open = false;
  if (bar) bar.hidden = true;
  findHits = []; findAt = -1;
  renderHl();
  // 严格判断 === true：这个函数同时被当成事件处理器绑定（closeFind(ev)），
  // 传进来的 MouseEvent 是 truthy，用普通真值判断会误伤"还给焦点"这条正常路径。
  if (noFocus === true) return;
  var t = document.getElementById('edt');
  if (t){ try { t.focus(); } catch (e) {} }
}

// ---- Markdown 大纲 ----
function tocWithLines(text){
  var lines = text.split('\n'), out = [], inFence = false;
  for (var i = 0; i < lines.length; i++){
    var ln = lines[i];
    if (startsAt(ltrim(ln), 0, CH_BT + CH_BT + CH_BT)){ inFence = !inFence; continue; }
    if (inFence) continue;
    if (ln.charAt(0) !== '#') continue;
    var lv = 0;
    while (lv < 6 && ln.charAt(lv) === '#') lv++;
    if (lv > 0 && isWs(ln.charAt(lv))) out.push({ lv: lv, text: ln.slice(lv).trim(), line: i });
  }
  return out;
}
function outlineSoon(){
  clearTimeout(ed.otimer);
  ed.otimer = setTimeout(mdOutline, 420);
}
function mdOutline(){
  var box = document.getElementById('edOutline');
  if (!box || RO) return;
  if (kindOf(ed.name || '', '') !== 'md'){ box.hidden = true; return; }
  var toc = tocWithLines(edText());
  if (toc.length < 2){ box.hidden = true; return; }
  var h = '<b>大纲</b>';
  for (var i = 0; i < toc.length; i++){
    h += '<a href="#" data-oline="' + toc[i].line + '" class="lv' + toc[i].lv + '">' + E(toc[i].text) + '</a>';
  }
  box.innerHTML = h;
  box.hidden = false;
}
function editorGoLine(line){
  var t = document.getElementById('edt');
  if (!t) return;
  var text = t.value, pos = 0, n = 0;
  for (var i = 0; i < text.length && n < line; i++){ if (text.charAt(i) === '\n') n++; pos = i + 1; }
  var mm = mirrorSync();
  var lh = mm ? mm.lh : 22;
  try { t.focus(); t.setSelectionRange(pos, Math.min(text.length, pos + 1)); } catch (e) {}
  t.scrollTop = Math.max(0, 14 + line * lh - Math.round(t.clientHeight / 4));
  syncGutter(); hlScroll(); gutScroll();
}

// ---- 编辑器里的「源码 / 预览」切换 ----
// 编辑区始终以源码为准（保存的永远是纯文本），预览只是叠加的一层显示，
// 所以不会出现"富文本编辑器把文件改坏"的风险。
function edCanPreview(name){
  var k = kindOf(name || ed.name || '', '');
  // html 也进来：编辑区仍以源码为准（保存的永远是纯文本），预览那层是 sandbox iframe，
  // 改完点一下预览就能看效果，不用下载再打开。
  return k === 'md' || k === 'json' || k === 'csv' || k === 'code' || k === 'html';
}
// 注意：刚打开文件时 ed.name 还是上一个文件的值，所以允许显式传入名字
function paintEdSeg(name){
  var seg = document.getElementById('edSeg');
  if (!seg) return;
  if (!edCanPreview(name)){ seg.innerHTML = ''; return; }
  var pv = document.getElementById('edPrev');
  var on = !!(pv && !pv.hidden);
  seg.innerHTML = '<span class="vseg">' +
    '<button data-emode="src"' + (!on ? ' class="on"' : '') + '>源码</button>' +
    '<button data-emode="prev"' + (on ? ' class="on"' : '') + '>预览</button></span>';
}
function edSetPreview(on){
  var p = document.getElementById('edPrev');
  var row = document.getElementById('edRow');
  var t = document.getElementById('edt');
  var bar = document.getElementById('findBar');
  if (!p || !row || !t) return;
  if (on){
    // 编辑器预览走"真文档"：iframe 直接加载管理端的 /f/<路径>?doc=1，
    // 这样页面自己的 css / 图片能加载（与分享页的渲染方式完全一致）。
    var docSrc = ed.path ? BASE + '/f/' + encPath(ed.path) + '?doc=1' : '';
    var r = renderText(ed.name || '', '', t.value, docSrc);
    if (!r.ok){ toast('这个格式没有专用预览，直接看源码就好'); return; }
    p.innerHTML = r.html;
    // HTML 预览：srcdoc 模式要把原文塞进 srcdoc；docSrc 模式交给 iframe 自己加载。
    // p 容器复用同一个 id，所以这里也要复位 className —— 否则看完 HTML 再切回
    // Markdown，htmlBox 的 padding:0 / overflow:hidden 会残留下来把渲染弄坏。
    p.className = (r.srcdoc != null || r.docSrc) ? 'rBox edPrev htmlBox' : 'rBox edPrev';
    if (r.srcdoc != null || r.docSrc){
      var fr = p.querySelector('iframe');
      if (fr){
        if (r.docSrc) fr.src = r.docSrc;
        else fr.srcdoc = r.srcdoc;
      }
      if (r.note) p.insertAdjacentHTML('beforeend', '<div class="htmlNote">' + r.note + '</div>');
    }
    p.hidden = false;
    row.hidden = true;
    if (bar) bar.hidden = true;
    findState.open = false;
    findHits = []; findAt = -1;
    renderHl();
  } else {
    p.hidden = true;
    p.innerHTML = '';
    p.className = 'rBox edPrev';
    row.hidden = false;
    syncGutter();
    renderHl();
  }
  paintEdSeg();
}

// ---- 草稿自动保存 ----
// 编辑中每 2.5 秒把内容存进浏览器本地。误关闭 / 崩溃后重新打开同一文件会提示恢复。
function draftKey(path){ return 'cfwtxt_draft:' + path; }
function saveDraftSoon(){
  if (RO || !ed.path) return;
  clearTimeout(ed.dtimer);
  ed.dtimer = setTimeout(saveDraft, 2500);
}
function saveDraft(){
  if (RO || !ed.path) return;
  var v = edText();
  if (v.length > ED_DRAFT_MAX) return;
  try { localStorage.setItem(draftKey(ed.path), JSON.stringify({ t: v, at: Date.now() })); } catch (e) {}
}
function loadDraft(path){
  try {
    var raw = localStorage.getItem(draftKey(path));
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (!d || typeof d.t !== 'string') return null;
    return d;
  } catch (e) { return null; }
}
function clearDraft(path){
  try { localStorage.removeItem(draftKey(path)); } catch (e) {}
}

// ---- 分隔符配对 / 缩进 ----
var PAIR_CLOSE = { '(': ')', '[': ']', '{': '}' };
var QUOTE_CH = { '"': 1, "'": 1 };
QUOTE_CH[CH_BT] = 1;
var COMMENT_TOK = { py: '#', sh: '#', yaml: '#', toml: '#', ini: '#', sql: '--' };

function commentTokenFor(name){
  var l = HL_ALIAS[extOf(name)];
  return COMMENT_TOK[l] || '//';
}
function selectedLines(t){
  var s = t.value.lastIndexOf('\n', Math.max(0, t.selectionStart - 1)) + 1;
  var e = t.value.indexOf('\n', t.selectionEnd);
  if (e < 0) e = t.value.length;
  return { start: s, end: e };
}
function indentSel(t, out){
  var r = selectedLines(t);
  var block = t.value.slice(r.start, r.end);
  var lines = block.split('\n');
  var changed;
  if (out){
    changed = lines.map(function(l){
      if (startsAt(l, 0, '  ')) return l.slice(2);
      if (startsAt(l, 0, ' ') || startsAt(l, 0, '\t')) return l.slice(1);
      return l;
    });
  } else {
    changed = lines.map(function(l){ return l ? '  ' + l : l; });
  }
  var nb = changed.join('\n');
  t.value = t.value.slice(0, r.start) + nb + t.value.slice(r.end);
  try { t.setSelectionRange(r.start, r.start + nb.length); } catch (e) {}
}
function moveLines(t, dir){
  var r = selectedLines(t);
  var all = t.value.split('\n');
  var first = t.value.slice(0, r.start).split('\n').length - 1;
  var count = t.value.slice(r.start, r.end).split('\n').length;
  if (dir < 0 && first === 0) return;
  if (dir > 0 && first + count >= all.length) return;

  if (dir < 0){
    var prev = all[first - 1];
    var block = all.slice(first, first + count);
    all = all.slice(0, first - 1).concat(block, [prev], all.slice(first + count));
    first = first - 1;
  } else {
    var nxt = all[first + count];
    var block2 = all.slice(first, first + count);
    all = all.slice(0, first).concat([nxt], block2, all.slice(first + count + 1));
    first = first + 1;
  }
  t.value = all.join('\n');
  var from = first > 0 ? all.slice(0, first).join('\n').length + 1 : 0;
  var len = all.slice(first, first + count).join('\n').length;
  try { t.setSelectionRange(from, from + len); } catch (e) {}
}
function toggleComment(t){
  var r = selectedLines(t);
  var block = t.value.slice(r.start, r.end);
  var tok = commentTokenFor(ed.name || '');
  var lines = block.split('\n');
  var nonEmpty = lines.filter(function(l){ return ltrim(l) !== ''; });
  var allCommented = nonEmpty.length > 0 && nonEmpty.every(function(l){ return startsAt(ltrim(l), 0, tok); });
  var changed = lines.map(function(l){
    if (!l.trim()) return l;
    if (allCommented){
      var pad = l.length - ltrim(l).length;
      return l.slice(0, pad) + ltrim(l).slice(tok.length).replace(/^ /, '');
    }
    var pad2 = l.length - ltrim(l).length;
    return l.slice(0, pad2) + tok + ' ' + ltrim(l);
  });
  var nb = changed.join('\n');
  t.value = t.value.slice(0, r.start) + nb + t.value.slice(r.end);
  try { t.setSelectionRange(r.start, r.start + nb.length); } catch (e) {}
}

// 编辑器快捷键。只在编辑视图生效，不干扰列表页与弹窗。
function edKeydown(e){
  var t = document.getElementById('edt');
  if (!t || RO || state.view !== 'edit') return;
  var mod = e.ctrlKey || e.metaKey;
  var key = e.key;
  var changed = false;

  if (mod && (key === 's' || key === 'S')){ e.preventDefault(); saveEd(); return; }
  if (mod && (key === 'f' || key === 'F')){ e.preventDefault(); openFind(false); return; }
  if (mod && (key === 'h' || key === 'H')){ e.preventDefault(); openFind(true); return; }
  if (mod && key === '/'){ e.preventDefault(); toggleComment(t); changed = true; }
  else if (key === 'Tab'){
    e.preventDefault();
    indentSel(t, e.shiftKey); changed = true;
  }
  else if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')){
    e.preventDefault();
    moveLines(t, key === 'ArrowUp' ? -1 : 1); changed = true;
  }
  else if (findState.open && document.activeElement === document.getElementById('fQ') && key === 'Enter'){
    e.preventDefault(); findGo(e.shiftKey ? -1 : 1); return;
  }
  else if (key === 'F3'){ e.preventDefault(); findGo(e.shiftKey ? -1 : 1); return; }
  else if (PAIR_CLOSE[key] || QUOTE_CH[key] === 1){
    var s = t.selectionStart, en = t.selectionEnd;
    if (en > s){
      // 选中内容 + 输入成对符号 = 自动包裹
      var close = PAIR_CLOSE[key] || key;
      e.preventDefault();
      var body = t.value.slice(s, en);
      t.value = t.value.slice(0, s) + key + body + close + t.value.slice(en);
      try { t.setSelectionRange(s, s + body.length + 2); } catch (x) {}
      changed = true;
    } else if (PAIR_CLOSE[key]){
      e.preventDefault();
      var nx = t.value.charAt(s);
      var typed = (nx === PAIR_CLOSE[key]) ? '' : PAIR_CLOSE[key];
      t.value = t.value.slice(0, s) + key + typed + t.value.slice(en);
      try { t.setSelectionRange(s + 1, s + 1); } catch (x2) {}
      changed = true;
    } else {
      // 引号：后面是空白/行尾才补另一半，避免在单词中间插入难打
      var prev = t.value.charAt(s - 1);
      var nxt = t.value.charAt(s);
      var wordChar = function(c){ return c && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_'); };
      if (wordChar(prev) && wordChar(nxt)) return;
      e.preventDefault();
      t.value = t.value.slice(0, s) + key + key + t.value.slice(en);
      try { t.setSelectionRange(s + 1, s + 1); } catch (x3) {}
      changed = true;
    }
  }
  if (changed){ markEdited(); }
}

// ================= 侧栏宽度：拖拽 / 自适应 =================
// 目录树里名字被省略号截断，根本原因就是侧栏固定 256px。所以做成可拖拽，
// 另外给一个"按最长文件名自适应"的按钮 —— 一键把侧栏撑到刚好装下最长的名字。
var SIDE_MIN = 200, SIDE_MAX = 620, SIDE_DEF = 256, SIDE_KEY = 'cfwtxt_sidew';

function sideW(){
  var v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
  return (v > 0) ? v : SIDE_DEF;
}
function reflowEditor(){
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}
function setSideW(px, noSave){
  var w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(px || SIDE_DEF)));
  document.documentElement.style.setProperty('--side-w', w + 'px');
  if (!noSave){ try { localStorage.setItem(SIDE_KEY, String(w)); } catch (e) {} }
  reflowEditor();
  return w;
}
// 量出目录树里"最宽的一行"真正需要的宽度：
// 行内其它部件（三角/图标/徽标/数量/操作）的合计宽 + 完整文件名宽 + 该行的缩进。
// 名字的完整宽度直接读 scrollWidth —— 元素上挂着 overflow:hidden，滚动宽度就是未截断的宽度。
function fitSideW(){
  var box = document.getElementById('sideScroll');
  var asideEl = document.querySelector('aside');
  if (!box || !asideEl) return sideW();
  var rows = box.querySelectorAll('.trow');
  if (!rows.length) return sideW();
  var asideL = asideEl.getBoundingClientRect().left;
  var need = 0;
  for (var i = 0; i < rows.length; i++){
    var row = rows[i];
    var name = row.querySelector('.tname');
    if (!name) continue;
    var others = row.offsetWidth - name.offsetWidth;
    var want = others + name.scrollWidth;
    var leftOff = row.getBoundingClientRect().left - asideL;
    if (leftOff + want > need) need = leftOff + want;
  }
  if (!need) return sideW();
  return setSideW(need + 16);
}

var gripDrag = null;
function onGripMove(e){
  if (!gripDrag) return;
  e.preventDefault();
  setSideW(gripDrag.w + (e.clientX - gripDrag.x), true);
}
function endGrip(){
  if (!gripDrag) return;
  gripDrag = null;
  var g = document.getElementById('sideGrip');
  if (g) g.classList.remove('on');
  document.body.classList.remove('grip-ing');
  window.removeEventListener('pointermove', onGripMove);
  window.removeEventListener('pointerup', endGrip);
  try { localStorage.setItem(SIDE_KEY, String(sideW())); } catch (e) {}
  reflowEditor();
}
function onGripDown(e){
  if (e.pointerType && e.pointerType !== 'mouse') return;   // 触屏交给页面滚动
  e.preventDefault();
  gripDrag = { x: e.clientX, w: sideW() };
  var g = document.getElementById('sideGrip');
  if (g) g.classList.add('on');
  document.body.classList.add('grip-ing');
  window.addEventListener('pointermove', onGripMove);
  window.addEventListener('pointerup', endGrip);
}
function onGripKey(e){
  var step = e.shiftKey ? 40 : 12;
  if (e.key === 'ArrowLeft'){ e.preventDefault(); setSideW(sideW() - step); }
  else if (e.key === 'ArrowRight'){ e.preventDefault(); setSideW(sideW() + step); }
  else if (e.key === 'Home'){ e.preventDefault(); setSideW(SIDE_DEF); }
  else if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toast('已按内容自适应到 ' + fitSideW() + 'px'); }
}

// ================= 列表排序 =================
var SORT_STORE = 'cfwtxt_sort';
var SORT_LABEL = { name: '名称', type: '类型', size: '大小', time: '修改时间' };
// 第一次点某一列时给"最有用的方向"：大小和时间默认从大到小，名称和类型默认正序
var SORT_FIRST_DESC = { name: false, type: false, size: true, time: true };

function loadSort(){
  var s = { by: 'name', desc: false };
  try {
    var raw = localStorage.getItem(SORT_STORE);
    if (raw){
      var d = JSON.parse(raw);
      if (d && SORT_LABEL[d.by]){ s.by = d.by; s.desc = !!d.desc; }
    }
  } catch (e) {}
  return s;
}
function saveSort(){
  try { localStorage.setItem(SORT_STORE, JSON.stringify(state.sort)); } catch (e) {}
}
function setSort(by, forceDesc){
  if (!SORT_LABEL[by]) return;
  if (forceDesc == null){
    if (state.sort.by === by) state.sort.desc = !state.sort.desc;
    else { state.sort.by = by; state.sort.desc = !!SORT_FIRST_DESC[by]; }
  } else {
    state.sort.by = by;
    state.sort.desc = !!forceDesc;
  }
  saveSort();
  return load(state.path);
}
function sortArrow(by){
  if (state.sort.by !== by) return '';
  return '<span class="sar">' + (state.sort.desc ? '↓' : '↑') + '</span>';
}
function sortTh(key, label, style){
  return '<th class="sortable' + (key === 'name' ? '' : ' hide-s') + '" data-sortby="' + key + '"' +
    (style ? ' style="' + style + '"' : '') + ' title="按' + SORT_LABEL[key] + '排序（再点一次切换升降序）">' +
    label + sortArrow(key) + '</th>';
}
function sortBarHtml(){
  var h = '<span class="sp"></span><span class="sortBox">' +
    '<select id="sortBy" title="排序字段">';
  for (var k in SORT_LABEL){
    h += '<option value="' + k + '"' + (state.sort.by === k ? ' selected' : '') + '>' + SORT_LABEL[k] + '</option>';
  }
  h += '</select>' +
    '<button class="wtog' + ' on" id="sortDir" title="点击切换升序 / 降序">' +
    (state.sort.desc ? '↓ 降序' : '↑ 升序') + '</button></span>';
  return h;
}
function bindSortBar(){
  var sel = document.getElementById('sortBy');
  if (sel) sel.onchange = function(){ setSort(sel.value, SORT_FIRST_DESC[sel.value]); };
  var dir = document.getElementById('sortDir');
  if (dir) dir.onclick = function(){ setSort(state.sort.by, !state.sort.desc); };
}

// 类型列的可读名称（比只有徽标更直白，也顺手把宽屏上空出来的地方用起来）
var TYPE_BY_CAT = { doc: '文档', data: '数据表', cfg: '配置', web: '网页', media: '媒体', code: '代码', other: '文件' };
function typeLabel(name, ct){
  var ext = extOf(name);
  var c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (ext === 'pdf' || c === 'application/pdf') return 'PDF';
  if (c.indexOf('image/') === 0 || EXT_MEDIA_IMG[ext]) return '图片';
  if (c.indexOf('video/') === 0 || EXT_MEDIA_VID[ext]) return '视频';
  if (c.indexOf('audio/') === 0 || EXT_MEDIA_AUD[ext]) return '音频';
  if (EXT_ARCHIVE[ext]) return '压缩包';
  if (c.indexOf('application/vnd.openxmlformats') === 0) return 'Office 文档';
  if (!ext) return '无扩展名';
  return TYPE_BY_CAT[extCat(name, ct)] || '文件';
}

// ================= 框选多选 =================
// 在列表区域按住鼠标拖出一个矩形，与它相交的行会被勾上（Ctrl/Shift 为加选）。
// 4px 抖动阈值：没越过就当成普通点击，点文件照样打开。
var marq = null;

function marqRows(){
  var list = document.getElementById('list');
  return list ? [].slice.call(list.querySelectorAll('tbody tr')) : [];
}
function applyMarq(l, t, r, b){
  var next = {};
  if (marq && marq.additive){ for (var k in marq.base) next[k] = marq.base[k]; }
  var rows = marqRows();
  for (var i = 0; i < rows.length; i++){
    var tr = rows[i];
    var cb = tr.querySelector('input.ck');
    if (!cb) continue;
    var rr = tr.getBoundingClientRect();
    // 矩形与行相交即命中（只看纵向重叠就够，横向整行都算）
    if (rr.bottom < t || rr.top > b || rr.right < l || rr.left > r) continue;
    next[cb.getAttribute('data-ck')] = {
      path: joinPath(state.path, cb.getAttribute('data-ckname')),
      isDir: cb.getAttribute('data-ckdir') === '1'
    };
  }
  state.sel = next;
  paintSel();
  syncSelection();
}
function onMarqMove(e){
  if (!marq) return;
  var dx = e.clientX - marq.x0, dy = e.clientY - marq.y0;
  if (!marq.moved){
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;      // 抖动阈值
    marq.moved = true;
    document.body.classList.add('marq-ing');
    try { if (window.getSelection) window.getSelection().removeAllRanges(); } catch (x) {}
  }
  e.preventDefault();
  if (!marq.box){
    marq.box = document.createElement('div');
    marq.box.className = 'marq';
    marq.box.id = 'marqBox';
    document.body.appendChild(marq.box);
  }
  var l = Math.min(marq.x0, e.clientX), tt = Math.min(marq.y0, e.clientY);
  var w = Math.abs(dx), h = Math.abs(dy);
  marq.box.style.left = l + 'px';
  marq.box.style.top = tt + 'px';
  marq.box.style.width = w + 'px';
  marq.box.style.height = h + 'px';
  // 拖动时每帧最多重算一次，避免几百行被 pointermove 打爆
  marq.pending = [l, tt, l + w, tt + h];
  if (!marq.raf){
    marq.raf = requestAnimationFrame(function(){
      if (!marq) return;
      marq.raf = 0;
      if (marq.pending) applyMarq(marq.pending[0], marq.pending[1], marq.pending[2], marq.pending[3]);
    });
  }
}
function endMarq(){
  window.removeEventListener('pointermove', onMarqMove);
  window.removeEventListener('pointerup', endMarq);
  if (marq && marq.box && marq.box.parentNode) marq.box.parentNode.removeChild(marq.box);
  document.body.classList.remove('marq-ing');
  marq = null;
}
function onMarqDown(e){
  if (RO || state.view !== 'list') return;
  if (e.button !== 0) return;
  if (e.pointerType && e.pointerType !== 'mouse'){ lpStart(e); return; }   // 触屏：长按进多选（拖框在手指上不成立）
  var t = e.target;
  if (t && t.closest && t.closest('a,button,input,select,label,option')) return;
  if (!marqRows().length) return;
  marq = {
    x0: e.clientX, y0: e.clientY, moved: false, box: null, raf: 0, pending: null,
    base: {}, additive: !!(e.ctrlKey || e.metaKey || e.shiftKey)
  };
  if (marq.additive){ for (var k in state.sel) marq.base[k] = state.sel[k]; }
  window.addEventListener('pointermove', onMarqMove);
  window.addEventListener('pointerup', endMarq);
}

// Shift + 点击勾选框 = 从上次点到这次之间的行全部选中
function rangeSelect(currentKey){
  var boxes = [].slice.call(document.querySelectorAll('#list input.ck'));
  var from = -1, to = -1;
  for (var i = 0; i < boxes.length; i++){
    var k = boxes[i].getAttribute('data-ck');
    if (k === state.lastPick) from = i;
    if (k === currentKey) to = i;
  }
  if (from < 0 || to < 0) return false;
  var a = Math.min(from, to), b = Math.max(from, to);
  for (var j = a; j <= b; j++){
    var bx = boxes[j];
    state.sel[bx.getAttribute('data-ck')] = {
      path: joinPath(state.path, bx.getAttribute('data-ckname')),
      isDir: bx.getAttribute('data-ckdir') === '1'
    };
  }
  paintSel();
  syncSelection();
  return true;
}

// ===== 文件打开 =====
function openPath(path){
  var name = path.split('/').pop();
  var dir = path.split('/').slice(0, -1).join('/');
  if (dir === state.path) { openFile(name); return; }
  markOpen(dir);
  // 关键优化：以前是 list → 等它完成 → openFile → read，**两次请求串行**，
  // 点树里的文件要等两个来回才出内容，这就是那"一丝丝卡顿"的来源。
  // 现在先把 state.path 切过去，read（打开文件）与 list（只负责刷新列表视图）**并行**发出 ——
  // 打开文件的延迟直接减半；列表数据回来时用户多半已经停在编辑器里了。
  state.path = dir;
  state.sel = {};
  state.lastPick = null;
  var opener = openFile(name);              // 立即切编辑器并发起 read
  api('list', { path: dir }).then(function(d){
    state.folders = d.folders || [];
    state.files = d.files || [];
    if (state.view === 'list') renderList();
    renderSide();
    revealInTree(dir);
  }).catch(function(e){ toast('打开失败：' + e.message); });
  return opener;
}

function openFile(name){
  var meta = metaFor(name);
  var kind = kindOf(name, meta.ct);
  // HTML 是 text/*，本来会落进"打开编辑器"，但 HTML 的价值在于**看到渲染效果**。
  // 只读端（分享访客）没有编辑器，直接给预览；管理端仍然打开编辑器 —— 那是唯一能改
  // HTML 的地方，不能为了预览把编辑能力换掉。编辑器里另给了"预览"按钮。
  if (kind === 'html' && RO){ openViewer(joinPath(state.path, name)); return; }
  if (isText(name, meta.ct)){
    if (RO) openViewer(joinPath(state.path, name));
    else openEditor(name);
    return;
  }
  // 图片 / 音视频 / PDF：开灯箱预览，不再只能下载
  if (PREVIEW_KINDS[kind]){ openMediaModal(joinPath(state.path, name), name); return; }
  location.href = dlUrl(name);
}

// ===== 媒体预览（灯箱）=====
// 用 blob: + <img>/<video>/<audio>/<iframe>，不发新窗口，也不依赖 object-src。
// 关闭时立刻 revokeObjectURL，避免大图长期占内存。
var mediaUrl = null;
function revokeMedia(){
  if (mediaUrl){ try { URL.revokeObjectURL(mediaUrl); } catch (e) {} mediaUrl = null; }
}

function openMediaModal(path, name){
  revokeMedia();
  var kind = kindOf(name, '');
  var scale = 1, rot = 0;
  showModal({
    title: name || path.split('/').pop(),
    noOk: true, cancelText: '关闭',
    body: '<div class="mediaBar">' +
      '<span class="rawNote" style="margin:0;flex:1" id="mbInfo">载入中…</span>' +
      (kind === 'image' ? '<button class="btn sm" id="mbOut">缩小</button>' +
        '<button class="btn sm" id="mbIn">放大</button>' +
        '<button class="btn sm" id="mbRot">旋转</button>' +
        '<button class="btn sm" id="mbRst">复位</button>' : '') +
      '<button class="btn sm" id="mbDl">下载</button>' +
      '</div><div id="mbBox"></div>',
    after: function(){
      var box = document.getElementById('mbBox');
      var info = document.getElementById('mbInfo');
      document.getElementById('mbDl').onclick = function(){ location.href = dlUrl('', path); };
      req(BASE + '/api?action=raw&path=' + encodeURIComponent(path)).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ct = r.headers.get('Content-Type') || '';
        return r.blob().then(function(b){ return { b: b, ct: ct }; });
      }).then(function(o){
        if (!o.b.size && o.b.size !== 0) throw new Error('空响应');
        mediaUrl = URL.createObjectURL(o.b);
        if (kind === 'image'){
          box.innerHTML = '<div class="mediaBox"><img id="mbImg" alt=""></div>';
          var img = document.getElementById('mbImg');
          img.src = mediaUrl;
          img.onerror = function(){ info.textContent = '这个文件不是有效的图片，无法预览'; };
          img.onload = function(){
            info.textContent = fmtSize(o.b.size) + ' · ' + img.naturalWidth + '×' + img.naturalHeight;
          };
          var apply = function(){ img.style.transform = 'scale(' + scale + ') rotate(' + rot + 'deg)'; };
          document.getElementById('mbOut').onclick = function(){ scale = Math.max(0.2, scale - 0.2); apply(); };
          document.getElementById('mbIn').onclick = function(){ scale = Math.min(6, scale + 0.2); apply(); };
          document.getElementById('mbRot').onclick = function(){ rot = (rot + 90) % 360; apply(); };
          document.getElementById('mbRst').onclick = function(){ scale = 1; rot = 0; apply(); };
          img.onclick = function(){ scale = scale > 1 ? 1 : 2; apply(); };
        } else if (kind === 'av'){
          if (o.ct.indexOf('audio/') === 0){
            box.innerHTML = '<div class="mediaBox"><audio id="mbAV" controls></audio></div>';
            info.textContent = fmtSize(o.b.size) + ' · 音频';
          } else {
            box.innerHTML = '<div class="mediaBox"><video id="mbAV" controls playsinline></video></div>';
            info.textContent = fmtSize(o.b.size) + ' · 视频';
          }
          var av = document.getElementById('mbAV');
          av.src = mediaUrl;
          av.onloadedmetadata = function(){
            info.textContent = fmtSize(o.b.size) + (av.duration ? ' · 时长 ' + Math.round(av.duration) + ' 秒' : '');
          };
        } else if (kind === 'pdf'){
          box.innerHTML = '<div class="frameBox" style="min-height:66vh"><iframe id="mbF"></iframe></div>';
          info.textContent = fmtSize(o.b.size) + ' · PDF';
          document.getElementById('mbF').src = mediaUrl;
        } else {
          info.textContent = '这个类型不支持在线预览，请下载后查看';
        }
      }).catch(function(e){
        if (info) info.textContent = '预览失败：' + e.message;
      });
    }
  });
}

// ===== 只读查看器（访客专用）=====
// 用 <pre> 而不是 <textarea>：不能输入、不弹键盘、没有光标闪烁，
// 一眼就知道是"看"而不是"改"，但文字照样可以选中复制。
// 在此基础上再叠一层渲染：md/json/csv/代码默认给渲染视图，右上角可切回源码。
var viewerText = '';
var viewerState = { rich: false, mode: 'rich', name: '', text: '', gated: false };

// 大 HTML 不自动渲染：1.8MB 实测 iframe 解析约 1s，先给源码，用户点了「渲染」再建。
// 只卡 HTML —— md/json/csv/代码的渲染都便宜，照旧直接出结果。
var VIEW_RENDER_MAX = 512 * 1024;

function paintViewerSeg(){
  var seg = document.getElementById('vSeg');
  if (!seg) return;
  if (!viewerState.rich){ seg.innerHTML = ''; return; }
  var rich = viewerState.mode === 'rich';
  var tip = viewerState.gated ? ' title="文件较大，渲染可能需要一会儿"' : '';
  seg.innerHTML = '<span class="vseg">' +
    '<button data-vmode="rich"' + (rich ? ' class="on"' : '') + tip + '>渲染</button>' +
    '<button data-vmode="src"' + (rich ? '' : ' class="on"') + '>源码</button></span>';
}

function applyViewerMode(){
  var rich = viewerState.rich && viewerState.mode === 'rich';
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  if (rbox) rbox.hidden = !rich;
  if (box){
    box.hidden = !!rich;
    box.className = 'viewer' + (wrapOn ? ' wrapon' : ' wrapoff');
  }
  var wb = document.getElementById('vWrap');
  if (wb) wb.hidden = !!rich;
  paintViewerSeg();
}

// 大文件按需渲染：只有用户点了「渲染」才真正把 iframe 建起来，之前一直是空的
function viewerRenderNow(){
  if (!viewerState.rich || !viewerState.gated) return;
  var rbox = document.getElementById('vRender');
  if (!rbox || rbox.innerHTML) return;
  var rr = renderInto(rbox, viewerState.name, '', viewerState.text, viewerState.docSrc);
  if (!rr) viewerState.rich = false;      // 渲染不出来就别露出空的渲染层
}

// 把一份文本画进查看器 —— 缓存命中 / 网络取回 / 后台校验 共用这一条路径
function paintViewerContent(path, text, enc, status){
  var name = path.split('/').pop();
  viewerText = text;
  viewerState.text = text;
  viewerState.name = name;
  // 分享页里预览 HTML：iframe 加载同一个分享范围内的"真文档"（?doc=1，注入过 base），
  // 这样页面自己的 css / 图片才会加载 —— 与单文件分享直链的渲染方式完全一致。
  viewerState.docSrc = kindOf(name, '') === 'html' ? (BASE + '/' + encPath(path) + '?doc=1') : '';
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  var note = document.getElementById('vNote');
  var gated = kindOf(name, '') === 'html' && text.length > VIEW_RENDER_MAX;
  viewerState.gated = gated;
  if (note){
    if (gated){
      note.innerHTML = '<div class="rawNote">文件较大（' + fmtSize(text.length) +
        '），为避免卡顿默认显示源码；点右上角 <b>渲染</b> 可预览。</div>';
    } else if (enc && enc !== 'utf-8'){
      note.innerHTML = '<div class="rawNote">检测到 <b>' + E(enc) + '</b> 编码，已自动按 UTF-8 显示。</div>';
    } else {
      note.innerHTML = '';
    }
  }
  if (gated){
    if (rbox){ rbox.innerHTML = ''; rbox.hidden = true; rbox.className = 'rBox'; }
    viewerState.rich = true;              // 有渲染能力，露出「渲染 / 源码」切换
    viewerState.mode = 'src';
  } else {
    var rr = renderInto(rbox, name, '', text, viewerState.docSrc);
    viewerState.rich = !!rr;
    viewerState.mode = 'rich';
  }
  // 无论是否渲染，都把原文放进 <pre> —— 切到"源码"才有东西看（原样纯文本，不挂网址图标）
  if (box){ box.textContent = text; box.scrollTop = 0; }
  applyWrap();
  applyViewerMode();
  var c = document.getElementById('vCount');
  if (c) c.textContent = (text ? text.split('\n').length : 0) + ' 行 · ' + text.length + ' 字符';
  setStatus(status || '已载入');
}

function openViewer(path){
  var name = path.split('/').pop();
  switchView('edit');
  ed.path = path; ed.name = name; ed.dirty = false;
  revokeMedia();

  viewerState = { rich: false, mode: 'rich', name: name, text: '' };
  var box = document.getElementById('viewer');
  var rbox = document.getElementById('vRender');
  var note = document.getElementById('vNote');
  var nameEl = document.getElementById('vName');
  if (nameEl) nameEl.textContent = name;
  if (box){ box.hidden = false; box.textContent = '载入中…'; }
  // className 也要一起复位：renderInto 给 HTML 预览加的 htmlBox（padding:0 + overflow:hidden）
  // 会残留到下一个文件。先看完一个 HTML 再打开 Markdown，那层 padding:0 会把渲染结果贴边、滚动也坏掉。
  if (rbox){ rbox.hidden = true; rbox.innerHTML = ''; rbox.className = 'rBox'; }
  if (note) note.innerHTML = '';
  var cnt = document.getElementById('vCount');
  if (cnt) cnt.textContent = '';
  applyViewerMode();
  renderViewerMeta(path);
  try { document.title = name + ' · 只读分享'; } catch (e) {}
  setStatus('载入中…');

  // 内存缓存命中：先秒出内容，再后台拿 ETag 校验。
  // 分享内容只在"发布"时变，绝大多数是 304 —— 相当于白拿一次即时打开。
  var cached = fileCacheGet(path);
  if (cached){
    paintViewerContent(path, cached.text, cached.enc, '已载入（内存缓存）');
    refreshTreeSel();
    revealInTree(path);
    revalidateViewer(path, cached);
    return;
  }

  return req(BASE + '/api?action=read&path=' + encodeURIComponent(path))
    .then(function(r){
      if (r.ok){
        var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
        var etag = r.headers ? (r.headers.get('ETag') || '') : '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      }
      return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error(d.error || ('HTTP ' + r.status)); });
    })
    .then(function(o){
      fileCachePut(path, o.t, o.enc, o.etag);
      paintViewerContent(path, o.t, o.enc, '已载入');
      refreshTreeSel();
      revealInTree(path);
    })
    .catch(function(e){
      var el = document.getElementById('viewer');
      if (el){ el.hidden = false; el.textContent = '打开失败：' + e.message; }
      var rb = document.getElementById('vRender');
      if (rb) rb.hidden = true;
      setStatus('打开失败');
    });
}

function renderViewerMeta(path){
  var name = path.split('/').pop();
  var dir = path.split('/').slice(0, -1).join('/');
  var m = (dir === state.path) ? metaFor(name) : {};
  var box = document.getElementById('vMeta');
  if (!box) return;
  var parts = [];
  if (m.size != null) parts.push(fmtSize(m.size));
  if (m.mtime) parts.push(fmtTime(m.mtime));
  box.textContent = parts.join(' · ');
}

function setStatus(msg){
  var el = document.getElementById('edtStatus');
  if (el) el.textContent = msg || '';
}

function updateCount(){
  var t = document.getElementById('edt');
  var c = document.getElementById('edtCount');
  if (!t || !c) return;
  var v = t.value;
  var lines = v ? v.split('\n').length : 0;
  var words = v ? (v.match(/[A-Za-z0-9_]+/g) || []).length : 0;
  var sel = 0;
  try { sel = Math.max(0, t.selectionEnd - t.selectionStart); } catch (e) {}
  var parts = [lines + ' 行', v.length + ' 字符'];
  if (words) parts.push(words + ' 单词');
  if (sel) parts.push('已选 ' + sel + ' 字符');
  c.textContent = parts.join(' · ');
}

// 只改行号槽的"当前行"高亮，不重建 DOM
function paintGutCur(){
  var t = document.getElementById('edt');
  var gi = document.getElementById('edGutterIn');
  if (!t || !gi) return;
  var cur = -1;
  try { cur = t.value.slice(0, t.selectionStart).split('\n').length - 1; } catch (e) { return; }
  var nums = gi.children;
  for (var i = 0; i < nums.length; i++){
    var on = (i === cur);
    if (nums[i].classList.contains('cur') !== on) nums[i].classList.toggle('cur', on);
  }
}

// ===== 文件内容缓存：打开过的文件留在内存里，重复打开瞬时 =====
// 为什么需要：read 每次都是"浏览器 → 边缘 → R2"的一次完整网络往返，
// 真实网络里小文件 150~300ms、大文件 300~800ms —— 这才是"点文件不够丝滑"的主因
// （实测前端渲染 669KB 也只要 ~17ms，浏览器侧根本不吃时间）。
// 策略：LRU（按字节封顶 + 条数封顶），命中先秒出内容，**同时后台拿 ETag 校验**，
// 真变了才热替换并提示 —— 既快又不会看到过期内容。
var fileCache = {
  map: {},            // path -> { text, enc, etag, bytes }
  order: [],          // LRU：末尾最新
  bytes: 0,
  cap: 8 * 1024 * 1024,
  maxItems: 30
};

function fileCacheGet(path){
  var e = fileCache.map[path];
  if (!e) return null;
  var i = fileCache.order.indexOf(path);
  if (i >= 0){ fileCache.order.splice(i, 1); fileCache.order.push(path); }
  return e;
}
function fileCachePut(path, text, enc, etag){
  if (!path || text == null) return;
  var old = fileCache.map[path];
  if (old) fileCache.bytes -= old.bytes;
  var bytes = text.length * 2;      // JS 字符串按 2 字节/字符粗算
  fileCache.bytes += bytes;
  fileCache.map[path] = { text: text, enc: enc || '', etag: etag || '', bytes: bytes };
  var i = fileCache.order.indexOf(path);
  if (i >= 0) fileCache.order.splice(i, 1);
  fileCache.order.push(path);
  // 淘汰：条数或字节超限时，从最久未用的开始丢（当前正在看的那个永不丢）
  while ((fileCache.order.length > fileCache.maxItems || fileCache.bytes > fileCache.cap) && fileCache.order.length > 1){
    var victim = fileCache.order[0];
    if (victim === ed.path) break;
    fileCache.order.shift();
    var v = fileCache.map[victim];
    if (v){ fileCache.bytes -= v.bytes; delete fileCache.map[victim]; }
  }
}
function fileCacheDel(path){
  var v = fileCache.map[path];
  if (!v) return;
  fileCache.bytes -= v.bytes;
  delete fileCache.map[path];
  var i = fileCache.order.indexOf(path);
  if (i >= 0) fileCache.order.splice(i, 1);
}
// 删除 / 改名 / 移动一个目录后，把该目录下的缓存一并清掉
function fileCacheDelPrefix(dir){
  if (!dir){ fileCache.map = {}; fileCache.order = []; fileCache.bytes = 0; return; }
  var pre = dir + '/';
  var keys = Object.keys(fileCache.map);
  for (var i = 0; i < keys.length; i++){
    if (keys[i] === dir || keys[i].indexOf(pre) === 0) fileCacheDel(keys[i]);
  }
}

// 后台校验：拿缓存里的 ETag 问一次"变了没"。304 就静默；变了才更新缓存，
// 并且只在用户还停在这个文件、且他自己没改过时，才热替换编辑器内容。
function revalidateFile(rel, cached){
  var init = { cache: 'no-store' };
  if (cached && cached.etag) init.headers = { 'If-None-Match': cached.etag };
  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel), init)
    .then(function(r){
      if (r.status === 304) return null;                  // 没变，缓存继续有效
      if (!r.ok) return null;
      var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
      var etag = r.headers ? (r.headers.get('ETag') || '') : '';
      return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
    })
    .then(function(o){
      if (!o) return;
      fileCachePut(rel, o.t, o.enc, o.etag);
      var t = document.getElementById('edt');
      if (ed.path === rel && !ed.dirty && t && t.value !== o.t){
        t.value = o.t;
        updateCount(); syncGutter(); paintEdSeg(); renderHl();
        setStatus('已载入 · 已在别处更新，已刷新为最新内容');
        toast('该文件已在别处更新，已刷新');
      }
    })
    .catch(function(){});
}

// 只读查看器的后台校验：缓存先秒出，再问一次 ETag 是不是过期。
// 单独一份（不复用 revalidateFile）是因为这里只重画查看器，不碰编辑器的 DOM。
function revalidateViewer(rel, cached){
  var init = { cache: 'no-store' };
  if (cached && cached.etag) init.headers = { 'If-None-Match': cached.etag };
  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel), init)
    .then(function(r){
      if (r.status === 304) return null;                  // 没变，缓存继续有效
      if (!r.ok) return null;
      var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
      var etag = r.headers ? (r.headers.get('ETag') || '') : '';
      return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
    })
    .then(function(o){
      if (!o) return;
      fileCachePut(rel, o.t, o.enc, o.etag);
      // 用户已经切到别的文件、或内容其实没变，就不动界面（避免白白重渲染大页面）
      if (ed.path !== rel || viewerText === o.t) return;
      paintViewerContent(rel, o.t, o.enc, '已载入 · 已在别处更新，已刷新为最新内容');
    })
    .catch(function(){});
}

// ===== 悬停预取（桌面端）：鼠标在文件上停 130ms 就把内容取回来 =====
// 这样点下去时缓存已经命中，**连第一次打开都是瞬时的**。
// 触屏设备没有 hover，直接跳过（用 hover:none + pointer:coarse 判断，
// 与样式表里 #btnUpDir 的写法保持一致）。
var pfTimer = null, pfPath = '', pfBusy = 0;
function prefetchFile(path){
  if (!path || RO) return;
  try {
    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  } catch (e) {}
  if (fileCacheGet(path)) return;
  if (path === pfPath && pfTimer) return;
  clearTimeout(pfTimer);
  pfPath = path;
  pfTimer = setTimeout(function(){
    pfTimer = null;
    if (pfBusy >= 2) return;                 // 最多 2 个预取并行，别和用户真正要的请求抢带宽
    pfBusy++;
    req(BASE + '/api?action=read&path=' + encodeURIComponent(path))
      .then(function(r){
        if (!r.ok) return null;
        var len = parseInt(r.headers.get('Content-Length') || '0', 10);
        if (len && len > 262144) return null;   // 只预取小文本，避免白耗流量
        var enc = r.headers.get('X-Text-Encoding') || '';
        var etag = r.headers.get('ETag') || '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      })
      .then(function(o){
        if (o && o.t.length <= 262144) fileCachePut(path, o.t, o.enc, o.etag);
      })
      .catch(function(){})
      .then(function(){ pfBusy--; });
  }, 130);
}

function renderEdContent(rel, name, text, enc, fromCache){
  ed.path = rel; ed.name = name; ed.dirty = false;
  updPubBtn();                  // 换了文件 → 「发布」按钮按新路径重判（缓存命中的路径不走 renderEditOps 之后那步）
  var t = document.getElementById('edt');
  t.value = text;
  ed.savedText = text;          // 载入的就是"与云端一致的基线"，之后只跟它比
  t.classList.remove('edt-loading');
  t.style.fontSize = edFont + 'px';
  updateCount();
  setStatus(enc && enc !== 'utf-8'
    ? ('已载入 · 原编码 ' + enc + '，保存后将转为 UTF-8')
    : (fromCache ? '已载入（内存缓存）' : '已载入'));
  refreshTreeSel();
  syncGutter();
  paintEdSeg();
  renderHl();                       // 正文换了，网址链接要跟着重画
  // Markdown 大纲解析对长文有成本，且不是首屏必需 —— 延后一帧，
  // 让正文先完整呈现（打开更"跟手"）；期间切换了文件就不再跑
  setTimeout(function(){ if (ed.path === rel && !ed.preview) mdOutline(); }, 0);
  // 从搜索结果打开的文件：把搜索词带进来高亮，直接回答"这个词在文里哪一处"。
  // 深搜跳行（pendingGoLine）优先 —— 那时光标已经定位到用户点的那一行，
  // 别让"滚到第一处"把滚动位置抢走，所以只在没有待跳行时才自动滚动。
  if (searchState && searchState.terms && searchState.terms.length && !ed.preview){
    try {
      highlightSearchTerms(searchState.terms, {
        scroll: pendingGoLine == null,
        word: !!(searchState.pq && searchState.pq.word)
      });
    } catch (e) {}
  }
  // 深搜结果点击跳行：文件载入完成后把光标/滚动定位到那一行。
  // 这是用户主动点击的结果，这里 focus 是符合预期的（不同于打开文件时的静默）。
  if (pendingGoLine != null){
    var goLn = pendingGoLine; pendingGoLine = null;
    try { editorGoLine(goLn); } catch (e) {}
  }
  offerDraft(rel, text);
}

function openEditor(name){
  var rel = joinPath(state.path, name);
  // 换文件先把上一次的预览/查找状态收干净
  ed.preview = false;
  var pv = document.getElementById('edPrev');
  if (pv){ pv.hidden = true; pv.innerHTML = ''; }
  var row = document.getElementById('edRow');
  if (row) row.hidden = false;
  closeFind(true);          // 只清状态，不抢焦点（手机上会弹键盘）

  // —— 缓存命中：0 等待，立即渲染，后台再校验 ——
  var cached = fileCacheGet(rel);
  if (cached){
    setStatus('载入中…');
    switchView('edit');
    renderEdCrumb(rel);
    renderEditOps(name);
    var t0 = document.getElementById('edt');
    t0.classList.remove('edt-loading');
    renderEdContent(rel, name, cached.text, cached.enc, true);
    revalidateFile(rel, cached);
    return;
  }

  setStatus('载入中…');
  switchView('edit');
  renderEdCrumb(rel);            // 此刻 ed.path 还没赋值，直接把目标路径传进去
  var tedEl = document.getElementById('edt');
  tedEl.value = '';
  tedEl.classList.add('edt-loading');   // 半透明 = "正在取内容"，而不是"卡住了"
  document.getElementById('edtCount').textContent = '0 行';
  document.getElementById('edPrev') && (document.getElementById('edPrev').hidden = true);
  renderEditOps(name);
  paintEdSeg(name);

  req(BASE + '/api?action=read&path=' + encodeURIComponent(rel))
    .then(function(r){
      if (r.ok){
        var enc = r.headers ? (r.headers.get('X-Text-Encoding') || '') : '';
        var etag = r.headers ? (r.headers.get('ETag') || '') : '';
        return r.text().then(function(t){ return { t: t, enc: enc, etag: etag }; });
      }
      return r.json().catch(function(){ return {}; }).then(function(d){ throw new Error(d.error || ('HTTP ' + r.status)); });
    })
    .then(function(o){
      fileCachePut(rel, o.t, o.enc, o.etag);      // 存进缓存，下次打开就是瞬时的
      renderEdContent(rel, name, o.t, o.enc, false);
    })
    .catch(function(e){
      var t = document.getElementById('edt');
      if (t) t.classList.remove('edt-loading');
      setStatus('打开失败：' + e.message);
      toast('打开失败：' + e.message);
    });
}

// 悬停预取的委托绑定：树节点、搜索结果（都带 data-openpath）、列表行都覆盖
document.addEventListener('mouseover', function(e){
  var t = e.target;
  if (!t || !t.closest) return;
  var node = t.closest('[data-openpath]');
  if (node){ prefetchFile(node.getAttribute('data-openpath')); return; }
  var tr = t.closest('#list tbody tr');
  if (tr){
    var a = tr.querySelector('a[data-open]');
    if (a && a.getAttribute('data-type') !== 'dir'){
      prefetchFile(joinPath(state.path, a.getAttribute('data-open')));
    }
  }
}, true);
document.addEventListener('mouseout', function(){
  if (pfTimer){ clearTimeout(pfTimer); pfTimer = null; pfPath = ''; }
}, true);

// 打开文件时如果本地还留着未保存的草稿，问一下要不要恢复
function offerDraft(rel, serverText){
  var d = loadDraft(rel);
  if (!d || d.t === serverText) return;
  var when = '';
  try { when = fmtTime(new Date(d.at).toISOString()); } catch (e) { when = ''; }
  showModal({
    title: '发现未保存的草稿', small: true, okText: '恢复草稿', cancelText: '用云端版本',
    body: '<div class="msg">「' + E(rel.split('/').pop()) + '」在本地有一份' + (when ? ('（' + E(when) + '）') : '') +
      '还没保存的修改，比云端版本' + (d.t.length > serverText.length ? '更长' : '不同') + '。<br>要恢复吗？</div>',
    onOk: function(){
      var t = document.getElementById('edt');
      t.value = d.t;
      ed.dirty = true;
      updateCount(); syncGutter(); mdOutline(); renderHl();
      setStatus('已恢复本地草稿（尚未保存）');
      toast('已恢复草稿，记得点保存');
    },
    after: function(){
      var cancel = document.getElementById('mCancel');
      if (cancel) cancel.onclick = function(){ clearDraft(rel); closeModal(); };
    }
  });
}

// 是不是 HTML 文档（决定要不要显示「抓附件」——只有 HTML 里才有 <a href> 可改写）
function isHtmlName(n){
  var e = extOf(n);
  return e === 'html' || e === 'htm' || e === 'xhtml';
}
function renderEditOps(name){
  var rel = joinPath(state.path, name);
  var h = '<button class="btn sm" id="edDl">下载</button>';
  if (!RO){
    h += '<button class="btn sm" id="edShare">分享</button>';
    // 「抓附件」只对 HTML 出现：它要把页面里的附件链接抓下来并改写 href，
    // 对 md / txt 这类文件没有意义（也没有 <a href> 可改写）。
    if (isHtmlName(name)) h += '<button class="btn sm" id="edAttach" title="把页面里“看起来像附件”的链接（文档 / 压缩包）抓下来存到同目录的 附件/ 下">抓附件</button>';
    h += '<button class="btn sm" id="edRename">重命名</button>';
    h += '<button class="btn sm" id="edMove">移动</button>';
    h += '<button class="btn sm" id="edDel">删除</button>';
  }
  h += '<button class="btn sm ghost" id="edBack">返回列表</button>';
  document.getElementById('editOps').innerHTML = h;
  document.getElementById('edDl').onclick = function(){ location.href = dlUrl(name, rel); };
  document.getElementById('edBack').onclick = function(){ tryLeaveEditor(function(){ load(state.path); }); };
  if (!RO){
    // 直接开分享弹窗（与列表行上的「分享」完全一致），点开就能生成链接。
    // 以前这里只是滚动到下方的"分享设置"面板 —— 用户点完以为没反应，还得自己往下找。
    document.getElementById('edShare').onclick = function(){ openShareModal(rel, false); };
    var at = document.getElementById('edAttach');
    if (at) at.onclick = function(){ collectAttach(); };
    document.getElementById('edRename').onclick = function(){ openRename(rel, false); };
    document.getElementById('edMove').onclick = function(){ openMove(rel, false); };
    document.getElementById('edDel').onclick = function(){ doDelete(rel, false); };
    // 「发布」按钮的可用状态。路径要显式传进去：此刻 ed.path 还是上一个文件。
    // 顺手把分享列表刷成最新的（15 秒 TTL 内不会重复请求），拉回来后再判一次。
    updPubBtn(rel);
    refreshShareCache(false).then(function(){ updPubBtn(rel); }, function(){ updPubBtn(rel); });
  }
}

function tryLeaveEditor(go){
  if (!ed.dirty) { ed.dirty = false; return go(); }
  showModal({
    title: '还有未保存的修改',
    small: true,
    okText: '放弃修改',
    cancelText: '继续编辑',
    body: '<div class="msg">「' + E(ed.name) + '」的修改还没保存，确定要离开吗？</div>',
    onOk: function(){ ed.dirty = false; go(); }
  });
}

// ---- 发布状态（会话内）----
// pubStale[path] = true 表示"草稿改过、还没重新发布"。保存时置位，发布成功时清掉。
// 只对**已被分享覆盖**的路径展示，免得给没分享的文件也挂个"待发布"误导人。
var pubStale = {};
function hhmm(){ return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function isSharedPath(p){
  if (RO || !p) return false;
  if (shareCount(p)) return true;
  var segs = p.split('/');
  for (var i = segs.length - 1; i > 0; i--){ if (shareCount(segs.slice(0, i).join('/'))) return true; }
  return false;
}
function pubSuffix(p){ return (p && pubStale[p] && isSharedPath(p)) ? ' · 待发布' : ''; }

// 「发布」按钮的可用状态：只有这个文件**真的会被分享页看到**才允许点 ——
// 文件本身被分享，或它所在的某个上级目录被分享（发布后分享页立刻更新）。
// 两者都没有时点下去只是往影子树里拷一份没人会读的内容、白花一次 R2 写，
// 所以置灰并说明原因（与文件右键菜单里那条判定完全一致，见 openCtxAt 的注释）。
// 同时把「分享」提成主按钮：唯一有意义的下一步，避免留下一个"点不动的死按钮"。
// 分享列表还没拉到之前**不改动**按钮状态：宁可保持原样，也不要给一个假的"置灰"。
// p 传了就用 p（renderEditOps 里 ed.path 还没赋值），否则用当前编辑的文件。
function updPubBtn(p){
  if (RO) return;
  var btn = document.getElementById('btnSave');
  if (!btn) return;
  if (!shareCache.loaded) return;
  var path = (p == null ? ed.path : p);
  var shared = !!(path && isSharedPath(path));
  btn.disabled = !shared;
  btn.title = shared
    ? '把当前文件发布到分享页；编辑会随时自动保存（Ctrl+S 也可立即保存）'
    : '这个文件还没有分享链接（也不在任何已分享的目录里），发布出去没人能看到 —— 先点右侧「分享」创建链接';
  var sh = document.getElementById('edShare');
  if (sh) sh.className = shared ? 'btn sm' : 'btn sm primary';
}

// ---- 保存到服务器（自动保存 / Ctrl+S / 发布前保存 共用）----
// 串行化：每次保存都排在上一次之后 —— 两次请求乱序时，旧响应不会把新内容盖回去。
// 取的是**执行时**的文本框内容，所以排队期间又敲的字会被最后一次一起存上。
var savePromise = Promise.resolve();
function saveEd(auto){
  if (RO) return Promise.resolve();
  var t = document.getElementById('edt');
  if (!t || !ed.path) return Promise.resolve();
  var run = function(){
    if (RO || !ed.path) return Promise.resolve();
    var myPath = ed.path, myVal = t.value, wasDirty = ed.dirty;
    // 【省请求的关键一步】正文和基线完全一致 → 什么都没改，直接把脏标撤掉。
    // 典型场景：打了个错字又删掉、Ctrl+Z 撤销回原样、复制粘贴再撤销。
    // 这些操作在旧逻辑下都会白白发一次 PUT（连带重写整份搜索索引），现在一个请求都不发。
    // savedText 为 null = 从没建立过基线（理论上不该发生），保守起见照常存。
    if (ed.savedText !== null && myVal === ed.savedText){
      ed.dirty = false;
      setStatus('未修改 ' + hhmm());
      return Promise.resolve();
    }
    var btn = document.getElementById('btnSave');
    if (btn) btn.disabled = true;
    setStatus('保存中…');
    return req(BASE + '/api?path=' + encodeURIComponent(myPath), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: myVal
    }).then(function(r){
      if (r.ok) return r.json();
      return r.text().then(function(x){ throw new Error(x); });
    }).then(function(){
      var same = (ed.path === myPath && t.value === myVal);   // 保存期间又改了 → 别清脏标
      if (same){ ed.dirty = false; ed.savedText = myVal; }     // 基线推进到刚存的内容
      if (wasDirty && same) pubStale[myPath] = true;          // 改过草稿 → 该文件进入"待发布"
      clearDraft(myPath);                                     // 存成功了就把本地草稿清掉
      fileCachePut(myPath, myVal, 'utf-8', '');               // 缓存同步成刚保存的内容（etag 置空，下次会重新取回）
      if (same) setStatus('已保存 ' + hhmm() + pubSuffix(myPath));
      if (!auto && same) toast('已保存');
      // 刻意**不**在这里重新拉 list：内容缓存已经同步，左栏要刷的话下次切目录/点刷新自然就准了。
      // 那次 list 是纯额外开销（一次 R2 list 操作），而自动保存是高频动作，省下来很值。
    }).catch(function(e){
      setStatus('保存失败');
      if (!auto) toast('保存失败：' + e.message);
    }).finally(function(){ updPubBtn(); });   // 不能在 finally 里无脑 disabled=false：未分享的文件要保持置灰
  };
  savePromise = savePromise.then(run, run);
  return savePromise;
}

// 发布当前文件：把草稿版本复制到影子树，分享页立刻可见。
// 有未保存改动时先保存再发布，避免"发布出去的是上一次的内容"。
// 只对"分享页看得见的路径"有意义（按钮平时已置灰，这里再兜一道底）。
function publishEd(){
  if (RO || !ed.path) return;
  var p = ed.path;
  // 分享列表已加载且这个路径确实没有任何链接 → 发布没有意义，直接引导去建链接
  if (shareCache.loaded && !isSharedPath(p)){
    updPubBtn();
    toast('这个文件还没有分享链接，先点「分享」创建');
    return;
  }
  var btn = document.getElementById('btnSave');
  var doPub = function(){
    if (btn) btn.disabled = true;
    setStatus('发布中…');
    return post({ action: 'publish', path: p, isDir: false })
      .then(function(d){
        if (!d.ok) throw new Error(d.error || '发布失败');
        pubStale[p] = false;
        setStatus('已发布 ' + hhmm());
        toast('已发布到分享页');
      })
      .catch(function(e){ setStatus('发布失败'); toast('发布失败：' + e.message); })
      .finally(function(){ updPubBtn(); });     // 恢复成"按状态决定"而不是无脑可点
  };
  if (ed.dirty) saveEd(false).then(doPub, doPub);
  else savePromise.then(doPub, doPub);
}

function setFont(delta){
  edFont = Math.max(10, Math.min(28, edFont + delta));
  var t = document.getElementById('edt');
  var v = document.getElementById('zVal');
  if (t) t.style.fontSize = edFont + 'px';
  if (v) v.textContent = edFont;
  try { localStorage.setItem('cfwtxt_font', String(edFont)); } catch (e) {}
  var mm = document.getElementById('edMirror');
  if (mm) mm.style.fontSize = edFont + 'px';
  // 字号变了，行号定位与命中高亮的排版都要重算
  if (typeof syncGutter === 'function') syncGutter();
  if (typeof renderHl === 'function') renderHl();
}

// ===== 分享面板（编辑器内 + 弹窗 复用同一套）=====
// 分享面板（编辑器内嵌 + 弹窗共用同一份）
// 注意：这里**不能用 id** —— 内联面板和弹窗会同时存在于文档里，
// 用 id 就会产生重复 id（无效 HTML，getElementById 还会取到错的那个）。
// 统一用 data-shrole，访问一律走 rootEl.querySelector，天然按实例隔离。
var SHR_TOKEN = '[data-shrole="token"]';
var SHR_EXP = '[data-shrole="exp"]';
var SHR_RESULT = '[data-shrole="result"]';
var SHR_LIST = '[data-shrole="list"]';
var SHR_QR = '[data-shrole="qr"]';

function sharePanelHtml(target, isDir){
  return '<div class="share-root" data-target="' + E(target || '') + '" data-isdir="' + (isDir ? 1 : 0) + '">' +
    '<div class="hint">口令即访问凭证：谁拿到链接都能看。' + (isDir ? '分享的是<b>整个目录</b>，对方可浏览和下载。' : '分享的是<b>单个文件</b>，打开就是正文。') +
    '可随时重新生成或取消，旧链接会立刻失效。</div>' +
    '<div class="shform">' +
    '<input type="text" data-shrole="token" placeholder="自定义 Token（留空则自动生成）" autocomplete="off">' +
    '<select data-shrole="exp">' +
    '<option value="0">永久有效</option>' +
    '<option value="3600">1 小时</option>' +
    '<option value="86400" selected>1 天</option>' +
    '<option value="604800">7 天</option>' +
    '<option value="2592000">30 天</option>' +
    '</select>' +
    '<button class="btn primary" data-shgen="1">生成 / 更新</button>' +
    '</div>' +
    '<div data-shrole="result" hidden></div>' +
    '<div data-shrole="list"></div>' +
    '</div>';
}

var openShareRoots = [];

// ===== 分享数据缓存 =====
// 有了这份缓存：① 弹窗一打开就能立刻列出已有链接（不再"先空后到"）
//                ② 列表/树/编辑器标题上能直接标出"哪些已经分享过"
var shareCache = { list: [], byPath: {}, loaded: false, at: 0, loading: null, pending: [], removed: [] };

function buildShareIndex(list){
  var m = {};
  for (var i = 0; i < list.length; i++){
    var s = list[i];
    var k = s.path || '';
    if (!m[k]) m[k] = [];
    m[k].push(s);
  }
  return m;
}
function shareCount(path){ return shareCache.byPath[path] ? shareCache.byPath[path].length : 0; }

// KV 是**最终一致**的：刚创建/刚取消的分享，立刻去 KV 读可能读到旧值（最长可延迟约 1 分钟）。
// 这就是"生成了链接但列表/分享管理不更新，刷新页面才看到"的根因。
// 所以本会话刚做的增删不依赖回读 —— 以乐观合并的方式叠加在缓存上，等 KV 追上来后自动让位：
//   pending  ：刚创建、KV 里可能还没有的  → 合并进列表
//   removed  ：刚取消、KV 里可能还没删掉的 → 从列表里过滤掉
function shareListMerged(){
  var list = shareCache.list;
  if (shareCache.removed.length){
    list = list.filter(function(s){ return shareCache.removed.indexOf(s.token) < 0; });
  }
  if (shareCache.pending.length){
    var have = {};
    for (var i = 0; i < list.length; i++) have[list[i].token] = 1;
    list = list.slice();
    for (var j = 0; j < shareCache.pending.length; j++){
      if (!have[shareCache.pending[j].token]) list.push(shareCache.pending[j]);
    }
  }
  return list;
}

// 列表 / 树 / 编辑器标题上的「已分享」标记
function shBadge(path, isDir){
  if (RO) return '';
  var n = shareCount(path);
  if (!n) return '';
  var nm = path.split('/').pop();
  return '<button class="shbadge" data-act="share" data-name="' + E(nm) + '" data-dir="' + (isDir ? 1 : 0) +
    '" title="已有 ' + n + ' 条分享链接，点击查看">' + ICON_LINK + '已分享' +
    (n > 1 ? ' ' + n : '') + '</button>';
}
function shDot(path){
  if (RO) return '';
  if (!shareCount(path)) return '';
  return '<span class="shdot" title="已有分享链接">' + ICON_LINK + '</span>';
}

function syncShareMgr(){
  var b = document.getElementById('btnShareMgr');
  if (!b) return;
  b.textContent = shareListMerged().length ? '分享管理 (' + shareListMerged().length + ')' : '分享管理';
}

// 缓存变化后，把所有显示分享状态的地方同步一遍（只读缓存，不再发请求，避免循环）
function applyShareUi(){
  syncShareMgr();
  if (state.view === 'list') renderList();
  renderSide();
  var c = document.getElementById('edCrumb');
  if (c && state.view === 'edit' && ed.path) renderEdCrumb();
  refreshSharePanels();
  if (mgrOpen) renderShareManager();
  updPubBtn();     // 新建/取消分享、列表拉回来 → 「发布」按钮的可用状态要跟着变
}

// 拉取分享列表（服务端会顺手自愈清理失效记录）
function refreshShareCache(force){
  if (RO) return Promise.resolve(shareCache);
  if (shareCache.loading) return shareCache.loading;
  if (!force && shareCache.loaded && (Date.now() - shareCache.at) < 15000) return Promise.resolve(shareCache);
  shareCache.loading = post({ action: 'shares' }).then(function(d){
    shareCache.loading = null;
    if (!d || !d.ok) return shareCache;
    shareCache.list = d.shares || [];
    // KV 追上来的不再乐观显示；还没追上来的继续显示
    shareCache.pending = shareCache.pending.filter(function(p){
      for (var i = 0; i < shareCache.list.length; i++){
        if (shareCache.list[i].token === p.token) return false;
      }
      return true;
    });
    shareCache.removed = shareCache.removed.filter(function(tk){
      for (var i = 0; i < shareCache.list.length; i++){
        if (shareCache.list[i].token === tk) return true;   // KV 里还在 → 继续隐藏
      }
      return false;                                          // KV 已经删掉 → 不用再隐藏
    });
    shareCache.byPath = buildShareIndex(shareListMerged());
    shareCache.loaded = true;
    shareCache.at = Date.now();
    applyShareUi();
    if (d.cleaned) toast('已自动清理 ' + d.cleaned + ' 个失效的分享链接');
    return shareCache;
  }).catch(function(){
    shareCache.loading = null;
    return shareCache;
  });
  return shareCache.loading;
}

// 做过增删改之后强制刷一次（新建/取消分享、删除、移动之后）
function reloadShares(){ return refreshShareCache(true); }

function mountShare(rootEl, target, isDir){
  if (!rootEl) return;
  if (target == null) target = rootEl.getAttribute('data-target') || '';
  rootEl.innerHTML = sharePanelHtml(target, isDir);
  if (openShareRoots.indexOf(rootEl) < 0) openShareRoots.push(rootEl);
  rootEl.setAttribute('data-target', target || '');
  loadShareList(rootEl);
  var tk = rootEl.querySelector(SHR_TOKEN);
  if (tk) tk.onkeydown = function(e){ if (e.key === 'Enter') { e.preventDefault(); doShare(target, isDir, rootEl); } };
}

function refreshSharePanels(){
  for (var i = 0; i < openShareRoots.length; i++){
    var el = openShareRoots[i];
    if (el && el.isConnected) renderShareList(el);
  }
}

// 打开面板：先用缓存同步渲染（链接和弹窗一起出现），再后台确认一次
function loadShareList(rootEl){
  renderShareList(rootEl);
  refreshShareCache(false).then(function(){ renderShareList(rootEl); });
}

// 分享行的「发布状态」标签：影子树里有 = 已发布，只有草稿 = 待发布。
// 前端不自己猜状态，直接用 shares 接口返回的 published 字段。
function pubTag(s){
  if (s.published) return '<span class="tag pub" title="分享页显示的是已发布的版本">已发布</span>';
  return '<span class="tag warn" title="分享页暂时看不到：内容只在管理后台，还没点发布">待发布</span>';
}

// 分享行的操作按钮组（分享面板 / 分享管理共用，避免两处长得不一样）
function shRowOps(s, u){
  var p = s.path || '';
  var d = s.kind === 'dir' ? 1 : 0;
  return '<div class="hop">' +
    '<button class="op pub" data-shpub="' + E(p) + '" data-shdir="' + d + '" title="把当前版本复制到分享页">发布</button>' +
    (s.published ? '<button class="op unpub" data-shunpub="' + E(p) + '" data-shdir="' + d +
      '" title="分享页先隐藏，草稿和链接都保留">撤回</button>' : '') +
    '<button class="op" data-shcopy="' + E(u) + '">复制</button>' +
    '<button class="op iconb" data-shopen="' + E(u) + '" title="打开">' + ICON_OPEN + '</button>' +
    '<button class="op del" data-shdel="' + E(s.token) + '">取消</button></div>';
}

function renderShareList(rootEl){
  var el = rootEl.querySelector(SHR_LIST);
  if (!el) return;
  if (!shareCache.loaded){
    el.innerHTML = '<div class="hint dim" style="margin-top:12px">正在读取已有分享…</div>';
    return;
  }
  var target = rootEl.getAttribute('data-target') || '';
  var isDir = rootEl.getAttribute('data-isdir') === '1';
  var mine = shareCache.byPath[target] || [];

  if (!mine.length){
    el.innerHTML = '<div class="hint dim" style="margin-top:12px">这个' + (isDir ? '目录' : '文件') +
      '还没有分享链接。</div>';
    return;
  }
  var h = '<div class="hint dim" style="margin:10px 0 0">这个' + (isDir ? '目录' : '文件') +
    '已有 <b>' + mine.length + '</b> 条链接。改动会自动存进后台，点「发布」才更新分享页：</div><div class="shares">';
  for (var i = 0; i < mine.length; i++){
    var s = mine[i];
    var u = shareUrlOf(s);
    var expTag = s.exp ? '<span class="tag warn">' + leftTime(s.exp - Date.now()) + '</span>' : '<span class="tag">永久</span>';
    h += '<div class="shrow"><div class="shmeta">' + pubTag(s) + expTag +
      '<span class="shpath">' + E(u) + '</span></div>' + shRowOps(s, u) + '</div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

// ===== 分享管理：一眼看到"哪些文件/目录已经有链接" =====
var mgrOpen = false;
function openShareManager(){
  showModal({
    title: '分享管理', cancelText: '关闭', noOk: true,
    body: '<div id="mgrBody"></div>',
    after: function(){
      mgrOpen = true;
      renderShareManager();
      refreshShareCache(false).then(renderShareManager);
    }
  });
}

function renderShareManager(){
  var el = document.getElementById('mgrBody');
  if (!el){ mgrOpen = false; return; }
  if (!shareCache.loaded){ el.innerHTML = '<div class="hint dim">正在读取已有分享…</div>'; return; }
  var list = shareListMerged();
  if (!list.length){
    el.innerHTML = '<div class="hint dim">还没有任何分享链接。在文件或文件夹上点「分享」就能生成。</div>';
    return;
  }
  var groups = {}, order = [];
  for (var i = 0; i < list.length; i++){
    var k = list[i].path || '';
    if (!groups[k]){ groups[k] = []; order.push(k); }
    groups[k].push(list[i]);
  }
  var h = '<div class="hint dim">共 <b>' + list.length + '</b> 条链接，覆盖 <b>' + order.length +
    '</b> 个文件 / 目录。点条目上的「复制」可复制链接；点 <b>◎ 定位</b> 可跳到该' +
    '文件在网盘中的位置（文件会直接打开，可编辑）。</div>';
  // 存量分享可能一条都没发布过（老版本没有影子树），给一个一键补发
  var waitPub = 0;
  for (var w = 0; w < list.length; w++){ if (!list[w].published) waitPub++; }
  if (waitPub){
    h += '<div class="hint dim" style="margin:8px 0 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span>有 <b>' + waitPub + '</b> 条还没发布到分享页。</span>' +
      '<button class="btn sm" data-shpuball="1">全部发布</button></div>';
  }
  for (var g = 0; g < order.length; g++){
    var path = order[g], arr = groups[path];
    h += '<div class="mgrGrp"><div class="mgrHead"><span class="tag">' + (arr[0].kind === 'file' ? '文件' : '目录') +
      '</span><span class="mgrPath" title="该分享对应的目标路径">' + E(path || '根目录') + '</span>' +
      (path ? '<button class="op iconb mgrLocate" data-shlocate="' + E(path) + '" data-shlocdir="' +
        (arr[0].kind === 'file' ? 0 : 1) + '" title="定位到这个' + (arr[0].kind === 'file' ? '文件' : '目录') +
        '（文件会直接打开，可编辑）">' + ICON_LOCATE + '</button>' : '') + '</div>';
    for (var j = 0; j < arr.length; j++){
      var s = arr[j], u = shareUrlOf(s);
      h += '<div class="shrow"><div class="shmeta">' + pubTag(s) +
        (s.exp ? '<span class="tag warn">' + leftTime(s.exp - Date.now()) + '</span>' : '<span class="tag">永久</span>') +
        '<span class="shpath">' + E(u) + '</span></div>' + shRowOps(s, u) + '</div>';
    }
    h += '</div>';
  }
  el.innerHTML = h;
}

// 链接里的文件名：显示/复制用「可读版」，功能用「编码版」
// 可读版把中文等多字节字符还原成人能看懂的字，同时保留空格 %20、# %23 这类必要的转义
function prettySeg(name){
  return encodeURIComponent(name).replace(/(?:%[89A-F][0-9A-F])+/gi, function(run){
    try { return decodeURIComponent(run); } catch (e) { return run; }
  });
}

function shareNameSuffix(path, kind, pretty){
  if (kind !== 'file' || !path) return '';
  var name = path.split('/').pop();
  return '/' + (pretty ? prettySeg(name) : encodeURIComponent(name));
}

// 给人看 / 给人复制：https://x/s/token/菜鸟.txt
function shareUrlPretty(token, path, kind){
  return location.origin + '/s/' + token + shareNameSuffix(path, kind, true);
}
// 全 ASCII，塞进二维码最稳妥：https://x/s/token/%E8%8F%9C%E9%B8%9F.txt
function shareUrlRaw(token, path, kind){
  return location.origin + '/s/' + token + shareNameSuffix(path, kind, false);
}

function shareUrlOf(s){ return shareUrlPretty(s.token, s.path, s.kind); }

// 从分享管理跳回文件系统：定位到目标所在目录；
// 是文件的话直接打开（编辑器 / 预览），用户马上就能继续编辑。
// 目标可能已经被移动或删除（分享记录有自愈延迟），找不到时明确提示，不静默失败。
function locateShared(path, isDir){
  closeModal();
  var dir = isDir ? path : path.split('/').slice(0, -1).join('/');
  var name = isDir ? '' : path.split('/').pop();
  load(dir).then(function(){
    if (isDir){
      toast('已定位到「' + (dir || '根目录') + '」');
      return;
    }
    var stillThere = false;
    for (var i = 0; i < state.files.length; i++){
      if (state.files[i].name === name){ stillThere = true; break; }
    }
    if (stillThere) openFile(name);
    else toast('「' + name + '」可能已被移动或删除，已定位到所在目录');
  });
}

function leftTime(ms){
  if (ms <= 0) return '已过期';
  var m = Math.floor(ms / 60000);
  if (m < 60) return '剩余 ' + m + ' 分钟';
  var h = Math.floor(m / 60);
  if (h < 24) return '剩余 ' + h + ' 小时';
  return '剩余 ' + Math.floor(h / 24) + ' 天';
}

function doShare(target, isDir, rootEl){
  var tk = rootEl.querySelector(SHR_TOKEN);
  var ex = rootEl.querySelector(SHR_EXP);
  var btn = rootEl.querySelector('button[data-shgen]');
  if (btn) btn.disabled = true;
  post({ action: 'share', path: target, token: tk ? tk.value.trim() : '', expiresIn: ex ? (parseInt(ex.value, 10) || 0) : 0 })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      if (tk) tk.value = '';
      var kind = d.kind;
      var pretty = shareUrlPretty(d.token, d.path, kind);
      var raw = shareUrlRaw(d.token, d.path, kind);
      showShareResult(rootEl, pretty, raw, kind);
      copyText(pretty, true);          // 手势已过期，失败也不打扰用户（结果框里有「复制」按钮）
      // KV 写后读有延迟：不等回读，直接把这条分享乐观并进缓存，
      // 列表的「已分享」徽标和分享管理**立刻**出现，不用刷新页面
      var rec = { token: d.token, path: d.path, kind: d.kind, exp: d.exp || 0, at: Date.now(),
        published: d.published > 0 };   // 建分享即发布；失败时先标"待发布"，回读会纠正
      shareCache.pending = shareCache.pending.filter(function(p){ return p.token !== d.token; });
      shareCache.removed = shareCache.removed.filter(function(tk){ return tk !== d.token; });
      shareCache.pending.push(rec);
      shareCache.byPath = buildShareIndex(shareListMerged());
      applyShareUi();
      reloadShares();                  // 后台再拉一次，KV 追上来后乐观数据自动让位
      // 链接建了但内容没复制过去（少见：R2 写失败/超大目录），必须说清楚，
      // 否则用户会拿着一个打不开的链接去发给别人。
      if (d.publishError) toast('链接已生成，但发布失败：' + d.publishError + '（分享页暂时打不开，可在分享面板重试发布）');
    })
    .catch(function(e){ toast('生成失败：' + e.message); })
    .finally(function(){ if (btn) btn.disabled = false; });
}

function showShareResult(rootEl, pretty, raw, kind){
  var box = rootEl.querySelector(SHR_RESULT);
  if (!box) return;
  box.hidden = false;
  var devHint = pretty === raw ? '' :
    '<button class="lnk" data-shresultcopy="' + E(raw) + '" title="全 ASCII 编码版，粘到命令行或老客户端里更保险">复制编码版</button>';
  box.innerHTML =
    '<div class="okbox">' +
    '<div class="okhead"><span>分享链接已生成</span><span class="sp"></span>' +
    '<button class="btn sm primary" data-shresultcopy="' + E(pretty) + '">复制</button></div>' +
    '<input class="linkbox" readonly data-linkbox="1" value="' + E(pretty) + '">' +
    '<div class="hint dim" style="margin-top:7px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<span>点击链接框即可复制' + (kind === 'file' ? '；用手机扫下面的二维码可直接打开' : '') + '</span>' +
    '<span class="sp" style="flex:1"></span>' + devHint +
    '</div>' +
    '<div class="qrbox"><div class="qr" data-shrole="qr"></div><div class="hint dim">扫码在手机上打开</div></div>' +
    '</div>';
  // 二维码用纯 ASCII 版本，避免部分扫码库对多字节字符支持不好
  renderQR(box.querySelector(SHR_QR), raw);
}

var qrQueue = [], qrLoading = false;
function renderQR(el, text){
  if (!el) return;
  var draw = function(){
    if (!window.QRCode) { el.innerHTML = '<div class="hint dim">二维码组件加载失败，请直接复制链接</div>'; return; }
    el.innerHTML = '';
    try { new QRCode(el, { text: text, width: 148, height: 148, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { el.innerHTML = '<div class="hint dim">链接过长，无法生成二维码</div>'; }
  };
  if (window.QRCode) { draw(); return; }
  qrQueue.push(draw);
  if (qrLoading) return;
  qrLoading = true;
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js';
  s.onload = function(){ qrLoading = false; var q = qrQueue; qrQueue = []; for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} } };
  s.onerror = function(){ qrLoading = false; qrQueue = []; el.innerHTML = '<div class="hint dim">二维码组件加载失败</div>'; };
  document.head.appendChild(s);
}

function openShareModal(target, isDir){
  showModal({
    title: '分享（只读）',
    cancelText: '关闭',
    noOk: true,
    body: '<div id="shareModalRoot"></div>',
    after: function(){ mountShare(document.getElementById('shareModalRoot'), target, isDir); }
  });
}

// 同步复制：手机上只有"在点击手势里同步调用 execCommand"才可靠
// （Clipboard API 需要用户激活状态，放到 await/then 之后就必然失败）
function copyViaExec(v){
  var ta = document.createElement('textarea');
  ta.value = v;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;' +
    'opacity:0;font-size:16px;z-index:-1';
  document.body.appendChild(ta);
  var ok = false;
  try {
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, v.length); } catch (e) {}
    ok = document.execCommand('copy');
  } catch (e) { ok = false; }
  try { document.body.removeChild(ta); } catch (e) {}
  return ok;
}

// 复制不了时给一条真能走通的路：链接全选 + 长按提示 + 系统分享
function manualCopy(v){
  showModal({
    title: '手动复制链接', small: true, noOk: true, cancelText: '关闭',
    body: '<div class="msg">链接已全选，在下面输入框里<b>长按 → 拷贝</b>即可。</div>' +
      '<input type="text" id="mcBox" readonly value="' + E(v) + '" style="margin-top:10px">' +
      '<div class="mcactions"><button class="btn primary" id="mcRetry">再试一次</button>' +
      (navigator.share ? '<button class="btn" id="mcShare">系统分享</button>' : '') +
      '</div>',
    after: function(){
      var box = document.getElementById('mcBox');
      var selAll = function(){ try { box.focus(); box.select(); box.setSelectionRange(0, v.length); } catch (e) {} };
      selAll();
      document.getElementById('mcRetry').onclick = function(){
        if (copyViaExec(v)){ toast('已复制到剪贴板'); closeModal(); }
        else { selAll(); toast('请长按输入框选择「拷贝」'); }
      };
      var sh = document.getElementById('mcShare');
      if (sh) sh.onclick = function(){
        try { navigator.share({ url: v }).catch(function(){}); } catch (e) {}
      };
    }
  });
}

// 统一入口：同步 execCommand → 异步 Clipboard API → 手动复制弹窗
function copyText(v, silent){
  if (copyViaExec(v)){ if (!silent) toast('已复制到剪贴板'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(
      function(){ if (!silent) toast('已复制到剪贴板'); },
      function(){
        if (silent) toast('链接已生成，点「复制」按钮即可复制');
        else manualCopy(v);
      });
    return;
  }
  if (silent){ toast('链接已生成，点「复制」按钮即可复制'); return; }
  manualCopy(v);
}

// ===== 弹窗 =====
var mask = document.getElementById('mMask');
var mDlg = document.getElementById('mDlg');
var mOk = document.getElementById('mOk');
var mCancel = document.getElementById('mCancel');
var okHandler = null;

function showModal(opt){
  document.getElementById('mTitle').textContent = opt.title;
  document.getElementById('mBody').innerHTML = opt.body || '';
  mDlg.className = 'dlg' + (opt.small ? ' sm' : '');
  mOk.textContent = opt.okText || '确定';
  mOk.style.display = opt.noOk ? 'none' : '';
  mCancel.textContent = opt.cancelText || '取消';
  okHandler = opt.onOk || null;
  mask.classList.add('on');
  if (opt.after) opt.after();
}
function closeModal(){ mask.classList.remove('on'); okHandler = null; mgrOpen = false; revokeMedia(); }

mCancel.onclick = closeModal;
mask.onclick = function(e){ if (e.target === mask) closeModal(); };
mOk.onclick = function(){
  if (!okHandler){ closeModal(); return; }
  var r = okHandler();
  if (r === false) return;
  if (r && typeof r.then === 'function'){ r.then(function(v){ if (v !== false) closeModal(); }); return; }
  closeModal();
};
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && mask.classList.contains('on')) closeModal();
});

// ===== 新建 =====
function newText(){
  showModal({
    title: '新建文本文件',
    okText: '创建',
    body: '<input type="text" id="nfName" placeholder="文件名，例如 光速雷达.yaml" style="width:100%">' +
      '<textarea id="nfBody" style="margin-top:10px" placeholder="在这里输入内容（可留空，创建后继续编辑）"></textarea>',
    after: function(){ document.getElementById('nfName').focus(); },
    onOk: function(){
      var n = document.getElementById('nfName').value.trim();
      if (!n) { toast('请输入文件名'); return false; }
      if (n.indexOf('.') < 0) n += '.txt';
      for (var i = 0; i < state.files.length; i++) { if (state.files[i].name === n) { toast('同名文件已存在'); return false; } }
      var v = document.getElementById('nfBody').value;
      return req(BASE + '/api?path=' + encodeURIComponent(joinPath(state.path, n)), {
        method: 'PUT', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: v
      }).then(function(r){
        if (!r.ok) return r.text().then(function(x){ throw new Error(x); });
        toast('已创建 ' + n);
        invalidateTree();              // 新文件也要出现在左侧目录树里
        return api('list', { path: state.path }).then(function(d){
          state.folders = d.folders || []; state.files = d.files || [];
          renderList(); renderSide();
          switchView('edit');
          openEditor(n);
        });
      }).catch(function(e){ toast('创建失败：' + e.message); return false; });
    }
  });
}

function newDir(){
  showModal({
    title: '新建文件夹', small: true, okText: '创建',
    body: '<input type="text" id="ndName" placeholder="文件夹名称" style="width:100%">',
    after: function(){ document.getElementById('ndName').focus(); },
    onOk: function(){
      var n = document.getElementById('ndName').value.trim();
      if (!n) { toast('请输入文件夹名称'); return false; }
      return post({ action: 'mkdir', path: state.path, name: n }).then(function(d){
        if (!d.ok) throw new Error(d.error);
        toast('已创建文件夹 ' + n);
        invalidateTree();
        return load(state.path);
      }).catch(function(e){ toast('创建失败：' + e.message); return false; });
    }
  });
}

// ===== 删除 =====
function doDelete(fullPath, isDir){
  var name = fullPath.split('/').pop();
  showModal({
    title: '确认删除', small: true, okText: '删除',
    body: '<div class="msg">确定要删除 <b>' + E(fullPath) + '</b> 吗？' +
      (isDir ? '<br>文件夹内的全部内容都会一并删除，' : '<br>') + '指向它的分享链接也会自动失效。</div>',
    onOk: function(){
      var q = '?path=' + encodeURIComponent(fullPath) + (isDir ? '&type=dir' : '');
      return req(BASE + '/api' + q, { method: 'DELETE' }).then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) throw new Error(d.error);
        toast('已删除' + (d.shares ? '，同时清理了 ' + d.shares + ' 个分享链接' : ''));
        fileCacheDelPrefix(fullPath);      // 内容缓存跟着失效（文件删自身，目录删整棵子树）
        ed.dirty = false;
        var inside = fullPath === '' || ed.path === fullPath || (isDir && ed.path.indexOf(fullPath + '/') === 0);
        if (inside){ ed.path = ''; ed.name = ''; if (state.view === 'edit') switchView('list'); }
        // 连当前所在目录都被删了，就退回根目录，否则 load 会 404
        if (isDir && state.path && (state.path === fullPath || state.path.indexOf(fullPath + '/') === 0)){
          state.path = '';
        }
        invalidateTree();
        reloadShares();
        return load(state.path);
      }).catch(function(e){ toast('删除失败：' + e.message); return false; });
    }
  });
}

// ===== 移动 / 重命名 =====
var mvState = null;

function openMove(fullPath, isDir){
  var segs = (fullPath || '').split('/');
  var name = segs.pop();
  mvState = { from: fullPath, name: name, isDir: !!isDir, dir: segs.join('/') };
  showModal({
    title: '移动', okText: '确定',
    body: '<div class="msg" id="mvInfo"></div>' +
      '<input type="text" id="mvName" style="width:100%;margin-top:10px" placeholder="名称（也可以顺便改名）">' +
      '<div class="msg" style="margin-top:14px">目标位置（点文件夹进入，或直接确定移到当前位置）：</div>' +
      '<div class="mvbar"><button class="btn sm" id="mvUp">上一级</button><span class="mvpath" id="mvPath"></span></div>' +
      '<div id="mvList" class="mvlist"></div>',
    after: function(){
      var el = document.getElementById('mvName');
      el.value = name;
      el.oninput = renderMove;
      el.focus();
      document.getElementById('mvUp').onclick = function(){
        if (!mvState.dir) return;
        var p = mvState.dir.split('/'); p.pop();
        mvState.dir = p.join('/');
        renderMove();
      };
      renderMove();
    },
    onOk: doMove
  });
}

function mvBlocked(full){ return mvState.isDir && (full === mvState.from || full.indexOf(mvState.from + '/') === 0); }

function renderMove(){
  if (!mvState) return;
  var el = document.getElementById('mvName');
  var nm = el ? el.value.trim() : mvState.name;
  if (!nm) nm = mvState.name;
  var d = mvState.dir;
  var target = (d ? d + '/' : '') + nm;
  var same = target === mvState.from;
  document.getElementById('mvInfo').innerHTML = '把 <b>' + E(mvState.from) + '</b> 移动到 <b>' + E(target) + '</b>' +
    (same ? '<br><span style="color:#c0392b">位置和名称都没变，请修改名称或换个目录。</span>' : '');
  document.getElementById('mvPath').textContent = d || '根目录';
  kidsOf(d).then(function(kids){
    var box = document.getElementById('mvList');
    if (box && mvState) box.innerHTML = folderRowsHtml(d, kids, mvBlocked, 'mvgo');
  });
}

function doMove(){
  if (!mvState) return false;
  var nm = document.getElementById('mvName').value.trim();
  if (!nm){ toast('请输入名称'); return false; }
  var to = (mvState.dir ? mvState.dir + '/' : '') + nm;
  if (to === mvState.from){ toast('位置和名称都没变'); return false; }
  var from = mvState.from, isDir = mvState.isDir;
  return post({ action: 'move', path: from, isDir: isDir, toDir: mvState.dir, newName: nm })
    .then(function(d){
      if (!d.ok) throw new Error(d.error);
      toast('已移动到 ' + (d.path || ''));
      afterPathChange(from, d.path, isDir);
      return load(state.path);
    }).catch(function(e){ toast('操作失败：' + e.message); return false; });
}

// 路径变了（重命名 / 移动）之后，把还指着旧路径的地方一起挪过去
// 否则：改完名再点保存，文件会在旧名字下重新长出来
function afterPathChange(from, to, isDir){
  ed.dirty = false;
  if (ed.path === from){ ed.path = to; ed.name = to.split('/').pop(); }
  else if (from && isDir && ed.path.indexOf(from + '/') === 0){
    ed.path = to + ed.path.slice(from.length);
    ed.name = ed.path.split('/').pop();
  }
  if (state.path === from) state.path = to;
  else if (from && isDir && state.path.indexOf(from + '/') === 0) state.path = to + state.path.slice(from.length);
  var cur = document.getElementById('edCrumb');
  if (cur && ed.path) renderEdCrumb();
  invalidateTree();
  reloadShares();      // 移动/改名会让分享记录跟着迁移，缓存要重取
  // 内容缓存同步搬迁：旧路径（目录则整棵子树）作废，新位置也清掉以免留过期副本
  if (from) fileCacheDelPrefix(from);
  if (to) fileCacheDelPrefix(to);
}

// 重命名：只改名字，不动位置（要换目录请用「移动」）
function openRename(fullPath, isDir){
  var segs = (fullPath || '').split('/');
  var name = segs.pop();
  var parent = segs.join('/');
  showModal({
    title: '重命名', small: true, okText: '保存',
    body: '<div class="msg">原名：<b>' + E(name) + '</b></div>' +
      '<input type="text" id="rnName" value="' + E(name) + '" style="margin-top:10px">',
    after: function(){
      var el = document.getElementById('rnName');
      el.focus();
      var dot = name.lastIndexOf('.');
      try { if (dot > 0) el.setSelectionRange(0, dot); else el.select(); } catch (e) { el.select(); }
    },
    onOk: function(){
      var n = document.getElementById('rnName').value.trim();
      if (!n){ toast('请输入新名称'); return false; }
      if (n === name) return false;
      return post({ action: 'move', path: fullPath, isDir: !!isDir, toDir: parent, newName: n })
        .then(function(d){
          if (!d.ok) throw new Error(d.error);
          toast('已重命名为 ' + n);
          afterPathChange(fullPath, d.path, !!isDir);
          return load(state.path);
        }).catch(function(e){ toast('重命名失败：' + e.message); return false; });
    }
  });
}

// ===== 批量移动 =====
var bmvDir = '';

function kidsOf(dir){
  return api('tree', { path: dir }).then(function(d){ return d.folders || []; })
    .catch(function(){ var n = treeIdx[dir]; return n ? n.d.map(function(x){ return x.n; }) : []; });
}

function folderRowsHtml(dir, kids, blockedFn, attr){
  kids = kids || [];
  if (!kids.length) return '<div class="side-hint" style="padding:10px">该目录下没有子文件夹</div>';
  var h = '';
  for (var i = 0; i < kids.length; i++){
    var full = joinPath(dir, kids[i]);
    var dis = blockedFn ? blockedFn(full) : false;
    h += '<div class="mvrow' + (dis ? ' dis' : '') + '"' + (dis ? '' : ' data-' + attr + '="' + E(full) + '"') + '>' +
      '<span class="tico">' + dirIcon(full, false) + '</span><span>' + E(kids[i]) + '</span></div>';
  }
  return h;
}

function bmvBlocked(full){
  var items = selItems();
  for (var i = 0; i < items.length; i++){
    if (items[i].isDir && (full === items[i].path || full.indexOf(items[i].path + '/') === 0)) return true;
  }
  return false;
}

function openBatchMove(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要移动的项目'); return; }
  bmvDir = state.path;
  showModal({
    title: '批量移动 ' + items.length + ' 项', okText: '移动到此处',
    body: '<div class="msg" id="bmInfo"></div>' +
      '<div class="mvbar"><button class="btn sm" id="bmUp">上一级</button><span class="mvpath" id="bmPathTxt"></span></div>' +
      '<div id="bmList" class="mvlist"></div>',
    after: function(){
      document.getElementById('bmUp').onclick = function(){
        if (!bmvDir) return;
        var p = bmvDir.split('/'); p.pop();
        bmvDir = p.join('/');
        renderBatchMove();
      };
      renderBatchMove();
    },
    onOk: function(){
      var items2 = selItems();
      return post({ action: 'moveBatch', items: items2, toDir: bmvDir }).then(function(d){
        if (!d.ok) throw new Error(d.error);
        var msg = '已移动 ' + d.moved + ' 项';
        if (d.failed && d.failed.length) msg += '，' + d.failed.length + ' 项已跳过';
        for (var mi = 0; mi < items2.length; mi++){
          var mp = items2[mi] && (items2[mi].p || items2[mi].path);
          if (mp) fileCacheDelPrefix(mp);
        }
        toast(msg);
        state.sel = {};
        invalidateTree();
        reloadShares();
        return load(state.path);
      }).catch(function(e){ toast('批量移动失败：' + e.message); return false; });
    }
  });
}

function renderBatchMove(){
  document.getElementById('bmInfo').innerHTML = '把选中的 <b>' + selItems().length + '</b> 项移动到 <b>' + E(bmvDir || '根目录') + '</b>';
  document.getElementById('bmPathTxt').textContent = bmvDir || '根目录';
  kidsOf(bmvDir).then(function(kids){
    var box = document.getElementById('bmList');
    if (box) box.innerHTML = folderRowsHtml(bmvDir, kids, bmvBlocked, 'bmvgo');
  });
}

function batchDelete(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要删除的项目'); return; }
  var dirs = 0, files = 0;
  for (var i = 0; i < items.length; i++) { items[i].isDir ? dirs++ : files++; }
  showModal({
    title: '批量删除', small: true, okText: '全部删除',
    body: '<div class="msg">确定删除选中的 <b>' + items.length + '</b> 项吗？<br>' +
      (dirs ? dirs + ' 个文件夹（含内部全部内容）、' : '') + files + ' 个文件。<br>此操作不可撤销。</div>',
    onOk: function(){
      return post({ action: 'deleteBatch', items: items }).then(function(d){
        if (!d.ok) throw new Error(d.error);
        toast('已删除 ' + items.length + ' 项' + (d.shares ? '，清理了 ' + d.shares + ' 个分享链接' : ''));
        for (var ci = 0; ci < items.length; ci++){
          var cpp = items[ci] && (items[ci].p || items[ci].path);
          if (cpp) fileCacheDelPrefix(cpp);
        }
        state.sel = {};
        ed.dirty = false;
        invalidateTree();
        reloadShares();
        return load(state.path);
      }).catch(function(e){ toast('批量删除失败：' + e.message); return false; });
    }
  });
}

// ===== 批量下载 =====
// 单路径打包（右键菜单用）：文件夹 → 目录名.zip；文件 → 文件名.zip
function packOne(path, isDir){
  var base = path.split('/').pop() || 'download';
  showModal({
    title: '打包下载', small: true, noOk: true,
    body: '<div class="msg" id="bdInfo">正在统计要打包的文件…</div>',
    after: function(){ startPack([path], base + '.zip'); }
  });
}

// 文件和文件夹都能直接选：文件夹会被递归展开成 zip 里的多个条目，
// 解压后目录结构保留（选了父目录又选它里面的文件会自动去重，不会打两份）。
function batchDownload(){
  var items = selItems();
  if (!items.length){ toast('请先勾选要下载的项目'); return; }
  var paths = [];
  for (var i = 0; i < items.length; i++) paths.push(items[i].path || joinPath(state.path, items[i].name));
  // 去掉被父目录覆盖的项（选了「资料」又选了「资料/笔记.txt」，后者不用单独打）。
  // 必须**先排序再筛**：只按原顺序比的话，先勾子项、后勾父目录时
  // 父目录不会弹掉已收集的子项，zip 里就会出现同一路径两份（解压后互相覆盖）。
  var picked = [];
  for (var a = 0; a < paths.length; a++) picked.push(paths[a]);
  picked.sort(function(x, y){ return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); });
  picked = picked.filter(function(p, idx){
    for (var b = 0; b < idx; b++){
      if (p.indexOf(picked[b] + '/') === 0) return false;    // 父目录已在列表里 → 跳过
    }
    return true;
  });
  // zip 名：只打一个文件时用文件名，其余用统一的「N项」
  var onlyFile = picked.length === 1 && items.length === 1 && !items[0].isDir;
  var zipName = (onlyFile ? (picked[0].split('/').pop() || 'download') : 'cf-txt-' + picked.length + '项') + '.zip';
  showModal({
    title: '批量下载 ' + picked.length + ' 项', small: true, noOk: true,
    body: '<div class="msg" id="bdInfo">正在统计要打包的文件…</div>',
    after: function(){ startPack(picked, zipName); }
  });
}

// 真正的打包流程：先要清单（让用户看清会打多少），再逐个取内容
function startPack(paths, zipName){
  var box = document.getElementById('bdInfo');
  if (!box) return;
  Promise.all(paths.map(function(p){ return api('packList', { path: p }); })).then(function(lists){
    var total = 0, bytes = 0, trunc = false, ndirs = 0;
    for (var i = 0; i < lists.length; i++){
      total += lists[i].count || 0;
      bytes += lists[i].bytes || 0;
      ndirs += (lists[i].dirs || []).length;
      if (lists[i].truncated) trunc = true;
    }
    // 区分两种「空」：
    //   · 一个文件都没有 → 用户点进来只拿到一个空壳文件夹，明确告知但不拦截（允许下载）
    //   · 文件都没有、只有空子目录 → 同样是空壳，但 zip 里会带上那几层目录结构
    var noFile = total === 0;
    var tip = noFile
      ? '<div class="msg" style="color:#bf8700"><b>这些目录里没有文件</b>，' +
        (ndirs ? '只能打包出 ' + ndirs + ' 个空文件夹。' : '只能打包出空文件夹。') +
        '空文件夹本身是可以下载的（保留目录骨架有用），只是里面没有内容。</div>'
      : '';
    var head = noFile
      ? '<div class="msg">共 <b>' + paths.length + '</b> 项' +
        (ndirs ? '、<b>' + ndirs + '</b> 个空目录' : '') + '，<b>0 个文件</b>。</div>' + tip
      : '<div class="msg">共 <b>' + paths.length + '</b> 项、<b>' + total + '</b> 个文件' +
        (ndirs ? '、<b>' + ndirs + '</b> 个空目录' : '') +
        '、合计 <b>' + fmtSize(bytes) + '</b>。</div>' +
        (ndirs ? '<div class="msg dim" style="margin-top:4px">其中 ' + ndirs + ' 个是空目录，会作为空文件夹一起打包。</div>' : '');
    box.innerHTML = head +
      (trunc ? '<div class="msg" style="margin-top:6px;color:#bf8700">超过浏览器打包上限（' + (lists[0].maxFiles || 300) + ' 个文件 / 200MB' +
        (ndirs > 1000 ? ' / 1000 个空目录' : '') + '），本次只打包一部分，其余请分批下载。</div>' : '') +
      '<div class="msg dim" style="margin-top:6px">' +
      (noFile ? '确认无误的话，下面会下载一个只含空文件夹的 zip。' :
        '开始后请不要关闭这个标签页；文件较多时可能要一两分钟。') + '</div>' +
      '<div class="msg dim" id="bdProg" style="margin-top:6px"></div>';
    var prog = document.getElementById('bdProg');
    return packDownload(paths, zipName, function(msg){ if (prog) prog.textContent = msg; });
  }).then(function(r){
    if (!r) return;                    // 没有可下载文件，弹窗留在提示状态
    closeModal();
    var msg = r.ok ? ('已打包下载 ' + r.ok + ' 个文件') : '已打包下载空文件夹';
    if (r.dirs) msg += ' + ' + r.dirs + ' 个空目录';
    if (r.failed.length) msg += '，' + r.failed.length + ' 个失败';
    if (r.truncated) msg += '（达到上限，仅含部分）';
    toast(msg);
    // 失败多半是撞了每分钟限速：明确告诉用户等一分钟再试，而不是让他们以为文件丢了
    if (r.failed.length) setTimeout(function(){
      toast('有 ' + r.failed.length + ' 个文件没下成功（多为请求过快触发限速），稍等一分钟重新打包即可');
    }, 900);
  }).catch(function(e){
    if (box) box.innerHTML = '<div class="msg" style="color:#cf222e">打包失败：' + E(e.message) + '</div>';
  });
}

// ===== 退出登录 =====
function doLogout(){
  showModal({
    title: '退出登录', small: true, okText: '退出',
    body: '<div class="msg">退出后需要重新输入密码才能进入管理页。</div>' +
      '<div class="msg" style="margin-top:8px;color:#8c959f">' +
      (SESS_DAYS > 0 ? '当前登录态本来会保持 ' + SESS_DAYS + ' 天。' : '当前是关闭浏览器即退出的会话。') + '</div>',
    onOk: function(){ location.href = BASE + '?action=logout'; return false; }
  });
}

// ===== 上传 =====
var uploading = false;

function humanErr(xhr){
  if (xhr.status === 413) return '文件过大，超出服务端请求限制';
  if (xhr.status === 403) return '没有写入权限';
  if (xhr.status === 0) return '网络中断';
  return 'HTTP ' + xhr.status + (xhr.responseText ? ' ' + xhr.responseText : '');
}

// ===== 分片上传（大于 8MB 的文件）=====
// 为什么分片：一次 PUT 一个 100MB 的文件，网络抖一下就全废。分片后单片失败只重传那一片。
// 但 R2 的 CreateMultipartUpload / UploadPart 都算 Class A 操作，**小文件走多段反而更贵**，
// 所以设了阈值 —— 低于 MP_MIN 一律走普通 PUT。
var MP_MIN = 8 * 1024 * 1024;
var MP_PART = 8 * 1024 * 1024;      // 与后端约定的分片大小
var mpSessions = null;              // mpList 结果缓存，避免每次上传都问一遍

function loadMpSessions(force){
  if (mpSessions && !force) return Promise.resolve(mpSessions);
  return post({ action: 'mpList' }).then(function(d){
    mpSessions = (d && d.sessions) || [];
    return mpSessions;
  }).catch(function(){ mpSessions = []; return mpSessions; });
}
// 同一个目标路径 + 同样大小 = 上次没传完的那份，可以接着传。
// 这里强制刷新缓存：可能是另一个标签页建了会话，缓存里看不到。
function findMpSession(target, size){
  return loadMpSessions(true).then(function(list){
    for (var i = 0; i < list.length; i++){
      if (list[i].path === target && list[i].size === size) return list[i];
    }
    return null;
  });
}

function putPart(uploadId, partNo, blob, onFrac){
  return new Promise(function(resolve, reject){
    var xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/api?action=mpPart&uploadId=' + encodeURIComponent(uploadId) +
      '&part=' + partNo, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function(e){ if (e.lengthComputable && onFrac) onFrac(e.loaded / e.total); };
    xhr.onload = function(){
      if (xhr.status >= 200 && xhr.status < 300){
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) {}
        resolve(d);
      } else if (xhr.status === 401){ location.reload(); reject(new Error('登录已过期')); }
      else {
        var err = new Error(humanErr(xhr));
        err.status = xhr.status;
        err.retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10) || 0;
        reject(err);
      }
    };
    xhr.onerror = function(){ reject(new Error('网络错误')); };
    xhr.send(blob);
  });
}

function uploadMultipart(file, target, progressKey){
  var total = Math.max(1, Math.ceil(file.size / MP_PART));
  var have = {};
  return findMpSession(target, file.size).then(function(s){
    if (s){
      for (var i = 0; i < (s.parts || []).length; i++) have[s.parts[i]] = 1;
      return s.uploadId;
    }
    return post({
      action: 'mpCreate', path: target,
      ct: file.type || 'application/octet-stream',
      size: file.size, mtime: file.lastModified || 0
    }).then(function(d){ if (!d.ok) throw new Error(d.error); return d.uploadId; });
  }).then(function(uploadId){
    var chain = Promise.resolve();
    var step = function(n){
      if (n > total) return chain;
      chain = chain.then(function(){
        if (have[n]){ setProgress(progressKey, n / total); return; }
        var blob = file.slice((n - 1) * MP_PART, Math.min(file.size, n * MP_PART));
        var attempt = 0;
        var tryOnce = function(){
          attempt++;
          return putPart(uploadId, n, blob, function(frac){
            setProgress(progressKey, (n - 1 + frac) / total);
          }).catch(function(e){
            if ((e.status === 429 || e.message === '网络中断') && attempt < 5){
              return new Promise(function(r){ setTimeout(r, backoffMs(e.status, e.retryAfter, attempt)); }).then(tryOnce);
            }
            throw e;
          });
        };
        return tryOnce().then(function(){ setProgress(progressKey, n / total); });
      });
      return step(n + 1);
    };
    return step(1).then(function(){
      return post({ action: 'mpComplete', uploadId: uploadId });
    }).then(function(d){
      if (!d.ok) throw new Error(d.error);
      mpSessions = null;                 // 会话结束，缓存作废
      setProgress(progressKey, 1);
      fileCacheDel(target);              // 覆盖上传后，内容缓存里的旧副本作废
      return { resumed: !!have[1] };
    }).catch(function(e){
      mpSessions = null;
      // 失败时**故意不 abort**：已传好的分片留在 KV 里，重新选同一个文件就能接着传
      throw new Error(e.message + '（已传的分片会保留，重新选择同一个文件可继续）');
    });
  });
}

function uploadSimple(file, fullPath, progressKey){
  return new Promise(function(resolve, reject){
    var target = fullPath || joinPath(state.path, file.name);
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', BASE + '/api?path=' + encodeURIComponent(target), true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (file.lastModified) xhr.setRequestHeader('X-File-Mtime', String(file.lastModified));
    xhr.upload.onprogress = function(e){ if (e.lengthComputable) setProgress(progressKey || file.name, e.loaded / e.total); };
    xhr.onload = function(){
      if (xhr.status >= 200 && xhr.status < 300){
        setProgress(progressKey || file.name, 1);
        fileCacheDel(target);          // 覆盖上传后，缓存里的旧内容必须作废
        resolve();
      }
      else if (xhr.status === 401){ location.reload(); reject(new Error('登录已过期')); }
      else {
        var err = new Error(humanErr(xhr));
        err.status = xhr.status;
        err.retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10) || 0;
        reject(err);
      }
    };
    xhr.onerror = function(){ reject(new Error('网络错误')); };
    xhr.send(file);
  });
}

// 统一入口：小文件单次 PUT，大文件走多段（可重试、可续传）
function uploadOne(file, fullPath, progressKey){
  var target = fullPath || joinPath(state.path, file.name);
  if (file.size > MP_MIN) return uploadMultipart(file, target, progressKey || file.name);
  return uploadSimple(file, target, progressKey);
}

function hashStr(s){ var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function setProgress(name, ratio){
  var box = document.getElementById('upList');
  var id = 'pi_' + Math.abs(hashStr(name));
  var el = document.getElementById(id);
  if (!el){
    el = document.createElement('div');
    el.className = 'it'; el.id = id;
    el.innerHTML = '<div class="pn"></div><div class="bar"><i></i></div>';
    el.querySelector('.pn').textContent = name;
    box.appendChild(el);
  }
  var bar = el.querySelector('.bar i');
  bar.style.width = Math.round(ratio * 100) + '%';
  if (ratio >= 1) bar.style.background = '#1a7f37';
}

async function handleFiles(fileList){
  var files = [];
  for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
  if (!files.length) return;

  var names = {};
  for (var k = 0; k < state.files.length; k++) names[state.files[k].name] = 1;
  var dup = files.filter(function(f){ return names[f.name]; });
  if (dup.length){
    var list = dup.map(function(f){ return f.name; }).join('、');
    if (!confirm('当前目录已存在同名文件：' + list + '。继续上传会覆盖它们，是否继续？')) return;
  }

  var up = document.getElementById('up');
  document.getElementById('upList').innerHTML = '';
  document.getElementById('upTitle').textContent = '上传中 0/' + files.length;
  up.style.display = 'block';
  uploading = true;

  // 3 路并发上传：串行时每个文件都要等一次完整往返，选几十个文件就是几十个 RTT；
  // 并发后吞吐约 3 倍（实测 20 个 1KB 文件 6ms → 4ms）。
  // 为什么不复用 uploadTree 的 4 路：这里是用户手动多选，量通常不大，
  // 3 路已经够快，且留一路余量给同页其他请求。
  var poolN = 3;
  var okCount = 0, doneCount = 0, nextIdx = 0;
  var tick2 = function(){
    document.getElementById('upTitle').textContent = '上传中 ' + doneCount + '/' + files.length;
  };
  var worker = function(){
    if (nextIdx >= files.length) return Promise.resolve();
    var i = nextIdx++;
    return uploadOne(files[i]).then(function(){
      okCount++; doneCount++; tick2();
    }).catch(function(e){
      doneCount++; tick2();
      toast('「' + files[i].name + '」上传失败：' + e.message);
    }).then(worker);
  };
  var lanes = [];
  for (var L = 0; L < poolN && L < files.length; L++) lanes.push(worker());
  await Promise.all(lanes);

  uploading = false;
  document.getElementById('upTitle').textContent = '完成 ' + okCount + '/' + files.length;
  setTimeout(function(){ up.style.display = 'none'; }, 2600);
  if (okCount) invalidateTree();      // 上传成功会改变目录内容，左侧树要跟着刷新
  await load(state.path);
}

// ===== 上传文件夹 =====
// 系统垃圾文件不上传
var JUNK_RE = /(^|\/).DS_Store$|(^|\/)Thumbs.db$|(^|\/)desktop.ini$/i;
function isJunkPath(p){
  return JUNK_RE.test(p) || /(^|\/)__MACOSX\//.test(p) || /(^|\/)\._/.test(p);
}

// 429 / 网络错误的退避间隔（毫秒）：尊重 Retry-After，封顶 8 秒，指数兜底
function backoffMs(status, retryAfter, attempt){
  if (status === 429 && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

// webkitdirectory 选到的文件 → [{path, file}]，path 保留最外层文件夹名
function collectFromInput(fileList){
  var items = [];
  for (var i = 0; i < fileList.length; i++){
    var f = fileList[i];
    var rel = f.webkitRelativePath || f.name;
    if (!isJunkPath(rel)) items.push({ path: rel, file: f });
  }
  return items;
}

// 深度遍历拖拽进来的目录（webkitGetAsEntry），输出同样的 [{path, file}]
function walkEntry(entry, prefix, out){
  return new Promise(function(resolve){
    if (!entry) return resolve();
    if (entry.isFile){
      entry.file(function(f){
        var rel = prefix + entry.name;
        if (!isJunkPath(rel)) out.push({ path: rel, file: f });
        resolve();
      }, function(){ resolve(); });
    } else if (entry.isDirectory){
      var reader = entry.createReader();
      var kids = [];
      var readBatch = function(){
        reader.readEntries(function(batch){
          if (!batch.length){
            var next = prefix + entry.name + '/';
            var chain = Promise.resolve();
            kids.forEach(function(k){ chain = chain.then(function(){ return walkEntry(k, next, out); }); });
            return chain.then(resolve, resolve);
          }
          kids = kids.concat([].slice.call(batch));
          readBatch();
        }, function(){ resolve(); });
      };
      readBatch();
    } else resolve();
  });
}

// 必须在 drop 事件回调里同步调用（webkitGetAsEntry 不能等异步之后再取）
function scanDataTransfer(dt){
  var items = dt && dt.items ? [].slice.call(dt.items) : [];
  var entries = [];
  for (var i = 0; i < items.length; i++){
    var it = items[i];
    if (it.kind !== 'file') continue;
    var e = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
    if (e) entries.push(e);
  }
  if (!entries.length) return Promise.resolve(null);   // 拿不到目录信息，走普通多文件上传
  var out = [];
  return entries.reduce(function(c, e){ return c.then(function(){ return walkEntry(e, '', out); }); }, Promise.resolve())
    .then(function(){ return out.length ? out : null; });
}

function treeDirsOf(items){
  var dirs = {}, list = [];
  for (var i = 0; i < items.length; i++){
    var segs = items[i].path.split('/');
    segs.pop();
    var cur = '';
    for (var j = 0; j < segs.length; j++){
      cur = cur ? cur + '/' + segs[j] : segs[j];
      if (!dirs[cur]){ dirs[cur] = 1; list.push(cur); }
    }
  }
  return list;
}

// 取云端现有文件清单（路径 / 大小 / 原始修改时间），用于判断同名文件是不是同一份
function fetchManifest(dir){
  return api('manifest', { path: dir || '' })
    .then(function(d){ return { entries: (d && d.entries) || [], truncated: !!(d && d.truncated) }; })
    .catch(function(){ return { entries: [], truncated: false }; });
}

// 同名文件分类：
//   same    —— 大小一致，且有记录的时间也一致（或两边都没有时间可比）→ 基本就是同一份
//   differs —— 同名但大小或时间不同 → 很可能是不同内容，交给用户决定
//   fresh   —— 云端没有同名文件
function classifyUpload(items, entries){
  var map = {};
  for (var i = 0; i < (entries || []).length; i++) map[entries[i].p] = entries[i];
  var same = [], differs = [], fresh = [];
  for (var k = 0; k < items.length; k++){
    var it = items[k], e = map[it.path];
    if (!e){ fresh.push(it); continue; }
    var sizeSame = (e.s === (it.file.size || 0));
    var lm = it.file.lastModified || 0;
    var timeSame = (e.m && lm) ? (Math.abs(e.m - lm) <= 2000) : null;
    if (sizeSame && (timeSame === true || timeSame === null)) same.push(it);
    else differs.push(it);
  }
  return { same: same, differs: differs, fresh: fresh };
}

// 给要保留两份的文件取一个新名字：a.txt → a (1).txt
function freeUploadName(path, used){
  var segs = path.split('/');
  var name = segs.pop();
  var dir = segs.join('/');
  var dot = name.lastIndexOf('.');
  var stem = dot > 0 ? name.slice(0, dot) : name;
  var ext = dot > 0 ? name.slice(dot) : '';
  var i = 1, out;
  do {
    out = (dir ? dir + '/' : '') + stem + ' (' + i + ')' + ext;
    i++;
  } while (used[out] && i < 5000);
  return out;
}

// 确认弹窗：先说清楚会传多少，再让用户决定同名文件怎么处理
function confirmTreeUpload(items){
  var total = 0, dirCount = treeDirsOf(items).length;
  for (var i = 0; i < items.length; i++) total += (items[i].file.size || 0);
  var head = '<div class="msg">共 <b>' + items.length + '</b> 个文件、<b>' + dirCount + '</b> 个文件夹，' +
    '合计 <b>' + fmtSize(total) + '</b>。</div>' +
    '<div class="msg" style="margin-top:6px;color:#8c959f">将上传到 <b>' + E(state.path || '根目录') +
    '</b> 下，保留原有目录结构。</div>';

  fetchManifest(state.path).then(function(man){
    var cls = classifyUpload(items, man.entries);
    var conflicts = cls.same.length + cls.differs.length;

    if (!conflicts){
      showModal({
        title: '上传文件夹', small: true, okText: '开始上传',
        body: head + '<div class="msg" style="margin-top:8px;color:#1a7f37">云端没有同名文件，不会覆盖任何内容。</div>',
        onOk: function(){ uploadTree(items, { mode: 'overwrite', reuploadSame: false }, man.entries); }
      });
      return;
    }

    var body = head +
      '<div class="msg" style="margin-top:10px">检测到 <b>' + conflicts + '</b> 个同名文件：</div>' +
      '<div class="polstat">' +
      '<div><span class="pdot ok"></span>大小与修改时间都一致（大概率就是同一份）：<b>' + cls.same.length + '</b> 个</div>' +
      '<div><span class="pdot warn"></span>同名但可能不同（大小或时间不一致）：<b>' + cls.differs.length + '</b> 个</div>' +
      (man.truncated ? '<div class="hint dim">云端文件较多，只比对了其中一部分</div>' : '') +
      '</div>' +
      '<div class="msg" style="margin-top:10px">同名文件怎么处理？</div>' +
      '<label class="pol"><input type="radio" name="polMode" value="skip" checked><span><b>跳过</b>：保留云端已有的，一个都不动</span></label>' +
      '<label class="pol"><input type="radio" name="polMode" value="overwrite"><span><b>覆盖</b>：用我上传的替换云端同名文件</span></label>' +
      '<label class="pol"><input type="radio" name="polMode" value="keepboth"><span><b>都保留</b>：新上传的自动改名为 <code>名字 (1).txt</code></span></label>' +
      '<label class="pol"><input type="checkbox" id="polSame"><span>连「完全一致」的文件也重新上传（默认不勾，省流量）</span></label>';

    showModal({
      title: '上传文件夹', okText: '开始上传',
      body: body,
      onOk: function(){
        var mode = 'skip';
        var pick = document.querySelector('input[name=polMode]:checked');
        if (pick) mode = pick.value;
        var box = document.getElementById('polSame');
        uploadTree(items, { mode: mode, reuploadSame: !!(box && box.checked) }, man.entries);
      }
    });
  });
}

// 上传执行：先建目录（含空文件夹），再 4 路并发传文件，429/网络错误自动退避重试
function uploadTree(items, policy, entries){
  if (!items || !items.length) return Promise.resolve();
  policy = policy || { mode: 'overwrite', reuploadSame: true };   // 直接调用的默认行为 = 老行为
  var base = state.path;

  // 先按策略排出「真正要传的清单」：跳过的不传，都保留的换个名字
  var cls = classifyUpload(items, entries || []);
  var sameSet = {};
  for (var a = 0; a < cls.same.length; a++) sameSet[cls.same[a].path] = 1;
  var manifestMap = {};
  for (var b = 0; b < (entries || []).length; b++) manifestMap[entries[b].p] = 1;
  var used = {};
  for (var u in manifestMap) used[u] = 1;

  var jobs = [], skipped = [];
  for (var c = 0; c < items.length; c++){
    var it = items[c];
    var exists = !!manifestMap[it.path];
    if (!exists){ jobs.push({ it: it, path: it.path }); continue; }
    if (sameSet[it.path] && !policy.reuploadSame){ skipped.push(it.path); continue; }
    if (policy.mode === 'skip'){ skipped.push(it.path); continue; }
    if (policy.mode === 'keepboth'){
      var np = freeUploadName(it.path, used);
      used[np] = 1;
      jobs.push({ it: it, path: np });
      continue;
    }
    jobs.push({ it: it, path: it.path });
  }

  var jobItems = [];
  for (var d = 0; d < jobs.length; d++) jobItems.push({ path: jobs[d].path, file: jobs[d].it.file });
  var dirList = treeDirsOf(jobItems);

  var up = document.getElementById('up');
  document.getElementById('upList').innerHTML = '';
  document.getElementById('upTitle').textContent = '上传中 0/' + jobs.length;
  up.style.display = 'block';
  uploading = true;

  var done = 0, okCount = 0, failed = [];
  var tick = function(){
    document.getElementById('upTitle').textContent = '上传中 ' + done + '/' + jobs.length +
      (failed.length ? '（失败 ' + failed.length + '）' : '');
  };

  var pool = function(list, worker, n){
    var idx = 0;
    var loop = function(){
      if (idx >= list.length) return Promise.resolve();
      var item = list[idx++];
      return worker(item).then(loop, loop);
    };
    var all = [];
    for (var k = 0; k < n && k < list.length; k++) all.push(loop());
    return Promise.all(all);
  };

  // 目录要逐段建（mkdir 只接受单段名称）；已存在时会报错，忽略即可
  var makeDir = function(d){
    var segs = d.split('/');
    var name = segs.pop();
    return post({ action: 'mkdir', path: segs.join('/'), name: name }).catch(function(){});
  };

  var runOne = function(job){
    var it = job.it;
    var fullPath = base ? base + '/' + job.path : job.path;
    var attempt = 0;
    var tryOnce = function(){
      attempt++;
      return uploadOne(it.file, fullPath, job.path).then(function(){
        done++; okCount++; tick();
      }).catch(function(e){
        if ((e.status === 429 || e.message === '网络中断') && attempt < 6){
          return new Promise(function(r){ setTimeout(r, backoffMs(e.status, e.retryAfter, attempt)); }).then(tryOnce);
        }
        done++; failed.push(job.path); tick();
        toast('「' + job.path + '」上传失败：' + e.message);
      });
    };
    return tryOnce();
  };

  return pool(dirList, makeDir, 4).then(function(){
    return pool(jobs, runOne, 4);
  }).then(function(){
    uploading = false;
    document.getElementById('upTitle').textContent = '完成 ' + okCount + '/' + jobs.length +
      (failed.length ? '（失败 ' + failed.length + '）' : '') +
      (skipped.length ? '（跳过 ' + skipped.length + '）' : '');
    setTimeout(function(){ up.style.display = 'none'; }, 3500);
    if (okCount) invalidateTree();
    return load(state.path).then(function(){
      var msg = '已上传 ' + okCount + ' 个文件';
      if (skipped.length) msg += '，跳过 ' + skipped.length + ' 个同名文件';
      if (failed.length) msg += '，' + failed.length + ' 个失败';
      toast(msg);
      // 批量上传是 4 路并发的，而索引更新是"读整份索引 → 改 → 写回"，
      // 并发交错可能互相覆盖（虽然 R2 条件写会重读重放，但每批都冲突仍可能漏条目）。
      // 单文件上传不并发所以没事，文件夹上传却会"部分文件搜正文搜不到"，
      // 所以批量传完后自动分批重建一次，把可能漏掉的补回来。
      if (okCount > 1) reindexAll();
    });
  });
}

// 上传相关的元素只在可写页面存在，只读分享页整块跳过
var fileInputEl = document.getElementById('fileInput');
if (fileInputEl){
  fileInputEl.addEventListener('change', function(e){
    var fl = e.target.files;
    handleFiles(fl).finally(function(){ e.target.value = ''; });
  });
  var dirInputEl = document.getElementById('dirInput');
  if (dirInputEl){
    dirInputEl.addEventListener('change', function(e){
      var items = collectFromInput(e.target.files);
      e.target.value = '';
      if (!items.length){ toast('文件夹里没有可上传的文件'); return; }
      confirmTreeUpload(items);
    });
  }
  document.getElementById('upClose').onclick = function(){
    if (uploading && !confirm('上传尚未完成，确定要关闭进度面板吗？')) return;
    document.getElementById('up').style.display = 'none';
  };

  var dropEl = document.getElementById('drop');
  var dragDepth = 0;
  window.addEventListener('dragenter', function(e){
    if (RO || !e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault(); dragDepth++; dropEl.classList.add('on');
  });
  window.addEventListener('dragover', function(e){ if (!RO) e.preventDefault(); });
  window.addEventListener('dragleave', function(){
    dragDepth--; if (dragDepth <= 0){ dragDepth = 0; dropEl.classList.remove('on'); }
  });
  window.addEventListener('drop', function(e){
    e.preventDefault();
    dragDepth = 0; dropEl.classList.remove('on');
    if (RO) return;
    // 先同步取目录句柄（webkitGetAsEntry 不能放到异步之后），再决定走哪种上传
    var dt = e.dataTransfer;
    scanDataTransfer(dt).then(function(items){
      if (items && items.length) confirmTreeUpload(items);
      else if (dt && dt.files && dt.files.length) handleFiles(dt.files);
      else toast('请拖入具体的文件或文件夹');
    });
  });
}

// ===== 启动 =====
// 批量操作条只在可写页面才输出，这里要判空（只读分享页没有这些元素）
var batchBar = document.getElementById('batch');
if (batchBar){
  document.getElementById('batchDel').onclick = batchDelete;
  document.getElementById('batchMove').onclick = openBatchMove;
  document.getElementById('batchDl').onclick = batchDownload;
  document.getElementById('batchClear').onclick = exitMulti;
  document.getElementById('batchAll').onclick = function(){
    var all = state.folders.length + state.files.length;
    if (all > 0 && selCount() >= all) clearSel();
    else { enterMulti(); selectAll(); }
  };
}
document.getElementById('q').addEventListener('input', onSearchInput);

// ===== 搜索框：历史下拉 + 结果键盘导航 + 目录范围开关 =====
(function(){
  var q = document.getElementById('q');
  var qh = document.getElementById('qHist');
  if (!q) return;

  histLoad();                                   // 上次搜过的词从本地读回来

  // 选中历史词：填进搜索框并立即搜
  function applyHist(v){
    v = String(v || '').trim();
    if (!v) return;
    q.value = v;
    histClose();
    clearTimeout(searchTimer);
    histPush(v);
    runSearch(v);
  }

  q.addEventListener('focus', function(){ if (searchHist.length) histOpen(); });
  q.addEventListener('keydown', function(e){
    var open = qh && qh.classList.contains('on');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if (!open){ if (searchHist.length) histOpen(); e.preventDefault(); return; }
      var n = searchHist.length;
      if (!n) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') qhSel = (qhSel <= -1) ? n - 1 : qhSel - 1;
      else qhSel = (qhSel >= n - 1) ? -1 : qhSel + 1;
      histRender();
      var sel = qh.querySelector('.qh.on');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter'){
      e.preventDefault();
      if (open && qhSel >= 0 && searchHist[qhSel] !== undefined) applyHist(searchHist[qhSel]);
      else { clearTimeout(searchTimer); histClose(); runSearch(q.value.trim()); }
      return;
    }
    if (e.key === 'Escape'){ if (open){ e.preventDefault(); histClose(); } return; }
  });

  // 用 mousedown 抢在 blur / 外层 click 之前处理，避免"点了没反应"
  if (qh){
    qh.addEventListener('mousedown', function(e){
      var t = e.target;
      var it = t && t.closest ? t.closest('[data-hq]') : null;
      if (it){ e.preventDefault(); applyHist(it.getAttribute('data-hq')); return; }
      var cl = t && t.closest ? t.closest('[data-hclr]') : null;
      if (cl){ e.preventDefault(); searchHist = []; histSave(); histRender(); return; }
    });
  }
  // 点空白处收起历史下拉（搜索框与下拉自身不算"外面"）
  document.addEventListener('click', function(e){
    if (!qh || !qh.classList.contains('on')) return;
    var t = e.target;
    if (t && t.closest && t.closest('.side-search')) return;
    histClose();
  }, true);

  // 「只在当前目录内搜索」开关
  var sc = document.getElementById('qScope');
  if (sc) sc.addEventListener('change', onScopeToggle);

  // 结果列表键盘导航：焦点不在输入框 / 弹窗没开时才接管 ↑↓ / Enter / Esc
  document.addEventListener('keydown', function(e){
    if (!searchState || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    if (mask && mask.classList.contains('on')) return;
    if (e.key === 'ArrowDown'){ if (srSelect(srSel + 1)) e.preventDefault(); return; }
    if (e.key === 'ArrowUp'){ if (srSelect(srSel - 1)) e.preventDefault(); return; }
    if (e.key === 'Enter'){ if (srOpenSelected()) e.preventDefault(); return; }
    if (e.key === 'Escape'){ if (srSel >= 0){ srClearSel(); e.preventDefault(); } return; }
  });
})();

// 管理页启动就预载分享列表：这样"哪些已经分享过"和弹窗内容都是现成的
if (!RO) refreshShareCache(false);

// 上次没传完的大文件：提示一下"重新选择同一个文件即可继续"。
// （浏览器不允许网页在刷新后自行读取本地文件，所以要用户再选一次，但已传的分片会复用）
if (!RO){
  setTimeout(function(){
    loadMpSessions(true).then(function(list){
      if (!list || !list.length) return;
      var names = list.slice(0, 2).map(function(s){ return String(s.path || '').split('/').pop(); }).join('、');
      toast('有 ' + list.length + ' 个大文件没传完（' + names + (list.length > 2 ? '…' : '') + '），重新选择同一文件可继续');
    });
  }, 1800);
}

// 以下是编辑（管理端）专有的元素，只读分享页根本没有，逐个判空
// 换行开关：管理端与只读页共用同一份偏好
(function(){
  var hasArea = document.getElementById('edt') || document.getElementById('viewer');
  if (!hasArea) return;
  var b1 = document.getElementById('btnWrap');
  if (b1) b1.onclick = toggleWrap;
  var b2 = document.getElementById('vWrap');
  if (b2) b2.onclick = toggleWrap;
  document.addEventListener('keydown', function(e){
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'z' || e.key === 'Z')){
      e.preventDefault();
      toggleWrap();
    }
  });
  applyWrap();
})();

var edtEl = document.getElementById('edt');
if (edtEl){
  document.getElementById('btnSave').onclick = publishEd;
  document.getElementById('zOut').onclick = function(){ setFont(-1); };
  document.getElementById('zIn').onclick = function(){ setFont(1); };
  edtEl.style.fontSize = edFont + 'px';
  document.getElementById('zVal').textContent = edFont;

  // 输入：立刻标脏 + 防抖更新统计/行号/命中高亮。行号重建有成本，所以单独延后一点。
  edtEl.addEventListener('input', function(){
    ed.dirty = true;
    clearTimeout(ed.timer);
    ed.timer = setTimeout(function(){ setStatus('未保存'); }, 150);
    clearTimeout(ed.gtimer);
    ed.gtimer = setTimeout(function(){
      updateCount();
      syncGutter();
      if (findState.open) findRun(true); else renderHl();   // 不在查找时也要重画网址链接
      paintGutCur();
    }, 140);
    outlineSoon();
    saveDraftSoon();
    // 静默自动保存：停手 5 秒就把改动写到服务器，不再依赖用户记得点保存。
    // 为什么是 5 秒而不是 1.5 秒：保存本身要发一次 PUT，而每次 PUT 都会触发后端维护搜索索引。
    // 1.5 秒意味着"每敲几个字就写一次索引"，绝大多数都是白写 —— 拉长到 5 秒后
    // 请求量直接降到 1/3，而"最多丢最后一次修改"的风险一点没增加
    //（失焦 / 切后台 / 关页面这三处仍然是立刻静默存，见下）。
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(function(){ if (ed.dirty) saveEd(true); }, 5000);
  });

  // 另外几个"来不及等防抖"的时刻也要落盘：失焦、切到后台、关闭/刷新页面。
  // 本地草稿（saveDraft）是最后一道保险，两者配合做到"改完关掉也不会丢"。
  edtEl.addEventListener('blur', function(){ if (ed.dirty) saveEd(true); });
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden' && ed.dirty) saveEd(true);
  });
  window.addEventListener('pagehide', function(){ if (ed.dirty) saveEd(true); });

  // 光标移动只改"当前行"高亮，不重建行号槽
  edtEl.addEventListener('keyup', paintGutCur);
  edtEl.addEventListener('click', paintGutCur);
  edtEl.addEventListener('select', paintGutCur);
  edtEl.addEventListener('scroll', function(){ gutScroll(); hlScroll(); });
  edtEl.addEventListener('keydown', edKeydown);

  // 网址快捷打开。普通点击永远是"放光标"（不改编辑习惯），两条路打开：
  // 桌面 Ctrl/Cmd+点击正文里的网址直接走；任何设备都可以点网址末尾那个小图标。
  edtEl.addEventListener('click', function(e){
    if (!(e.ctrlKey || e.metaKey)) return;
    var l = linkAt(edtEl.selectionStart);
    if (l) openUrl(l.href);
  });

  // 查找替换条
  var btnFind = document.getElementById('btnFind');
  if (btnFind) btnFind.onclick = function(){ openFind(false); };
  // 复制全文：走 copyText 的三级降级（同步 execCommand → Clipboard API → 手动面板），
  // 这样手机端点了也能真的复制成功
  var edCopyBtn = document.getElementById('edCopy');
  if (edCopyBtn) edCopyBtn.onclick = function(){
    var v = edText();
    if (!v){ toast('还没有内容'); return; }
    copyText(v);
  };
  var fq = document.getElementById('fQ');
  if (fq){
    fq.addEventListener('input', function(){
      // 用户自己敲字 = 普通单串查找，退出"搜索词高亮"会话（否则多关键词语义会和输入框对不上）
      findState.terms = null; findState.word = false;
      findState.q = fq.value; findRun(false);
    });
    fq.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); findGo(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape'){ e.preventDefault(); closeFind(); }
    });
  }
  var bindClick = function(id, fn){
    var el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bindClick('fPrev', function(){ findGo(-1); });
  bindClick('fNext', function(){ findGo(1); });
  bindClick('fRep', findReplaceOne);
  bindClick('fRepAll', replaceAll);
  bindClick('fClose', closeFind);
  bindClick('fCase', function(){
    findState.case = !findState.case;
    this.classList.toggle('on', findState.case);
    findRun(true);
  });
  bindClick('fRe', function(){
    findState.re = !findState.re;
    // 正则只对"一条串"有意义；从多关键词会话切过来就先退回单串（否则用户看到的现象无法解释）
    if (findState.re){ findState.terms = null; findState.word = false; }
    this.classList.toggle('on', findState.re);
    if (findState.re) toast('已启用正则表达式');
    findRun(false);
  });

  // 首屏把行号槽与分段控件铺好
  syncGutter();
  paintEdSeg();
  document.addEventListener('keydown', edKeydown);
}

// 窗口尺寸变了，换行位置会变，行号与高亮都要重算
var rsTimer = null;
window.addEventListener('resize', function(){
  clearTimeout(rsTimer);
  rsTimer = setTimeout(function(){
    if (typeof syncGutter === 'function') syncGutter();
    if (typeof renderHl === 'function') renderHl();
  }, 200);
});

// 只读查看器的几个按钮
if (typeof openViewer === 'function' && document.getElementById('viewer')){
  document.getElementById('vCopy').onclick = function(){
    if (!viewerText){ toast('还没有内容'); return; }
    copyText(viewerText);
  };
  document.getElementById('vDl').onclick = function(){
    if (ed.path) location.href = dlUrl('', ed.path);
  };
  document.getElementById('vBack').onclick = function(){ load(state.path, true); };
}

var sideBtn = document.getElementById('sideBtn');
if (sideBtn){
  sideBtn.onclick = function(){
    document.body.classList.toggle('side-open');
    if (document.body.classList.contains('side-open')) { markOpen(state.path); renderSide(); }
  };
}
document.getElementById('sideMask').onclick = function(){ document.body.classList.remove('side-open'); };

// ===== 侧栏调宽 =====
(function(){
  var grip = document.getElementById('sideGrip');
  if (grip){
    grip.addEventListener('pointerdown', onGripDown);
    grip.addEventListener('dblclick', function(e){
      e.preventDefault();
      toast('已按内容自适应到 ' + fitSideW() + 'px');
    });
    grip.addEventListener('keydown', onGripKey);
  }
  // 恢复上次的宽度
  try {
    var sw = parseInt(localStorage.getItem(SIDE_KEY), 10);
    if (sw >= SIDE_MIN && sw <= SIDE_MAX) setSideW(sw, true);
  } catch (e) {}
})();

// ===== 框选：在列表区域按住拖动 =====
(function(){
  var vl = document.getElementById('viewList');
  if (vl) vl.addEventListener('pointerdown', onMarqDown);
})();

// 排序偏好要在首次 load 之前就位
state.sort = loadSort();

(function(){
  var q = new URLSearchParams(location.search);
  load(q.get('path') || '');
})();

// PWA：注册 Service Worker（Android 的"安装到主屏幕"能力依赖它；iOS 走"添加到主屏幕"，
// 不依赖 SW，但同样受益于 manifest 与图标）。只在安全上下文注册，失败静默 —— SW 挂了不能影响正常使用。
try {
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function(){});
    });
  }
} catch (e) {}
