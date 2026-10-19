import 'dart:convert';

import 'package:webshell_core/webshell_core.dart';

/// 注入到每个页面的桥接脚本。
///
/// 这一层是"全功能"的关键，它补的正是"网页转 APP"工具缺掉的东西：
///   1. `blob:` / `data:` 文件（前端生成的文件）——原生下载事件拦不到这一类；
///   2. **下载意图拦截** —— Windows 上 WebView2 的下载事件根本没接到原生
///      （见 ARCHITECTURE §7），不在这里接管的话，文件会绕过我们的下载器，
///      下载列表里什么都不显示、用户也找不到文件；
///   3. 站点自定义请求头 —— WebView 平台不让你改页面内部请求的头，只能在 JS 层补；
///   4. 长按链接 → 原生菜单（下载 / 复制 / 用系统浏览器打开）；
///   5. Windows 上 WebView2 不给全屏事件，这里用 JS 兜底。
///
/// [guessExtensions] / [guessQuery] / [guessByLabel]：**自动**接管下载的三条宽松规则。
///
/// 触发面覆盖（"点了就要下载"这件事在页面里可能有多少种写法）：
///   * 用户点 `<a download>` / `<a href="…zip">` / 文字写着"下载"的 `<a>`；
///   * 站点用 JS 动态造 `<a>` 再 `a.click()`（多数文件保存库都这么干，而且**不一定
///     把它插进 DOM**，所以 click 事件不会冒泡到 document —— 必须单独劫持 `a.click`）；
///   * `window.open(url)` / `location = blob:…` / 服务端回附件的导航型下载
///     （地址常没扩展名，靠按钮文字或 `?download` 认）；
///   * `<form method=post>` 提交后服务端回附件。
///
/// **刻意不接管** `fetch()` / `XMLHttpRequest` 里带 `Content-Disposition: attachment`
/// 的响应：原生浏览器中 fetch/XHR 拿到的响应永远不会触发下载（哪怕带 attachment），
/// 而"打包下载"这类功能恰恰是页面自己逐个 fetch 文件、再在前端拼成一个 zip
/// （本站 worker.js 的 packDownload 就是逐个 fetch，单文件响应头正是 attachment）。
/// 壳一旦抢走这些响应，一次"打包下载"就会被拆成 N 个独立文件 —— 用户看到的正是
/// "应该是一个 zip，结果下了好几个文件"。放手之后，页面自己把 zip 拼好，走
/// `a[download]`（blob:）那条路进来，拿到的才是完整的 zip。
///
/// 每一条都留在这里，是因为站点实现千差万别，漏掉任意一条都会表现为"下载按钮点了
/// 没反应 / 文件不知道去哪了"。命中后统一走两条通道之一：普通 URL 交给原生
/// `downloadRequest`（进下载管理器），内存里的字节交给 `blobStart/blobData/blobEnd`
/// 分片落盘。
String buildBridgeScript(
  SiteProfile site, {
  Set<String> guessExtensions = kBinaryExtensions,
  bool guessQuery = false,
  bool guessByLabel = false,
}) {
  return _template
      .replaceFirst('__WS_HEADERS__', jsonEncode(site.headers))
      .replaceFirst(
        '__WS_EXTENSIONS__',
        jsonEncode(guessExtensions.toList()..sort()),
      )
      .replaceFirst('__WS_GUESS_QUERY__', guessQuery ? 'true' : 'false')
      .replaceFirst('__WS_GUESS_LABEL__', guessByLabel ? 'true' : 'false');
}

