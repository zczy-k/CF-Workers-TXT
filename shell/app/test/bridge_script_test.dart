import 'package:flutter_test/flutter_test.dart';
import 'package:webshell/src/engine/scripts.dart';
import 'package:webshell_core/webshell_core.dart';

/// 注入脚本是"下载能不能落到本机"的关键一环（Windows 上尤其：WebView2 的
/// 下载事件根本没接到原生，只能靠这段脚本把下载意图报上来）。
///
/// 它跑在网页里，Dart 侧没法断言它的行为，所以这里守住最容易出错的三件事：
/// 占位符有没有漏替换、配置有没有真的嵌进去、开关是不是按平台给的。
/// 脚本里语法错的代价是"整个桥接静默失效"，那比崩溃更难查。
///
/// ---
/// 想看**真实行为**（不只是文本），本机可以拿 Edge 无头模式跑真引擎：
///
/// ```powershell
/// # 1) 先把脚本导出来（临时文件，不进仓库）：在 app/test/ 下临时放一个 test，把
/// #    buildBridgeScript(site, guessQuery: true, guessByLabel: true)  写到
/// #    $env:TEMP/opencode/bridgejs/windows.js
/// #    buildBridgeScript(site)                                       写到
/// #    $env:TEMP/opencode/bridgejs/android.js
/// # 2) 拼一个桩页面：定义 window.flutter_inappwebview.callHandler 把每次 post 记进数组，
/// #    把导出的脚本插进去，然后 dispatchEvent 点 16 种 <a>：
/// #      a[download] / .zip / .ZIP / .pdf / .jpg / .mp4 / .txt / .csv / ?download=1 /
/// #      文字是「下载」的 /note1/download / class="download-btn" / 文字是 Save File /
/// #      download="名字" / blob: / .html / 无扩展名
/// #    页面最后把数组塞进 <div id="out">，用 --dump-dom 读出来
/// # 3) 两种配置各跑一次：--virtual-time-budget 让 setTimeout 有机会执行
/// msedge --headless=new --disable-gpu --virtual-time-budget=4000 `
///   --dump-dom "file:///…/harness2_windows.html"
/// ```
///
/// 期望（本机实测过）：
/// * Windows：`a[download]`、`.zip`/`.ZIP`/`.pdf`、`?download=1`、`/note1/download`（链接
///   文字「下载」）、`class="download-btn"`、`Save File`、带名字的 `download` 都被接管
///   （名字也带过来了），blob 走三段分片；共 9 次 downloadRequest + 3 次 blob*。
/// * Android：只接管 `a[download]`、二进制扩展名、带名字的 `download` 与 blob（原生下载
///   事件在那边会兜住附件响应，所以 `?download`/链接文字这类宽松规则不开）。
/// * 两端都**不动**：`.html`、`.jpg`、`.mp4`、`.txt`、`.csv` 与普通链接（没有误伤）。
SiteProfile _site({Map<String, String>? headers}) => SiteProfile(
      id: 's1',
      name: '测试站点',
      startUrl: 'https://example.com/',
      headers: headers,
    );

void main() {
  group('桥接脚本', () {
    test('占位符必须全部替换掉（漏一个就是脚本语法错，整个桥接静默失效）', () {
      final String js = buildBridgeScript(_site(headers: <String, String>{'X-Token': 'a"b'}));
      expect(js.contains('__WS_'), isFalse, reason: '还有没替换的占位符');
      // 也必须是能跑起来的 JS 起点（IIFE 收尾没被截断）
      expect(js.trimLeft().startsWith('(function ()'), isTrue);
      expect(js.trimRight().endsWith(')();'), isTrue);
    });

    test('站点自定义头原样嵌进去，带引号也不会把脚本搞坏', () {
      final String js = buildBridgeScript(
        _site(headers: <String, String>{'X-Token': 'a"b', 'X-Space': '1 2'}),
      );
      expect(js.contains('"X-Token":"a\\"b"'), isTrue);
      expect(js.contains('"X-Space":"1 2"'), isTrue);
    });

    test('自动接管规则：扩展名两端都开，?download 与"链接文字"只给 Windows', () {
      // Android：只有保守的扩展名规则
      final String android = buildBridgeScript(_site());
      expect(android.contains('var GUESS_QUERY = false;'), isTrue);
      expect(android.contains('var GUESS_LABEL = false;'), isTrue);

      // Windows：三条都开（引擎不给下载事件，只能多认几种）
      final String windows = buildBridgeScript(
        _site(),
        guessQuery: true,
        guessByLabel: true,
      );
      expect(windows.contains('var GUESS_QUERY = true;'), isTrue);
      expect(windows.contains('var GUESS_LABEL = true;'), isTrue);
    });

    test('默认扩展名表是保守表：图片/音视频/纯文本不许自动接管', () {
      final String js = buildBridgeScript(_site());
      // 该接管的（WebView 显示不了）
      for (final String ext in <String>['apk', 'pdf', 'zip', 'docx']) {
        expect(js.contains('"$ext"'), isTrue, reason: '$ext 应该在自动接管表里');
      }
      // 不该接管的（用户点它们是想"看"）
      for (final String ext in <String>['jpg', 'mp4', 'mp3', 'txt', 'md', 'csv', 'html']) {
        expect(js.contains('"$ext"'), isFalse, reason: '$ext 不该出现在自动接管表里');
      }
    });

    test('下载接管所需的零件都在：扩展名表、a[download] 判断、上报入口', () {
      final String js = buildBridgeScript(_site(), guessQuery: true, guessByLabel: true);
      expect(js.contains('downloadRequest'), isTrue, reason: '原生侧的 handler 名字要对上');
      expect(js.contains('hasAttribute(\'download\')'), isTrue);
      expect(js.contains('labelSaysDownload'), isTrue);
      expect(js.contains('wantsDownload'), isTrue);
      // 走了 window.open 的下载也要接住
      expect(js.contains('origWindowOpen'), isTrue);
    });
  });
}
