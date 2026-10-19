/// 下载器：自己实现，不依赖引擎的原生下载。
///
/// 为什么自己实现：引擎的下载能力在两个平台上并不对等（见 ARCHITECTURE.md §7），
/// 而"能下载到手机/电脑本地"是这个 App 的硬需求。所以下载一律走这里：
/// 带 Cookie/UA/Referer、`Range` 续传、并发闸门、失败重试、暂停/继续/取消。
///
/// 传输层与落点都做成了接口（[DownloadTransport]/[DownloadSink]）：
/// 单测里塞内存假实现，Android 上可以换成 SAF 文档写入，互不影响。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'models.dart';
import 'url_utils.dart';

enum DownloadStatus { queued, running, paused, done, failed, canceled }

class DownloadException implements Exception {
  DownloadException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() =>
      statusCode == null ? message : '$message (HTTP $statusCode)';
}

/// 一条下载任务。可变字段直接绑在列表 UI 上，改完通知刷新即可。
class DownloadTask {
  DownloadTask({
    required this.id,
    required this.siteId,
    required this.url,
    required this.fileName,
    this.referer,
    this.savePath,
    this.createdAtMs = 0,
  });

  final String id;
  final String siteId;
  final String url;
  String fileName;
  String? referer;

  /// 最终落盘位置（解析一次后缓存，续传必须落在同一个文件上）。
  String? savePath;

  int received = 0;
  int? total;
  DownloadStatus status = DownloadStatus.queued;
  String? error;

  /// 服务端是否支持 `Range`（决定"继续"时是续传还是从头下）。
  bool resumable = false;

  /// 续传校验器：上次响应的 `ETag` / `Last-Modified`。
  ///
  /// 续传（`Range`）不保证两次响应是同一个文件 —— 服务端在两次之间换了内容，
  /// 拼出来就是坏文件。带上其一作为 `If-Range`：服务端"文件没变"才回 206，
  /// 变了就回 200 全量，我们从头发写，绝不拼半新半旧的字节。
  String? etag;
  String? lastModified;

  final int createdAtMs;

  double get progress {
    final int? t = total;
    if (t == null || t <= 0) return 0;
    return (received / t).clamp(0.0, 1.0).toDouble();
  }

  bool get isActive =>
      status == DownloadStatus.queued || status == DownloadStatus.running;

  bool get isFinished =>
      status == DownloadStatus.done ||
      status == DownloadStatus.failed ||
      status == DownloadStatus.canceled;

  String get displaySize {
    final int? t = total;
    if (t == null || t <= 0) return humanBytes(received);
    return '${humanBytes(received)} / ${humanBytes(t)}';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'siteId': siteId,
        'url': url,
        'fileName': fileName,
        if (referer != null && referer!.isNotEmpty) 'referer': referer,
        if (savePath != null && savePath!.isNotEmpty) 'savePath': savePath,
        'received': received,
        if (total != null) 'total': total,
        'status': status.name,
        'resumable': resumable,
        if (etag != null && etag!.isNotEmpty) 'etag': etag,
        if (lastModified != null && lastModified!.isNotEmpty)
          'lastModified': lastModified,
        'createdAtMs': createdAtMs,
      };

  static DownloadTask? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? rawUrl = raw['url'];
    final String url = rawUrl is String ? rawUrl.trim() : '';
    if (url.isEmpty) return null;

    final String name =
        (raw['fileName'] is String && (raw['fileName'] as String).trim().isNotEmpty)
            ? (raw['fileName'] as String).trim()
            : fileNameFromUrl(url);
    final DownloadTask task = DownloadTask(
      id: raw['id'] is String ? raw['id'] as String : url,
      siteId: raw['siteId'] is String ? raw['siteId'] as String : '',
      url: url,
      fileName: name,
      referer: raw['referer'] is String ? raw['referer'] as String : null,
      savePath: raw['savePath'] is String ? raw['savePath'] as String : null,
      createdAtMs: raw['createdAtMs'] is int ? raw['createdAtMs'] as int : 0,
    );
    task.received = raw['received'] is int ? raw['received'] as int : 0;
    task.total = raw['total'] is int ? raw['total'] as int : null;
    task.resumable = raw['resumable'] == true;
    task.etag = raw['etag'] is String ? raw['etag'] as String : null;
    task.lastModified =
        raw['lastModified'] is String ? raw['lastModified'] as String : null;
    task.status = _statusFromName(raw['status']);
    // 重启后不该停在"正在下载"，半截文件还在，一律变回暂停由用户决定。
    if (task.status == DownloadStatus.running) task.status = DownloadStatus.paused;
    return task;
  }
}

