import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webshell/src/icons.dart';
import 'package:webshell/src/pages/home_page.dart';
import 'package:webshell/src/state.dart';
import 'package:webshell_core/webshell_core.dart';

/// 测试里不发真 HTTP、不往磁盘写图标。
class _NoNetworkIcons extends IconFetcher {
  _NoNetworkIcons() : super(Directory.systemTemp);

  @override
  Future<String?> fetch(SiteProfile site) async => null;
}

/// 测试里也不建 `HttpClient`：真实现（FileDownloadTransport）在构造时就建一个，
/// 会让测试运行时警告"本测试创建了 HttpClient"。这些用例根本不下载，桩掉最干净。
class _NoNetworkTransport implements DownloadTransport {
  @override
  Future<DownloadResponse> open(
    Uri url, {
    required Map<String, String> headers,
    String? ifRange,
    int offset = 0,
  }) =>
      throw UnimplementedError('测试不下载');

  @override
  Future<DownloadSink> openSink(String path, {required bool append}) =>
      throw UnimplementedError('测试不下载');

  @override
  Future<void> delete(String path) async {}
}

class _Harness {
  _Harness()
      : dir = Directory.systemTemp.createTempSync('webshell_test'),
        config = ShellConfig();

  final Directory dir;
  final ShellConfig config;
  File get configFile => File('${dir.path}/webshell.json');
  File get downloadsFile => File('${dir.path}/downloads.json');

  late final ShellState state = ShellState.forTest(
    config: config,
    configFile: configFile,
    downloadsFile: downloadsFile,
    icons: _NoNetworkIcons(),
    transport: _NoNetworkTransport(),
  );

  void dispose() {
    state.dispose();
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  }
}

/// 把「添加站点」表单挂起来，点一下就能打开；返回值是 showAddSiteSheet 的结果。
Widget _sheetHost(ShellState state, void Function(Future<SiteProfile?>) onOpen) {
  return MaterialApp(
    home: Builder(
      builder: (BuildContext context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => onOpen(showAddSiteSheet(context, state)),
            child: const Text('打开表单'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('添加站点后，站点必须已经写进配置（曾经漏过这一步）',
      (WidgetTester tester) async {
    // 背景：曾经「添加站点」只 new 了一个 SiteProfile 就跳浏览页，没有 addSite，
    // 于是浏览页按 id 查不到它，只显示"这个站点已经被删除了"，首页列表永远是空的。
    // flutter analyze 和纯 Dart 单测都抓不到这种"UI 流程忘了调某个函数"的问题，
    // 所以这条用例是刻意跑一遍界面流程的。
    final _Harness h = _Harness();
    addTearDown(h.dispose);

    Future<SiteProfile?>? opened;
    await tester.pumpWidget(_sheetHost(h.state, (Future<SiteProfile?> f) => opened = f));

    await tester.tap(find.text('打开表单'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'note.istudy.qzz.io/note1');
    await tester.tap(find.text('添加并打开'));
    await tester.pumpAndSettle();

    final SiteProfile? site = await opened!;
    expect(site, isNotNull);
    expect(site!.startUrl, 'https://note.istudy.qzz.io/note1');

    // 这三条就是这个 bug 的验收标准
    expect(h.config.sites, hasLength(1));
    expect(h.config.byId(site.id), isNotNull, reason: '浏览页就是按 id 查站点的');
    expect(h.config.activeSiteId, site.id);

    // 不只是内存里有，也要真的落盘（下次启动还在）
    expect(h.configFile.existsSync(), isTrue);
    expect(h.configFile.readAsStringSync(), contains('note.istudy.qzz.io/note1'));
  });

  testWidgets('同一个地址再添加一次：不会再塞一条，直接交回已有的那个',
      (WidgetTester tester) async {
    final _Harness h = _Harness();
    addTearDown(h.dispose);

    final SiteProfile first = SiteProfile(
      id: newId(),
      name: '我的笔记',
      startUrl: 'https://note.istudy.qzz.io/note1',
      createdAtMs: nowMs(),
    );
    await h.state.addSite(first);

    Future<SiteProfile?>? opened;
    await tester.pumpWidget(_sheetHost(h.state, (Future<SiteProfile?> f) => opened = f));
    await tester.tap(find.text('打开表单'));
    await tester.pumpAndSettle();
    // 故意用不带协议、带首尾空格的写法，验证规整后仍能认出"已经加过"
    await tester.enterText(find.byType(TextField).first, '  note.istudy.qzz.io/note1  ');
    await tester.tap(find.text('添加并打开'));
    await tester.pumpAndSettle();

    final SiteProfile? site = await opened!;
    expect(site?.id, first.id);
    expect(h.config.sites, hasLength(1), reason: '不能出现两条一模一样的站点');
    expect(find.textContaining('已经在列表里了'), findsOneWidget);
  });

  testWidgets('首页：空的时候引导添加，加完之后列出来', (WidgetTester tester) async {
    final _Harness h = _Harness();
    addTearDown(h.dispose);

    Widget host() => MaterialApp(
          home: ListenableBuilder(
            listenable: h.state,
            builder: (BuildContext context, Widget? _) => HomePage(state: h.state),
          ),
        );

    await tester.pumpWidget(host());
    expect(find.text('还没有站点'), findsOneWidget);

    await h.state.addSite(SiteProfile(
      id: newId(),
      name: '我的笔记',
      startUrl: 'https://note.istudy.qzz.io/note1',
      createdAtMs: nowMs(),
    ));
    await tester.pumpWidget(host());
    await tester.pumpAndSettle();

    expect(find.text('还没有站点'), findsNothing);
    expect(find.text('我的笔记'), findsOneWidget);
    expect(find.text('note.istudy.qzz.io/note1'), findsOneWidget);
  });
}
