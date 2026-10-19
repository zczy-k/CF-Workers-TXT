import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../store.dart';
import '../util.dart';

/// 分享管理。
///
/// 这里最需要讲清楚的一件事是「**发布**」与「**分享**」不是一回事：
///   * 建分享 = 生成 `/s/<token>` 链接，**服务端当场把当前版本发一次**；
///   * 之后草稿又改了，链接指向的仍是**旧影子副本** —— 必须再点一次「发布」才更新；
///   * 「撤回」只删影子副本，**草稿和链接都还在**，随时能发回来。
///
/// UI 上把这两件事拆成两个动作（发布 / 撤回），而不是混成"同步"，就是为了让上面这段
/// 语义在界面上能直接读出来。
class SharesPage extends StatefulWidget {
  final AppStore store;

  const SharesPage({super.key, required this.store});

  @override
  State<SharesPage> createState() => _SharesPageState();
}

class _SharesPageState extends State<SharesPage> {
  List<ShareRecord> _shares = const [];
  bool _loading = true;
  String? _error;
  bool _busy = false;

  CfwClient get c => widget.store.client!;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await c.shares();
      if (!mounted) return;
      setState(() {
        _shares = s;
        _loading = false;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = humanError(e);
      });
    }
  }

  String _url(ShareRecord s) => '${c.config.baseUrl}/s/${s.token}';

  Future<void> _toast(String m) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _publish(ShareRecord s) async {
    try {
      final r = await c.publish(path: s.path, isDir: s.isDir);
      await _load();
      await _toast(r.unchanged ? '已是最新，无需重发' : '已重新发布（${r.published} 个对象）');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _unpublish(ShareRecord s) async {
    try {
      await c.unpublish(path: s.path, isDir: s.isDir);
      await _load();
      await _toast('已撤回：分享页暂时看不到它，链接还在');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _unshare(ShareRecord s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('取消这个分享？'),
        content: Text('链接 ${s.token} 会立即失效，**共享的文件本身不会被删除**。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('取消分享')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await c.unshare(s.token);
      await _load();
      await _toast('分享已取消');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _publishAll() async {
    setState(() => _busy = true);
    try {
      final r = await c.publishAll();
      await _load();
      await _toast('已补发 ${r.published} 个分享（跳过 ${r.skipped} 个）');
      if (r.failed.isNotEmpty) await _toast('${r.failed.length} 个失败：${r.failed.first}');
    } on Object catch (e) {
      await _toast(humanError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unshareAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('取消全部分享？'),
        content: const Text('所有 /s/ 链接会立即失效。文件不会被删除。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('算了')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('全部取消')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final n = await c.unshareAll();
      await _load();
      await _toast('已取消 $n 个分享');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _openLink(ShareRecord s) async {
    final uri = Uri.parse(_url(s));
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } on Object {
      await Clipboard.setData(ClipboardData(text: _url(s)));
      await _toast('打不开浏览器，已复制链接');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('分享管理'),
        actions: [
          PopupMenuButton<String>(
            enabled: !_busy,
            onSelected: (v) async {
              if (v == 'publishAll') await _publishAll();
              if (v == 'unshareAll') await _unshareAll();
              if (v == 'refresh') await _load();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'publishAll', child: Text('一键补发存量分享')),
              PopupMenuItem(value: 'unshareAll', child: Text('取消全部分享')),
              PopupMenuItem(value: 'refresh', child: Text('刷新')),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _body(theme),
      ),
    );
  }

  Widget _body(ThemeData theme) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              children: [
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(onPressed: _load, child: const Text('重试')),
              ],
            ),
          ),
        ],
      );
    }
    if (_shares.isEmpty) {
      return ListView(
        children: const [
          Padding(
            padding: EdgeInsets.all(40),
            child: Center(child: Text('还没有分享。在文件行的 ⋯ 菜单里选「分享」即可生成链接。')),
          ),
        ],
      );
    }

    return ListView.separated(
      itemCount: _shares.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (ctx, i) {
        final s = _shares[i];
        return ListTile(
          leading: Icon(
            s.isDir ? Icons.folder_shared_outlined : Icons.description_outlined,
            color: s.published ? theme.colorScheme.primary : theme.colorScheme.outline,
          ),
          title: Text(s.path.isEmpty ? '根目录' : s.path,
              maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_url(s), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11)),
              const SizedBox(height: 2),
              Text(
                [
                  s.published ? '🌐 已发布' : '⏸ 未发布（链接暂时打不开）',
                  if (s.exp != null) '有效至 ${fmtTime(s.exp)}',
                  if (s.exp != null && s.expired) '已过期',
                  if (s.synced == true) '与草稿一致',
                  if (s.synced == false) '草稿有更新，需重新发布',
                ].join(' · '),
                style: TextStyle(
                  fontSize: 11,
                  color: s.expired ? theme.colorScheme.error : null,
                ),
              ),
            ],
          ),
          trailing: PopupMenuButton<String>(
            onSelected: (v) async {
              switch (v) {
                case 'open':
                  await _openLink(s);
                case 'copy':
                  await Clipboard.setData(ClipboardData(text: _url(s)));
                  await _toast('已复制链接');
                case 'publish':
                  await _publish(s);
                case 'unpublish':
                  await _unpublish(s);
                case 'unshare':
                  await _unshare(s);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'open', child: Text('在浏览器打开')),
              const PopupMenuItem(value: 'copy', child: Text('复制链接')),
              if (!s.published) const PopupMenuItem(value: 'publish', child: Text('发布到分享页')),
              if (s.published) const PopupMenuItem(value: 'publish', child: Text('重新发布（更新内容）')),
              if (s.published) const PopupMenuItem(value: 'unpublish', child: Text('撤回（链接保留）')),
              const PopupMenuDivider(),
              const PopupMenuItem(value: 'unshare', child: Text('取消分享')),
            ],
          ),
          isThreeLine: true,
        );
      },
    );
  }
}
