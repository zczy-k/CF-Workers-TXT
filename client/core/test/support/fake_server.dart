import 'dart:convert';
// 只取 File：dart:io 的 HttpRequest / HttpResponse 会和 core 里的同名类型冲突
import 'dart:io' show File;
import 'dart:typed_data';

import 'package:cfwtxt_core/cfwtxt_core.dart';

/// 一个**内存版服务端**，照着 worker.js 的真实响应形状实现。
///
/// 思路和这个仓库自己的 `.workbuddy/tests/mock.mjs` 一致：不做"打桩返回固定 JSON"，
/// 而是**照着真实语义回数据**（同样的字段名、同样的 409/403/401 行为）。
/// 这样测出来的是"客户端在真实服务端前面会不会错"，而不是"客户端和我的桩是否一致"。
class FakeServer implements Transport {
  /// 远端文件：相对路径 -> 内容
  final Map<String, List<int>> files = {};

  /// 远端目录（含占位语义）
  final Set<String> dirs = {};

  /// 原文件修改时间：相对路径 -> ms（等价于服务端的 customMetadata.mtime）
  final Map<String, int> mtimes = {};

  final Set<String> protectedDirs = {};

  /// 分享记录：token -> {path, kind}
  final Map<String, Map<String, String>> shares = {};

  /// 已发布（影子树）里的路径
  final Set<String> published = {};

  /// 建站密码。null = 站点没设 PASSWORD（服务端不鉴权）
  String? password;

  /// 给每个响应加的人工延迟，用来测并发闸门
  Duration latency = Duration.zero;

  /// 记录收到的每一个请求，供断言用
  final List<HttpRequest> requests = [];

  /// 固定返回 429 的次数（测退避），用一次减一次
  int inject429 = 0;

  /// 固定返回 401 的次数（测重登）
  int inject401 = 0;

  static const String _cookieValue = 'fake-session-token';

  @override
  Future<HttpResponse> send(HttpRequest req) async {
    requests.add(req);
    if (latency > Duration.zero) await Future<void>.delayed(latency);

    if (inject429 > 0) {
      inject429--;
      return _json({'ok': false, 'error': '请求过于频繁'}, 429, {'Retry-After': '0'});
    }
    if (inject401 > 0) {
      inject401--;
      return _json({'ok': false, 'error': '登录已过期'}, 401);
    }

    final segs = req.uri.pathSegments.where((s) => s.isNotEmpty).toList();
    if (segs.isEmpty) return _json({'ok': false, 'error': 'bad path'}, 404);

    final isApi = segs.length >= 2 && segs[1] == 'api';

    // ---- 登录 ----
    if (!isApi && req.method == 'POST' && req.uri.queryParameters['action'] == 'login') {
      final body = utf8.decode(req.body ?? const []);
      final pass = Uri.splitQueryString(body)['password'] ?? '';
      if (password != null && pass != password) {
        return _json({'ok': false, 'error': '密码错误'}, 401);
      }
      return HttpResponse(
        status: 302,
        headers: {
          'location': '/${segs[0]}',
          'set-cookie': 'wbauth=$_cookieValue; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000',
        },
        body: Uint8List(0),
      );
    }

    // ---- 鉴权（与 worker.js 一致：只在设了 PASSWORD 时校验）----
    if (password != null) {
      final c = req.header('cookie') ?? '';
      if (!c.contains('wbauth=$_cookieValue')) {
        return isApi ? _json({'ok': false, 'error': '登录已过期，请刷新页面重新登录'}, 401) : _json({}, 401);
      }
    }

    if (!isApi) return _json({'ok': false, 'error': 'not found'}, 404);

    switch (req.method) {
      case 'GET':
        return _get(req);
      case 'PUT':
        return _put(req);
      case 'DELETE':
        return _delete(req);
      case 'POST':
        return _post(req);
      default:
        return _json({'ok': false, 'error': '未知方法'}, 405);
    }
  }

  // ------------------------------------------------------------ GET

