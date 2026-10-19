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
/// # 1) 先把脚本导出来（临时文件，不进仓库）
/// #    在 app/test/ 下临时放一个 test，把 buildBridgeScript(...) 写到
/// #    $env:TEMP/opencode/bridgejs/{guess,noguess}.js
/// # 2) 拼一个桩页面：定义 window.flutter_inappwebview.callHandler 把每次 post 记进数组，
/// #    再插入上面导出的脚本，然后 dispatchEvent 点一堆 <a>：
/// #      a[download] / .pdf / .ZIP / ?download=1 / download="名字" / blob: / .html / 无扩展名
/// #    页面最后把数组塞进 <div id="out">，用 --dump-dom 读出来
/// # 3) 跑两次：--virtual-time-budget 让 setTimeout 有机会执行
/// msedge --headless=new --disable-gpu --virtual-time-budget=4000 `
///   --dump-dom "file:///…/harness_guess.html"
/// ```
///
/// 期望：`guess`（Windows）接管 8 种里的 5 种 + blob 三连；`noguess`（Android）只接管
/// `a[download]` 与 blob；`.html` 和普通链接都不动（没有误伤）。
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

    test('按扩展名猜下载：Windows 开、Android 关', () {
      expect(
        buildBridgeScript(_site(), guessDownloadsByExtension: true)
            .contains('var GUESS_DOWNLOADS = true;'),
        isTrue,
      );
      expect(
        buildBridgeScript(_site()).contains('var GUESS_DOWNLOADS = false;'),
        isTrue,
      );
    });

    test('下载接管所需的零件都在：扩展名表、a[download] 判断、上报入口', () {
      final String js = buildBridgeScript(_site(), guessDownloadsByExtension: true);
      expect(js.contains('downloadRequest'), isTrue, reason: '原生侧的 handler 名字要对上');
      expect(js.contains('hasAttribute(\'download\')'), isTrue);
      // 扩展名表来自 core 的 kDownloadExtensions，两端口径必须一致
      expect(js.contains('"apk"'), isTrue);
      expect(js.contains('"pdf"'), isTrue);
      expect(js.contains('"torrent"'), isTrue);
    });
  });
}
