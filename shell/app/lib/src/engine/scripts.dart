import 'dart:convert';

import 'package:webshell_core/webshell_core.dart';

/// 注入到每个页面的桥接脚本。
///
/// 这一层是"全功能"的关键，它补的正是"网页转 APP"工具缺掉的东西：
///   1. `blob:` / `data:` 文件（前端生成的文件）——原生下载事件拦不到这一类；
///   2. 站点自定义请求头 —— WebView 平台不让你改页面内部请求的头，只能在 JS 层补；
///   3. 长按链接 → 原生菜单（下载 / 复制 / 用系统浏览器打开）；
///   4. Windows 上 WebView2 不给全屏事件，这里用 JS 兜底。
String buildBridgeScript(SiteProfile site) {
  final String headers = jsonEncode(site.headers);
  return _template.replaceFirst('__WS_HEADERS__', headers);
}

const String _template = r'''
(function () {
  if (window.__wsInstalled) { return; }
  window.__wsInstalled = true;

  var EXTRA_HEADERS = __WS_HEADERS__;

  function post(name, payload) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler(name, payload);
      }
    } catch (e) { }
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

  // ---- 2) blob:/data: 导出 -------------------------------------------------
  // 这两类不走网络层，原生下载事件拦不到，所以在这里把字节分片读出交给原生落盘。
  // 分片读是为了大文件不会一次性把内存打爆。
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
    }
  }, true);

  var origWindowOpen = window.open;
  window.open = function (u, n, f) {
    if (typeof u === 'string' && (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0)) {
      sendBlob(u, 'download');
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
