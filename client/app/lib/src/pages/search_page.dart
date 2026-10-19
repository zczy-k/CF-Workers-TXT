import 'dart:async';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../store.dart';
import '../util.dart';
import '../widgets/icons.dart';
import 'editor_page.dart';

/// 搜索页。
///
/// 服务端做两件事：**文件名 / 路径**匹配（永远可用）+ **正文**匹配（需要 KV 索引）。
/// 所以这里如实把两类命中分开显示（芯片计数直接来自服务端的筛选前真实总量），并且：
///   * 索引没建 / 落后了，给「重建索引」的入口 —— 而不是让用户以为"搜不到就是没有"；
///   * 每条结果都能**深搜全文**（`deepsearch` 读原文件精确验证、**带行号**），
///     因为索引只留前 8K 正文，行号是它给不了的。
///
/// 注意这个 widget 不能叫 `SearchPage` —— core 里已经有一个同名的响应模型了。
class SearchView extends StatefulWidget {
  final AppStore store;

  const SearchView({super.key, required this.store});

  @override
  State<SearchView> createState() => _SearchViewState();
}

class _SearchViewState extends State<SearchView> {
  final _ctl = TextEditingController();

  String _ftype = '';
  String _lastQuery = '';
  String? _error;

  /// 服务端这一页的元信息（计数、是否还有更多、是否已建索引）
  SearchPage? _meta;

  final List<SearchItem> _items = [];

  bool _loading = false;
  bool _bannerGone = false;
  IdxStat? _idx;

  CfwClient get c => widget.store.client!;

  @override
  void initState() {
    super.initState();
    unawaited(_loadStat());
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  Future<void> _loadStat() async {
    try {
      final st = await c.idxStat();
      if (mounted) setState(() => _idx = st);
    } catch (_) {
      // 索引统计拿不到不影响搜索本身
    }
  }

  Future<void> _run({bool append = false, String? ftype}) async {
    final q = _ctl.text.trim();
    if (ftype != null) _ftype = ftype;
    if (q.isEmpty) return;

    if (!append) {
      _lastQuery = q;
      _items.clear();
      _meta = null;
    }
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final p = await c.search(q, ftype: _ftype, limit: 40, offset: append ? _items.length : 0);
      if (!mounted) return;
      setState(() {
        _meta = p;
        if (!append) _items.clear();
        _items.addAll(p.results);
        _loading = false;
      });
      await widget.store.persistCookie();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = humanError(e);
      });
    }
  }

  Future<void> _reindex() async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _ReindexDialog(client: c),
    );
    await _loadStat();
    if (mounted) await _run(ftype: _ftype);
  }

  Future<void> _showStat() async {
    final st = _idx;
    if (st == null) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('正文索引状态'),
        content: Text('KV 已绑定：${st.hasKv ? "是" : "否"}\n'
            '已索引：${st.count} 个文件\n'
            '全文：${st.full} · 部分：${st.part} · 未收录：${st.none}\n'
            '单文件正文上限：${fmtSize(st.textCap)}\n'
            '最后更新：${fmtTime(st.at)}'),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('好'))],
      ),
    );
  }

  /// 深搜：对**单个文件**读全文精确验证，返回**行号**级的命中。
  /// 这是索引搜索给不了的东西 —— 名字就该这么叫，别跟普通搜索混起来。
  Future<void> _deep(SearchItem it) async {
    try {
      final r = await c.deepSearch(path: it.path, query: _lastQuery);
      if (!mounted) return;

      final buf = StringBuffer()
        ..writeln('文件：${it.path}')
        ..writeln('编码：${r.encoding.isEmpty ? "未知" : r.encoding}   体积：${fmtSize(r.size)}')
        ..writeln('命中 ${r.count} 次，覆盖 ${r.lines} 行${r.approx ? "（近似值）" : ""}')
        ..writeln('─' * 24);
      for (final h in r.hits) {
        buf.writeln('第 ${h.line} 行（×${h.count}）：${h.text ?? ""}');
      }
      if (r.hitsMore) buf.writeln('……命中过多，未全部列出');
      if (r.hits.isEmpty && r.snippet != null && r.snippet!.isNotEmpty) buf.writeln(r.snippet);

      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('全文深搜'),
          content: SizedBox(
            width: 560,
            height: 420,
            child: SingleChildScrollView(
              child: SelectableText(buf.toString(),
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                _open(it);
              },
              child: const Text('打开文件'),
            ),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('好')),
          ],
        ),
      );
    } on Object catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    }
  }

  void _open(SearchItem it) {
    if (it.isDir) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => EditorPage(store: widget.store, path: it.path)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final meta = _meta;

    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _ctl,
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            hintText: '搜文件名、路径，或正文内容',
            border: InputBorder.none,
          ),
          onSubmitted: (_) => _run(),
        ),
        actions: [
          IconButton(
            tooltip: '搜索',
            icon: const Icon(Icons.search),
            onPressed: _loading ? null : () => _run(),
          ),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'reindex') await _reindex();
              if (v == 'stat') await _showStat();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'reindex', child: Text('重建正文索引')),
              PopupMenuItem(value: 'stat', child: Text('索引状态')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (meta != null) _chips(meta),
          if (meta != null && !meta.indexed && !_bannerGone)
            MaterialBanner(
              content: Text(_idx?.hasKv == false
                  ? '这个站点没有绑定 KV，正文搜索不可用（文件名 / 路径照样能搜）。'
                  : '正文索引还没建立，现在只能搜文件名与路径。'),
              leading: const Icon(Icons.info_outline),
              actions: [
                TextButton(onPressed: _reindex, child: const Text('重建索引')),
                TextButton(
                  onPressed: () => setState(() => _bannerGone = true),
                  child: const Text('知道了'),
                ),
              ],
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ),
          Expanded(child: _results()),
          if (_loading) const LinearProgressIndicator(),
        ],
      ),
    );
  }

  Widget _chips(SearchPage meta) {
    // 这四类与网页端完全一致（服务端只认 name / path / text / dir）
    final kinds = <List<Object>>[
      ['', '全部', meta.total],
      ['name', '文件名命中', meta.nameHits],
      ['path', '路径命中', meta.pathHits],
      ['text', '正文命中', meta.textHits],
      ['dir', '文件夹', meta.dirHits],
    ];
    return SizedBox(
      height: 52,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        children: [
          for (final k in kinds)
            if ((k[0] as String).isEmpty || (k[2] as int) > 0)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: FilterChip(
                  label: Text('${k[1]} ${k[2]}'),
                  selected: _ftype == k[0],
                  onSelected: (_) => _run(ftype: k[0] as String),
                ),
              ),
        ],
      ),
    );
  }

  Widget _results() {
    if (_items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _lastQuery.isEmpty
                ? '输入关键词开始搜索'
                : (_loading ? '搜索中…' : '没有匹配的结果'),
          ),
        ),
      );
    }
    final meta = _meta;
    return ListView.separated(
      itemCount: _items.length + 1,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (ctx, i) {
        if (i == _items.length) {
          if (meta != null && meta.hasMore) {
            return Padding(
              padding: const EdgeInsets.all(12),
              child: Center(
                child: TextButton(
                  onPressed: _loading ? null : () => _run(append: true),
                  child: Text('加载更多（已显示 ${_items.length} / ${meta.total}）'),
                ),
              ),
            );
          }
          return const SizedBox(height: 24);
        }

        final it = _items[i];
        final name = baseName(it.path);
        final dir = parentOf(it.path);

        return ListTile(
          leading: Icon(
            it.isDir ? Icons.folder_rounded : iconOf(iconFor(name)),
            color: it.isDir ? Theme.of(ctx).colorScheme.primary : null,
          ),
          title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (dir.isNotEmpty)
                Text(dir, style: const TextStyle(fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis),
              if (it.snippet != null && it.snippet!.isNotEmpty)
                Text(it.snippet!, maxLines: 2, style: const TextStyle(fontSize: 12)),
              Text(
                [
                  if (it.nameHit) '文件名命中',
                  if (it.pathHit) '路径命中',
                  if (!it.isDir && it.count > 0) '正文 ×${it.count}',
                  if (!it.isDir) fmtSize(it.size),
                ].join(' · '),
                style: const TextStyle(fontSize: 11),
              ),
            ],
          ),
          trailing: PopupMenuButton<String>(
            onSelected: (v) async {
              switch (v) {
                case 'open':
                  _open(it);
                case 'deep':
                  await _deep(it);
                case 'copy':
                  await Clipboard.setData(ClipboardData(text: it.path));
                  if (mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(const SnackBar(content: Text('已复制路径')));
                  }
              }
            },
            itemBuilder: (_) => [
              if (!it.isDir) const PopupMenuItem(value: 'open', child: Text('打开 / 编辑')),
              if (!it.isDir) const PopupMenuItem(value: 'deep', child: Text('全文深搜（带行号）')),
              const PopupMenuItem(value: 'copy', child: Text('复制路径')),
            ],
          ),
          onTap: it.isDir ? null : () => _open(it),
        );
      },
    );
  }
}