  Future<HttpResponse> _get(HttpRequest req) async {
    final q = req.uri.queryParameters;
    final action = q['action'] ?? 'list';
    final path = _norm(q['path'] ?? '');

    switch (action) {
      case 'list':
        final folders = _childDirs(path);
        final names = _childFiles(path)..sort();
        return _json({
          'ok': true,
          'path': path,
          'folders': folders,
          'files': [
            for (final n in names)
              {
                'name': n,
                'size': files[_join(path, n)]!.length,
                'ct': (n.endsWith('.txt') || n.endsWith('.md'))
                    ? 'text/plain;charset=utf-8'
                    : 'application/octet-stream',
                'mtime': DateTime.fromMillisecondsSinceEpoch(
                        mtimes[_join(path, n)] ?? 0)
                    .toUtc()
                    .toIso8601String(),
              }
          ],
          'total': folders.length + names.length,
          'sort': 'name',
          'desc': false,
        });

      case 'manifest':
        final pre = path.isEmpty ? '' : '$path/';
        final entries = <Map<String, dynamic>>[
          for (final e in files.entries)
            if (e.key.startsWith(pre) || pre.isEmpty)
              {
                'p': e.key,
                's': e.value.length,
                'm': mtimes[e.key] ?? 0,
                't': 0,
              }
        ];
        return _json({'ok': true, 'path': path, 'entries': entries, 'truncated': false});

      case 'read':
        final b = files[path];
        if (b == null) return _json({'ok': false, 'error': '文件不存在'}, 404);
        if (b.length > 2 * 1024 * 1024) {
          return _json({'ok': false, 'error': '文件超过 2MB，请下载后用本地编辑器打开'}, 413);
        }
        return HttpResponse(
          status: 200,
          headers: {'content-type': 'text/plain;charset=utf-8', 'etag': '"e-$path"'},
          body: Uint8List.fromList(b),
        );

      case 'download':
      case 'raw':
        final b = files[path];
        if (b == null) return _json({'ok': false, 'error': '文件不存在'}, 404);
        return HttpResponse(
          status: 200,
          headers: {'content-type': 'application/octet-stream', 'content-length': '${b.length}'},
          body: Uint8List.fromList(b),
        );

      case 'search':
        final term = (q['q'] ?? '').toLowerCase();
        final hits = <Map<String, dynamic>>[];
        for (final e in files.entries) {
          if (term.isEmpty || e.key.toLowerCase().contains(term)) {
            hits.add({
              'path': e.key,
              'size': e.value.length,
              'ct': '',
              'mtime': '',
              'nameHit': true,
              'pathHit': false,
              'cnt': 0,
              'cut': 2,
            });
          }
        }
        return _json({
          'ok': true,
          'results': hits,
          'total': hits.length,
          'offset': 0,
          'limit': 60,
          'hasMore': false,
          'nameHits': hits.length,
          'pathHits': 0,
          'dirHits': 0,
          'textHits': 0,
          'cutHits': 0,
        });

      case 'treeFull':
        return _json({
          'ok': true,
          'tree': {'n': '根目录', 'p': '', 'd': [], 'f': [], 'c': 0, 'z': 0, 'x': 0, 'pr': 0},
          'nodes': 0,
          'truncated': false,
          'protected': protectedDirs.toList(),
        });

      case 'packList':
        final pre = path.isEmpty ? '' : '$path/';
        final list = [
          for (final e in files.entries)
            if (pre.isEmpty || e.key.startsWith(pre)) {'p': e.key, 's': e.value.length}
        ];
        return _json({
          'ok': true,
          'dir': path,
          'isFile': files.containsKey(path),
          'files': list,
          'dirs': <String>[],
          'truncated': false,
          'count': list.length,
          'bytes': list.fold<int>(0, (a, b) => a + (b['s'] as int)),
        });

      case 'idxstat':
        return _json({'ok': true, 'hasKv': true, 'count': files.length, 'full': files.length});

      default:
        return _json({'ok': false, 'error': '未知操作'}, 400);
    }
  }

  // ------------------------------------------------------------ PUT / DELETE

