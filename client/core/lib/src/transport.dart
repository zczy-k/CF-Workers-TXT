import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'errors.dart';

/// 一个请求。刻意做成**不可变 + 显式**的（而不是直接吃 `dart:io` 的 `HttpClientRequest`），
/// 这样测试里可以用假传输层把每个请求的 method / uri / headers / body 断言一遍。
class HttpRequest {
  final String method;
  final Uri uri;
  final Map<String, String> headers;
  final List<int>? body;
  final Stream<List<int>>? bodyStream;

  /// 流式上传时的总长度。给了就用它当 Content-Length（服务端 `arrayBuffer()` 能少缓冲一次）；
  /// 不给就走 chunked。
  final int? contentLength;

  /// 登录请求必须关掉：服务端在 **302 的响应头**里下发 `Set-Cookie`，
  /// 自动跟随重定向就永远看不到它了。
  final bool followRedirects;

  const HttpRequest({
    required this.method,
    required this.uri,
    this.headers = const {},
    this.body,
    this.bodyStream,
    this.contentLength,
    this.followRedirects = true,
  });

  HttpRequest withHeaders(Map<String, String> extra) => HttpRequest(
        method: method,
        uri: uri,
        headers: {...headers, ...extra},
        body: body,
        bodyStream: bodyStream,
        contentLength: contentLength,
        followRedirects: followRedirects,
      );

  /// 头名字大小写不敏感地取一个头（服务端到处是 `ETag` / `X-File-Mtime` 这种写法）
  String? header(String name) {
    final l = name.toLowerCase();
    for (final e in headers.entries) {
      if (e.key.toLowerCase() == l) return e.value;
    }
    return null;
  }
}

/// 一个响应。头部统一**小写键**，因为服务端各处的头大小写不统一
/// （`ETag` / `X-Text-Encoding` / `Retry-After`），调用方不该被迫猜大小写。
class HttpResponse {
  final int status;
  final Map<String, String> headers;
  final Uint8List body;

  const HttpResponse({required this.status, required this.headers, required this.body});

  String get text => utf8.decode(body, allowMalformed: true);

  String? header(String name) => headers[name.toLowerCase()];

  bool get isOk => status >= 200 && status < 300;
}

/// 传输层抽象。唯一实现是 [IoTransport]，测试里换成假实现。
abstract class Transport {
  Future<HttpResponse> send(HttpRequest req);

  /// 流式写盘 —— 大文件绝不能 `readAsBytes()` 进内存。
  /// 因为服务端**不支持 Range**，这里是"要么整包成功、要么从头再来"。
  Future<void> download(
    HttpRequest req,
    String destPath, {
    void Function(int received, int? total)? onProgress,
  });
}

/// 基于 `dart:io` 的实现。**不引入 http / dio**：一个纯 Dart 包带第三方依赖，
/// 会让 CI 里 `dart test` 多一层网络解析，收益却几乎为零。
class IoTransport implements Transport {
  /// 建连 + 收到响应头的超时（**不限制整个下载时长** —— 大文件本来就要很久）
  final Duration timeout;

  /// 自签名证书放行。给"自己用 IP + 自建反代"的部署留一个开关，默认关。
  final bool allowBadCertificate;

  final String userAgent;

  IoTransport({
    this.timeout = const Duration(seconds: 30),
    this.allowBadCertificate = false,
    this.userAgent = 'CF-Workers-TXT-Client/0.1 (+dart:io)',
  });

  HttpClient _client() {
    final c = HttpClient();
    c.connectionTimeout = timeout;
    c.idleTimeout = const Duration(seconds: 30);
    c.userAgent = userAgent;
    c.autoUncompress = true;
    if (allowBadCertificate) {
      c.badCertificateCallback = (cert, host, port) => true;
    }
    return c;
  }

