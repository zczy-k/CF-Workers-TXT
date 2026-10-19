import 'package:flutter/material.dart';

import '../theme.dart';

/// 桌面端把内容收窄居中（微信桌面版 / Notion 的做法），手机上全宽。
///
/// 放在 Scaffold body 里用：`body: Centered(child: ListView(...))`。
class Centered extends StatelessWidget {
  const Centered({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppTheme.contentMaxWidth),
        child: child,
      ),
    );
  }
}
