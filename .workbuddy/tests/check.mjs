import { writeFileSync, readFileSync } from 'node:fs';
import { appHtml } from './t.mjs';

// worker 全文（t.mjs 就是 worker.js 的副本）—— 后端函数的断言查这里，不是内联脚本
const src = readFileSync(new URL('./t.mjs', import.meta.url), 'utf8');

let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg + (extra ? '  → ' + extra : '')); }
}

for (const ro of [false, true]) {
  const html = appHtml({ title: 'T', base: ro ? '/s/abc' : '/admin-x', readonly: ro, hasPw: !ro });
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  ok(!!m, `readonly=${ro} 能提取出内联脚本`);
  const js = m ? m[1] : '';
  writeFileSync(`front_${ro}.js`, js);
  let syn = null;
  try { new Function(js); } catch (e) { syn = e.message; }
  ok(!syn, `readonly=${ro} 内联脚本可以正常编译`, syn);
}

// 关键：确认反斜杠在模板字符串里没被吞掉
const html = appHtml({ title: 'T', base: '/admin-x', readonly: false });
const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

ok(js.includes("'\\n'"), '脚本里保留了换行转义（split 用，双反斜杠写法正确）');
ok(js.includes("'\\t'"), '脚本里保留了制表符转义');
ok(!js.includes("'\n'"), '没有把真换行塞进单引号字符串（那会导致整页 JS 报错）');
ok(!js.includes('Unterminated'), '没有未闭合的正则/分组');
// 反引号必须用 String.fromCharCode(96) 绕过，脚本里不应出现裸反引号
ok(!js.includes(String.fromCharCode(96)), '脚本里没有裸反引号（模板字符串不会被提前截断）');
// 不能出现被吞成裸换行的字符字面量（症状是 ' 后紧跟真换行）
ok(!/';\s*\n\s*'/.test(js), '没有因转义丢失产生的空字符串拼接');

// 必需的 id 都存在（新增的渲染层/编辑器增强元素）
const need = ro => ([
  'viewList', 'viewEdit', 'listBar', 'list', 'crumb', 'acct', 'sideScroll', 'q', 'toast',
]);
const roIds = ['viewer', 'vName', 'vMeta', 'vCount', 'vWrap', 'vCopy', 'vDl', 'vBack', 'vNote', 'vRender', 'vSeg'];
const adminIds = ['edt', 'edGutter', 'edGutterIn', 'edHl', 'edHlIn', 'edMirror', 'edMeasure', 'edRow', 'edPrev',
  'findBar', 'fQ', 'fStat', 'fPrev', 'fNext', 'fCase', 'fRe', 'fR', 'fRep', 'fRepAll', 'fClose',
  'btnFind', 'btnSave', 'btnWrap', 'edSeg', 'edOutline', 'edtStatus', 'edtCount', 'fileInput', 'dirInput', 'batch',
  'edCopy', 'sideGrip', 'edCrumb', 'edLinkIcons'];

const roHtml = appHtml({ title: 'T', base: '/s/abc', readonly: true });
for (const id of roIds) ok(roHtml.includes('id="' + id + '"'), `只读页存在 #${id}`);
for (const id of adminIds) ok(html.includes('id="' + id + '"'), `管理页存在 #${id}`);

// 管理端 id 不应出现在只读页（不生成而非隐藏）
// 注意：必须先把 <script> 剥掉再查 —— 两版页面共用同一段前端 JS，
// 而像 renderEditOps 里的 '<button id="edShare">' 这种字符串会在 JS 源码里出现，
// 直接 includes 全文会误报（有个 id 就是这么被抓出来的）。
const roMarkup = roHtml.replace(/<script[\s\S]*?<\/script>/g, '');
for (const id of ['edt', 'findBar', 'btnSave', 'batch', 'fileInput', 'edCopy', 'edGutter', 'edHl', 'edRow', 'fQ', 'edLinkIcons']) {
  ok(!roMarkup.includes('id="' + id + '"'), `只读页不生成 #${id}`);
}
ok(!roMarkup.includes('id="editOps"') && !roMarkup.includes('class="editTop"'), '只读页不生成编辑器工具栏');

// 刷新按钮：renderAcct() 注入，源码里必须排在退出按钮之前（退出图标的左侧）
{
  const iReload = js.indexOf('id="btnReload"');
  const iLogout = js.indexOf('id="btnLogout"');
  ok(iReload >= 0, '有刷新按钮 #btnReload');
  ok(iReload >= 0 && iLogout > iReload, '刷新按钮在源码里排在退出按钮之前');
  ok(js.includes("getElementById('btnReload').onclick"), '刷新按钮绑定了点击处理');
}

// 网址链接：正则用字符码拼（源码里不能出现裸反斜杠/裸反引号，否则被模板字符串吞掉）
ok(js.includes('var URL_RE = new RegExp(CH_BS'), 'URL_RE 用 CH_BS 拼接构造');
ok(js.includes('function findLinks'), '定义了 findLinks()');
ok(js.includes('function overlayHtml'), '定义了 overlayHtml()');
// 只读分享页不挂网址图标：查看器正文是原样纯文本，前端不再对它做任何加工
ok(!js.includes('paintViewerText'), '只读分享页不再挂网址图标（查看器保持纯文本）');
ok(js.includes('box.textContent = text'), '查看器正文用 textContent 原样写入（不再做网址加工）');
ok(js.includes('function linkAt') && js.includes('function openUrl') && js.includes('function renderLinkIcons'),
  '定义了 linkAt()/openUrl()/renderLinkIcons()（网址打开）');