DownloadStatus _statusFromName(Object? name) {
  for (final DownloadStatus s in DownloadStatus.values) {
    if (s.name == name) return s;
  }
  return DownloadStatus.queued;
}

/// 一次响应的抽象（单测里用假实现，真机上是 `HttpClientResponse`）。
class DownloadResponse {
  DownloadResponse({
    required this.statusCode,
    required this.bytes,
    this.fileName,
    this.contentLength,
    this.totalLength,
    this.acceptsRanges = false,
    this.contentType,
    this.etag,
    this.lastModified,
  });

  final int statusCode;
  final Stream<List<int>> bytes;

  /// 服务端在 `Content-Disposition` 里给的文件名（优先于 URL 猜出来的）。
  final String? fileName;

  /// 本次响应体的长度（续传时是"剩余长度"）。
  final int? contentLength;

  /// 文件总长度。
  final int? totalLength;

  final bool acceptsRanges;
  final String? contentType;

  /// 服务端给的校验器（续传时回带成 `If-Range`）。
  final String? etag;
  final String? lastModified;
}

/// 落点：真机上是本地文件；Android 上也可以是 SAF 文档。
abstract class DownloadSink {
  void add(List<int> chunk);
  Future<void> close();
}

/// 传输层接口。
abstract class DownloadTransport {
  /// [offset] > 0 表示续传，实现方应带上 `Range` 头。
  ///
  /// [ifRange] = 上次响应的 `ETag`/`Last-Modified`，实现方带成 `If-Range`；
  /// 服务端在文件已变时会回 200 全量（我们据此从头写），避免续传出坏文件。
  Future<DownloadResponse> open(
    Uri url, {
    required Map<String, String> headers,
    int offset = 0,
    String? ifRange,
  });

  /// [append] = false 表示从头写（截断已有内容）。
  Future<DownloadSink> openSink(String path, {required bool append});

  /// 删除半截文件（取消时用）。
  Future<void> delete(String path);
}

/// 真机实现：`dart:io` 的 `HttpClient` + 本地文件。
class FileDownloadTransport implements DownloadTransport {
  FileDownloadTransport({HttpClient? client})
      : _client = client ??
            (HttpClient()
              ..connectionTimeout = const Duration(seconds: 30)
              ..userAgent = null);

  final HttpClient _client;

  @override
  Future<DownloadResponse> open(
    Uri url, {
    required Map<String, String> headers,
    int offset = 0,
    String? ifRange,
  }) async {
    final HttpClientRequest req = await _client.openUrl('GET', url);
    req.followRedirects = true;
    req.maxRedirects = 10;
    headers.forEach((String k, String v) {
      if (v.isNotEmpty) req.headers.set(k, v);
    });
    if (offset > 0) {
      req.headers.set(HttpHeaders.rangeHeader, 'bytes=$offset-');
      final String validator = (ifRange ?? '').trim();
      if (validator.isNotEmpty) {
        req.headers.set(HttpHeaders.ifRangeHeader, validator);
      }
    }

    final HttpClientResponse resp = await req.close();
    final int? remaining = resp.contentLength >= 0 ? resp.contentLength : null;
    final int? totalFromRange =
        _totalFromContentRange(resp.headers.value(HttpHeaders.contentRangeHeader));

    int? total;
    if (totalFromRange != null) {
      total = totalFromRange;
    } else if (remaining != null) {
      total = (offset > 0 && resp.statusCode != 206 ? 0 : offset) + remaining;
    }

    return DownloadResponse(
      statusCode: resp.statusCode,
      bytes: resp,
      fileName: parseContentDisposition(
          resp.headers.value('content-disposition')),
      contentLength: remaining,
      totalLength: total,
      acceptsRanges:
          (resp.headers.value(HttpHeaders.acceptRangesHeader)?.toLowerCase().contains('bytes') ??
                  false) ||
              resp.statusCode == 206,
      contentType: resp.headers.contentType?.mimeType,
      etag: _nonEmpty(resp.headers.value(HttpHeaders.etagHeader)),
      lastModified:
          _nonEmpty(resp.headers.value(HttpHeaders.lastModifiedHeader)),
    );
  }

