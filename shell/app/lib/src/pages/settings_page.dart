import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

import '../open.dart';
import '../state.dart';
import '../widgets/centered.dart';
import 'site_edit_page.dart' show copyText;

/// 全局设置。
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.state});

  final ShellState state;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  ShellState get state => widget.state;

  @override
  Widget build(BuildContext context) {
    final ShellConfig config = state.config;
    final Branding branding = state.branding;
    // 与 TrayController.supported 对齐：三桌面平台都显示，移动端不显示
    final bool desktop = !kIsWeb &&
        (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: Centered(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: <Widget>[
            _section(context, '下载'),
            _card(context, <Widget>[
              ListTile(
                title: const Text('同时下载数'),
                subtitle: Text('${config.maxConcurrentDownloads} 个（带宽有限时调小一点更稳）'),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Slider(
                  value: config.maxConcurrentDownloads.toDouble(),
                  min: 1,
                  max: 6,
                  divisions: 5,
                  label: '${config.maxConcurrentDownloads}',
                  onChanged: (double value) {
                    setState(() {
                      config.maxConcurrentDownloads = value.round();
                      state.downloads.maxConcurrent = config.maxConcurrentDownloads;
                    });
                    state.saveSoon();
                  },
                ),
              ),
              const Divider(height: 1, indent: 16, endIndent: 16),
              ListTile(
                title: const Text('下载位置'),
                subtitle: Text(state.downloadDirectoryLabel),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (!Platform.isAndroid)
                      IconButton(
                        tooltip: '打开文件夹',
                        icon: const Icon(Icons.folder_open),
                        onPressed: () async {
                          final String? error =
                              await openDirectory(state.downloadDirectoryLabel);
                          if (error != null) _snack(error);
                        },
                      ),
                    IconButton(
                      tooltip: '复制路径',
                      icon: const Icon(Icons.copy),
                      onPressed: () =>
                          copyText(context, state.downloadDirectoryLabel),
                    ),
                  ],
                ),
              ),
              if (!Platform.isAndroid)
                ListTile(
                  leading: const Icon(Icons.folder_open),
                  title: const Text('更改下载位置'),
                  onTap: _pickDirectory,
                ),
              if (Platform.isAndroid)
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Text(
                    'Android 上文件默认保存在应用自己的目录（不需要存储权限，也不用担心被系统限制）。\n'
                    '想放进系统的「下载」或别的文件夹：在下载列表里选「另存为」即可。',
                    style: TextStyle(fontSize: 12),
                  ),
                ),
            ]),

            _section(context, '浏览'),
            _card(context, <Widget>[
              SwitchListTile(
                title: const Text('省流模式'),
                subtitle: const Text('不自动加载图片；重新打开站点后生效'),
                value: !config.loadImages,
                onChanged: (bool value) {
                  setState(() => config.loadImages = !value);
                  state.saveSoon();
                },
              ),
              SwitchListTile(
                title: const Text('保持登录状态'),
                subtitle: Text(config.saveLogin
                    ? '关闭后立即退出登录，且重启 App 不再保留登录态'
                    : '已关闭：登录态不落盘，重启后需重新登录'),
                value: config.saveLogin,
                onChanged: (bool value) async {
                  await state.setSaveLogin(value);
                  if (mounted) setState(() {});
                },
              ),
            ]),

            if (desktop) ...<Widget>[
              _section(context, '桌面'),
              _card(context, <Widget>[
                SwitchListTile(
                  title: const Text('关闭时收进系统托盘'),
                  subtitle: const Text('点关闭 / 最小化时藏到托盘，不退出；托盘右键可以真正退出'),
                  value: config.closeToTray,
                  onChanged: (bool value) {
                    setState(() => config.closeToTray = value);
                    state.saveSoon();
                  },
                ),
              ]),
            ],

            _section(context, '隐私'),
            _card(context, <Widget>[
              ListTile(
                leading: const Icon(Icons.cookie_outlined),
                title: const Text('清空所有 Cookie'),
                subtitle: const Text('所有站点都会退出登录'),
                onTap: _confirmClearCookies,
              ),
              ListTile(
                leading: const Icon(Icons.history),
                title: const Text('清空下载记录'),
                subtitle: const Text('只清列表，不删已经下载好的文件'),
                onTap: () {
                  state.clearFinishedDownloads();
                  _snack('下载记录已清空');
                },
              ),
            ]),

            _section(context, '关于'),
            _card(context, <Widget>[
              ListTile(
                title: Text(branding.appName),
                subtitle: Text(
                  '万能壳 0.1.0\n'
                  '${branding.isWhiteLabel ? '专属（白标）版本' : '通用版本'}\n'
                  '引擎：Android 系统 WebView / Windows WebView2',
                ),
              ),
              if (state.engineUserAgent != null)
                ListTile(
                  title: const Text('当前引擎 UA'),
                  subtitle: Text(state.engineUserAgent!, style: const TextStyle(fontSize: 11)),
                ),
            ]),
          ],
        ),
      ),
    );
  }

  Widget _section(BuildContext context, String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 20, 8, 8),
      child: Text(
        title,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Theme.of(context).colorScheme.primary,
              fontWeight: FontWeight.w700,
            ),
      ),
    );
  }

  /// 一组设置 = 一张圆角卡片，卡片内条目之间用浅分隔线。
  Widget _card(BuildContext context, List<Widget> children) {
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(children: children),
    );
  }

  Future<void> _pickDirectory() async {
    try {
      final String? dir = await FilePicker.getDirectoryPath(
        dialogTitle: '选择下载位置',
      );
      if (dir == null || dir.isEmpty) return;
      setState(() => state.config.downloadDir = dir);
      state.saveNow();
    } catch (e) {
      _snack('选目录失败：$e');
    }
  }

  Future<void> _confirmClearCookies() async {
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('清空所有 Cookie'),
        content: const Text('所有站点都会退出登录，下次要重新登录。继续？'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('清空'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await state.clearAllCookies();
    _snack('已清空所有 Cookie');
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}
