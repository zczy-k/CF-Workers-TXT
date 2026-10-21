import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:webshell_core/webshell_core.dart';

import 'app.dart';
import 'state.dart';
import 'update_prompt.dart';

/// 启动时的静默更新检查（24h 节流）。
///
/// 与设置页的手动检查（`settings_page.dart` 的 `_checkUpdate`，不受节流）共用
/// [UpdateChecker] 与 [showUpdateDialog]。这里多两件事：
/// * 只在**有界面时**弹窗 —— 通过 MaterialApp 的 [appNavigatorKey] 拿 context，
///   `runApp` 还没渲染第一帧时 `currentContext` 为 null，直接放弃弹窗
///   （检查结果仍然记入节流时间戳，不会因为没弹窗而反复查）；
/// * 无论结果如何都更新 `lastUpdateCheckMs` 并落盘 —— 节流的语义是
///   "今天查过了"，不是"今天查到过更新"。
///
/// 网络失败 / 无配置一律静默：启动路径上不许有任何弹窗打扰。
Future<void> runStartupUpdateCheck(ShellState state) async {
  final Branding branding = state.branding;
  final String? url = branding.updateUrl;
  if (url == null || url.isEmpty) return; // 没配置更新源：整个功能关闭

  final int now = DateTime.now().millisecondsSinceEpoch;
  const int day = 24 * 60 * 60 * 1000;
  if (now - state.config.lastUpdateCheckMs < day) return; // 24h 内查过

  final UpdateInfo? info = await UpdateChecker.fetch(branding);
  state.config.lastUpdateCheckMs = now;
  state.saveSoon();
  if (info == null) return; // 无新版 / 网络失败：静默

  // 等 MaterialApp 挂上（runApp 的第一帧之后）；最多等 10s，防界面逻辑死锁。
  final BuildContext? ctx = await _waitForContext();
  if (ctx == null) return;
  if (!ctx.mounted) return;
  await showUpdateDialog(ctx, info, branding.appVersion);
}

Future<BuildContext?> _waitForContext() async {
  for (int i = 0; i < 100; i++) {
    final BuildContext? ctx = appNavigatorKey.currentContext;
    if (ctx != null && ctx.mounted) return ctx;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  return null;
}
