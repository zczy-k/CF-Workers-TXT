import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:path_provider/path_provider.dart';

import '../store.dart';
import '../util.dart';
import '../widgets/icons.dart';

/// 文件查看 / 编辑页。三种形态，按扩展名自动选：
///
///   * **图片** → `Image.network(<ADMIN>/f/<路径>)` 直接带会话 Cookie 拉原图，
///     走的是 Dart 自己的 HTTP 栈，**不是 WebView**。
///   * **Markdown** → `flutter_markdown` 原生渲染，可切回源码。
///   * **其余文本** → 编辑器 + 自动保存（服务端上限 2MB；超了转为"下载后用系统程序打开"）。
///
/// 唯一一处主动"交给浏览器"的是 `.html`：本地沙箱预览需要 WebView 或 iframe，
/// 而这两条路都与"不依赖浏览器"冲突。所以 HTML 只有源码视图 + "用系统浏览器打开"，
/// 且打开的是**本机临时文件**（外部浏览器没有会话 Cookie，直接访问 /f/ 会 401）。
class EditorPage extends StatefulWidget {
  final AppStore store;
  final String path;

  const EditorPage({super.key, required this.store, required this.path});

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> {
  final _ctl = TextEditingController();

  String _original = '';
  String _status = '';
  String? _error;

  bool _loading = true;
  bool _busy = false;
  bool _preview = false;
  bool _autosave = true;

  /// 已发布到分享页？null = 还没查出来
  bool? _published;

  /// 'text' | 'markdown' | 'image' | 'binary'
  String _kind = 'text';

  Timer? _debounce;
  final _scroll = ScrollController();

  CfwClient get c => widget.store.client!;

  bool get _dirty => !_loading && _ctl.text != _original;

  @override
  void initState() {
    super.initState();
    _kind = _kindOf(widget.path);
    _ctl.addListener(_onChanged);
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _flushOnDispose();
    _ctl.removeListener(_onChanged);
    _ctl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// 离开页面时把没落盘的内容补一次 —— 用户按返回键不该丢字。
  ///
  /// 这里**不能**直接调 `_save()`：它开头就 `setState`，而 dispose 期间
  /// `setState` 会抛异常。所以另走一条"只写、不碰 UI"的路径。
  void _flushOnDispose() {
    // 注意不能因为 `_busy` 就跳过：正在飞的那次写的是**旧快照**，
    // 退出前这最后一次改动还是得补上。
    if (_loading) return;
    final text = _ctl.text;
    if (text == _original) return;
    final client = widget.store.client;
    if (client == null) return;
    unawaited(
      client
          .writeFile(widget.path, utf8.encode(text),
              contentType: guessContentType(widget.path), mtime: DateTime.now())
          .catchError((Object _) {
        // 退出时保存失败无处可报，静默即可：本地缓冲还在，下次进来还能看到原文
      }),
    );
  }

  static String _kindOf(String path) {
    final name = baseName(path).toLowerCase();
    final ext = extOf(name);
    if (const ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].contains(ext)) {
      return 'image';
    }
    if (ext == 'svg') return 'binary'; // 不渲染 SVG：图片解码器不认，且它是"能带脚本的文本"
    if (ext == 'md' || ext == 'markdown') return 'markdown';
    if (isTextyPath(name)) return 'text';
    return 'binary';
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_kind != 'image' && _kind != 'binary') {
        try {
          final text = await c.readText(widget.path);
          _original = text;
          _ctl.text = text;
        } on ApiException catch (e) {
          // 服务端 2MB 上限：这不是错误，是这个文件本来就该"下载后打开"
          if (e.status == 413) {
            _kind = 'binary';
          } else {
            rethrow;
          }
        }
      }
      await widget.store.persistCookie();
      await _checkPublished();
      if (!mounted) return;
      setState(() {
        _loading = false;
        _status = '';
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = humanError(e);
      });
    }
  }

  Future<void> _checkPublished() async {
    try {
      final shares = await c.shares();
      final mine = shares.where((s) =>
          s.path == widget.path || (s.isDir && widget.path.startsWith('${s.path}/')));
      if (!mounted) return;
      setState(() {
        _published = mine.isEmpty ? false : mine.any((s) => s.published);
      });
    } catch (_) {
      if (mounted) setState(() => _published = null);
    }
  }

  void _onChanged() {
    if (_loading) return;
    setState(() {}); // 让"未保存"指示器与字数动起来
    if (!_autosave) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 3), () => _save(quiet: true));
  }

  Future<void> _save({bool quiet = false}) async {
    if (_loading) return;
    // 上一次保存还没回来：别丢这次的改动，稍后重试（保存本身有超时，不会永久占着 _busy）
    if (_busy) {
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 600), () => _save(quiet: quiet));
      return;
    }
    if (_ctl.text == _original) return;
    // 先拍快照：写盘期间用户还可能继续打字，写进去的和"已保存"的必须是同一份
    final text = _ctl.text;
    setState(() {
      _busy = true;
      _status = '保存中…';
    });
    try {
      await c.writeFile(
        widget.path,
        utf8.encode(text),
        contentType: guessContentType(widget.path),
        // **必须带本地时间**：manifest 会回传它，同步引擎才知道这份文件是什么时候改的
        mtime: DateTime.now(),
      );
      if (!mounted) return;
      setState(() {
        _original = text;
        _status = _ctl.text == text ? '已保存 ${TimeOfDay.now().format(context)}' : '正在保存…';
        _busy = false;
      });
      await widget.store.persistCookie();
      // 写盘期间又改了 → 再排一次（否则这段改动要等用户下次敲键才落盘）
      if (mounted && _ctl.text != _original && _autosave) {
        _debounce?.cancel();
        _debounce = Timer(const Duration(seconds: 1), () => _save(quiet: true));
      }
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = '保存失败：${humanError(e)}';
      });
      if (!quiet) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    }
  }

  Future<void> _publish() async {
    if (_dirty) await _save();
    try {
      final r = await c.publish(path: widget.path);
      if (!mounted) return;
      setState(() => _published = true);
      _toast(r.unchanged ? '内容与已发布版本一致，无需重发' : '已发布（${r.published} 个对象）');
    } on Object catch (e) {
      _toast(humanError(e));
    }
  }

  Future<void> _unpublish() async {
    try {
      await c.unpublish(path: widget.path);
      if (!mounted) return;
      setState(() => _published = false);
      _toast('已撤回：分享页暂时看不到它，链接和草稿都还在');
    } on Object catch (e) {
      _toast(humanError(e));
    }
  }

  Future<void> _share() async {
    if (_dirty) await _save();
    try {
      final s = await c.createShare(path: widget.path);
      if (!mounted) return;
      setState(() => _published = true);
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('分享链接（已自动发布）'),
          content: SelectableText(s.url),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('好'))],
        ),
      );
    } on Object catch (e) {
      _toast(humanError(e));
    }
  }

  /// 下载到本机。桌面端优先落到"下载"目录，手机端落到应用目录 —— 之后可以直接
  /// 「用系统程序打开」，这是大文件与 HTML 的正路。
  Future<String?> _downloadLocal() async {
    Directory? dir;
    try {
      dir = await getDownloadsDirectory();
    } catch (_) {}
    try {
      dir ??= await getApplicationSupportDirectory();
      final dest = '${dir.path}/${baseName(widget.path)}';
      await c.download(widget.path, dest);
      _toast('已保存到 $dest');
      return dest;
    } on Object catch (e) {
      _toast(humanError(e));
      return null;
    }
  }

  Future<void> _openExternalLocal() async {
    final local = await _downloadLocal();
    if (local == null || !mounted) return;
    try {
      await openWithSystem(local);
    } on Object catch (e) {
      _toast(humanError(e));
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ------------------------------------------------------------ 构建

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final title = baseName(widget.path);
    final parent = parentOf(widget.path);

    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.keyS, control: true): _SaveIntent(),
        SingleActivator(LogicalKeyboardKey.keyS, meta: true): _SaveIntent(),
      },
      child: Actions(
        actions: {
          _SaveIntent: CallbackAction<_SaveIntent>(onInvoke: (_) {
            _save();
            return null;
          }),
        },
        child: Scaffold(
            appBar: AppBar(
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (parent.isNotEmpty)
                    Text(parent,
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.normal)),
                ],
              ),
              actions: [
                if (_kind == 'markdown')
                  IconButton(
                    tooltip: _preview ? '源码' : '预览',
                    icon: Icon(_preview ? Icons.code : Icons.visibility_outlined),
                    onPressed: () => setState(() => _preview = !_preview),
                  ),
                if (_kind == 'text' || _kind == 'markdown')
                  IconButton(
                    tooltip: _autosave ? '自动保存已开' : '自动保存已关',
                    icon: Icon(_autosave ? Icons.cloud_done_outlined : Icons.cloud_off_outlined),
                    onPressed: () => setState(() => _autosave = !_autosave),
                  ),
                IconButton(
                  tooltip: _busy ? '保存中' : (_dirty ? '保存（有未保存的修改）' : '已保存'),
                  icon: Icon(_dirty ? Icons.save : Icons.check_circle_outline,
                      color: _dirty ? theme.colorScheme.primary : null),
                  onPressed: _busy ? null : () => _save(),
                ),
                PopupMenuButton<String>(
                  onSelected: (v) async {
                    switch (v) {
                      case 'share':
                        await _share();
                      case 'publish':
                        await _publish();
                      case 'unpublish':
                        await _unpublish();
                      case 'download':
                        await _downloadLocal();
                      case 'external':
                        await _openExternalLocal();
                      case 'copy':
                        await Clipboard.setData(ClipboardData(text: _ctl.text));
                        _toast('已复制全文');
                      case 'copypath':
                        await Clipboard.setData(ClipboardData(text: widget.path));
                        _toast('已复制路径');
                      case 'reload':
                        await _load();
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(value: 'share', child: Text('生成分享链接')),
                    const PopupMenuItem(value: 'publish', child: Text('发布到分享页')),
                    const PopupMenuItem(value: 'unpublish', child: Text('撤回发布')),
                    const PopupMenuDivider(),
                    const PopupMenuItem(value: 'download', child: Text('下载到本机')),
                    const PopupMenuItem(value: 'external', child: Text('用系统程序打开')),
                    const PopupMenuDivider(),
                    const PopupMenuItem(value: 'copy', child: Text('复制全文')),
                    const PopupMenuItem(value: 'copypath', child: Text('复制路径')),
                    const PopupMenuItem(value: 'reload', child: Text('丢弃改动重新载入')),
                  ],
                ),
              ],
              bottom: (_status.isEmpty && _published == null)
                  ? null
                  : PreferredSize(
                      preferredSize: const Size.fromHeight(22),
                      child: Container(
                        alignment: Alignment.centerLeft,
                        padding: const EdgeInsets.only(left: 16),
                        height: 22,
                        child: Text(
                          [
                            if (_status.isNotEmpty) _status,
                            if (_published == true) '🌐 已发布到分享页',
                            if (_published == false) '未发布',
                          ].join('  ·  '),
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    ),
            ),
            body: _body(),
          ), // Scaffold
        ), // Actions
      ); // Shortcuts
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton(onPressed: _load, child: const Text('重试')),
            ],
          ),
        ),
      );
    }

    switch (_kind) {
      case 'image':
        return _imageView();
      case 'binary':
        return _binaryView();
      case 'markdown':
        if (_preview) {
          return Markdown(
            data: _ctl.text,
            selectable: true,
            onTapLink: (text, href, title) async {
              if (href == null || href.isEmpty) return;
              final uri = Uri.tryParse(href);
              if (uri != null && uri.isAbsolute) {
                await Clipboard.setData(ClipboardData(text: href));
                _toast('链接已复制：$href');
              }
            },
          );
        }
        return _textView();
      default:
        return _textView();
    }
  }

  Widget _imageView() {
    final cookie = c.cookie;
    return InteractiveViewer(
      maxScale: 6,
      child: Center(
        child: Image.network(
          c.config.fileUri(widget.path).toString(),
          // 原图直出要带会话 Cookie —— 这是"原生预览"和"浏览器预览"唯一的差别
          headers: cookie == null ? const {} : {'Cookie': cookie},
          loadingBuilder: (ctx, child, p) => p == null
              ? child
              : Center(
                  child: CircularProgressIndicator(
                    value: p.expectedTotalBytes == null
                        ? null
                        : p.cumulativeBytesLoaded / (p.expectedTotalBytes ?? 1),
                  ),
                ),
          errorBuilder: (ctx, e, st) => Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.broken_image_outlined, size: 48),
                const SizedBox(height: 8),
                const Text('图片加载失败（可能不在已发布范围内，或格式不被支持）'),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _openExternalLocal, child: const Text('下载后用系统程序打开')),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _binaryView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(iconOf(iconFor(baseName(widget.path))),
                size: 56, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 12),
            const Text('这个文件不能当文本编辑'),
            const SizedBox(height: 4),
            Text(
              '可能是二进制、超大文本（服务端正文上限 2MB）或 HTML/其他需要沙箱的类型。\n'
              '下载到本机后用系统程序打开是最稳的路子。',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _downloadLocal,
              icon: const Icon(Icons.download),
              label: const Text('下载到本机'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _openExternalLocal,
              icon: const Icon(Icons.open_in_new),
              label: const Text('下载并用系统程序打开'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _textView() {
    final s = widget.store;
    return Stack(
      fit: StackFit.expand,
      children: [
        TextField(
          controller: _ctl,
          scrollController: _scroll,
          autofocus: true,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          keyboardType: TextInputType.multiline,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: s.fontSize,
            height: 1.45,
          ),
          decoration: const InputDecoration(
            border: InputBorder.none,
            contentPadding: EdgeInsets.all(16),
          ),
        ),
        Positioned(
          right: 12,
          bottom: 12,
          child: Row(
            children: [
              _round(Icons.text_decrease,
                  () => s.setFontSize((s.fontSize - 1).clamp(10.0, 22.0).toDouble())),
              const SizedBox(width: 6),
              _round(Icons.text_increase,
                  () => s.setFontSize((s.fontSize + 1).clamp(10.0, 22.0).toDouble())),
            ],
          ),
        ),
      ],
    );
  }

  Widget _round(IconData icon, VoidCallback onTap) => Material(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        shape: const CircleBorder(),
        child: IconButton(
          icon: Icon(icon, size: 18),
          tooltip: '字号',
          onPressed: onTap,
        ),
      );
}

class _SaveIntent extends Intent {
  const _SaveIntent();
}