  Future<HttpResponse> _put(HttpRequest req) async {
    final path = _norm(req.uri.queryParameters['path'] ?? '');
    if (path.isEmpty) return _json({'ok': false, 'error': '缺少 path 参数'}, 400);
    if (dirs.contains(path)) {
      return _json({'ok': false, 'error': '该路径是文件夹，请指定具体的文件名'}, 409);
    }

    final bytes = req.body ?? await _collect(req.bodyStream);
    files[path] = bytes;

    // 服务端：记下 X-File-Mtime 供之后"是不是同一份"比对
    final mt = int.tryParse(req.header('x-file-mtime') ?? '');
    mtimes[path] = mt ?? DateTime.now().millisecondsSinceEpoch;

    // 目录占位：文件写进去后，父目录链要在（list 才认得出来）
    for (var p = _parent(path); p.isNotEmpty; p = _parent(p)) {
      dirs.add(p);
    }
    return _json({'ok': true, 'path': path});
  }

  Future<HttpResponse> _delete(HttpRequest req) async {
    final q = req.uri.queryParameters;
    final path = _norm(q['path'] ?? '');
    final isDir = q['type'] == 'dir';
    if (_isProtected(path)) {
      if (password == null || q['password'] != password) {
        return _json({'ok': false, 'needPw': true, 'error': '该路径位于受保护文件夹内，删除需要管理员密码'}, 403);
      }
    }
    var removed = 0;
    if (isDir) {
      final pre = '$path/';
      files.removeWhere((k, v) {
        final hit = k.startsWith(pre);
        if (hit) removed++;
        return hit;
      });
      dirs.removeWhere((d) => d == path || d.startsWith(pre));
    } else {
      removed = files.remove(path) == null ? 0 : 1;
    }
    return _json({'ok': true, 'removed': removed, 'shares': 0});
  }

  // ------------------------------------------------------------ POST

