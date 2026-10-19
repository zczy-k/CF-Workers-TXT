/// 测试用的假传输层：文件在内存里，落点是内存列表。
///
/// 用它就能在没有网络、没有磁盘的 CI 里把"续传、重试、并发闸门、取消"
/// 这些最容易写错的逻辑全测一遍。
library;

import 'dart:async';
import 'dart:io';

import 'package:webshell_core/webshell_core.dart';

/// 服务端上的一个"文件"。
class FakeFile {
  FakeFile(
    this.bytes, {
    this.fileName,
    this.supportsRange = true,
    this.contentType = 'application/octet-stream',
    this.etag = 'v1',
  });

  final List<int> bytes;
  final String? fileName;
  final bool supportsRange;
  final String contentType;

  /// 服务端给的 ETag（续传校验器；客户端回带成 If-Range）。
  final String? etag;

  int get length => bytes.length;
}

class _MemorySink implements DownloadSink {
  _MemorySink(this.target);
  final List<int> target;

  @override
  void add(List<int> chunk) => target.addAll(chunk);

  @override
  Future<void> close() async {}
}

class FakeTransport implements DownloadTransport {
  FakeTransport({
    Map<String, FakeFile>? files,
    this.chunkSize = 4,
    this.chunkDelay = Duration.zero,
  }) : files = files ?? <String, FakeFile>{};

  /// url → 文件
  final Map<String, FakeFile> files;

  /// 每次 add 的块大小（小块能把"边下边推进度"的行为测出来）。
  final int chunkSize;

  /// 每块之间的延迟（用来观察并发行为）。
  final Duration chunkDelay;

  /// path → 已写入的字节
  final Map<String, List<int>> saved = <String, List<int>>{};

  /// 被删除的 path
  final List<String> deleted = <String>[];

  int openCount = 0;
  final List<int> requestedOffsets = <int>[];
  Map<String, String> lastHeaders = <String, String>{};

  /// 前 N 次 open 直接抛错（测重试）。
  int failTimes = 0;

  /// 全局开关：服务端会不会忽略 Range（返回 200 + 全量）。
  bool honourRange = true;

  /// 模拟"服务端文件在两次请求之间变了"：忽略 Range，回 200 + 全量。
  bool fileChanged = false;

  /// 最近一次 open 收到的 If-Range（测"续传带上校验器"）。
  String? lastIfRange;

  int _inFlight = 0;
  int maxInFlight = 0;

  @override
  Future<DownloadResponse> open(
    Uri url, {
    required Map<String, String> headers,
    int offset = 0,
    String? ifRange,
  }) async {
    openCount++;
    requestedOffsets.add(offset);
    lastIfRange = ifRange;
    lastHeaders = Map<String, String>.of(headers);

    if (failTimes > 0) {
      failTimes--;
      throw const SocketException('模拟网络中断');
    }

    final FakeFile? file = files[url.toString()];
    if (file == null) {
      throw DownloadException('找不到文件', statusCode: 404);
    }

    // 文件变了（If-Range 不匹配）时服务端忽略 Range，回 200 全量。
    final bool canResume =
        offset > 0 && honourRange && file.supportsRange && !fileChanged;
    // 不支持续传时必须从头发全量，否则测不出"服务端忽略 Range"这条分支
    final int start = canResume
        ? (offset > file.length ? file.length : offset)
        : 0;
    final List<int> body = file.bytes.sublist(start);

    return DownloadResponse(
      statusCode: canResume ? 206 : 200,
      bytes: _stream(body),
      fileName: file.fileName,
      contentLength: body.length,
      totalLength: file.length,
      acceptsRanges: honourRange && file.supportsRange,
      contentType: file.contentType,
      etag: file.etag,
    );
  }

  Stream<List<int>> _stream(List<int> body) async* {
    _inFlight++;
    if (_inFlight > maxInFlight) maxInFlight = _inFlight;
    try {
      for (int i = 0; i < body.length; i += chunkSize) {
        if (chunkDelay > Duration.zero) {
          await Future<void>.delayed(chunkDelay);
        } else {
          await Future<void>.delayed(Duration.zero);
        }
        final int end = (i + chunkSize > body.length) ? body.length : i + chunkSize;
        yield body.sublist(i, end);
      }
    } finally {
      _inFlight--;
    }
  }

  @override
  Future<DownloadSink> openSink(String path, {required bool append}) async {
    final List<int> target = saved.putIfAbsent(path, () => <int>[]);
    if (!append) target.clear();
    return _MemorySink(target);
  }

  @override
  Future<void> delete(String path) async {
    deleted.add(path);
    saved.remove(path);
  }
}
