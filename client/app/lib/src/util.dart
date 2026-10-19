/// 界面里到处要用的小工具。放一处，免得每个页面各写一遍 `fmtSize`。
import 'dart:io';

import 'package:cfwtxt_core/cfwtxt_core.dart';

String fmtSize(int n) {
  if (n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = n.toDouble();
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${i == 0 ? v.toStringAsFixed(0) : v.toStringAsFixed(1)} ${units[i]}';
}

String fmtTime(DateTime? t) {
  if (t == null) return '';
  final l = t.toLocal();
  final now = DateTime.now();
  final sameDay = l.year == now.year && l.month == now.month && l.day == now.day;
  if (sameDay) return '${_2(l.hour)}:${_2(l.minute)}';
  if (l.year == now.year) return '${l.month}-${_2(l.day)} ${_2(l.hour)}:${_2(l.minute)}';
  return '${l.year}-${_2(l.month)}-${_2(l.day)}';
}

String _2(int n) => n < 10 ? '0$n' : '$n';

/// 路径的显示名：根目录统一叫「根目录」（与网页端一致）
String displayPath(String path) => path.isEmpty ? '根目录' : path;

List<String> crumbs(String path) {
  if (path.isEmpty) return const [];
  return path.split('/').where((s) => s.isNotEmpty).toList();
}

/// 父目录
String parentOf(String path) {
  final i = path.lastIndexOf('/');
  return i < 0 ? '' : path.substring(0, i);
}

String baseName(String path) {
  final i = path.lastIndexOf('/');
  return i < 0 ? path : path.substring(i + 1);
}

String extOf(String name) {
  final i = name.lastIndexOf('.');
  if (i <= 0 || i == name.length - 1) return '';
  final e = name.substring(i + 1);
  return e.length > 5 ? e.substring(0, 5) : e;
}

/// 后缀 → 图标。目录树与列表共用，一眼能分辨类型。
IconDataLite iconFor(String name, {bool isDir = false}) {
  if (isDir) return IconDataLite.folder;
  switch (extOf(name).toLowerCase()) {
    case 'md':
    case 'markdown':
    case 'txt':
    case 'log':
    case 'rst':
      return IconDataLite.text;
    case 'json':
    case 'jsonl':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'env':
      return IconDataLite.config;
    case 'csv':
    case 'tsv':
      return IconDataLite.table;
    case 'html':
    case 'htm':
    case 'xhtml':
    case 'css':
    case 'js':
    case 'xml':
    case 'vue':
      return IconDataLite.web;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'avif':
    case 'bmp':
    case 'svg':
      return IconDataLite.image;
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'mkv':
    case 'mp3':
    case 'm4a':
    case 'wav':
    case 'flac':
    case 'ogg':
      return IconDataLite.media;
    case 'pdf':
      return IconDataLite.pdf;
    case 'zip':
    case 'gz':
    case '7z':
    case 'rar':
    case 'tar':
      return IconDataLite.zip;
    case 'py':
    case 'go':
    case 'rs':
    case 'java':
    case 'ts':
    case 'sh':
    case 'sql':
    case 'c':
    case 'cpp':
    case 'h':
      return IconDataLite.code;
    default:
      return IconDataLite.file;
  }
}

/// 刻意不 import material（这个文件要能被纯逻辑复用）
enum IconDataLite { folder, text, config, table, web, image, media, pdf, zip, code, file }

bool isTextyPath(String name) {
  const exts = {
    'txt', 'text', 'log', 'md', 'markdown', 'mdx', 'rst', 'csv', 'tsv', 'json',
    'json5', 'jsonc', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg',
    'conf', 'env', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'vue', 'svelte', 'xml', 'svg', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'cs', 'm',
    'swift', 'dart', 'lua', 'pl', 'php', 'r', 'sql', 'graphql', 'gql', 'proto',
    'tex', 'srt', 'vtt', 'diff', 'patch', 'pem', 'gitignore', 'editorconfig',
    // HTML 只作为**源码**编辑（客户端永不渲染它 —— 渲染就得 WebView / iframe）
    'html', 'htm', 'xhtml',
  };
  return exts.contains(extOf(name).toLowerCase());
}

/// 把异常变成一句用户能看懂的话（不要往界面里丢 Dart 的 stacktrace）
String humanError(Object e) {
  // ApiException.toString() 是给日志看的（`ApiException(403): ...`），
  // 界面上只要 message 本身
  final raw = e is ApiException ? e.message : e.toString();
  return raw.length > 300 ? '${raw.substring(0, 300)}…' : raw;
}

Future<void> openWithSystem(String path) async {
  // 桌面端用系统默认程序打开（编辑器里的大文件走这条）
  if (Platform.isWindows) {
    await Process.run('cmd', ['/c', 'start', '', path]);
  } else if (Platform.isMacOS) {
    await Process.run('open', [path]);
  } else if (Platform.isLinux) {
    await Process.run('xdg-open', [path]);
  } else {
    // Android 上要"交给别的 App 打开"得走 FileProvider + content:// ，
    // 那需要改 AndroidManifest 与 res/xml。这里不假装成功，直接把落点告诉用户。
    throw StateError('这个平台不支持直接调用系统程序打开。文件已保存到：$path');
  }
}
