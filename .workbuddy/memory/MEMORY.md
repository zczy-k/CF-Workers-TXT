# CF-Workers-TXT —— 长期项目约定

## 工程事实（改代码前先知道）

- **一份源码两种部署**：`worker.js`（Workers，可直接粘贴到控制台）；`pages.zip` 内是 `_worker.js`（Pages 上传）。**改完 worker.js 必须重建 pages.zip**（zip 里文件名是 `_worker.js`，用 ZIP_DEFLATED）。
- **测试副本**：`.workbuddy/tests/t.mjs` = `worker.js` + 末尾一行 `export { appHtml };`。改完 worker.js 要 `cp` 过去再跑测试。`.workbuddy/tests` 下的 `check.mjs` 是静态守卫（断言 worker 源码片段 + 编译 appHtml 的内联脚本），其余 `*.mjs` 是用 mock 驱动真实 worker 的功能/浏览器测试。
- **当前有效的测试套件**（Node 5 + 浏览器 3）：`check`（静态守卫）、`sharedoc`（**目录分享**的 `?doc=1` + 资源通道 + 边缘缓存）、`htmlshell`（单文件分享的壳页面 / 真文档 / 资源 / SVG）、`sharecache`（命中边缘缓存时不抛"不可变头部"）、`backend`（API 全量）、`htmlshell_browser` / `linkclick_browser` / `pubbtn_browser`（真浏览器）。**`sharedoc` 与 `htmlshell` 不能互相替代**：目录分享走 `serveShareDoc()`，单文件分享走 `serveSharedFile()/buildSharedFile()`，是两段代码。
- **历史测试里有写死的旧路径**：`htmlgate.mjs` / `htmlpreview.mjs` / `htmlshot.mjs` / `perf.mjs` / `browser.mjs` / `htmlperf.mjs` / `probe*.mjs` 里硬编码了 `C:/Users/Administrator/...`（项目早期在别的 Windows 用户下），**在本机跑不起来（ENOENT）**，别以为是自己的改动弄坏的。
- **跑浏览器测试的前提**：本机 Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`；测试自带 `--disable-site-isolation-trials`（否则 iframe 的 console/Network 事件收不到）。**两个浏览器套件都用 8899 端口，不要连着跑**（serve.mjs 未释放会 EADDRINUSE）；Chrome profile 按 pid 隔离，残留 Chrome 会锁住旧目录（EBUSY）。清理进程**不要**用 `taskkill /IM chrome.exe`（会误关用户浏览器），要按命令行里的 `cfwtxt-` 过滤。
- **写测量脚本的两个坑**：`post()` 不 `.json()` 拿到的是 Response（`.ok` 恒为 200，失败被当成功）；缓存写入挂在 `waitUntil` 上是异步的，不等 `exec.waits` 落定就发第二次请求会测出"假未命中"。
- **模板字符串陷阱**：`appHtml()` 产出的那一大段前端脚本写在模板字符串里，**源码里不能出现反斜杠和反引号**（会被吞掉，症状是整页 JS 语法错误）。需要单引号用 `String.fromCharCode(39)` / `CH_BS` 拼。`check.mjs` 有专门的守卫。

## 踩过的坑（别踩第二次）

- **响应头必须复制到新 Response 上再改**。`caches.default.match()` 与 `fetch()` 返回的 Response 头部是**不可变**的，直接 `res.headers.set(...)` 会抛 `Can't modify immutable headers`。线上事故：分享链接在缓存 TTL（60s）内第二次打开返回 `error code: 1101`。`applySecurity()` 已改成 `new Headers(res.headers)` + 重建 Response。
- **测试里没有 `caches` 就等于没测缓存路径**。Node 没有全局 `caches`，需要 `globalThis.caches = makeCaches()`（`mock.mjs` 提供，且**复现了"命中缓存的响应头部不可变"**）。见 `sharecache.mjs`。
- **缓存命中不等于安全头存在**：安全头在 `applySecurity` 里统一补，所以缓存条目本身不含它们 —— 只要 applySecurity 每次都能跑就不会出问题（这也正是上面那个坑致命的原因）。
- **`?doc=1` 的文档要靠 `frame-ancestors` 才嵌得进自己的壳页面**：`applySecurity` 遇到响应自带 `frame-ancestors` 时不再强行加 `X-Frame-Options: DENY`。
- **iframe 是替换元素**：绝对定位同时设 `top`/`bottom` 会忽略 `bottom`、退回 150px 固有高度，必须显式写 `height`。
- **字节级注入优于解码再编码**：给 HTML 注入 `<base>` 时不解码整篇（免费版单请求只有 10ms CPU），也不动原文编码声明。
- **注入的 `<base>` 必须带 `target="_blank"`**：沙箱 iframe 里点一个不带 `target` 的外链会让帧自身导航，被壳页面 CSP 的 `frame-src 'self'` 拦下 → Chrome 把正文帧换成 `chrome-error://` 错误页，**存档当场废掉**。论坛类页面（Discourse）正文链接 90% 以上不带 target。带 `target="_blank"` 后走 sandbox 的 `allow-popups` 开新标签，正文不动。取舍：页内 `#锚点` 也会开新标签（静态存档里无意义）。
- **SingleFile 抓的页面常常没有 `<head>`**：`injectBaseTag` 的锚点会回退到 `<!doctype>` 之后（注入点在 `<html>` 之前，位置非法）。**实测浏览器会把它挪进 head**，baseURI / 相对解析 / target 全部生效 —— 这个回退分支可靠，别"顺手优化"掉。
- **验证点击行为必须用真实鼠标事件**：CDP `Input.dispatchMouseEvent`。程序化 `element.click()` 没有用户激活，`target=_blank` 会被弹窗拦截干扰，得出的结论是错的。
- **沙箱 iframe 在同进程时不是独立 target**：它出现在 `Page.getFrameTree` 里，但 `/json/list` 看不到。要进它的执行上下文用 `Page.createIsolatedWorld({frameId})`（不透明源，普通 eval 进不去）。

