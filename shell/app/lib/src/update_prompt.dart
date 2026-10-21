import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

import 'open.dart';

/// 「发现新版本」对话框 —— 设置页手动检查与启动后的自动检查共用一套 UI。
///
/// 只提供两个动作：稍后 / 前往下载（系统浏览器打开 `update_url` JSON 里的 `url`）。
/// 下载安装这步不接管：APK 静默安装需要额外权限，Windows 端更新更是各家分发
/// 各家规矩，交给浏览器最稳。
Future<void> showUpdateDialog(
  BuildContext context,
  UpdateInfo info,
  String currentVersion,
) {
  return showDialog<void>(
    context: context,
    builder: (BuildContext dialogContext) => AlertDialog(
      title: Text('发现新版本 v${info.version}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('当前版本 v$currentVersion'),
          if ((info.note ?? '').trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: 12),
            Text(info.note!),
          ],
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('稍后再说'),
        ),
        FilledButton(
          onPressed: () {
            Navigator.of(dialogContext).pop();
            openExternal(info.url);
          },
          child: const Text('前往下载'),
        ),
      ],
    ),
  );
}