// 网址不再染色/铺底纹，只在末尾挂一个小图标；文字本身保持和正文一模一样
ok(!/#edHlIn \.lnk\{/.test(html), '编辑器不再给网址铺底色（.lnk 底纹已移除）');
ok(/\.lnkico\{[^}]*background:transparent[^}]*\}/.test(html), '网址图标默认无底色（只有 hover 才给一点反馈）');
// 图标要"极小 + 浅蓝 + 抬高成上标"：平着放必然压住后一个字，抬高才躲得开
ok(/\.lnkico\{[^}]*width:11px;height:11px/.test(html), '网址图标做得很小（11px）');
ok(/\.lnkico\{[^}]*color:#6aa9e0/.test(html), '网址图标是浅蓝色');
ok(js.includes('LINK_ICON_RAISE'), '编辑器里的图标会抬高成上标（LINK_ICON_RAISE）');
ok(js.includes('function cutUrlAtStop') && js.includes('URL_STOP'),
  '网址在全角句读处截断（"a.com/x。后文"不会把中文吃进网址）');
ok(/#edLinkIcons\{[^}]*pointer-events:none/.test(html) &&
  /#edLinkIcons \.lnkico\{[^}]*pointer-events:auto/.test(html),
  '图标层本身不吃鼠标、只有图标可点（点空白处仍然是放光标）');
ok(js.includes('function makeLinkIcon') && js.includes('LINK_ICON'),
  '编辑器网址图标共用同一份 SVG（makeLinkIcon）');

// 布局：桌面端 .layout 不能再有像素级 max-width
// （否则宽屏上侧栏被居中的边距推离左边缘，左侧出现灰带；移动端的 max-width:none 不算）
ok(!/\.layout\{[^}]*max-width:\s*\d/.test(html), '.layout 没有像素级 max-width（宽屏不留左侧空白）');

// 用户可控内容必须转义
const evil = appHtml({ title: '<img src=x onerror=alert(1)>', base: '/admin-x', readonly: false, shareName: '<b>x</b>' });
ok(!evil.includes('<img src=x onerror'), '标题里的 HTML 被转义');

// 前端定义了渲染层与编辑器增强的关键函数
const fns = ['mdHtml', 'mdInline', 'hlCode', 'hlHtml', 'hlBlock', 'jsonTreeHtml', 'csvTableHtml',
  'renderText', 'renderInto', 'kindOf', 'safeUrl', 'syncGutter', 'findRun', 'openFind', 'replaceAll',
  'updateCount', 'saveDraft', 'loadDraft', 'clearDraft', 'mdOutline', 'applyWrap',
  'extBadge', 'extCat',
  'sideW', 'setSideW', 'fitSideW', 'onGripDown', 'onGripKey',
  'loadSort', 'saveSort', 'setSort', 'sortTh', 'sortBarHtml', 'bindSortBar', 'typeLabel',
  'onMarqDown', 'onMarqMove', 'applyMarq', 'endMarq', 'rangeSelect',
  'enterMulti', 'exitMulti', 'rowPick', 'toggleRowPick', 'lpStart', 'lpMove', 'lpEnd', 'lpTipOnce',
  'renderEdCrumb', 'navUrl', 'setUrl',
  'linkAt', 'openUrl', 'renderLinkIcons', 'makeLinkIcon', 'editorLinks', 'cutUrlAtStop'];
for (const f of fns) {
  ok(new RegExp('function\\s+' + f + '\\s*\\(').test(js), `定义了 ${f}()`);
}

// 新函数确实被调用（避免"写了却没人用"）
for (const f of ['syncGutter', 'openFind', 'renderText']) {
  const calls = (js.match(new RegExp(f + '\\s*\\(', 'g')) || []).length;
  ok(calls >= 2, `${f}() 被调用（出现 ${calls} 次）`);
}

// 同一份文档里不能出现重复 id
// （内联分享面板与分享弹窗共用 sharePanelHtml，历史上两处都用了固定 id）
for (const [name, h] of [['管理页', html], ['只读页', roHtml]]) {
  const markup = h.replace(/<script[\s\S]*?<\/script>/g, '');
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dup.length === 0, name + ' 没有重复 id', dup);
}
ok(html.indexOf('data-shrole="token"') >= 0, '分享面板用 data-shrole 而不是 id');

// ---- 本轮：界面整洁 + 位置可见 + 返回键行为 ----
// 内嵌的「分享设置」面板已删除（顶部工具条的分享按钮是唯一入口）
ok(!html.includes('id="sharePanel"'), '编辑器里没有内嵌的分享设置面板');
ok(!js.includes('secShareHead'), '分享面板的折叠标题也一并移除');
ok(!html.includes('.curName'), '旧的"当前：文件名"已换成路径条');
ok(html.includes('id="edCrumb"'), '编辑器顶部有路径条容器');
ok(/\.edCrumb\{[^}]*nowrap/.test(html), '路径条不换行（长路径横向滑动）');
ok(js.includes('function renderEdCrumb'), '有 renderEdCrumb() 生成路径条');
ok(js.includes('data-nav="">'), '路径条的目录级复用 data-nav，点击走同一套跳转逻辑');

// 返回键要能回上一级目录，而不是退出整个网站
ok(js.includes('history.pushState'), '切目录用 pushState 记入历史');
ok(js.includes("addEventListener('popstate'"), '监听 popstate，返回键回到上一级目录');
ok(js.includes('function setUrl'), '有 setUrl() 统一管理地址栏与历史');
ok(js.includes('function navUrl'), '有 navUrl() 拼路径');
ok(!js.includes('history.replaceState(null'), '旧的"每次只替换、从不新增历史"的写法已移除');

// 打开网页不能自动聚焦到文本框（手机上一聚焦就弹键盘，把页面顶掉）
const svSrc = js.slice(js.indexOf('function switchView'));
const svEnd = svSrc.indexOf('\nfunction ');
const svFn = svSrc.slice(0, svEnd > 0 ? svEnd : 900);
ok(!svFn.includes('.focus('), 'switchView 里不再自动聚焦文本框');

// ---- 触屏多选 ----
// 手指拖拽天生是"滚页面"，框选在移动端不成立，所以触屏走"长按进多选"
ok(html.includes('body.multi #list tbody tr'), '多选模式有行级样式');
// 故意不设"每行一个多选按钮"：它和"长按整行"是完全同一套机制，
// 只会把每行操作区从 6 个按钮挤到 7 个。多选的常驻可见入口是复选框本身。
ok(!html.includes('mulionly'), '没有多余的「多选」按钮（与长按机制重复）');
ok(!html.includes('data-act="multi"'), '行操作区不再塞一个「多选」按钮');
const cosMiq = html.indexOf('@media (hover:none) and (pointer:coarse)');
ok(cosMiq >= 0, '存在触屏专属媒体查询');
const miqTail = html.slice(cosMiq);
ok(miqTail.includes('.ck{width:21px'), '触屏把复选框放大到 21px（它就是多选的可见入口）');
ok(miqTail.includes('touch-action:pan-y'), '触屏行允许纵向滚动，长按不会卡住页面');
ok(miqTail.includes('-webkit-touch-callout:none'), '禁掉 iOS 长按弹出的系统菜单');
// 长按没有可见按钮，所以要有一次性的发现性提示（而不是塞个常驻按钮）
ok(js.includes('lpTipOnce'), '触屏首次进列表会提示一次"长按可多选"');
ok(js.includes("(hover:none) and (pointer:coarse)"), '提示只在触屏出现（桌面有框选，不需要）');
// 长按后那次"补发的 click"必须被吞掉，否则刚选中就被取消
ok(js.includes('suppressClickUntil'), '长按触发的 click 有抑制窗口');
// 但抑制必须精确：只针对"被长按的那一行"，否则用户长按后点「重命名」会变成点了没反应
ok(js.includes('suppressRowKey'), '抑制窗口绑定到"被长按的那一行"，不会误吞别处点击');
// 长按检测绝不能把 <a> 排除掉 —— 移动端一行里大部分面积就是文件名那个链接
ok(js.includes("closest('button,input,select,label,option,#list .ops')"),
  '长按只排除操作控件，不排除文件名链接');