  @override
  Future<DownloadSink> openSink(String path, {required bool append}) async {
    final File f = File(path);
    if (!f.parent.existsSync()) {
      await f.parent.create(recursive: true);
    }
    return FileDownloadSink(f, append: append);
  }

  @override
  Future<void> delete(String path) async {
    final File f = File(path);
    if (await f.exists()) {
      await f.delete();
    }
  }
}

class FileDownloadSink implements DownloadSink {
  FileDownloadSink(File file, {required bool append})
      : _sink = file.openWrite(
          mode: append ? FileMode.append : FileMode.write,
        );

  final IOSink _sink;

  @override
  void add(List<int> chunk) => _sink.add(chunk);

  @override
  Future<void> close() async {
    await _sink.flush();
    await _sink.close();
  }
}

/// 取 Cookie 头等：由 App 实现（向引擎的 Cookie 仓库要）。
typedef DownloadHeaderProvider = Future<Map<String, String>> Function(
    DownloadTask task);

/// 决定文件存哪儿：由 App 实现（Android 走 SAF，Windows 走目录选择器）。
typedef DownloadPathResolver = Future<String> Function(
    DownloadTask task, String suggestedFileName);

/// 下载队列。
class DownloadManager {
  DownloadManager({
    required DownloadTransport transport,
    DownloadHeaderProvider? headers,
    DownloadPathResolver? resolvePath,
    this.maxConcurrent = 2,
    this.maxAttempts = 3,
    this.retryDelay = const Duration(milliseconds: 500),
    this.onChanged,
  })  : _transport = transport,
        _headers = headers,
        _resolvePath = resolvePath;

  /// 任务列表（新任务在最前），UI 直接读。
  final List<DownloadTask> tasks = <DownloadTask>[];

  /// 并发闸门：同时最多下几个（设置页可改）。
  int maxConcurrent;

  /// 单个任务最多尝试几次（含第一次）。
  final int maxAttempts;

  /// 重试间隔（第 n 次等待 `retryDelay * n`）。
  final Duration retryDelay;

  /// 任何状态变化都会回调（UI 刷新 + 存盘）。
  void Function(DownloadTask task)? onChanged;

  final DownloadTransport _transport;
  final DownloadHeaderProvider? _headers;
  final DownloadPathResolver? _resolvePath;

  final Map<String, int> _lastNotifyMs = <String, int>{};
  int _running = 0;
  bool _closed = false;

  /// 恢复上次没下完的队列（比如 App 被关掉）。
  void restore(List<DownloadTask> restored) {
    for (final DownloadTask t in restored) {
      if (t.status == DownloadStatus.done) continue;
      tasks.add(t);
    }
    if (tasks.isNotEmpty) _pump();
  }

