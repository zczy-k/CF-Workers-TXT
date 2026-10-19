import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webshell_core/webshell_core.dart';

import 'src/app.dart';
import 'src/state.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final Branding branding = await loadBranding();
  final ShellState state = await ShellState.create(branding);
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
