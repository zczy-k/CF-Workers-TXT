import 'dart:io';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import '../util.dart';
import '../widgets/entry_tile.dart';
import 'editor_page.dart';
import 'search_page.dart';
import 'setup_page.dart';
import 'shares_page.dart';
import 'sync_page.dart';

/// 主页：目录树 + 列表。
///
/// 宽屏（≥900）左树右列表，窄屏是单栏 + 抽屉 —— 与网页端的断点保持一致，
/// 这样同一个用户在手机和电脑上看到的层级不会差太远。
class HomePage extends StatefulWidget {
  final AppStore store;

  const HomePage({super.key, required this.store});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  String _path = '';
  DirListing? _listing;
  TreeResult? _tree;
  List<ShareRecord> _shares = const [];

  String _sort = 'name';
  bool _desc = false;
  bool _loading = false;
  bool _selectionMode = false;
  /// 选中项：`路径 -> 是否文件夹`。把 isDir 一起记住，是因为批量删除/移动时
  /// 每条都要带上它 —— 之前靠"去列表里反查"的写法在翻页后就会算错。
  final Map<String, bool> _selected = {};

  String? _error;
  String? _cursor;

  CfwClient get c => widget.store.client!;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reload());
  }

  Future<void> _reload({bool tree = true, bool shares = true}) async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
      _cursor = null;
    });
    try {
      final listing = await c.list(path: _path, pageSize: 200, sort: _sort, desc: _desc);
      TreeResult? t = _tree;
      if (tree) {
        try {
          t = await c.treeFull();
        } catch (_) {
          // 树拿不到不该让列表也看不了（目录特别大 / 被截断时是这样）
        }
      }
      List<ShareRecord>? s = _shares;
      if (shares) {
        try {
          s = await c.shares();
        } catch (_) {}
      }
      await widget.store.persistCookie();
      if (!mounted) return;
      setState(() {
        _listing = listing;
        _tree = t;
        _shares = s ?? const [];
        _cursor = listing.cursor;
        _loading = false;
        _selected.clear();
        _selectionMode = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.isAuth ? '登录态失效，请到「设置」重新输入密码' : e.message;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = humanError(e);
      });
    }
  }

  Future<void> _loadMore() async {
    final cur = _cursor;
    if (cur == null || cur.isEmpty) return;
    setState(() => _loading = true);
    try {
      final more = await c.list(path: _path, pageSize: 200, cursor: cur, sort: _sort, desc: _desc);
      if (!mounted) return;
      setState(() {
        _listing = DirListing(
          path: more.path,
          folders: [...?_listing?.folders, ...more.folders],
          files: [...?_listing?.files, ...more.files],
          total: more.total,
          cursor: more.cursor,
          more: more.more,
          sort: more.sort,
          desc: more.desc,
        );
        _cursor = more.cursor;
        _loading = false;
      });
    } on Object {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ------------------------------------------------------------ 打开

  void _cd(String path) {
    setState(() {
      _path = path;
      _listing = null;
      _selected.clear();
      _selectionMode = false;
    });
    _reload();
  }

  Future<void> _openItem(String name, bool isDir) async {
    final full = _path.isEmpty ? name : '$_path/$name';
    if (isDir) {
      _cd(full);
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => EditorPage(store: widget.store, path: full),
    ));
    if (mounted) _reload(tree: false, shares: false);
  }

  // ------------------------------------------------------------ 操作

  Future<void> _toast(String msg) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _mkdir() async {
    final name = await _askText('新建文件夹', '文件夹名');
    if (name == null || name.isEmpty) return;
    try {
      final protected = await _askProtected();
      await c.mkdir(dir: _path, name: name, isProtected: protected);
      await _reload();
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<bool> _askProtected() async {
    final r = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('设为受保护文件夹？'),
        content: const Text('受保护后，删除里面的内容需要管理员密码（与网页端同一套规则）。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('普通文件夹')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('受保护 🔒')),
        ],
      ),
    );
    return r ?? false;
  }

  Future<void> _newText() async {
    var name = await _askText('新建文本', '文件名');
    if (name == null || name.isEmpty) return;
    if (!name.contains('.')) name = '$name.txt';
    final full = _path.isEmpty ? name : '$_path/$name';
    try {
      await c.writeFile(full, const [], contentType: 'text/plain;charset=utf-8', mtime: DateTime.now());
      await _reload();
      if (!mounted) return;
      await _openItem(name, false);
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<String?> _askText(String title, String label, {String initial = ''}) {
    final ctl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: InputDecoration(labelText: label),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('确定')),
        ],
      ),
    );
  }

  Future<void> _rename(String name, bool isDir) async {
    final full = _path.isEmpty ? name : '$_path/$name';
    // 只看**文件名**里有没有扩展名。别拿 `full` 去 split：父目录里带点
    // （`notes.v2/README`）时 lastIndexOf('.') 会是 -1，substring 直接 RangeError。
    final dot = isDir ? -1 : name.lastIndexOf('.');
    final newName = await _askText('重命名', '新名称',
        initial: dot > 0 ? name.substring(0, dot) : name);
    if (newName == null || newName.isEmpty || newName == name) return;
    try {
      await c.rename(path: full, newName: newName, isDir: isDir);
      await _reload();
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _move(String name, bool isDir) async {
    final full = _path.isEmpty ? name : '$_path/$name';
    final to = await showDialog<String>(
      context: context,
      builder: (_) => _DirPickerDialog(client: c),
    );
    if (to == null) return;
    try {
      await c.move(path: full, toDir: to, isDir: isDir);
      await _reload();
    } on ApiException catch (e) {
      if (e.needPw) {
        final pw = await _askText('需要管理员密码', '密码');
        if (pw == null) return;
        try {
          await c.move(path: full, toDir: to, isDir: isDir, password: pw);
          await _reload();
        } on Object catch (e2) {
          await _toast(humanError(e2));
        }
        return;
      }
      await _toast(e.message);
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _delete(List<Map<String, dynamic>> items) async {
    if (items.isEmpty) return;
    final dirs = items.where((e) => e['isDir'] == true).length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('删除 ${items.length} 项？'),
        content: Text(dirs > 0
            ? '其中 $dirs 个是文件夹，**里面的内容会一起递归删掉**，且不可撤销。'
            : '删掉之后不可撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;

    try {
      final r = await c.deleteBatch(items);
      await _reload();
      await _toast(r.failed.isEmpty ? '已删除 ${r.removed} 项' : '删除完成，${r.failed.length} 项被跳过（受保护需要密码）');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _share(String name, bool isDir) async {
    final full = _path.isEmpty ? name : '$_path/$name';
    final token = await _askText('生成分享链接', '自定义口令（可留空）');
    if (token == null) return;
    var expiresIn = 0;
    final ttl = await showDialog<int>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('有效期'),
        children: [
          for (final e in const {
            '1 小时': 3600,
            '1 天': 86400,
            '7 天': 604800,
            '30 天': 2592000,
            '永久': 0,
          }.entries)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, e.value),
              child: Text(e.key),
            ),
        ],
      ),
    );
    if (ttl == null) return;
    expiresIn = ttl;

    try {
      final s = await c.createShare(path: full, token: token, expiresIn: expiresIn);
      await _reload(tree: false);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('链接已生成'),
          content: SelectableText(s.url),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                showDialog<void>(
                  context: context,
                  builder: (c2) => AlertDialog(content: SelectableText(s.url)),
                );
              },
              child: const Text('放大'),
            ),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('好')),
          ],
        ),
      );
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  Future<void> _download(String name) async {
    final full = _path.isEmpty ? name : '$_path/$name';
    Directory? dir;
    try {
      dir = await getDownloadsDirectory();
    } catch (_) {}
    try {
      dir ??= await getApplicationSupportDirectory();
      final dest = '${dir.path}/$name';
      await _toast('正在下载 $name …');
      await c.download(full, dest);
      await _toast('已保存到 $dest');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  /// 上传。同名文件**先问一句**再动手 —— 网页端就是这么做的，客户端也不能默认覆盖。
  Future<void> _upload() async {
    final picked = await FilePicker.platform.pickFiles(allowMultiple: true);
    if (picked == null || picked.files.isEmpty) return;
    final paths = picked.files.map((f) => f.path).whereType<String>().toList();
    if (paths.isEmpty) return;

    // 云端现有文件（比对同名）
    final existing = <String>{};
    try {
      final m = await c.manifest(path: _path);
      for (final e in m.entries) {
        final rel = _path.isEmpty ? e.path : e.path.substring('$_path/'.length);
        if (!rel.contains('/')) existing.add(rel);
      }
    } catch (_) {}

    final conflicts = paths.map((p) => File(p).uri.pathSegments.last).where(existing.contains).toList();

    var mode = 'overwrite';
    if (conflicts.isNotEmpty) {
      if (!mounted) return;
      final r = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('有 ${conflicts.length} 个同名文件'),
          content: const Text('云端已经有同名文件了，怎么处理？（对本批全部生效）'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, 'skip'), child: const Text('全部跳过')),
            TextButton(onPressed: () => Navigator.pop(ctx, 'keepBoth'), child: const Text('都保留')),
            FilledButton(onPressed: () => Navigator.pop(ctx, 'overwrite'), child: const Text('全部覆盖')),
          ],
        ),
      );
      if (r == null) return;
      mode = r;
      if (mode == 'skip') {
        await _toast('已取消上传');
        return;
      }
    }

    var done = 0;
    final failed = <String>[];
    for (final p in paths) {
      final f = File(p);
      var name = f.uri.pathSegments.last;
      if (mode == 'keepBoth' && existing.contains(name)) {
        final dot = name.lastIndexOf('.');
        final stem = dot > 0 ? name.substring(0, dot) : name;
        final ext = dot > 0 ? name.substring(dot) : '';
        name = '$stem (${DateTime.now().millisecondsSinceEpoch % 100000})$ext';
      }
      final remote = _path.isEmpty ? name : '$_path/$name';
      try {
        await c.uploadFile(remote, f);
        done++;
      } on Object catch (e) {
        failed.add('$name: ${humanError(e)}');
      }
    }
    await _reload();
    await _toast(failed.isEmpty ? '已上传 $done 个文件' : '上传 $done 个，失败 ${failed.length} 个');
  }

  Future<void> _batchMove() async {
    final to = await showDialog<String>(
      context: context,
      builder: (_) => _DirPickerDialog(client: c),
    );
    if (to == null) return;
    final items = [
      for (final e in _selected.entries) {'path': e.key, 'isDir': e.value}
    ];
    try {
      final r = await c.moveBatch(items, to);
      await _reload();
      await _toast(r.failed.isEmpty ? '已移动 ${r.moved} 项' : '移动完成，${r.failed.length} 项失败');
    } on Object catch (e) {
      await _toast(humanError(e));
    }
  }

  // ------------------------------------------------------------ 构建

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.of(context).size.width >= 900;
    final body = Column(
      children: [
        _breadcrumb(),
        if (_error != null)
          MaterialBanner(
            content: Text(_error!),
            actions: [TextButton(onPressed: () => _reload(), child: const Text('重试'))],
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => _reload(),
            child: _listView(),
          ),
        ),
      ],
    );

    return Scaffold(
      appBar: AppBar(
        title: Text(wide ? 'CF-Workers-TXT' : displayPath(_path)),
        actions: [
          IconButton(
            tooltip: '搜索',
            icon: const Icon(Icons.search),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => SearchView(store: widget.store)),
            ),
          ),
          IconButton(
            tooltip: '分享管理',
            icon: const Icon(Icons.link),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => SharesPage(store: widget.store)),
            ),
          ),
          PopupMenuButton<String>(
            tooltip: '更多',
            onSelected: (v) async {
              switch (v) {
                case 'refresh':
                  await _reload();
                case 'mkdir':
                  await _mkdir();
                case 'newtext':
                  await _newText();
                case 'sync':
                  await Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => SyncPage(store: widget.store)),
                  );
                case 'settings':
                  await Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => SetupPage(store: widget.store)),
                  );
                  await _reload();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'refresh', child: Text('刷新')),
              PopupMenuItem(value: 'mkdir', child: Text('新建文件夹')),
              PopupMenuItem(value: 'newtext', child: Text('新建文本')),
              PopupMenuItem(value: 'sync', child: Text('与本机同步')),
              PopupMenuItem(value: 'settings', child: Text('设置 / 站点')),
            ],
          ),
        ],
      ),
      drawer: wide
          ? null
          : Drawer(child: SafeArea(child: _treeView())),
      floatingActionButton: FloatingActionButton(
        tooltip: '上传文件',
        onPressed: _upload,
        child: const Icon(Icons.upload_file),
      ),
      bottomNavigationBar: _selectionMode ? _selectionBar() : null,
      body: wide
          ? Row(
              children: [
                SizedBox(width: 300, child: _treeView()),
                const VerticalDivider(width: 1),
                Expanded(child: body),
              ],
            )
          : body,
    );
  }

  Widget _breadcrumb() {
    final parts = crumbs(_path);
    return SizedBox(
      height: 40,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        children: [
          TextButton(onPressed: () => _cd(''), child: const Text('根目录')),
          for (var i = 0; i < parts.length; i++) ...[
            const Icon(Icons.chevron_right, size: 16),
            TextButton(
              onPressed: () => _cd(parts.sublist(0, i + 1).join('/')),
              child: Text(parts[i]),
            ),
          ],
        ],
      ),
    );
  }

  Widget _listView() {
    final l = _listing;
    if (l == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final entries = <Widget>[];

    for (final f in l.folders) {
      final full = _path.isEmpty ? f : '$_path/$f';
      entries.add(EntryTile(
        key: ValueKey('d:$full'),
        name: f,
        isDir: true,
        selectionMode: _selectionMode,
        selected: _selected.containsKey(full),
        isProtected: (_tree?.protectedPaths ?? const <String>[]).contains(full),
        onTap: _selectionMode ? () => _toggle(full, true) : () => _openItem(f, true),
        onLongPress: () => _enterSelection(full, true),
        onToggle: () => _toggle(full, true),
        menuItems: [
          const PopupMenuItem(value: 'rename', child: Text('重命名')),
          const PopupMenuItem(value: 'move', child: Text('移动到…')),
          const PopupMenuItem(value: 'share', child: Text('分享')),
          const PopupMenuItem(value: 'delete', child: Text('删除')),
        ],
        onMenuSelected: (v) async {
          switch (v) {
            case 'rename':
              await _rename(f, true);
            case 'move':
              await _move(f, true);
            case 'share':
              await _share(f, true);
            case 'delete':
              await _delete([
                {'path': full, 'isDir': true}
              ]);
          }
        },
      ));
    }

    final sharePaths = _shares.map((s) => s.path).toSet();
    for (final f in l.files) {
      final full = _path.isEmpty ? f.name : '$_path/${f.name}';
      entries.add(EntryTile(
        key: ValueKey('f:$full'),
        name: f.name,
        size: f.size,
        mtime: f.mtime,
        selectionMode: _selectionMode,
        selected: _selected.containsKey(full),
        shared: sharePaths.contains(full),
        onTap: _selectionMode ? () => _toggle(full, false) : () => _openItem(f.name, false),
        onLongPress: () => _enterSelection(full, false),
        onToggle: () => _toggle(full, false),
        menuItems: const [
          PopupMenuItem(value: 'open', child: Text('打开 / 编辑')),
          PopupMenuItem(value: 'download', child: Text('下载到本机')),
          PopupMenuItem(value: 'share', child: Text('分享')),
          PopupMenuItem(value: 'rename', child: Text('重命名')),
          PopupMenuItem(value: 'move', child: Text('移动到…')),
          PopupMenuItem(value: 'delete', child: Text('删除')),
        ],
        onMenuSelected: (v) async {
          switch (v) {
            case 'open':
              await _openItem(f.name, false);
            case 'download':
              await _download(f.name);
            case 'share':
              await _share(f.name, false);
            case 'rename':
              await _rename(f.name, false);
            case 'move':
              await _move(f.name, false);
            case 'delete':
              await _delete([
                {'path': full, 'isDir': false}
              ]);
          }
        },
      ));
    }

    if (entries.isEmpty) {
      entries.add(const Padding(
        padding: EdgeInsets.all(40),
        child: Center(child: Text('这个目录是空的')),
      ));
    }

    entries.add(_sortBar(l));

    return ListView(children: entries);
  }

  Widget _sortBar(DirListing l) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          Text('共 ${l.total} 项', style: Theme.of(context).textTheme.bodySmall),
          const Spacer(),
          if (l.more)
            TextButton(
              onPressed: _loading ? null : _loadMore,
              child: const Text('加载更多'),
            ),
          DropdownButton<String>(
            value: _sort,
            underline: const SizedBox.shrink(),
            items: const [
              DropdownMenuItem(value: 'name', child: Text('名称')),
              DropdownMenuItem(value: 'type', child: Text('类型')),
              DropdownMenuItem(value: 'size', child: Text('大小')),
              DropdownMenuItem(value: 'time', child: Text('修改时间')),
            ],
            onChanged: (v) {
              if (v == null) return;
              setState(() => _sort = v);
              _reload(tree: false, shares: false);
            },
          ),
          IconButton(
            tooltip: _desc ? '降序' : '升序',
            icon: Icon(_desc ? Icons.arrow_downward : Icons.arrow_upward),
            onPressed: () {
              setState(() => _desc = !_desc);
              _reload(tree: false, shares: false);
            },
          ),
        ],
      ),
    );
  }

  Widget _treeView() {
    final t = _tree;
    if (t == null) {
      return const Center(child: Text('目录树加载中…'));
    }
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 4),
      children: [
        ListTile(
          dense: true,
          leading: const Icon(Icons.home_outlined),
          title: const Text('根目录'),
          selected: _path.isEmpty,
          onTap: () => _cd(''),
        ),
        ..._treeNodes(t.tree.dirs, 1),
      ],
    );
  }

  List<Widget> _treeNodes(List<TreeNode> dirs, int depth) {
    final out = <Widget>[];
    for (final d in dirs) {
      out.add(Padding(
        padding: EdgeInsets.only(left: depth * 14.0),
        child: ListTile(
          dense: true,
          leading: Icon(
            d.isProtected ? Icons.lock_rounded : Icons.folder_outlined,
            size: 18,
            color: d.isProtected ? const Color(0xFFB8891F) : null,
          ),
          title: Text(d.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text('${d.childCount} 项 · ${fmtSize(d.size)}',
              style: const TextStyle(fontSize: 11)),
          selected: _path == d.path,
          onTap: () => _cd(d.path),
        ),
      ));
      if (d.dirs.isNotEmpty && (_path == d.path || _path.startsWith('${d.path}/'))) {
        out.addAll(_treeNodes(d.dirs, depth + 1));
      }
    }
    return out;
  }

  // ------------------------------------------------------------ 多选

  void _enterSelection(String key, bool isDir) {
    setState(() {
      _selectionMode = true;
      _selected[key] = isDir;
    });
  }

  void _toggle(String key, bool isDir) {
    setState(() {
      if (_selected.containsKey(key)) {
        _selected.remove(key);
      } else {
        _selected[key] = isDir;
      }
      if (_selected.isEmpty) _selectionMode = false;
    });
  }

  Widget _selectionBar() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            Text('已选 ${_selected.length} 项'),
            const Spacer(),
            TextButton(onPressed: _batchMove, child: const Text('移动')),
            TextButton(
              onPressed: () => _delete([
                for (final e in _selected.entries) {'path': e.key, 'isDir': e.value}
              ]),
              child: const Text('删除'),
            ),
            TextButton(
              onPressed: () => setState(() {
                _selected.clear();
                _selectionMode = false;
              }),
              child: const Text('完成'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 目录选择器：一边浏览一边选目标目录。移动 / 批量移动都用它。
class _DirPickerDialog extends StatefulWidget {
  final CfwClient client;

  const _DirPickerDialog({required this.client});

  @override
  State<_DirPickerDialog> createState() => _DirPickerDialogState();
}

class _DirPickerDialogState extends State<_DirPickerDialog> {
  String _path = '';
  DirListing? _listing;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await widget.client.list(path: _path);
      if (mounted) setState(() => _listing = l);
    } on Object {
      if (mounted) setState(() => _listing = DirListing(path: _path));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = _listing;
    return AlertDialog(
      title: Text('选择目标目录：${displayPath(_path)}'),
      content: SizedBox(
        width: 420,
        height: 380,
        child: l == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                children: [
                  if (_path.isNotEmpty)
                    ListTile(
                      leading: const Icon(Icons.arrow_upward),
                      title: const Text('上一级'),
                      onTap: () {
                        final i = _path.lastIndexOf('/');
                        _path = i < 0 ? '' : _path.substring(0, i);
                        _load();
                      },
                    ),
                  for (final f in l.folders)
                    ListTile(
                      leading: const Icon(Icons.folder_outlined),
                      title: Text(f),
                      onTap: () {
                        _path = _path.isEmpty ? f : '$_path/$f';
                        _load();
                      },
                    ),
                ],
              ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () => Navigator.pop(context, _path),
          child: Text('移到${_path.isEmpty ? '根目录' : '这里'}'),
        ),
      ],
    );
  }
}
