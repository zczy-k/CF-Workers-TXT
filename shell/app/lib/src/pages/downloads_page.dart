import 'dart:io';

import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

import '../open.dart';
import '../state.dart';
import 'site_edit_page.dart' show copyText;

/// 下载列表：进度、暂停/继续/取消/重试、打开文件、另存为。
class DownloadsPage extends StatelessWidget {
  const DownloadsPage({super.key, required this.state});

  final ShellState state;

  @override
  Widget build(BuildContext context) {
    // 下载页是 push 出来的路由：App 级的 ListenableBuilder 不会重建它
    // （ModalRoute 的页面只建一次），所以这里必须自己监听 —— 否则点开之后
    // 进度条不动、状态永远停在打开那一刻，看着就像"下载根本没开始"。
    return ListenableBuilder(
      listenable: state,
      builder: (BuildContext context, Widget? _) {
        final List<DownloadTask> tasks = state.downloads.tasks;
        // 显示"实际会落到哪个目录"，而不是设置里那一格（可能是空的）
        final String dir = state.downloadDirectoryLabel;

        return Scaffold(
          appBar: AppBar(
            title: const Text('下载'),
            actions: <Widget>[
              IconButton(
                tooltip: '清空已完成',
                onPressed: tasks.any((DownloadTask t) => t.status == DownloadStatus.done)
                    ? state.clearFinishedDownloads
                    : null,
                icon: const Icon(Icons.cleaning_services_outlined),
              ),
            ],
          ),
          body: tasks.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      '还没有下载。\n\n在站点里点下载链接就行；\n'
                      '前端生成的文件（blob）和长按链接也能下载。\n\n'
                      '文件会保存到：\n$dir',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: tasks.length,
                  separatorBuilder: (BuildContext context, int index) => const Divider(height: 1),
                  itemBuilder: (BuildContext context, int index) =>
                      _TaskTile(state: state, task: tasks[index]),
                ),
          bottomNavigationBar: dir.isEmpty
              ? null
              : SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                    child: Row(
                      children: <Widget>[
                        const Icon(Icons.folder_outlined, size: 16),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            dir,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ),
                        IconButton(
                          tooltip: '打开文件夹',
                          iconSize: 18,
                          onPressed: () => openDirectory(dir),
                          icon: const Icon(Icons.folder_open),
                        ),
                        IconButton(
                          tooltip: '复制路径',
                          iconSize: 18,
                          onPressed: () => copyText(context, dir),
                          icon: const Icon(Icons.copy),
                        ),
                      ],
                    ),
                  ),
                ),
        );
      },
    );
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.state, required this.task});

  final ShellState state;
  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final bool inProgress = task.status == DownloadStatus.running || task.status == DownloadStatus.queued;
    final bool indeterminate = task.total == null || task.total! <= 0;

    return ListTile(
      isThreeLine: task.status == DownloadStatus.failed,
      leading: Icon(_icon, color: _iconColor(context)),
      title: Text(task.fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (inProgress) ...<Widget>[
            const SizedBox(height: 4),
            LinearProgressIndicator(
              value: indeterminate ? null : task.progress,
              minHeight: 3,
            ),
          ],
          const SizedBox(height: 4),
          Text(
            _subtitle(),
            style: Theme.of(context).textTheme.bodySmall,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
      trailing: PopupMenuButton<String>(
        onSelected: (String value) => _onAction(context, value),
        itemBuilder: (BuildContext context) => _menuItems(),
      ),
      onTap: task.status == DownloadStatus.done ? () => _open(context) : null,
    );
  }

  IconData get _icon {
    switch (task.status) {
      case DownloadStatus.queued:
        return Icons.schedule;
      case DownloadStatus.running:
        return Icons.downloading;
      case DownloadStatus.paused:
        return Icons.pause_circle_outline;
      case DownloadStatus.done:
        return Icons.check_circle_outline;
      case DownloadStatus.failed:
        return Icons.error_outline;
      case DownloadStatus.canceled:
        return Icons.cancel_outlined;
    }
  }

  Color _iconColor(BuildContext context) {
    switch (task.status) {
      case DownloadStatus.done:
        return Colors.green;
      case DownloadStatus.failed:
        return Theme.of(context).colorScheme.error;
      case DownloadStatus.canceled:
        return Theme.of(context).disabledColor;
      default:
        return Theme.of(context).colorScheme.primary;
    }
  }

  String _subtitle() {
    switch (task.status) {
      case DownloadStatus.queued:
        return '排队中 · ${task.displaySize}';
      case DownloadStatus.running:
        final String speed = task.resumable ? '' : '（服务器不支持续传）';
        return '下载中 · ${task.displaySize} · ${(task.progress * 100).toStringAsFixed(0)}%$speed';
      case DownloadStatus.paused:
        return '已暂停 · ${task.displaySize}';
      case DownloadStatus.done:
        return '已完成 · ${humanBytes(task.received)}'
            '${task.savePath == null ? '' : ' · ${File(task.savePath!).parent.path}'}';
      case DownloadStatus.failed:
        return '失败：${task.error ?? '未知原因'}';
      case DownloadStatus.canceled:
        return '已取消';
    }
  }

  List<PopupMenuEntry<String>> _menuItems() {
    final List<PopupMenuEntry<String>> items = <PopupMenuEntry<String>>[];
    switch (task.status) {
      case DownloadStatus.queued:
      case DownloadStatus.running:
        items.add(const PopupMenuItem<String>(value: 'pause', child: Text('暂停')));
        items.add(const PopupMenuItem<String>(value: 'cancel', child: Text('取消')));
        break;
      case DownloadStatus.paused:
        items.add(const PopupMenuItem<String>(value: 'resume', child: Text('继续')));
        items.add(const PopupMenuItem<String>(value: 'cancel', child: Text('取消')));
        break;
      case DownloadStatus.failed:
        items.add(const PopupMenuItem<String>(value: 'resume', child: Text('重试')));
        items.add(const PopupMenuItem<String>(value: 'remove', child: Text('从列表移除')));
        break;
      case DownloadStatus.canceled:
        items.add(const PopupMenuItem<String>(value: 'remove', child: Text('从列表移除')));
        break;
      case DownloadStatus.done:
        items.add(const PopupMenuItem<String>(value: 'open', child: Text('打开')));
        items.add(const PopupMenuItem<String>(value: 'export', child: Text('另存为…')));
        items.add(const PopupMenuItem<String>(value: 'reveal', child: Text('在文件夹中显示')));
        items.add(const PopupMenuItem<String>(value: 'copyPath', child: Text('复制文件路径')));
        items.add(const PopupMenuItem<String>(value: 'remove', child: Text('从列表移除')));
        break;
    }
    return items;
  }

  Future<void> _onAction(BuildContext context, String value) async {
    switch (value) {
      case 'pause':
        state.pauseDownload(task.id);
        break;
      case 'resume':
        state.resumeDownload(task.id);
        break;
      case 'cancel':
        await state.cancelDownload(task.id);
        break;
      case 'remove':
        state.removeDownload(task.id);
        break;
      case 'open':
        await _open(context);
        break;
      case 'export':
        final String? error = await state.exportDownload(task);
        if (error != null && context.mounted) _snack(context, error);
        break;
      case 'reveal':
        final String? path = task.savePath;
        if (path == null) break;
        final bool ok = await revealInFolder(path);
        if (!ok && context.mounted) _snack(context, '没找到文件，可能已经被删掉了');
        break;
      case 'copyPath':
        final String? path = task.savePath;
        if (path != null && context.mounted) await copyText(context, path);
        break;
    }
  }

  Future<void> _open(BuildContext context) async {
    final String? path = task.savePath;
    if (path == null || !File(path).existsSync()) {
      if (context.mounted) _snack(context, '文件不在了：可能被移动或删除');
      return;
    }
    final String? error = await openLocalFile(path);
    if (error != null && context.mounted) _snack(context, error);
  }

  void _snack(BuildContext context, String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}
