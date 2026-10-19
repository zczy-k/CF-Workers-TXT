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
///   * `window.open(url)` / `location = blob:…`；
///   * `fetch(url)` 或 `XMLHttpRequest` 拿到一个 `Content-Disposition: attachment`
///     的响应（服务端生成文件的常见做法，地址往往没有扩展名）；
///   * `<form method=post>` 提交后服务端回附件。
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

  // 从 Content-Disposition 里抠文件名（含 RFC 5987 的 filename*=）。
  function fileNameFromCD(cd) {
    if (!cd) { return ''; }
    var m = /filename\*\s*=\s*([^;']*)'[^']*'([^;]+)/i.exec(cd);
    if (m && m[2]) {
      try { return decodeURIComponent(m[2].trim()); } catch (e) { return m[2].trim(); }
    }
    m = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(cd);
    if (m) {
      var v = (m[2] || m[1] || '').trim().replace(/^"|"$/g, '');
      if (v) { return v; }
    }
    return '';
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
    fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      feedBlob(blob, newKey(url), name);
    }).catch(function (e) {
      post('blobError', { url: url, message: String(e) });
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
      var promise = origFetch.call(this, input, init);
      // 服务端生成的下载常常是这样：fetch('/note1/export') → 响应头带
      // Content-Disposition: attachment。地址没扩展名，只能靠响应头认。
      try {
        promise = promise.then(function (resp) {
          try {
            var cd = '';
            try { cd = resp.headers.get('content-disposition') || ''; } catch (e2) { }
            if (/attachment/i.test(cd) && resp.clone) {
              var url = resp.url ||
                (typeof input === 'string' ? absolute(input) : (input && input.url) || '');
              resp.clone().blob().then(function (blob) {
                feedBlob(blob, newKey(url), fileNameFromCD(cd));
              }).catch(function () { });
            }
          } catch (e3) { }
          return resp;
        });
      } catch (e) { }
      return promise;
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
      try {
        self.addEventListener('load', function () {
          try {
            var cd = '';
            try { cd = self.getResponseHeader('content-disposition') || ''; } catch (e2) { }
            if (!/attachment/i.test(cd)) { return; }
            var body = self.response;
            if (body instanceof Blob) {
              feedBlob(body, newKey(self.responseURL), fileNameFromCD(cd));
            } else if (body instanceof ArrayBuffer) {
              feedBlob(new Blob([body]), newKey(self.responseURL), fileNameFromCD(cd));
            } else if (typeof body === 'string' && body) {
              feedBlob(new Blob([body]), newKey(self.responseURL), fileNameFromCD(cd));
            }
          } catch (e3) { }
        });
      } catch (e) { }
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