  @override
  Future<HttpResponse> send(HttpRequest req) async {
    final client = _client();
    try {
      final r = await _open(client, req);
      final res = await r.close().timeout(timeout);
      final bytes = await _collect(res);
      return HttpResponse(status: res.statusCode, headers: _headersOf(res), body: bytes);
    } on ApiException {
      rethrow;
    } catch (e) {
      throw _networkError(e);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<void> download(
    HttpRequest req,
    String destPath, {
    void Function(int received, int? total)? onProgress,
  }) async {
    final client = _client();
    IOSink? sink;
    File? part;
    try {
      final r = await _open(client, req);
      final res = await r.close().timeout(timeout);

      if (res.statusCode != 200) {
        final bytes = await _collect(res);
        throw ApiException(
          _errorTextOf(bytes, res.statusCode),
          status: res.statusCode,
          retryAfter: int.tryParse(_headersOf(res)['retry-after'] ?? ''),
        );
      }

      final total = res.contentLength > 0 ? res.contentLength : null;
      // 先写 .part 再改名：中途断网 / 被 kill 时不会留下一个"看起来完整"的半个文件
      part = File('$destPath.part');
      await part.parent.create(recursive: true);
      sink = part.openWrite();

      var got = 0;
      await for (final chunk in res) {
        sink.add(chunk);
        got += chunk.length;
        onProgress?.call(got, total);
      }
      await sink.flush();
      await sink.close();
      sink = null;

      await part.rename(destPath);
      part = null;
    } on ApiException {
      rethrow;
    } catch (e) {
      throw _networkError(e);
    } finally {
      try {
        await sink?.close();
      } catch (_) {}
      // 失败时清掉半截文件，免得下次被当成"已下载"
      if (part != null) {
        try {
          if (await part.exists()) await part.delete();
        } catch (_) {}
      }
      client.close(force: true);
    }
  }

  Future<HttpClientRequest> _open(HttpClient client, HttpRequest req) async {
    final r = await client.openUrl(req.method, req.uri).timeout(timeout);
    r.followRedirects = req.followRedirects;
    if (!req.followRedirects) r.maxRedirects = 0;
    // 显式转发每个头。别写成 `req.headers.forEach(r.headers.set)`：
    // HttpHeaders.set 的 value 是 Object 且带一个具名可选参数，
    // 直接当 tear-off 传进去要依赖函数子类型规则，编译器不认就得改。
    req.headers.forEach((k, v) => r.headers.set(k, v));

    if (req.bodyStream != null) {
      if (req.contentLength != null) r.contentLength = req.contentLength!;
      await r.addStream(req.bodyStream!);
    } else if (req.body != null) {
      r.contentLength = req.body!.length;
      r.add(req.body!);
    }
    return r;
  }

  static Map<String, String> _headersOf(HttpClientResponse res) {
    final out = <String, String>{};
    res.headers.forEach((k, v) => out[k.toLowerCase()] = v.join(', '));
    return out;
  }

  static Future<Uint8List> _collect(Stream<List<int>> s) async {
    final b = BytesBuilder(copy: false);
    await for (final chunk in s) {
      b.add(chunk);
    }
    return b.takeBytes();
  }

  /// 服务端的错误响应是 JSON（`{ok:false,error:'...'}`），尽量把原文冒出来
  static String _errorTextOf(Uint8List bytes, int status) {
    final t = utf8.decode(bytes, allowMalformed: true);
    try {
      final m = jsonDecode(t);
      if (m is Map && m['error'] != null) return m['error'].toString();
    } catch (_) {}
    return t.trim().isEmpty ? 'HTTP $status' : t.trim();
  }

  static ApiException _networkError(Object e) {
    if (e is TimeoutException) return ApiException('连接超时，请检查网络或站点地址', status: 0);
    if (e is SocketException) return ApiException('连不上服务器：${e.message}', status: 0);
    if (e is HandshakeException) return ApiException('TLS 握手失败：${e.message}', status: 0);
    if (e is HttpException) return ApiException('HTTP 错误：${e.message}', status: 0);
    return ApiException('网络异常：$e', status: 0);
  }
}
