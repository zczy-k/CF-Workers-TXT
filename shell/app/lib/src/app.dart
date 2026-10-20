import 'package:flutter/material.dart';

import 'state.dart';
import 'theme.dart';
import 'pages/browser_page.dart';
import 'pages/home_page.dart';

class WebShellApp extends StatelessWidget {
  const WebShellApp({super.key, required this.state});

  final ShellState state;

  @override
  Widget build(BuildContext context) {
    // 主题/标题静态建：branding 运行期不变（preset.json 只在启动读一次），
    // 没必要跟着任何通知重建。之前这里用 ListenableBuilder 监听整个
    // ShellState 包住 MaterialApp —— 下载中每 200ms 一次 notifyListeners
    // 会把 MaterialApp 整树重建（每次还 new 两套 ThemeData + Navigator +
    // 全部路由），是"下载一跑全 App 掉帧"的根源。
    // 只有 home 需要跟 config 变（站点增删 / 默认站点切换），把监听收窄到
    // home 一层：下载进度广播最多重建首页列表，MaterialApp 本体不动。
    return MaterialApp(
      title: state.branding.appName,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(Color(state.branding.themeColor)),
      darkTheme: AppTheme.dark(Color(state.branding.themeColor)),
      home: ListenableBuilder(
        listenable: state,
        builder: (BuildContext context, Widget? _) => _homeFor(state),
      ),
    );
  }

  /// 首屏策略：
  /// * 单站点直达模式（白标 + 禁止加站）：直接进预置站点的内容页 ——
  ///   用户要的是"打开就是这个网站"，站点列表对他没有意义；
  /// * 其余情况（通用壳，或白标但允许加站）：站点列表首屏，方便添加/切换站点。
  static Widget _homeFor(ShellState state) {
    if (state.branding.singleSiteMode) {
      final String? siteId = state.config.activeSiteId ??
          (state.config.sites.isEmpty ? null : state.config.sites.first.id);
      if (siteId != null) return BrowserPage(state: state, siteId: siteId);
      // 直达模式但站点没了（配置被手改坏之类的兜底）：退回列表页，别给用户黑屏。
    }
    return HomePage(state: state);
  }
}