  /// 入队。[startPaused] = true 时只排队不开始（"每次问存哪儿"的流程用）。
  DownloadTask enqueue({
    required String url,
    required String siteId,
    String? fileName,
    String? referer,
    String? savePath,
    bool startPaused = false,
  }) {
    // 同一个地址 + 同一个站点已经在队列里，就不重复加了。
    for (final DownloadTask t in tasks) {
      if (t.url == url && t.siteId == siteId && !t.isFinished) return t;
    }
    final DownloadTask task = DownloadTask(
      id: '${nowMs()}-${tasks.length}-${url.hashCode.toRadixString(36)}',
      siteId: siteId,
      url: url,
      fileName: sanitizeFileName(fileName ?? fileNameFromUrl(url)),
      referer: referer,
      savePath: savePath,
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    if (startPaused) task.status = DownloadStatus.paused;
    tasks.insert(0, task);
    _notify(task, force: true);
    if (!startPaused) _pump();
    return task;
  }

  DownloadTask? byId(String id) {
    for (final DownloadTask t in tasks) {
      if (t.id == id) return t;
    }
    return null;
  }

  void pause(String id) {
    final DownloadTask? t = byId(id);
    if (t == null || !t.isActive) return;
    t.status = DownloadStatus.paused;
    _notify(t, force: true);
  }

  void resume(String id) {
    final DownloadTask? t = byId(id);
    if (t == null) return;
    if (t.status == DownloadStatus.paused || t.status == DownloadStatus.failed) {
      t.error = null;
      t.status = DownloadStatus.queued;
      _notify(t, force: true);
      _pump();
    }
  }

  Future<void> cancel(String id) async {
    final DownloadTask? t = byId(id);
    if (t == null) return;
    final bool wasActive = t.isActive;
    t.status = DownloadStatus.canceled;
    _notify(t, force: true);
    // 正在写的那个由 _run 收尾后删（否则会和正在写入的 sink 打架）
    if (!wasActive) await _cleanupPartial(t);
  }

  Future<void> _cleanupPartial(DownloadTask task) async {
    final String? path = task.savePath;
    if (path == null || path.isEmpty) return;
    try {
      await _transport.delete(path);
    } catch (_) {
      // 删不掉不影响功能，只是留个半截文件
    }
  }

  /// 从列表里移掉（失败/取消/完成的记录）。
  void remove(String id) {
    final DownloadTask? t = byId(id);
    if (t == null || t.isActive) return;
    tasks.remove(t);
    _lastNotifyMs.remove(id);
  }

  void clearFinished() {
    tasks.removeWhere((DownloadTask t) => t.status == DownloadStatus.done);
  }

  /// 整体进度（完成数 / 总数），用于顶栏。
  double get overallProgress {
    final List<DownloadTask> active = tasks
        .where((DownloadTask t) => t.status == DownloadStatus.done || t.isActive || t.status == DownloadStatus.paused)
        .toList();
    if (active.isEmpty) return 0;
    double sum = 0;
    for (final DownloadTask t in active) {
      sum += t.status == DownloadStatus.done ? 1 : t.progress;
    }
    return sum / active.length;
  }

  bool get isBusy =>
      _running > 0 || tasks.any((DownloadTask t) => t.status == DownloadStatus.queued);

  /// 等队列跑空（测试与"下载完再退出"用）。
  Future<void> waitIdle() async {
    while (!_closed && isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
  }

  void close() {
    _closed = true;
  }

  void _pump() {
    if (_closed) return;
    while (_running < maxConcurrent) {
      final int i = tasks.indexWhere((DownloadTask t) => t.status == DownloadStatus.queued);
      if (i < 0) return;
      final DownloadTask task = tasks[i];
      task.status = DownloadStatus.running;
      _running++;
      _notify(task, force: true);
      _run(task).whenComplete(() {
        _running--;
        if (!_closed) _pump();
      });
    }
  }

  Future<void> _run(DownloadTask task) async {
    int attempt = 0;
    while (!_closed && task.status == DownloadStatus.running) {
      attempt++;
      try {
        await _attempt(task);
        break; // 正常返回：下完了，或者被暂停/取消
      } on DownloadException catch (e) {
        task.error = e.message;
      } catch (e) {
        task.error = e.toString();
      }
      if (_closed || task.status != DownloadStatus.running) break;
      if (attempt >= maxAttempts) break;
      await Future<void>.delayed(retryDelay * attempt);
    }
    if (!_closed && task.status == DownloadStatus.running) {
      task.status = DownloadStatus.failed;
      _notify(task, force: true);
    }
    if (task.status == DownloadStatus.canceled) {
      // 取消：删掉半截文件（等 sink 关掉之后再删，否则和正在写入的文件打架）
      await _cleanupPartial(task);
    }
  }

  Future<void> _attempt(DownloadTask task) async {
    final DownloadHeaderProvider? provider = _headers;
    final Map<String, String> headers =
        provider == null ? const <String, String>{} : await provider(task);

    final int offset = task.received;
    final DownloadResponse resp = await _transport.open(
      Uri.parse(task.url),
      headers: headers,
      offset: offset,
      // 续传时带上上次的校验器：文件没变服务端才回 206，变了回 200 全量。
      ifRange: offset > 0 ? (task.etag ?? task.lastModified) : null,
    );

    if (resp.statusCode >= 400) {
      throw DownloadException('服务器返回错误', statusCode: resp.statusCode);
    }
    if (resp.statusCode != 200 && resp.statusCode != 206) {
      throw DownloadException('服务器返回了意外状态', statusCode: resp.statusCode);
    }

    // 服务端给了名字就用它的（比 URL 末段准，尤其是带签名的下载链接）。
    final String? serverName = resp.fileName;
    if (serverName != null && serverName.trim().isNotEmpty && offset == 0) {
      task.fileName = sanitizeFileName(serverName);
    }

    final String? existing = task.savePath;
    final String path = (existing != null && existing.isNotEmpty)
        ? existing
        : (task.savePath = await _resolveSavePath(task));

    if (offset > 0 && resp.statusCode == 200) {
      // 服务端不支持续传（或 If-Range 校验失败、文件已变）：从头写，进度归零。
      task.received = 0;
    }

    // 记下服务端这次给的校验器，供下次续传做 `If-Range`。
    // 200 全量响应是"权威版本"：即使这次没带校验器也要把旧的清掉，否则会拿
    // 过期校验器去续传一个已经变了的文件。
    if (resp.statusCode == 200) {
      task.etag = _nonEmpty(resp.etag);
      task.lastModified = _nonEmpty(resp.lastModified);
    } else if (resp.statusCode == 206) {
      final String? newEtag = _nonEmpty(resp.etag);
      if (newEtag != null) task.etag = newEtag;
      final String? newLm = _nonEmpty(resp.lastModified);
      if (newLm != null) task.lastModified = newLm;
    }

    final int? remaining = resp.contentLength;
    final int? total = resp.totalLength ?? (remaining == null ? null : task.received + remaining);
    if (total != null) task.total = total;
    task.resumable = resp.acceptsRanges;
    final bool append = task.received > 0;

    final DownloadSink sink = await _transport.openSink(path, append: append);
    try {
      await for (final List<int> chunk in resp.bytes) {
        if (_closed || task.status != DownloadStatus.running) {
          // 暂停/取消/退出：把 sink 关掉收尾，半截文件留着以便续传。
          await sink.close();
          return;
        }
        sink.add(chunk);
        task.received += chunk.length;
        final int? known = task.total;
        if (known != null && task.received > known) task.total = task.received;
        _notify(task);
      }
      await sink.close();
      if (_closed) return;
      task.status = DownloadStatus.done;
      task.error = null;
      _notify(task, force: true);
    } catch (e) {
      await sink.close();
      rethrow;
    }
  }

  Future<String> _resolveSavePath(DownloadTask task) async {
    final DownloadPathResolver? resolver = _resolvePath;
    if (resolver != null) {
      final String resolved = await resolver(task, task.fileName);
      if (resolved.trim().isNotEmpty) return resolved;
    }
    final String dir = defaultDownloadDir();
    return uniquePath(joinPath(dir, task.fileName));
  }

  /// 进度回调节流：200ms 一次，避免每秒几百次重建 UI。
  void _notify(DownloadTask task, {bool force = false}) {
    final void Function(DownloadTask)? cb = onChanged;
    if (cb == null) return;
    if (!force) {
      final int now = DateTime.now().millisecondsSinceEpoch;
      final int last = _lastNotifyMs[task.id] ?? 0;
      if (now - last < 200 && task.status == DownloadStatus.running) return;
      _lastNotifyMs[task.id] = now;
    }
    cb(task);
  }
}

/// 去掉空串的响应头值（不少服务端会回 `ETag:` 这种空值）。
String? _nonEmpty(String? s) {
  if (s == null) return null;
  final String v = s.trim();
  return v.isEmpty ? null : v;
}

/// `Content-Range: bytes 100-999/1000` → 1000。
int? _totalFromContentRange(String? value) {
  if (value == null || value.isEmpty) return null;
  final int slash = value.lastIndexOf('/');
  if (slash < 0 || slash == value.length - 1) return null;
  final String tail = value.substring(slash + 1).trim();
  if (tail == '*') return null;
  return int.tryParse(tail);
}

/// 解析 `Content-Disposition` 里的文件名（支持 RFC 5987 的 `filename*`）。
String? parseContentDisposition(String? header) {
  if (header == null || header.trim().isEmpty) return null;

  // filename*=UTF-8''%E4%B8%AD%E6%96%87.pdf
  final RegExpMatch? star = RegExp(
    r"""filename\*\s*=\s*([^;']*)'[^']*'([^;]+)""",
    caseSensitive: false,
  ).firstMatch(header);
  if (star != null) {
    final String charset = star.group(1)!.trim().toLowerCase();
    final String raw = star.group(2)!.trim();
    if (charset.isEmpty || charset == 'utf-8' || charset == 'utf8') {
      try {
        final String decoded = Uri.decodeComponent(raw);
        if (decoded.trim().isNotEmpty) return sanitizeFileName(decoded);
      } catch (_) {
        // 解码失败就落到下一个分支
      }
    }
  }

  // filename="a b.pdf" / filename=a.pdf
  final RegExpMatch? plain = RegExp(
    r'''filename\s*=\s*("([^"]*)"|[^;]+)''',
    caseSensitive: false,
  ).firstMatch(header);
  if (plain == null) return null;
  final String raw = (plain.group(2) ?? plain.group(1) ?? '').trim();
  if (raw.isEmpty) return null;
  return sanitizeFileName(_decodeLatin1AsUtf8(raw));
}

/// 有些服务端把 UTF-8 字节当 latin1 塞进 `filename=`，这里救回来。
String _decodeLatin1AsUtf8(String raw) {
  bool hasNonAscii = false;
  for (final int c in raw.codeUnits) {
    if (c > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return raw;
  try {
    return utf8.decode(raw.codeUnits.map((int c) => c & 0xFF).toList());
  } catch (_) {
    return raw;
  }
}

/// 服务端没给名字时，从 URL 猜。
String resolveFileName({required String url, String? contentDisposition}) =>
    parseContentDisposition(contentDisposition) ?? fileNameFromUrl(url);

/// 默认下载目录（桌面端/测试用；Android 永远由 App 提供 SAF 落点）。
String defaultDownloadDir() {
  final Map<String, String> env = Platform.environment;
  if (Platform.isWindows) {
    final String? profile = env['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) return '$profile\\Downloads';
  }
  final String? home = env['HOME'];
  if (home != null && home.isNotEmpty) return '$home/Downloads';
  return Directory.systemTemp.path;
}

String joinPath(String dir, String name) {
  if (dir.isEmpty) return name;
  final String sep = Platform.pathSeparator;
  if (dir.endsWith('/') || dir.endsWith('\\')) return '$dir$name';
  return '$dir$sep$name';
}

/// Android：`/…/Android/data/<包名>/files` → `/…/Android/media/<包名>`。
///
/// 为什么要换：`Android/data/<包名>` 从 Android 11 起被系统对文件管理器和 MTP
/// **屏蔽**了 —— 文件其实下到了手机上，但用户在文件管理里根本翻不到，体验上就是
/// "下载的东西没到本机"。`Android/media/<包名>` 同样是应用私有目录（不需要任何
/// 权限，也不用 SAF），但它是**可见**的：WhatsApp 的媒体就放这儿，文件管理器能翻到。
///
/// 传入路径不是 Android 应用私有目录的形状时返回 null（调用方自己兜底）。
String? androidMediaDirOf(String appPrivatePath) {
  const String marker = '/Android/data/';
  final int at = appPrivatePath.indexOf(marker);
  if (at < 0) return null;
  final String rest = appPrivatePath.substring(at + marker.length);
  final int slash = rest.indexOf('/');
  final String pkg = slash < 0 ? rest : rest.substring(0, slash);
  if (pkg.isEmpty || pkg.contains('..')) return null;
  return '${appPrivatePath.substring(0, at)}/Android/media/$pkg';
}

/// Android：`/…/Android/data/<包名>/files` → `/…`（卷根，通常是
/// `/storage/emulated/0`）。用于定位系统公共 `Download` 目录。
///
/// 传入路径不是 Android 应用私有目录的形状时返回 null（调用方自己兜底）。
String? androidVolumeRootOf(String appPrivatePath) {
  const String marker = '/Android/data/';
  final int at = appPrivatePath.indexOf(marker);
  if (at < 0) return null;
  final String root = appPrivatePath.substring(0, at);
  return root.isEmpty ? null : root;
}

/// 已有同名文件时补 ` (1)`、` (2)`。
String uniquePath(String path, {bool Function(String path)? exists}) {
  final bool Function(String p) test = exists ?? (String p) => File(p).existsSync();
  if (!test(path)) return path;

  final int dot = path.lastIndexOf('.');
  final int sep = path.lastIndexOf(RegExp(r'[/\\]'));
  final bool hasExt = dot > sep + 1;
  final String stem = hasExt ? path.substring(0, dot) : path;
  final String ext = hasExt ? path.substring(dot) : '';
  for (int i = 1; i < 1000; i++) {
    final String candidate = '$stem ($i)$ext';
    if (!test(candidate)) return candidate;
  }
  return '$stem-${nowMs()}$ext';
}

/// 人类可读的体积。
String humanBytes(int bytes) {
  if (bytes < 0) return '0 B';
  if (bytes < 1024) return '$bytes B';
  const List<String> units = <String>['KB', 'MB', 'GB', 'TB'];
  double value = bytes / 1024;
  int i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  final String text = value >= 100 ? value.toStringAsFixed(0) : value.toStringAsFixed(1);
  return '$text ${units[i]}';
}