  Future<HttpResponse> _post(HttpRequest req) async {
    // 分片上传的那个动作走 query + 原始字节，不是 JSON
    if (req.uri.queryParameters['action'] == 'mpPart') {
      final id = req.uri.queryParameters['uploadId']!;
      final n = int.parse(req.uri.queryParameters['part']!);
      final bytes = req.body ?? await _collect(req.bodyStream);
      final s = mpSessions[id];
      if (s == null) return _json({'ok': false, 'error': '上传会话已失效，请重新开始'}, 404);
      s.parts[n] = bytes;
      return _json({'ok': true, 'partNumber': n, 'etag': '"p$n"', 'size': bytes.length});
    }

    final body = jsonDecode(utf8.decode(req.body ?? const [])) as Map<String, dynamic>;
    final action = body['action'] as String? ?? '';

    switch (action) {
      case 'mkdir':
        final dir = _norm(body['path'] as String? ?? '');
        final name = body['name'] as String;
        final key = _join(dir, name);
        if (dirs.contains(key)) return _json({'ok': false, 'error': '同名文件夹已存在'}, 409);
        dirs.add(key);
        if (body['protected'] == true) protectedDirs.add(key);
        return _json({'ok': true, 'path': key, 'protected': body['protected'] == true});

      case 'rename':
        final path = _norm(body['path'] as String);
        final newName = body['newName'] as String;
        final isDir = body['isDir'] == true;
        final to = _join(_parent(path), newName);
        if (isDir) {
          final pre = '$path/';
          for (final k in files.keys.toList()) {
            if (k.startsWith(pre)) files[_join(to, k.substring(pre.length))] = files.remove(k)!;
          }
          dirs.remove(path);
          dirs.add(to);
        } else {
          files[to] = files.remove(path)!;
        }
        return _json({'ok': true, 'path': to});

      case 'move':
        final path = _norm(body['path'] as String);
        final toDir = _norm(body['toDir'] as String? ?? '');
        final isDir = body['isDir'] == true;
        final name = (body['newName'] as String?) ?? path.split('/').last;
        final to = _join(toDir, name);
        if (!toDir.isEmpty && !dirs.contains(toDir)) {
          return _json({'ok': false, 'error': '目标目录不存在'}, 404);
        }
        if (isDir) {
          final pre = '$path/';
          for (final k in files.keys.toList()) {
            if (k.startsWith(pre)) files[_join(to, k.substring(pre.length))] = files.remove(k)!;
          }
          dirs.remove(path);
          dirs.add(to);
        } else {
          files[to] = files.remove(path)!;
        }
        return _json({'ok': true, 'path': to});

      case 'deleteBatch':
        final items = (body['items'] as List).cast<Map<String, dynamic>>();
        var removed = 0;
        final failed = <String>[];
        for (final it in items) {
          final p = _norm(it['path'] as String);
          if (_isProtected(p)) {
            failed.add('$p（受保护，需要管理员密码）');
            continue;
          }
          if (it['isDir'] == true) {
            final pre = '$p/';
            final before = files.length;
            files.removeWhere((k, v) => k.startsWith(pre));
            removed += before - files.length;
          } else if (files.remove(p) != null) {
            removed++;
          }
        }
        return _json({'ok': true, 'removed': removed, 'failed': failed, 'count': items.length});

      case 'share':
        final target = _norm(body['path'] as String);
        final token = (body['token'] as String?) ?? 'tok${shares.length + 1}';
        shares[token] = {'path': target, 'kind': dirs.contains(target) ? 'dir' : 'file'};
        // 服务端建完即发布
        if (dirs.contains(target)) {
          for (final k in files.keys) {
            if (k.startsWith('$target/')) published.add(k);
          }
        } else {
          published.add(target);
        }
        return _json({
          'ok': true,
          'token': token,
          'path': target,
          'kind': shares[token]!['kind'],
          'exp': 0,
          'published': 1,
          'publishError': '',
          'url': 'https://x.workers.dev/s/$token',
          'urlNoName': 'https://x.workers.dev/s/$token',
        });

      case 'shares':
        return _json({
          'ok': true,
          'shares': [
            for (final e in shares.entries)
              {
                'token': e.key,
                'path': e.value['path'],
                'kind': e.value['kind'],
                'at': 0,
                'exp': 0,
                // 目录分享的"已发布"要看影子树里有没有它的内容，
                // 不能拿目录路径本身去 contains（published 里存的是文件路径）
                'published': e.value['kind'] == 'dir'
                    ? published.any((k) => k.startsWith('${e.value['path']}/'))
                    : published.contains(e.value['path']),
              }
          ],
          'origin': 'https://x.workers.dev',
        });

      case 'publish':
        final p = _norm(body['path'] as String);
        final isDir = body['isDir'] == true;
        if (isDir) {
          for (final k in files.keys) {
            if (k.startsWith('$p/')) published.add(k);
          }
        } else {
          published.add(p);
        }
        return _json({'ok': true, 'published': 1, 'path': p, 'isDir': isDir});

      case 'unpublish':
        final p = _norm(body['path'] as String);
        published.removeWhere((k) => k == p || k.startsWith('$p/'));
        return _json({'ok': true, 'removed': 1, 'path': p});

      case 'pubState':
        final items = (body['items'] as List).cast<Map<String, dynamic>>();
        return _json({
          'ok': true,
          'states': {
            for (final it in items) _norm(it['path'] as String): published.contains(it['path'])
          },
        });

      case 'mpCreate':
        final path = _norm(body['path'] as String);
        final id = 'mp${mpSessions.length + 1}';
        mpSessions[id] = _MpUpload(
          path: path,
          size: body['size'] as int? ?? 0,
          partSize: 8 * 1024 * 1024,
          mtime: body['mtime'] as int? ?? 0,
        );
        return _json({'ok': true, 'uploadId': id, 'path': path, 'partSize': 8 * 1024 * 1024});

      case 'mpComplete':
        final id = body['uploadId'] as String;
        final s = mpSessions.remove(id);
        if (s == null) return _json({'ok': false, 'error': '上传会话已失效，请重新开始'}, 404);
        final nums = s.parts.keys.toList()..sort();
        final all = <int>[];
        for (final n in nums) {
          all.addAll(s.parts[n]!);
        }
        files[s.path] = all;
        mtimes[s.path] = s.mtime > 0 ? s.mtime : DateTime.now().millisecondsSinceEpoch;
        return _json({'ok': true, 'path': s.path, 'size': all.length, 'parts': nums.length});

      case 'mpAbort':
        mpSessions.remove(body['uploadId'] as String);
        return _json({'ok': true});

      case 'mpList':
        return _json({
          'ok': true,
          'sessions': [
            for (final e in mpSessions.entries)
              {
                'uploadId': e.key,
                'path': e.value.path,
                'size': e.value.size,
                'parts': e.value.parts.keys.toList()..sort(),
                'totalParts': ((e.value.size + e.value.partSize - 1) ~/ e.value.partSize),
              }
          ],
        });

      default:
        return _json({'ok': false, 'error': '未知操作'}, 400);
    }
  }