// 只读分享页不给批量能力
ok(!roHtml.includes('id="batch"'), '只读分享页没有批量条');

// ---- 高度链：编辑器文本框要铺满可用高度，不能只够内容高 ----
// 桌面链条：body(100vh·列flex) → .layout(flex:1) → main(flex:1·列flex) → .wrap(flex:1) → #edt(flex:1)
ok(html.includes('height:100vh;display:flex;flex-direction:column'), '桌面 body 定高一屏 + 列方向 flex');
ok(/\.wrap\{flex:1;display:flex;flex-direction:column/.test(html), '.wrap 是列 flex 且 flex:1');
ok(html.includes('#edt{flex:1;'), '#edt 用 flex:1 撑满');
// 移动端必须把这条链续上（历史问题：body{display:block} + main{height:auto} 让高度变成"由内容决定"，
// 于是打开一个只有两行的文件时，整页只有那么点高，文本框下面空出一大片）
ok(!html.includes('body{display:block;height:auto;overflow:auto}'), '移动端不再把 body 改成 block（那会砍断高度链）');
ok(html.includes('body{display:flex;flex-direction:column;height:auto;min-height:100vh;overflow:auto}'),
  '移动端保留列 flex + 至少一屏高');
ok(!html.includes('.layout{display:block;max-width:none}'), '移动端 .layout 不再改成 block');
ok(html.includes('#viewEdit{padding-bottom:14px}'), '桌面编辑器不留 60px 底部空白（列表页才需要那点呼吸）');
ok(html.includes('#viewEdit{padding-bottom:12px}'), '移动端编辑器同样收掉为批量条预留的底部内边距');

// ---- PWA（manifest / sw / 动态图标）----
ok(html.includes('<link rel="manifest" href="/manifest.webmanifest">'), '管理页声明 manifest');
ok(roHtml.includes('/manifest.webmanifest'), '只读分享页也声明 manifest');
ok(html.includes('apple-mobile-web-app-capable') && html.includes('apple-touch-icon'), 'iOS 主屏 meta 齐全');
ok(html.includes("register('/sw.js'"), '注册 Service Worker');
ok(/function iconPixels\(/.test(src) && /function iconPng\(/.test(src), '动态图标生成函数存在（后端）');
ok(src.includes("CompressionStream('deflate')"), 'PNG 编码用 CompressionStream（无需二进制资源）');
// SW 只许缓存图标与 manifest：页面带每次随机的 CSP nonce 和登录态，缓存重放会坏事
ok(src.includes("p.indexOf('/icon/') === 0"), 'SW 的静态缓存范围只含图标/manifest');

// 侧栏宽度走 CSS 变量；两个页面都有拖拽手柄
ok(/:root\{--side-w:/.test(html), '侧栏宽度用 CSS 变量 --side-w');
ok(/aside\{[^}]*width:var\(--side-w/.test(html), 'aside 宽度绑定了 --side-w');
ok(html.includes('id="sideGrip"') && roHtml.includes('id="sideGrip"'), '两侧页面都有侧栏拖拽手柄');
ok(!/aside\{width:256px/.test(html), 'aside 不再写死 256px');

// #edMirror / #edMeasure 必须同时有 inset:0 和 overflow:hidden，否则会把 main 撑出几千像素的空白
const mirRule = (html.match(/#edMirror,#edMeasure\{[^}]*\}/) || [''])[0];
ok(/inset:0/.test(mirRule), '#edMirror 有 inset:0（钉住盒子，不撑大滚动区域）', mirRule.slice(0, 90));
ok(/overflow:hidden/.test(mirRule), '#edMirror 有 overflow:hidden');
ok(/visibility:hidden/.test(mirRule), '量测层不可见（纯测量用，不参与显示）');

// ---- 本轮：搜索结果交互优化（第一档 + 3.2/3.3/3.4）----
// 搜索历史：本地存 + 下拉 + ↑↓ 选择
ok(js.includes('function histLoad') && js.includes('function histSave') && js.includes('function histPush'),
  '搜索历史有 load/save/push');
ok(js.includes('SEARCH_HIST_KEY') && js.includes('localStorage.setItem'),
  '搜索历史落在 localStorage（不上传）');
ok(js.includes('histLoad()'), '启动时调用 histLoad() 把历史读回来');
ok(js.includes('if (v) histSchedule(v);'), '输入停手后才记进历史（半成品词不落库）');
ok(js.includes('function histOpen') && js.includes('function histClose') && js.includes('function histRender'),
  '历史下拉有 open/close/render');
ok(js.includes("closest('.side-search')"), '点搜索框以外收起历史下拉');
ok(js.includes('data-hq') && js.includes('data-hclr'), '历史项与「清除搜索记录」都可点');

// 结果列表键盘导航
for (const f of ['srSelect', 'srOpenSelected', 'srClearSel']) {
  ok(js.includes('function ' + f), `定义了 ${f}()`);
}
ok(js.includes('function srRows'), '有 srRows() 取当前渲染出的结果行');
ok(js.includes("e.key === 'ArrowDown'") && js.includes("e.key === 'ArrowUp'") && js.includes('srSelect(srSel + 1)'),
  '↑↓ 在结果列表里移动选中');
ok(js.includes('isContentEditable'), '焦点在输入框时不抢方向键');

// 清空搜索框可返回上次结果
ok(js.includes('function rememberSearch') && js.includes('function restoreSearch') && js.includes('function backBarHtml'),
  '有搜索视图快照（记住 / 返回 / 返回条）');
ok(js.includes('data-srback') && js.includes('data-srbackx'), '「返回搜索结果」条可点、可关闭');
ok(js.includes('rememberSearch();') && js.includes('restoreSearch();'), '快照的存与取都被调用');

// 多关键词区分着色
ok(html.includes('.hl-1{--hlbg:#cfe8ff}') && html.includes('.hl-2{--hlbg:#d6f5e3}') && html.includes('.hl-3{--hlbg:#ffd9e0}'),
  '三种区分底色已定义');
ok(js.includes("' hl-' + (t % 3 + 1)"), '多关键词按词轮换底色（保留重叠区间的先到词）');

// 信息层级重整 + 深搜入口收进 ⋯ 菜单
ok(js.includes('function srRowHtml') && js.includes('function srKind'), '有单行渲染与类型归类');
ok(!js.includes('data-deep='), '结果行里不再内嵌「深搜此文件」按钮');
ok(js.includes("c: 'deep'") && js.includes('function openCtxAt') && js.includes("closest('.sfile[data-openpath]')"),
  '深搜入口改由 ⋯ / 右键菜单带出（并带上搜索词）');
ok(js.includes('data-snip') && js.includes('data-sq'), '结果行带出片段标记与搜索词给菜单用');

// 结果分组 + 筛选芯片（服务端 ftype 过滤）
ok(js.includes('function setSrFilter'), '有 setSrFilter()');
ok(js.includes('data-ftype'), '筛选芯片带 data-ftype');
ok(js.includes("'&ftype=' + srFilter"), '筛选值随请求发给服务端（服务端过滤而非只筛当前页）');
ok(js.includes("var group = (srFilter === '') && list.length > 1"), '「全部」视图下按类型分组');
ok(html.includes('.sr-group{'), '分组标题有样式');
ok(html.includes('.sr-chips button.on'), '筛选芯片有选中态样式');
ok(html.includes('.sfile.sel{'), '结果行有键盘选中态样式');

// 「只在当前目录内搜索」开关
ok(js.includes('function onScopeToggle') && js.includes("addEventListener('change', onScopeToggle)"),
  '目录范围开关有 change 绑定');
ok(js.includes('function effDir') && js.includes('effDir(pq)'), 'effDir() 把开关并进请求的 dir 参数');

// 从搜索结果打开文件 → 正文里把搜索词点亮（侧栏说"有几处"，编辑器要告诉"在哪几处"）
ok(js.includes('function highlightSearchTerms'), '有 highlightSearchTerms()');
ok(js.includes('highlightSearchTerms(searchState.terms'), '打开文件时把搜索词带进编辑器');
ok(js.includes('scroll: pendingGoLine == null'), '深搜跳行优先，不被"滚到第一处"抢走滚动位置');
ok(js.includes('function findScrollToCurrent'), '抽出了 findScrollToCurrent()（可指定是否抢焦点）');
ok(js.includes('findScrollToCurrent(true)'), '从搜索打开时定位但不抢焦点（手机不弹键盘）');
ok(js.includes('terms: null') && js.includes('findState.terms = null'), '手动敲字/切正则会退出"搜索词高亮"会话');
ok(html.includes('#edHlIn .hmark.t1') && html.includes('#edHlIn .hmark.t2') && html.includes('#edHlIn .hmark.t3'),
  '编辑器高亮层有按词分色（t1/t2/t3）');
ok(html.indexOf('#edHlIn .hmark.cur') > html.indexOf('#edHlIn .hmark.t3'),
  '当前命中 .cur 排在分色之后（否则会被按词底色压掉）');
ok(js.includes('if (!findHits.length){') && js.includes('bar.hidden = true'),
  '正文里一处都没有时不留下"无匹配"的查找栏');
ok(js.includes('function wordOkAt'), '整词搜索（"cat"）在编辑器高亮时也守词边界');
ok(js.includes('function setRepCtl'), '有 setRepCtl()（替换控件显隐）');
ok(js.includes('setRepCtl(false)') && js.includes('setRepCtl(true)'),
  '从搜索打开时收起替换控件，自己打开查找栏时恢复');
ok(html.includes('[hidden]{display:none!important}'), 'hidden 属性不会被 .fbtn 的 display 覆盖掉');

// ===== 发布机制（草稿树 d/ 与已发布影子树 __pub__/ 分离）=====
// 后端函数在 worker 全文里（src），前端交互在 js 里 —— 别查错对象
ok(/const PUB = '__pub__\/'/.test(src), '定义了影子树前缀 PUB（与草稿树 ROOT 物理隔离）');
ok(src.includes('function publishPath'), '有 publishPath()（草稿 → 影子树）');
ok(src.includes('function unpublishPath'), '有 unpublishPath()（删影子树副本，草稿不动）');
ok(src.includes('function movePublished'), '有 movePublished()（移动/重命名时同步已发布副本）');
ok(src.includes('function purgeShareCache'), '有 purgeShareCache()（发布后清边缘缓存，避免看到旧内容）');
ok(src.includes('function shareState'), '有 shareState()（区分"已发布/仅草稿"）');
ok(src.includes("action === 'publish'") && src.includes("action === 'unpublish'") && src.includes("action === 'publishAll'"),
  '有 publish / unpublish / publishAll 三个动作');
// 建分享即发布：不先拷过去，链接建出来也是打不开的
ok(src.includes('const pr = await publishPath(bucket, target, asDir)'), '新建分享时自动发布当前版本');
// 自动保存：内容随时进草稿树，但绝不自动进影子树
ok(js.includes('var savePromise = Promise.resolve()'), 'saveEd 用 savePromise 串行化（避免乱序覆盖）');
ok(js.includes('ed.saveTimer = setTimeout(function(){ if (ed.dirty) saveEd(true); }, 5000)'),
  '输入停手 5 秒触发静默保存（1.5s 太频繁：每次保存都会连带重写索引）');
ok(js.includes("addEventListener('visibilitychange'") && js.includes("addEventListener('pagehide'"),
  '切后台/关页面时兜底保存（防改了忘保存就关网页丢内容）');
ok(js.includes('function publishEd') && js.includes("getElementById('btnSave').onclick = publishEd"),
  '工具栏按钮改为「发布」，走 publishEd 而不是 saveEd');
ok(html.includes('>发布</button>'), '按钮文案是「发布」');
ok(js.includes('pubSynced') && js.includes('待发布') && !js.includes('pubStale'),
  '发布状态只有 pubSynced 一个来源（无改动 / 待发布都从它派生，不再有两套状态打架）');
// 分享端只读影子树 + 方案 B：不做全文搜索，只留文件名/路径
ok(src.includes('readonly ? null : await idxLoad'), '分享端不加载全文索引（方案 B：去掉全文搜索）');
ok(js.includes('data-shpub') && js.includes('data-shunpub') && js.includes('data-shpuball'),
  '分享面板 / 分享管理有发布、撤回、全部发布入口');
ok(js.includes('function doPublishAll'), '有一键补发存量分享的 doPublishAll()');
ok(js.includes('if (isSharedPath(path))') && js.includes("{ c: 'unpublish'"),
  '右键菜单的发布/撤回只对"分享页能看到"的路径出现');

// ===== 分享页不该出现任何"正文/索引"字样 =====
// 访客既没有 reindex 权限（点了必然 403），也不该被"未进索引""容量已满"这些内部状态困扰。
// 分享页只该告诉他一件事：这里搜不了正文。
ok(js.includes("if (RO){\n    note = '<div class=\"side-note\">此分享页<b>只按文件名和目录名搜索</b>"),
  '分享页搜索提示改为「只按文件名和目录名搜索」');
ok(js.includes("var extra = RO ? '' : idxBtnHtml(d.indexed)"),
  '分享页不再渲染「建立正文索引」按钮（访客点了也是 403）');
ok(js.includes("if (RO && kd.k === 'text') continue"), '分享页不显示「正文命中」筛选芯片');
ok(js.includes("ctxDeepQ && !isDir && !RO"), '分享页不显示「深搜此文件」（读全文，访客用不了）');
// placeholder 分 readonly / 非 readonly 两套，必须分别查（html 变量是非 readonly 那份）
const roPh = (appHtml({ title: 'T', base: '/s/abc', readonly: true, hasPw: false })
  .match(/id="q"[^>]*placeholder="([^"]*)"/) || [])[1] || '';
ok(roPh.indexOf('按文件名 / 目录搜索') === 0, '分享页搜索框 placeholder 明确说清搜什么', roPh);
ok(html.indexOf('按文件名 / 目录搜索') < 0, '管理端 placeholder 不受分享页改动影响', html.match(/id="q"[^>]*placeholder="([^"]*)"/));
// 反向断言：这些词只能出现在 RO 分支之外，不能出现在分享页会渲染的那段里
const roNoteIdx = js.indexOf('if (RO){\n    note =');
ok(roNoteIdx > 0 && !js.slice(roNoteIdx, roNoteIdx + 400).includes('未建立正文索引'),
  '分享页那段提示里没有「未建立正文索引」');
ok(!js.slice(roNoteIdx, js.indexOf('} else {', roNoteIdx)).includes('正文索引容量已满'),
  '分享页那段提示里没有「正文索引容量已满」');

// ===== 省资源：内容对比 / 5 秒防抖 / 去掉多余 list（索引仍是同步建）=====
ok(js.includes('savedText: null') && js.includes('ed.savedText = text;'),
  'ed.savedText 记录"与云端一致的基线"，用于逐字对比');
ok(js.includes('if (ed.savedText !== null && myVal === ed.savedText){'),
  '内容与基线一致就不保存（改了又改回来 / Ctrl+Z 撤销，一个请求都不发）');
ok(js.includes('if (same){ ed.dirty = false; ed.savedText = myVal; }'),
  '保存成功后基线推进到刚存的内容');
// 只在 saveEd 内部查（别处如移动后刷新列表也用 api('list')，那是必要的）
const saveEdBlock = js.slice(js.indexOf('function saveEd(auto){'), js.indexOf('// 发布当前文件'));
ok(saveEdBlock.indexOf("api('list'") < 0,
  '保存后不再多拉一次 list（纯额外开销，内容缓存已经同步）');
// 索引策略：同步建（保存即写），所以改完立刻搜得到 —— 这是刻意的取舍，别被改回懒更新
const putBlock = src.slice(src.indexOf("if (method === 'PUT') {"), src.indexOf("// ---- DELETE"));
ok(putBlock.indexOf('idxUpsert(') >= 0, '保存文件时同步写搜索索引（改完立刻能搜到）');
ok(!src.includes('function idxCatchUp') && !src.includes('IDX_LAZY_MAX'),
  '没有懒更新那套（懒更新会让"改完第一次搜不到"，已放弃');
ok(!src.includes('lazyDirty') && !js.includes('d.lazy'),
  '搜索路径上不再有 lazy 补齐逻辑和对应提示');
ok(js.includes("if (okCount > 1) reindexAll();") || js.includes('reindexAll();'),
  '批量上传后仍会自动分批重建一次（4 路并发可能漏索引条目）');
// 索引首建窗口：cur.etag 为 null 时必须用「仅当不存在时创建」的条件写，
// 否则并发首建会各自无条件覆盖写、只剩最后一路（已实测丢 3/4）。
ok(src.includes("etagDoesNotMatch: '*'"),
  '索引不存在时用 etagDoesNotMatch:* 原子建键（并发首建不丢条目）');

// reindex 批大小：必须自适应，且断点要记在"处理完之后"
// 这两条都是实测踩出来的坑：写死 limit 会超免费版 10ms CPU；断点记错会隔文件丢条目。
ok(!/post\(\{ action: 'reindex', limit: \d+/.test(js),
  '前端不写死 reindex 的批大小（交给服务端按索引体积自适应）');
ok(/wantLimit > 0\) \? Math\.min\(120, wantLimit\) : 0/.test(src),
  'reindex 批大小会归一化「没传 = 0」（Math.max(1,·) 会让自适应永不触发）');
ok(src.includes('if (scanned >= limit)'),
  'reindex 用 scanned 控批（indexed 不涨，会让本轮一直扫）');
{
  const reBlock = src.slice(src.indexOf("if (action === 'reindex') {"), src.indexOf("if (action === 'mkdir')"));
  const guardAt = reBlock.indexOf('if (scanned >= limit)');
  const markAt = reBlock.indexOf('lastProc = o.key;');
  ok(guardAt >= 0 && markAt > guardAt,
    '断点记在判闸门之后（记在前面会让被拦下的 key 被下一轮跳过 → 隔一个丢一个）');
}

// 多选上传：原来是串行 for+await，选几十个文件就是几十个往返
{
  const hfBlock = js.slice(js.indexOf('async function handleFiles'), js.indexOf('// ===== 上传文件夹'));
  ok(!/for \(var j = 0; j < files\.length; j\+\+\)\s*\{[^}]*await uploadOne/.test(hfBlock),
    '多选上传不是串行 for+await（已改成并发上传）');
  ok(/poolN = \d+/.test(hfBlock) && hfBlock.includes('Promise.all(lanes)'),
    '多选上传走并发池，且等全部完成再收尾');
  ok(hfBlock.includes('doneCount++; tick2();') && hfBlock.includes('toast('),
    '并发上传仍逐个更新进度、逐个报失败（没为了提速丢掉反馈）');
}

// 打包下载的性能红线：防止以后改动把上限或并发改坏
{
  const packBlock = src.slice(src.indexOf("if (action === 'packList') {"), src.indexOf("if (action === 'mkdir')"));
  ok(packBlock.includes('if (dirs.length < ZIP_MAX_FILES)'),
    '空目录数量也受 ZIP_MAX_FILES 约束（否则 3000 个空目录会全塞进 zip）');
  ok(/const direct = await bucket\.head\(R \+ dir\)/.test(packBlock),
    'packList 先 head 区分文件/文件夹（文件走这条能省掉 list）');
  ok(/var pool = 3/.test(js), '打包取内容是 3 路并发（4 路以上容易撞每分钟限速）');
  ok(/function fetchFileBytes\(path, attempts\)/.test(js) && /r\.status === 429 && left > 0/.test(js),
    '取文件遇到 429 会退避重试（几百个请求必然触发放限，不能静默丢文件）');
  // 目录条目也必须有总量上限：单个 packList 有 300，但多选时各列表相加，
  // 不封顶会撞上 ZIP 中央目录的 16 位条目数上限（65535）导致压缩包损坏。
  ok(src.includes('const ZIP_MAX_DIRS = 1000'), '定义了目录条目总量上限 ZIP_MAX_DIRS');
  const pd2 = js.slice(js.indexOf('function packDownload('), js.indexOf('// ===== 多选'));
  ok(pd2.includes('dirEntries.length >= ZIP_MAX_DIRS') && pd2.includes('dirsCut'),
    '目录条目收集有总量封顶并标记截断');
}

// HTML 预览（sandbox iframe）的安全与结构红线
// 真实产出必须**求值**出来看，而不是只对源码做正则 —— 我第一版拼接顺序写错了
// （漏了 img-src 指令名、CSP 变成 default-src 'data:），正则全过、CSP 却是废的。
{
  ok(js.includes("var Q = String.fromCharCode(39);") && js.includes("var IMG_SRC = 'data:';"),
    'HTML 预览的单引号/图片源用变量拼（模板字符串会吃掉反斜杠转义）');
  ok(/if \(kind === 'html'\)/.test(js), 'renderText 里有 html 分支（原来漏配，HTML 只能看源码）');
  ok(/return k === 'md' \|\| k === 'json' \|\| k === 'csv' \|\| k === 'code' \|\| k === 'html';/.test(js),
    'edCanPreview 包含 html（管理端编辑器要有预览按钮）');
  ok(/if \(kind === 'html' && RO\)\{ openViewer/.test(js),
    '只读端点 HTML 走预览查看器');
  ok(js.includes("rbox.className = 'rBox'") && js.includes("'rBox edPrev'"),
    '切文件/切模式时复位容器 className（否则 htmlBox 的 padding:0 会残留弄坏别的渲染）');

  // 抽出拼接串并真实求值（现在要先定位到带 csp 属性的那个 srcdoc iframe：
  // 前面还有个 docSrc 模式的 iframe，那个引用了 E(docSrc)，不能拿来求值）
  const hl = js.split('\n');
  const cspAt = hl.findIndex(l => l.includes('csp="default-src'));
  let hs = cspAt;
  while (hs >= 0 && !hl[hs].includes("html: '<iframe sandbox=")) hs--;
  let he = cspAt;
  while (he < hl.length && !hl[he].includes("></iframe>',")) he++;
  ok(hs >= 0 && he < hl.length, '找到 HTML 预览的 iframe 拼接串');
  if (hs >= 0 && he < hl.length) {
    const expr = hl.slice(hs, he + 1).map(l => l.trim()).join('\n')
      .replace(/^html:\s*/, '').replace(/,$/, '');
    let tag = null, err = '';
    try {
      tag = new Function('var Q=String.fromCharCode(39), IMG_SRC="data:";return (' + expr + ');')();
    } catch (e) { err = e.message; }
    ok(!!tag, 'iframe 拼接串能求值（模板字符串没把字符串截断）' + (err ? ' → ' + err : ''));
    if (tag) {
      ok(!/allow-same-origin/.test(tag), 'sandbox 不含 allow-same-origin（否则能读主站 cookie/存储）');
      ok(!/allow-scripts/.test(tag), 'sandbox 不含 allow-scripts（否则上传的页面脚本会执行）');
      ok(!/allow-forms/.test(tag), 'sandbox 不含 allow-forms');
      ok(!/allow-top-navigation/.test(tag), 'sandbox 不含 allow-top-navigation');
      ok(/referrerpolicy="no-referrer"/.test(tag), '带 referrerpolicy=no-referrer');
      ok(/default-src 'none'/.test(tag), "CSP 有 default-src 'none'");
      ok(/img-src data:/.test(tag), 'CSP 有 img-src data:（少了这条图片指令，CSP 等于没写）');
      ok(/style-src 'unsafe-inline'/.test(tag), "CSP 有 style-src 'unsafe-inline'（否则内联样式全丢）");
      ok(/form-action 'none'/.test(tag) && /frame-src 'none'/.test(tag),
        "CSP 有 form-action / frame-src 'none'");
      ok(!/script-src/.test(tag), 'CSP 不放开 script-src（与 sandbox 双保险）');
      ok(tag.endsWith('></iframe>'), 'iframe 标签正确闭合');
      ok(/frame-src 'none'" title=/.test(tag), 'csp 属性引号正确闭合（错一位就整段失效）');
    }
  }
  ok(/fr\.srcdoc = r\.srcdoc/.test(js) && /fr\.src = r\.docSrc/.test(js),
    '两处预览都支持两种模式（srcdoc 老路径 / docSrc 真文档）');
}

// HTML 预览的资源红线：服务端别做"整篇解码 → 再编码回 UTF-8"的无谓往返
{
  ok(/const sniff = sniffEncoding\(bytes\);/.test(src),
    '读文件先做一次廉价编码嗅探（sniffEncoding 只采样前 64KB）');
  ok(/sniff\.enc === 'utf-8' && !sniff\.bom/.test(src),
    "UTF-8 且无 BOM 才走快路径（带 BOM 的原样回传会把 BOM 显示出来）");
  const fast = (src.match(/return new Response\(bytes, \{ headers \}\);/g) || []).length;
  ok(fast >= 2, '快路径在「在线读取」与「单文件分享」两处都接上（实际 ' + fast + ' 处）');
  ok(/headers\.delete\('ETag'\);/.test(src),
    '转码路径仍删 ETag（转码后原始 etag 不再代表响应体）');
}

// 只读查看器的内存缓存红线：重复打开不再打 R2
{
  ok(/var cached = fileCacheGet\(path\);/.test(js),
    '只读查看器先查内存缓存');
  ok(/fileCachePut\(path, o\.t, o\.enc, o\.etag\);/.test(js),
    '取回后写入缓存（带 etag 供后台校验）');
  ok(/function revalidateViewer\(/.test(js),
    '有独立的 revalidateViewer（缓存先秒出，再后台校验）');
  const rvBody = (js.split('function revalidateViewer(')[1] || '').split('\nfunction ')[0];
  ok(!/getElementById\('edt'\)/.test(rvBody) && !/updateCount|syncGutter|renderHl/.test(rvBody),
    'revalidateViewer 只重画查看器，不碰编辑器 DOM');
}

// 大 HTML 不自动渲染：先给源码，点「渲染」才建 iframe
{
  ok(/var VIEW_RENDER_MAX = 512 \* 1024;/.test(js),
    '有渲染体积阈值常量（VIEW_RENDER_MAX）');
  ok(/kindOf\(name, ''\) === 'html' && text\.length > VIEW_RENDER_MAX/.test(js),
    '只门控 HTML（md/json/csv/代码照旧直接渲染）');
  const pvc = (js.split('function paintViewerContent(')[1] || '').split('\nfunction ')[0];
  ok(/viewerState\.mode = 'src';/.test(pvc),
    '门控命中时默认落到源码视图（不是渲染视图）');
  ok(/function viewerRenderNow\(/.test(js) && /if \(want === 'rich'\) viewerRenderNow\(\);/.test(js),
    '切到「渲染」时才按需建 iframe');
  ok(/paintViewerContent\(rel, o\.t, o\.enc,/.test(js),
    '后台校验也走同一条绘制路径（不会偷偷渲染大页面）');
}

// ===== HTML 单文档分享：壳页面 + 真文档模式（?doc=1）+ 分享内静态资源 + SVG 加固 =====
// 分享直链不能把用户上传的 HTML 按 text/html 吐给浏览器 —— 那等于让上传者的脚本跑在
// 本站源上，能带着会话 Cookie 打管理接口（HttpOnly 只防"读"cookie，不防"用"cookie）。
// 现在：壳页面（自己生成的）+ iframe 加载 ?doc=1 真文档（注入 <base> 让相对资源解析到
// 本分享范围内的被动资源），脚本靠 sandbox + 响应头 CSP 两道闸挡死。
{
  ok(src.includes('const HTML_SHELL_MAX = 4 * 1024 * 1024;'), '定义了 HTML_SHELL_MAX（超大 HTML 退回纯文本源码）');
  ok(/function sharedHtmlShell\(/.test(src), '有 sharedHtmlShell() 壳页面构造函数');
  ok(/function sharedHtmlDoc\(/.test(src), '有 sharedHtmlDoc() 真文档构造（?doc=1）');
  ok(src.includes('const isSvg = /^image\\/svg/i.test(ct);') && src.includes('const isTexty = TEXTY.test(ct) || isSvg;'),
    'SVG 直链并入 isTexty（独立 SVG 文档也能跑脚本，按纯文本输出）');
  ok(src.includes("const isHtml = /^(text\\/html|application\\/xhtml\\+xml)/i.test(ct);"),
    'HTML 分支覆盖 text/html 与 application/xhtml+xml');
  ok(src.includes('if (isHtml && !forceDl && obj.size <= HTML_SHELL_MAX) {') &&
    src.includes('if (wantsDoc) return sharedHtmlDoc(path, obj, shareBase || \'/\', cachable);') &&
    src.includes('if (!wantsRaw) return sharedHtmlShell(path, obj, cachable);'),
    '四种出口分派正确：普通导航→壳、?doc=1→真文档、?raw=1→纯文本、?dl=1/超大→源码');

  const sh = src.slice(src.indexOf('function sharedHtmlShell('));
  const shBody = sh.slice(0, sh.indexOf('\n}'));
  ok(!/innerHTML/.test(shBody), '壳页面不用 innerHTML 注入任何东西');
  ok(/frame\.src = urlWith\('doc', '1'\)/.test(shBody),
    'iframe 加载 ?doc=1 真文档（真实 URL 才解析得对相对路径）');
  const sbAttr = (shBody.match(/sandbox="([^"]*)"/) || [])[1] || '';
  ok(sbAttr === 'allow-popups allow-popups-to-escape-sandbox',
    '壳页面 iframe 的 sandbox 只有 allow-popups 系列（没有 allow-scripts / allow-same-origin）', sbAttr);
  ok(/referrerpolicy="no-referrer"/.test(shBody), '壳页面 iframe 带 referrerpolicy=no-referrer');
  ok(shBody.indexOf('csp="') < 0,
    'iframe 不再挂 csp 属性（那会连自己目录的图片一起挡掉）—— 改用文档响应头里的 CSP');
  ok(/fetch\(urlWith\('raw', '1'\)/.test(shBody) && /if \(m === 'src' && text === null\) loadSrc\(\)/.test(shBody),
    '源码按需才取（打开页面只走一条路，不再多打一次请求）');
  ok(/src\.textContent = t;/.test(shBody), '源码视图用 textContent 写入（不解析 HTML）');
  ok(/escapeHtml\(name\)/.test(shBody), '文件名注入前转义（壳页面唯一注入的用户可控值）');

  ok(/const SHARE_DOC_CSP = /.test(src) && src.includes("script-src 'none'") && src.includes("frame-ancestors 'self'"),
    '真文档自带 CSP：script-src none（与 sandbox 双保险）+ frame-ancestors self（只许自己的壳页面嵌）');
  ok(/frame-ancestors/.test(src.slice(src.indexOf('function applySecurity'), src.indexOf('function applySecurity') + 900)),
    'applySecurity 遇到 frame-ancestors 时不再强行 X-Frame-Options: DENY（否则自己的壳页面也嵌不了）');
  // 线上事故复现守卫：缓存命中返回的 Response 头部不可变，直接 set 会抛
  // "Can't modify immutable headers" → Worker 1101（分享链接 TTL 内二次打开就挂）
  ok(src.includes('const h = new Headers(res.headers);') &&
    src.includes('return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });'),
    'applySecurity 复制一份头部再改（绝不能直接动原响应，缓存/ fetch 的头部是不可变的）');
  ok(src.indexOf('const h = res.headers;') < 0, '没有"直接拿原响应 headers 改"的写法');
  ok(/function injectBaseTag\(/.test(src) && /function asciiIndexOf\(/.test(src) &&
    src.includes("const anchors = ['<head', '<!doctype', '<html'];"),
    'base 注入走字节级拼接（不解码整篇：省 CPU，也不动原文编码声明）');
  ok(/if \(\/\^utf-16\/i\.test\(sniff\.enc \|\| ''\)\) return new Response\(bytes, \{ headers \}\);/.test(src),
    'UTF-16 文档跳过注入（ASCII 锚点在 UTF-16 里搜不到）');
  // 注入的 base 必须带 target="_blank"。不带的话，文档里"没有 target 的外链"一被点击就让
  // 帧自身导航，被壳页面 CSP 的 frame-src 'self' 拦下 → Chrome 把正文帧换成 chrome-error://
  // 错误页，整个存档当场废掉（无头 Chrome 实测复现）。论坛类页面的正文链接 90% 以上不带 target。
  ok(src.includes('\'<base href="\' + escapeHtml(base) + \'" target="_blank">\''),
    '注入的 <base> 带 target="_blank"（否则点外链会把存档正文顶成错误页）');
  ok(/sandbox="allow-popups allow-popups-to-escape-sandbox"/.test(src),
    'iframe 的 sandbox 含 allow-popups（target=_blank 才开得起来；escape 让新标签是正常页面）');

  ok(/const SHARE_ASSET_MIME = \{/.test(src) &&
    !/js:|javascript:|text\/html/.test(src.slice(src.indexOf('const SHARE_ASSET_MIME'), src.indexOf('const SHARE_ASSET_MIME') + 500)),
    '资源白名单里没有脚本类 / 没有 html（只放行样式 / 图片 / 字体）');
  ok(/async function serveShareAsset\(bucket, rootDir, rel, url, exec\)/.test(src) &&
    src.includes("await bucket.get(PUB + safeDir(normPath(rootDir + '/' + normPath(rel))))"),
    '资源路径按资源根目录归一化（复用 safeDir/normPath，穿越从根上不成立）');
  ok(src.includes('if (isHtmlSharePath(scope) && rest.length) {'),
    '只有 HTML 单文档分享才开资源通道（别的类型不该顺手暴露同目录文件）');
  ok(src.includes("if (rest.length > 1) return text('Not Found', 404);"),
    '深层路径不是白名单资源时直接 404（不再兜底返回文件）');
  const assetFn = src.slice(src.indexOf('async function serveShareAsset('), src.indexOf('// 热门分享走边缘缓存'));
  ok(/serverExtOf\(rel\) === 'svg'/.test(assetFn), 'SVG 资源单独再钉一份最严 CSP');
  ok(assetFn.indexOf('cache.match(key)') >= 0 && assetFn.indexOf('cache.put(key, resp.clone())') >= 0 &&
    assetFn.indexOf('async function serveShareAsset(bucket, rootDir, rel, url, exec)') >= 0,
    '资源也走边缘缓存（命中时 0 次 R2 读；副作用是改图后最多 60 秒生效）');
  ok(src.includes('serveShareAsset(bucket, assetRoot, rel, url, exec)') &&
    src.includes('serveShareAsset(bucket, scope, rel, url, exec)'),
    '两处调用点各传各的资源根（单文件分享=文件所在目录，目录分享=分享根）');
  ok(/async function serveShareDoc\(/.test(src) &&
    src.includes("await serveShareDoc(bucket, full, url, exec, base + '/' + relDir)"),
    '目录分享的 ?doc=1 也走边缘缓存（原来直接调 sharedHtmlDoc，每次加载都读一次 R2）');

  ok(src.includes("urls.push(f, f + '?doc=1', f + '?raw=1', f + '?dl=1');"),
    'purgeShareCache 把 ?doc=1 / ?raw=1 / ?dl=1 缓存变体一起清（否则重新发布后分享页拿旧内容）');
  ok(src.includes('return serveSharedFile(bucket, scope, url, exec, base);'),
    '直连把分享前缀传下去（真文档要靠它拼 <base>）');
}

// ===== 「发布」按钮只在真会被分享页看到时才可点 =====
// 没有任何链接指向这个文件时点发布 = 往影子树拷一份没人会读的内容（白花一次 R2 写），
// 所以置灰 + 把「分享」提成主按钮引导下一步（避免留下"点不动的死按钮"）。
{
  ok(/function updPubBtn\(/.test(js), '有 updPubBtn() 统一管理发布按钮状态');
  ok(js.includes('if (!shareCache.loaded) return;'), '分享列表没加载完不判定（宁可保持原样，也不给假的置灰）');
  ok(js.includes('var shared = !!(path && isSharedPath(path));'),
    '判定复用 isSharedPath（文件本身、或它在某个已分享目录里，都算）');
  ok(js.includes("sh.className = shared ? 'btn sm' : 'btn sm primary';"),
    '未分享时把「分享」提成主按钮（否则用户看到灰按钮却不知道下一步）');
  const applyFn = js.slice(js.indexOf('function applyShareUi(){'), js.indexOf('// 拉取分享列表'));
  ok(applyFn.indexOf('updPubBtn();') >= 0, 'applyShareUi 里同步：新建/取消分享、列表拉回都会走到');
  const opsFn = js.slice(js.indexOf('function renderEditOps(name){'), js.indexOf('function tryLeaveEditor'));
  ok(opsFn.indexOf('updPubBtn(rel);') >= 0, 'renderEditOps 显式传路径（此刻 ed.path 还是上一个文件）');
  ok(opsFn.indexOf('refreshShareCache(false)') >= 0, '打开编辑器顺手把分享列表刷新（15 秒 TTL 内不会重复请求）');
  ok(js.slice(js.indexOf('function renderEdContent('), js.indexOf('function renderEdContent(') + 400)
    .indexOf('updPubBtn();') >= 0, 'renderEdContent 按新路径重判（缓存命中路径不走 renderEditOps 之后那步）');
  const saveFn = js.slice(js.indexOf('function saveEd(auto){'), js.indexOf('// 发布当前文件'));
  ok(saveFn.indexOf('updPubBtn();') >= 0 && saveFn.indexOf('btn.disabled = false') < 0,
    'saveEd 收尾用 updPubBtn 而不是无脑 disabled=false（否则自动保存一跑就把置灰按钮点亮）');
  const pubFn = js.slice(js.indexOf('function publishEd(){'), js.indexOf('function setFont('));
  ok(pubFn.indexOf('updPubBtn();') >= 0 && pubFn.indexOf('btn.disabled = false') < 0,
    'publishEd 收尾同样按状态恢复');
  ok(js.includes('if (shareCache.loaded && !isSharedPath(p)){'),
    'publishEd 再兜一道底：绕过置灰也不会白发一次发布请求');
  ok(/\.btn\.primary:disabled\{[^}]*background:#e6e8eb/.test(html), '禁用的主按钮是真灰色，不是半透明蓝');
}

{



  // 预览真文档化
  ok(src.includes("pathname.indexOf(adminPath + '/f/') === 0"),
    '管理端有文件直出路由 /<ADMIN>/f/<路径>（预览用真文档）');
  ok(src.includes("return sharedHtmlDoc(rel, obj, adminPath + '/f/' + fdir, false);"),
    '管理端文件路由在 ?doc=1 时复用同一个真文档构建器');
  ok(js.includes("BASE + '/f/' + encPath(ed.path) + '?doc=1'"), '编辑器预览加载管理端的真文档');
  ok(/viewerState\.docSrc = kindOf\(name, ''\) === 'html'/.test(js), '分享页查看器同样走真文档');
  ok(/function encPath\(/.test(js) && !/encPath[\s\S]{0,200}\\\\/.test(js),
    'encPath 按段转义路径（且没有多余反斜杠）');
  ok(src.includes("const asset = await serveShareAsset(bucket, scope, rel, url, exec);"),
    '目录分享也能提供分享内的静态资源');
  ok(src.includes("if (url.searchParams.get('doc') === '1' && HTML_EXT_RE.test(serverExtOf(rel)))"),
    '目录分享也支持 ?doc=1 真文档');
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : '\n✅ 静态检查全部通过');
process.exit(fail ? 1 : 0);