## 「真文档」模式（HTML 预览/直链的统一机制）

同一套 `sharedHtmlDoc()`（原文 + 字节级注入 `<base>` + 响应头 CSP）在三个入口复用：
1. 单文件分享直链 `/s/<token>/x.html?doc=1`（壳页面的 iframe 加载它）
2. 管理端 `/<ADMIN>/f/<路径>?doc=1`（编辑器预览用）
3. 目录分享 `/s/<token>/<路径>?doc=1`（分享页查看器用）
配套：`serveShareAsset` 只放行被动类型（CSS/图片/字体），**rootDir 由调用方给**（单文件分享=文件所在目录，目录分享=分享根）。
两条铁律：① doc 模式下**不能给 iframe 挂 csp 属性**（会把 img-src 限死在 data:，连自己目录的图片都挡掉）；② 路径参数**必须先逐段 decodeURIComponent 再归一化**，否则中文/空格目录一律 404。

## 分享链路的领域约定

- 两棵树物理隔离：`d/` 草稿树（管理端读写）、`__pub__/` 影子树（**只有分享页读**）。点「发布」才复制过去。
- 分享直连的 URL 变体：普通导航（HTML 走壳页面）、`?doc=1`（真文档 + `<base>`）、`?raw=1`（纯文本原文）、`?dl=1`（下载）。**发布后 `purgeShareCache` 要把这些变体一起清**。
- 分享内资源通道只放行**被动资源**（`SHARE_ASSET_MIME`：CSS/图片/字体），**永远不含 HTML / 脚本**；路径必须落在被分享文件所在目录内。
- 「发布」按钮有两种置灰：① 路径不被分享覆盖（无链接）；② **内容与影子树一致**（无改动）。判定走 `publishSynced()` 的内容指纹（size+etag），目录是排序后的 `相对路径:size:etag` 整体比。**指纹拿不到必须返回 null（保守放行），绝不能把"缺证据"当成"一致"**；`publish` 动作里还有同款 no-op 兜底（`unchanged:true`，不复制不清缓存）。`saveEd`→false、发布成功→true、目录级发布/撤回/改名/移动/删除→`forgetPubSynced()`。