  /// 未完成的分片上传会话（对应服务端 KV 里的 `mp:<id>`）
  final Map<String, _MpUpload> mpSessions = {};

  // ------------------------------------------------------------ 辅助

  bool _isProtected(String path) {
    for (final d in protectedDirs) {
      if (path == d || path.startsWith('$d/')) return true;
    }
    return false;
  }

  List<String> _childDirs(String path) {
    final pre = path.isEmpty ? '' : '$path/';
    final out = <String>{};
    for (final d in dirs) {
      if (!d.startsWith(pre) || d == path) continue;
      final rest = d.substring(pre.length);
      if (rest.isEmpty || rest.contains('/')) continue;
      out.add(rest);
    }
    // 只靠 dirs 记录可能漏（比如直接 put 文件时补的父目录链），从文件路径再推一遍
    for (final k in files.keys) {
      if (!k.startsWith(pre)) continue;
      final rest = k.substring(pre.length);
      final i = rest.indexOf('/');
      if (i > 0) out.add(rest.substring(0, i));
    }
    final l = out.toList()..sort();
    return l;
  }

  List<String> _childFiles(String path) {
    final pre = path.isEmpty ? '' : '$path/';
    return [
      for (final k in files.keys)
        if (k.startsWith(pre) && !k.substring(pre.length).contains('/')) k.substring(pre.length)
    ];
  }

  static String _norm(String p) =>
      p.replaceAll('\\', '/').split('/').where((s) => s.isNotEmpty && s != '.').join('/');

  static String _join(String a, String b) => a.isEmpty ? b : '$a/$b';

  static String _parent(String p) {
    final i = p.lastIndexOf('/');
    return i < 0 ? '' : p.substring(0, i);
  }

  static Future<List<int>> _collect(Stream<List<int>>? s) async {
    if (s == null) return const [];
    final out = <int>[];
    await for (final c in s) {
      out.addAll(c);
    }
    return out;
  }

  /// 头键**必须一律小写** —— 真实传输层（`IoTransport._headersOf`）就是这么做的，
  /// 客户端也统一按小写取头。桩这里不一致，测试就会在"现实中本来会通过"的地方变红。
  static HttpResponse _json(Map<String, dynamic> body, [int status = 200, Map<String, String>? extra]) =>
      HttpResponse(
        status: status,
        headers: {
          'content-type': 'application/json;charset=utf-8',
          for (final e in (extra ?? const {}).entries) e.key.toLowerCase(): e.value,
        },
        body: Uint8List.fromList(utf8.encode(jsonEncode(body))),
      );

  @override
  Future<void> download(
    HttpRequest req,
    String destPath, {
    void Function(int received, int? total)? onProgress,
  }) async {
    final res = await send(req);
    if (res.status != 200) {
      throw ApiException('HTTP ${res.status}', status: res.status);
    }
    final f = File(destPath);
    await f.parent.create(recursive: true);
    await f.writeAsBytes(res.body);
    onProgress?.call(res.body.length, res.body.length);
  }
}

class _MpUpload {
  final String path;
  final int size;
  final int partSize;
  final int mtime;
  final Map<int, List<int>> parts = {};

  _MpUpload({required this.path, required this.size, required this.partSize, required this.mtime});
}
