import 'dart:io';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../store.dart';
import '../util.dart';

/// 与本机目录做增量同步。
///
/// 这个页面的存在理由：网页版只能一个文件一个文件地上传/下载，而"我的文本盘"最常见的
/// 用法是**一批笔记来回搬**。同步引擎在 core 里（纯 Dart、有单测），这里只负责：
///   * 选目录、选冲突策略、把报告如实显示出来（含"清单被截断"这种容易被忽略的坏消息）。
///
/// 判据是 `size + mtime`，不是内容哈希 —— 服务端没给客户端内容哈希接口，
/// 而这一期约束是"不改 worker.js"。
class SyncPage extends StatefulWidget {
  final AppStore store;

  const SyncPage({super.key, required this.store});

  @override
  State<SyncPage> createState() => _SyncPageState();
}

class _SyncPageState extends State<SyncPage> {
  String _root = '';
  ConflictPolicy _policy = ConflictPolicy.keepBoth;
  bool _mirror = false;
  bool _busy = false;

  final List<String> _log = [];
  SyncReport? _last;
  String _status = '';

  CfwClient get c => widget.store.client!;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final id = widget.store.activeId;
    if (id == null) return;
    final root = await widget.store.syncRoot(id);
    if (!mounted) return;
    setState(() => _root = root);
  }

  Future<void> _pickDir() async {
    try {
      final dir = await FilePicker.getDirectoryPath(dialogTitle: '选择同步目录');
      if (dir == null || !mounted) return;
      setState(() => _root = dir);
    } on Object catch (e) {
      _toast('这个平台不支持选目录：${humanError(e)}');
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _run(String mode) async {
    if (_busy || _root.isEmpty) return;
    setState(() {
      _busy = true;
      _log.clear();
      _status = '';
      _last = null;
    });

    try {
      final root = Directory(_root);
      await root.create(recursive: true);
      final state = await LocalState.open(File('$_root/.cfwtxt/state.json'));

      final engine = SyncEngine(
        client: c,
        root: root,
        state: state,
        policy: _policy,
        log: (m) {
          if (!mounted) return;
          setState(() => _log.add(m));
        },
      );

      setState(() => _log.add('开始${mode == 'pull' ? '拉取' : (mode == 'push' ? '推送' : '双向同步')}…'));

      final SyncReport r;
      switch (mode) {
        case 'pull':
          r = await engine.pull();
        case 'push':
          r = await engine.push(deleteRemoteMissing: _mirror);
        default:
          r = await engine.sync(deleteRemoteMissing: _mirror);
      }

      if (!mounted) return;
      setState(() {
        _last = r;
        _status = r.summary;
      });
      await widget.store.persistCookie();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _status = '失败：${humanError(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resetState() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('清除本地同步状态？'),
        content: const Text('只删本机记的"上次同步到哪"的账本，**两边的文件都不会动**。\n'
            '下次同步会当成第一次，全部重新比对一遍（慢，但不会丢东西）。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('清除')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await LocalState.open(File('$_root/.cfwtxt/state.json'))
          .then((s) => s.clear())
          .then((_) async {
        final f = File('$_root/.cfwtxt/state.json');
        if (await f.exists()) await f.delete();
      });
      _toast('已清除，下次同步会全量比对');
    } on Object catch (e) {
      _toast(humanError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final r = _last;

    return Scaffold(
      appBar: AppBar(
        title: const Text('与本机同步'),
        actions: [
          IconButton(
            tooltip: '清除同步状态',
            icon: const Icon(Icons.restart_alt),
            onPressed: _busy ? null : _resetState,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.folder_open, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _root.isEmpty ? '（还没定）' : _root,
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      TextButton.icon(
                        onPressed: _busy ? null : _pickDir,
                        icon: const Icon(Icons.drive_folder_upload, size: 18),
                        label: const Text('换目录'),
                      ),
                      const Spacer(),
                      Text('远端根目录', style: theme.textTheme.bodySmall),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),

          DropdownButtonFormField<ConflictPolicy>(
            value: _policy,
            decoration: const InputDecoration(
              labelText: '两边都改了怎么办',
              border: OutlineInputBorder(),
            ),
            items: const [
              DropdownMenuItem(
                value: ConflictPolicy.keepBoth,
                child: Text('都保留（本机版本另存一份）'),
              ),
              DropdownMenuItem(
                value: ConflictPolicy.preferRemote,
                child: Text('远端优先（覆盖本机）'),
              ),
              DropdownMenuItem(
                value: ConflictPolicy.preferLocal,
                child: Text('本机优先（覆盖远端）'),
              ),
              DropdownMenuItem(
                value: ConflictPolicy.skip,
                child: Text('跳过，列出来我自己处理'),
              ),
            ],
            onChanged: _busy ? null : (v) => setState(() => _policy = v ?? ConflictPolicy.keepBoth),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('镜像模式（危险）'),
            subtitle: const Text('本地删掉的文件，同步时把远端也删掉。默认关闭。'),
            value: _mirror,
            onChanged: _busy ? null : (v) => setState(() => _mirror = v),
          ),

          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : () => _run('pull'),
                  icon: const Icon(Icons.cloud_download_outlined),
                  label: const Text('拉取'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : () => _run('push'),
                  icon: const Icon(Icons.cloud_upload_outlined),
                  label: const Text('推送'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy ? null : () => _run('sync'),
                  icon: const Icon(Icons.sync),
                  label: const Text('双向'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          if (_busy) const LinearProgressIndicator(),
          if (_status.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_status, style: theme.textTheme.titleSmall),
          ],

          if (r != null && r.manifestTruncated)
            Card(
              color: theme.colorScheme.errorContainer,
              child: const Padding(
                padding: EdgeInsets.all(12),
                child: Text('⚠️ 远端清单被截断（超过服务端单次上限）。'
                    '这次同步只覆盖了清单里那部分文件，剩下的没有被比对 —— '
                    '不要让本页显示的数字给你"全都同步好了"的错觉。'),
              ),
            ),

          if (r != null && r.conflicts.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('冲突 ${r.conflicts.length} 个', style: theme.textTheme.titleSmall),
            for (final x in r.conflicts)
              ListTile(
                dense: true,
                leading: const Icon(Icons.merge_type, size: 18),
                title: Text(x.path, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(
                  '${x.reason}${x.keptAs.isEmpty ? '' : '\n另存为：${x.keptAs}'}',
                ),
              ),
          ],

          if (r != null && r.errors.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('失败 ${r.errors.length} 个', style: theme.textTheme.titleSmall),
            for (final e in r.errors)
              ListTile(
                dense: true,
                leading: Icon(Icons.error_outline, size: 18, color: theme.colorScheme.error),
                title: Text(e, style: const TextStyle(fontSize: 12)),
              ),
          ],

          if (_log.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('日志', style: theme.textTheme.titleSmall),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in _log.reversed.take(12))
                    Text(line, style: const TextStyle(fontSize: 11, fontFamily: 'monospace')),
                ],
              ),
            ),
          ],

          const SizedBox(height: 16),
          Text(
            '同步依据是「体积 + 原文件修改时间」，不是内容哈希。\n'
            '手机端默认落在应用私有目录（系统不允许普通应用随意写外部存储）；'
            '桌面端可以换成任意目录，比如你的 Obsidian 仓库。',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
