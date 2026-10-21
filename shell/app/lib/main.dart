import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webshell_core/webshell_core.dart';

import 'src/app.dart';
import 'src/desktop/single_instance.dart';
import 'src/desktop/tray_controller.dart';
import 'src/state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final Branding branding = await loadBranding();

  // Windows 单实例：同一个包（同一 app_id）只许跑一个。第二个实例
  // 唤醒旧窗口后立即退出 —— 多开会让各自的 WebView2 残留弹窗互相看不见
  // 对方进程系的清扫名单，正是"桌面点不动"Bug 的多开放大版（见
  // single_instance.dart / webview_window_guard.dart 的注释）。
  if (!SingleInstanceGuard.instance.claim(
    windowTitle: branding.appName,
    appId: branding.appId,
  )) {
    exit(0);
  }

  final ShellState state = await ShellState.create(branding);

  // 桌面端：关闭按钮收进系统托盘（最小化按钮走系统默认进任务栏，不接管；
  // 移动端没有托盘，supported 为 false 直接跳过）
  if (TrayController.supported) {
    final TrayController tray = TrayController(
      appName: branding.appName,
      hideToTray: () => state.config.closeToTray,
      // 真退出前同步落盘：配置与下载记录都是 400ms 防抖写，退出路径上的
      // 300ms 硬切可能抢在落盘前 —— 这里 flush 一次，最后的改动不丢。
      onBeforeQuit: () async {
        state.saveNow();
        state.saveDownloadsNow();
      },
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
