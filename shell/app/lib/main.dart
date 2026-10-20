import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webshell_core/webshell_core.dart';

import 'src/app.dart';
import 'src/desktop/tray_controller.dart';
import 'src/state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final Branding branding = await loadBranding();
  final ShellState state = await ShellState.create(branding);

  // 桌面端：关闭按钮收进系统托盘（最小化按钮走系统默认进任务栏，不接管；
  // 移动端没有托盘，supported 为 false 直接跳过）
  if (TrayController.supported) {
    final TrayController tray = TrayController(
      appName: branding.appName,
      hideToTray: () => state.config.closeToTray,
    );
    await tray.start();
  }

  runApp(WebShellApp(state: state));
}

/// 白标配置来自 `assets/preset.json`（CI 按 workflow 输入重写它再打包）。
///
/// 读不到就用通用壳默认值：一个坏文件不该让 App 起不来。
Future<Branding> loadBranding() async {
  try {
    final String text = await rootBundle.loadString('assets/preset.json');
    return Branding.fromJson(jsonDecode(text));
  } catch (_) {
    return Branding.generic;
  }
}