/// 重建索引的进度框。
///
/// 服务端**每批只处理几个文件**（免费版 10ms CPU），所以这里必须能显示"跑了多少批"，
/// 否则用户会以为卡死了然后强杀 App。
class _ReindexDialog extends StatefulWidget {
  final CfwClient client;

  const _ReindexDialog({required this.client});

  @override
  State<_ReindexDialog> createState() => _ReindexDialogState();
}

class _ReindexDialogState extends State<_ReindexDialog> {
  int _rounds = 0;
  int _indexed = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_go());
  }

  Future<void> _go() async {
    try {
      await widget.client.reindexAll(onBatch: (r) {
        if (!mounted) return;
        setState(() {
          _rounds++;
          _indexed = r.indexed;
        });
      });
      if (!mounted) return;
      // 先拿到 messenger 再 pop：pop 之后这个 context 就不该再用了
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      messenger.showSnackBar(SnackBar(content: Text('索引重建完成：共 $_rounds 批')));
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = humanError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // 重建跑到一半被返回键关掉，用户会以为"没生效"，而服务端其实还在慢慢爬
      canPop: _error != null,
      child: AlertDialog(
        title: Text(_error == null ? '正在重建正文索引' : '重建失败'),
        content: _error != null
            ? Text(_error!)
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const LinearProgressIndicator(),
                  const SizedBox(height: 12),
                  Text('已处理 $_rounds 批，收尾时已索引 $_indexed 个文件。\n\n'
                      '服务端每批只处理几个文件（免费版 CPU 限制），目录大时需要多轮才能跑完。'),
                ],
              ),
        actions: [
          if (_error != null)
            FilledButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
        ],
      ),
    );
  }
}
