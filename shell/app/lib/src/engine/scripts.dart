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
/// [guessDownloadsByExtension]：链接扩展名像文件（`.zip`/`.pdf`/…）时就当下载
/// 接管。Android 不开这个 —— 那边原生 `onDownloadStartRequest` 会准确告诉你
/// "服务器回的是附件"，而按扩展名猜会把"点开看图/看视频"也变成下载。
String buildBridgeScript(
  SiteProfile site, {
  bool guessDownloadsByExtension = false,
}) {
  return _template
      .replaceFirst('__WS_HEADERS__', jsonEncode(site.headers))
      .replaceFirst(
        '__WS_EXTENSIONS__',
        jsonEncode(kDownloadExtensions.toList()..sort()),
      )
      .replaceFirst(
        '__WS_GUESS_DOWNLOADS__',
        guessDownloadsByExtension ? 'true' : 'false',
      );
}

const String _template = r'''
(function () {
  if (window.__wsInstalled) { return; }
  window.__wsInstalled = true;

  var EXTRA_HEADERS = __WS_HEADERS__;
  var GUESS_DOWNLOADS = __WS_GUESS_DOWNLOADS__;
  var DOWNLOAD_EXTS = __WS_EXTENSIONS__;

  function post(name, payload) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler(name, payload);
      }
    } catch (e) { }
  }

  function absolute(href) {
    try { return new URL(href, document.baseURI).href; } catch (e) { return href; }
  }

  // 这个链接是不是"要点下载"？只认两类，避免把普通链接变成下载：
  //   * 页面自己标了 download 属性；
  //   * （Windows 上）地址末段的扩展名像文件。
  function wantsDownload(el, href) {
    if (!href) { return false; }
    if (el.hasAttribute('download')) { return true; }
    if (!GUESS_DOWNLOADS) { return false; }
    var u;
    try { u = new URL(href, document.baseURI); } catch (e) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
    var path = u.pathname.toLowerCase();
    var dot = path.lastIndexOf('.');
    if (dot < 0) { return u.search.toLowerCase().indexOf('download') >= 0; }
    return DOWNLOAD_EXTS.indexOf(path.substring(dot + 1)) >= 0;
  }

  // ---- 1) 给页面自己的 fetch / XHR 补上站点自定义请求头 ---------------------
  try {
    if (EXTRA_HEADERS && Object.keys(EXTRA_HEADERS).length) {
      var mergeHeaders = function (h) {
        var out = {};
        if (!h) { return out; }
        if (typeof Headers !== 'undefined' && h instanceof Headers) {
          h.forEach(function (v, k) { out[k] = v; });
        } else if (Array.isArray(h)) {
          h.forEach(function (p) { out[p[0]] = p[1]; });
        } else {
          for (var k in h) { out[k] = h[k]; }
        }
        return out;
      };

      var origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (input, init) {
          try {
            init = init || {};
            var merged = {};
            var k;
            for (k in EXTRA_HEADERS) { merged[k] = EXTRA_HEADERS[k]; }
            var given = mergeHeaders(init.headers);
            for (k in given) { merged[k] = given[k]; }
            init.headers = merged;
          } catch (e) { }
          return origFetch.call(this, input, init);
        };
      }

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
        try {
          for (var k in EXTRA_HEADERS) {
            if (!this.__wsHeaders || !this.__wsHeaders[String(k).toLowerCase()]) {
              this.setRequestHeader(k, EXTRA_HEADERS[k]);
            }
          }
        } catch (e) { }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) { }

  // ---- 2) 下载接管：blob:/data: 与"点了就是要下载"的链接 -------------------
  // blob:/data: 不走网络层，原生下载事件拦不到，所以在这里把字节分片读出交给原生落盘。
  // 分片读是为了大文件不会一次性把内存打爆。
  // 普通链接则按 wantsDownload() 判断：a[download] 两端都认，扩展名像文件只在 Windows 认。
  var CHUNK = 256 * 1024;

  function sendBlob(url, name) {
    fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      post('blobStart', {
        url: url,
        name: name || 'download',
        size: blob.size,
        type: blob.type || ''
      });
      var index = 0;
      if (!blob.size) { post('blobEnd', { url: url }); return; }

      function next() {
        if (index >= blob.size) { post('blobEnd', { url: url }); return; }
        var end = Math.min(index + CHUNK, blob.size);
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result);
          post('blobData', { url: url, data: text.substring(text.indexOf(',') + 1) });
          index = end;
          next();
        };
        reader.onerror = function () { post('blobError', { url: url, message: '读取文件失败' }); };
        reader.readAsDataURL(blob.slice(index, end));
      }
      next();
    }).catch(function (e) {
      post('blobError', { url: url, message: String(e) });
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') { el = el.parentElement; }
    if (!el) { return; }
    var href = el.getAttribute('href') || '';
    if (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0) {
      e.preventDefault();
      e.stopPropagation();
      sendBlob(href, el.getAttribute('download') || 'download');
      return;
    }
    if (!wantsDownload(el, href)) { return; }
    // 接管下载：不让引擎自己去下（Windows 上它下完既不入列表也不告诉你存在哪）
    e.preventDefault();
    e.stopPropagation();
    post('downloadRequest', {
      url: el.href || absolute(href),
      name: el.getAttribute('download') || ''
    });
  }, true);

  var origWindowOpen = window.open;
  window.open = function (u, n, f) {
    if (typeof u === 'string' && (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0)) {
      sendBlob(u, 'download');
      return null;
    }
    if (typeof u === 'string' && GUESS_DOWNLOADS && wantsDownload({ hasAttribute: function () { return false; } }, u)) {
      post('downloadRequest', { url: absolute(u), name: '' });
      return null;
    }
    return origWindowOpen.apply(window, arguments);
  };

  // ---- 3) 长按链接 → 原生菜单 ---------------------------------------------
  // 需要原生侧关掉 WebView 自带的上下文菜单（disableContextMenu），这个事件才会来。
  document.addEventListener('contextmenu', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') { el = el.parentElement; }
    if (!el) { return; }
    e.preventDefault();
    post('longPressLink', {
      url: el.href || '',
      text: String(el.innerText || el.textContent || '').trim().substring(0, 60)
    });
  }, true);

  // ---- 4) 全屏兜底 --------------------------------------------------------
  function reportFullscreen(on) { post('fullscreen', { on: !!on }); }
  document.addEventListener('fullscreenchange', function () {
    reportFullscreen(document.fullscreenElement);
  }, true);
  document.addEventListener('webkitfullscreenchange', function () {
    reportFullscreen(document.webkitFullscreenElement);
  }, true);
})();
''';