const String _template = r'''
(function () {
  if (window.__wsInstalled) { return; }
  window.__wsInstalled = true;

  var EXTRA_HEADERS = __WS_HEADERS__;
  var GUESS_EXTS = __WS_EXTENSIONS__;
  var GUESS_QUERY = __WS_GUESS_QUERY__;
  var GUESS_LABEL = __WS_GUESS_LABEL__;

  // 分片读内存 blob 时的单片大小（见 sendBlobUrl / feedBlob）。
  var CHUNK = 256 * 1024;

  // blob: URL → 页面刚生成的 Blob 本体。
  // 站点拼好 zip 后走的是 URL.createObjectURL(blob) + a[download].click()，
  // 这里在源头把 Blob 抓住，落盘时就不必再 fetch('blob:…') —— 后者在部分
  // WebView 里会直接失败，表现正是"点了没反应、什么都下不了"。
  var WS_BLOBS = {};
  var WS_BLOB_MAX = 32;
  (function () {
    var origCreate = URL.createObjectURL;
    if (typeof origCreate !== 'function') { return; }
    URL.createObjectURL = function (blob) {
      var url = origCreate.call(URL, blob);
      try {
        if (blob instanceof Blob) {
          WS_BLOBS[url] = blob;
          var keys = Object.keys(WS_BLOBS);
          if (keys.length > WS_BLOB_MAX) { delete WS_BLOBS[keys[0]]; }
          setTimeout(function () { delete WS_BLOBS[url]; }, 60000);
        }
      } catch (e) { }
      return url;
    };
  })();

  function post(name, payload) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler(name, payload);
      }
    } catch (e) { }
  }

  function safeUrl(href) {
    try { return new URL(href, document.baseURI); } catch (e) { return null; }
  }

  function absolute(href) {
    var u = safeUrl(href);
    return u ? u.href : href;
  }

  // 取扩展名只看末段：/v1.2/download 的末段没有扩展名，不能把父目录里的 .2 算进来
  function extOf(u) {
    if (!u) { return ''; }
    var p = u.pathname.toLowerCase();
    var slash = p.lastIndexOf('/');
    var dot = p.lastIndexOf('.');
    if (dot < 0 || dot < slash + 1) { return ''; }
    return p.substring(dot + 1);
  }

  // 链接文字/类名/aria-label 写着"下载/保存/导出"？
  //
  // 很多站点的下载地址长这样：`/note1/download`、`/export?id=3` —— 没有扩展名、
  // 也没有 ?download，光看 URL 猜不出来，但按钮上一定写着"下载"。
  function labelSaysDownload(el) {
    if (!GUESS_LABEL || !el) { return false; }
    try {
      var cls = (typeof el.className === 'string') ? el.className : '';
      var t = ((el.innerText || el.textContent || '') + ' ' +
               (el.getAttribute('aria-label') || '') + ' ' +
               (el.getAttribute('title') || '') + ' ' + cls).toLowerCase();
      if (!t) { return false; }
      return t.indexOf('下载') >= 0 || t.indexOf('下載') >= 0 ||
             t.indexOf('保存') >= 0 || t.indexOf('导出') >= 0 ||
             t.indexOf('匯出') >= 0 || t.indexOf('download') >= 0 ||
             t.indexOf('export') >= 0 || t.indexOf('save file') >= 0;
    } catch (e) { return false; }
  }

  // 这个链接/地址是不是"点了就是要下载"？
  //   * 页面自己标了 download 属性 —— 最可靠的信号；
  //   * 纯页内锚点（#…）先排除，否则"导出"这种按钮会被误当成下载；
  //   * 扩展名在保守表里（zip/pdf/apk/docx…，不含图片/音视频/纯文本）；
  //   * 查询串带 download（当 GUESS_QUERY 打开）；
  //   * 链接文字写着下载（当 GUESS_LABEL 打开）。
  function wantsDownload(el, href) {
    if (!href) { return false; }
    if (el && el.hasAttribute && el.hasAttribute('download')) { return true; }
    if (href.charAt(0) === '#') { return false; }
    var u = safeUrl(href);
    if (!u) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
    if (GUESS_EXTS.length && GUESS_EXTS.indexOf(extOf(u)) >= 0) { return true; }
    if (GUESS_QUERY && u.search.toLowerCase().indexOf('download') >= 0) { return true; }
    return labelSaysDownload(el);
  }

  // 每次内存下载给一个唯一 key，避免同一个地址并发下载互相覆盖。
  function newKey(url) {
    return (url || 'blob:') + '|' + Date.now() + '|' + Math.floor(Math.random() * 1e9);
  }

  // ---- 内存字节落盘：blob:/data:/fetch 响应 → 分片交给原生 -----------------
  // 分片读是为了大文件不会一次性把内存打爆。
  function feedBlob(blob, key, name) {
    post('blobStart', {
      url: key,
      name: name || 'download',
      size: blob.size,
      type: blob.type || ''
    });
    if (!blob.size) { post('blobEnd', { url: key }); return; }
    var index = 0;
    function next() {
      if (index >= blob.size) { post('blobEnd', { url: key }); return; }
      var end = Math.min(index + CHUNK, blob.size);
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        post('blobData', { url: key, data: text.substring(text.indexOf(',') + 1) });
        index = end;
        next();
      };
      reader.onerror = function () { post('blobError', { url: key, message: '读取文件失败' }); };
      reader.readAsDataURL(blob.slice(index, end));
    }
    next();
  }

  function sendBlobUrl(url, name) {
    var key = newKey(url);
    // 首选：页面刚 createObjectURL 出来的 Blob 本体还在手里，直接用。
    var cached = WS_BLOBS[url];
    if (!cached && url.indexOf('blob:') === 0) {
      // absolute() 会规范化过 href，逐条前缀比对兜底，保证仍能命中本体。
      var keys = Object.keys(WS_BLOBS);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === url || keys[i].indexOf(url) === 0 || url.indexOf(keys[i]) === 0) {
          cached = WS_BLOBS[keys[i]];
          delete WS_BLOBS[keys[i]];
          break;
        }
      }
    }
    if (cached) {
      feedBlob(cached, key, name);
      return;
    }
    fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      feedBlob(blob, key, name);
    }).catch(function () {
      // fetch 读不了 blob: 时退到 XHR —— 老 WebView 对 blob: 的 fetch 支持不全。
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'blob';
        xhr.onload = function () {
          if (xhr.response) { feedBlob(xhr.response, key, name); }
          else { post('blobError', { url: url, message: '空响应' }); }
        };
        xhr.onerror = function () { post('blobError', { url: url, message: '读取失败' }); };
        xhr.send();
      } catch (e) {
        post('blobError', { url: url, message: String(e) });
      }
    });
  }

  // ---- 1) 接管"点了就该下载"的 <a> ---------------------------------------
  // 返回 true = 已经接管，调用方不要再让默认行为发生。
  function handleAnchor(el, evt) {
    if (!el) { return false; }
    var href = el.getAttribute('href') || '';
    if (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0) {
      if (evt) { evt.preventDefault(); evt.stopPropagation(); }
      sendBlobUrl(absolute(href), el.getAttribute('download') || 'download');
      return true;
    }
    if (!wantsDownload(el, href)) { return false; }
    if (evt) { evt.preventDefault(); evt.stopPropagation(); }
    post('downloadRequest', {
      url: el.href || absolute(href),
      name: el.getAttribute('download') || ''
    });
    return true;
  }

  function closestAnchor(node) {
    var el = node;
    while (el && el.tagName !== 'A') { el = el.parentElement; }
    return el;
  }

  // 用户真实点击（可能点在 <a> 内部的 <span>/<img> 上，所以要向上找 <a>）。
  document.addEventListener('click', function (e) {
    var el = closestAnchor(e.target);
    if (el) { handleAnchor(el, e); }
  }, true);

  // 程序化点击：`var a = document.createElement('a'); a.href = url; a.click();`
  // 很多文件保存库（FileSaver 等）**不会**把这个 a 插进 DOM，于是 click 事件
  // 根本不冒泡到 document，上面那个监听器收不到 —— 必须单独劫持 a.click()。
  // 两条路径互斥（劫持命中时不会触发 DOM 事件冒泡），不会重复下载。
  try {
    var origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (handleAnchor(this, null)) { return; }
      return origAnchorClick.apply(this, arguments);
    };
  } catch (e) { }

  // window.open(url) / window.open('blob:…')
  var origWindowOpen = window.open;
  window.open = function (u, n, f) {
    if (typeof u === 'string' && (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0)) {
      sendBlobUrl(absolute(u), 'download');
      return null;
    }
    if (typeof u === 'string' && wantsDownload(null, u)) {
      post('downloadRequest', { url: absolute(u), name: '' });
      return null;
    }
    return origWindowOpen.apply(window, arguments);
  };

  // ---- 2) form 提交下载（POST 表单 → 服务端回附件） ----------------------
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') { return; }
    var action = form.getAttribute('action') || form.action || '';
    if (!action) { return; }
    var btn = e.submitter || null;
    // 只看 action 里的下载词 / 提交按钮上的文字，避免整张表单 textContent 里
    // 恰好有"下载"两个字就把普通表单也劫持了。
    var actionLike = /download|export|attachment|\/save\b/i.test(action);
    if (!actionLike && !wantsDownload(btn, action) && !(btn && labelSaysDownload(btn))) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    try {
      var method = (form.getAttribute('method') || 'GET').toUpperCase();
      var opts = { method: method };
      var target = absolute(action);
      if (method === 'POST') {
        opts.body = new FormData(form);
      } else {
        var qs = new URLSearchParams(new FormData(form)).toString();
        if (qs) { target = target + (target.indexOf('?') >= 0 ? '&' : '?') + qs; }
      }
      fetch(target, opts).then(function (r) { return r.blob(); }).then(function (blob) {
        feedBlob(blob, newKey(target), '');
      }).catch(function (err) {
        post('blobError', { url: target, message: String(err) });
      });
    } catch (err) {
      post('blobError', { url: action, message: String(err) });
    }
  }, true);

  // ---- 3) 给页面 fetch/XHR 补站点头 + 拦下"附件响应" ---------------------
  function mergeHeaderObject(h) {
    var out = {};
    if (!h) { return out; }
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(function (p) { out[p[0]] = p[1]; });
      } else {
        for (var k in h) { out[k] = h[k]; }
      }
    } catch (e) { }
    return out;
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (EXTRA_HEADERS && Object.keys(EXTRA_HEADERS).length) {
          init = init || {};
          var merged = {};
          var k;
          for (k in EXTRA_HEADERS) { merged[k] = EXTRA_HEADERS[k]; }
          var given = mergeHeaderObject(init.headers);
          for (k in given) { merged[k] = given[k]; }
          init.headers = merged;
        }
      } catch (e) { }
      // 只补站点头，响应原样返回。
      // 不再接管带 attachment 的响应 —— 原生 fetch 也不会因响应头而下载，
      // 而"打包下载"（页面自己逐个 fetch 再拼 zip）会被这种接管拆散（见文件头注释）。
      return origFetch.call(this, input, init);
    };
  }

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () {
      this.__wsHeaders = {};
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { this.__wsHeaders[String(name).toLowerCase()] = 1; } catch (e) { }
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        if (EXTRA_HEADERS && Object.keys(EXTRA_HEADERS).length) {
          for (var k in EXTRA_HEADERS) {
            if (!self.__wsHeaders || !self.__wsHeaders[String(k).toLowerCase()]) {
              self.setRequestHeader(k, EXTRA_HEADERS[k]);
            }
          }
        }
      } catch (e) { }
      // 同 fetch：不接管带 attachment 的 XHR 响应 —— 原生里 XHR 也不触发下载，
      // 接管它只会把"页面自己逐个拉文件再拼 zip"的内部请求误当成下载。
      return origSend.apply(this, arguments);
    };
  } catch (e) { }

  // ---- 4) 长按链接 → 原生菜单 ---------------------------------------------
  // 需要原生侧关掉 WebView 自带的上下文菜单（disableContextMenu），这个事件才会来。
  document.addEventListener('contextmenu', function (e) {
    var el = closestAnchor(e.target);
    if (!el) { return; }
    e.preventDefault();
    post('longPressLink', {
      url: el.href || '',
      text: String(el.innerText || el.textContent || '').trim().substring(0, 60)
    });
  }, true);

  // ---- 5) 全屏兜底 --------------------------------------------------------
  function reportFullscreen(on) { post('fullscreen', { on: !!on }); }
  document.addEventListener('fullscreenchange', function () {
    reportFullscreen(document.fullscreenElement);
  }, true);
  document.addEventListener('webkitfullscreenchange', function () {
    reportFullscreen(document.webkitFullscreenElement);
  }, true);
})();
''';
