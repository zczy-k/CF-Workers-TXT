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
    return ListenableBuilder(
      listenable: state,
      builder: (BuildContext context, Widget? _) {
        final Color seed = Color(state.branding.themeColor);
        return MaterialApp(
          title: state.branding.appName,
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light(seed),
          darkTheme: AppTheme.dark(seed),
          home: _homeFor(state),
        );
      },
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
