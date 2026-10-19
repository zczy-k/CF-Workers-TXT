import 'dart:async';
import 'dart:convert';
// dart:io 里也有 HttpRequest / HttpResponse（服务端那一对），会把我们自己的
// 传输层同名类型搞成 ambiguous import。这里按名字屏蔽掉，只留 File / HttpClient 等。
import 'dart:io' hide HttpRequest, HttpResponse;
import 'dart:typed_data';

import 'config.dart';
import 'errors.dart';
import 'models.dart';
import 'rate_limit.dart';
import 'session.dart';
import 'transport.dart';

/// CF-Workers-TXT 管理端 API 的类型化封装。**服务端一行都不用改。**
///
/// 拿到一个 [CfwClient] 就等于拿到了整个网盘：列目录 / 读写 / 搜索 / 分享 / 发布。
///
/// 三件它替你处理好的事：
///   1. **登录态**：自动登录、401 自动重登并重放原请求一次；
///   2. **限速**：并发闸门 + 滑动窗口（见 [RateGate]），429 时按 `Retry-After` 退避；
///   3. **CSRF**：原生客户端默认不发 `Origin`，服务端的同源校验天然放行 —— 不需要任何额外处理。
class CfwClient {
  final ServerConfig config;
  final Transport transport;
  final RateGate gate;
  final Session session;

  String? _password;

  CfwClient._(this.config, this.transport, this.gate, this.session, this._password);

  factory CfwClient({
    required ServerConfig config,
    Transport? transport,
    RateGate? gate,
    String? password,
    String? cookie,
  }) {
    final t = transport ?? IoTransport();
    return CfwClient._(
      config,
      t,
      gate ?? RateGate(),
      Session(config: config, transport: t, cookie: cookie),
      password,
    );
  }

  /// 首次登录后可在设置里改。**不持久化在 core 里**（app 侧负责安全存储）。
  set password(String? pw) => _password = pw;

  String? get password => _password;

  String? get cookie => session.cookie;

  // ============================================================ 底层收发

  Future<HttpResponse> _send(HttpRequest req) async {
    await session.ensure(password: _password);

    Future<HttpResponse> once() {
      final c = session.cookie;
      final r = c == null ? req : req.withHeaders({'Cookie': c});
      return gate.run(() => transport.send(r));
    }

    var res = await once();

    // 服务端会话过期（SESSION_DAYS 到了 / 手动退出）→ 清 Cookie 重登一次再重放。
    // 只重放一次：密码本身错了的话第二次还是 401，让它抛出去，别死循环。
    if (res.status == 401 && config.hasPassword) {
      session.clear();
      await session.ensure(password: _password);
      res = await once();
    }

    // 429：服务端会带 Retry-After，尊重它退避一次
    if (res.status == 429) {
      final raw = int.tryParse(res.header('retry-after') ?? '') ?? 5;
      // 注意别写 `wait.clamp(1, 60)`：`num.clamp` 的静态返回类型是 num，
      // 塞进 Duration(seconds:) 编译不过。宁可多写一个三元。
      final wait = raw < 1 ? 1 : (raw > 60 ? 60 : raw);
      await Future<void>.delayed(Duration(seconds: wait));
      res = await once();
    }

    return res;
  }

  /// 解 JSON + **把 `ok:false` 变成异常**。所有 ok / error / needPw 的判断只在这里做一次。
  Map<String, dynamic> _decode(HttpResponse res, {bool throwOnHttpError = true}) {
    Map<String, dynamic> data = const {};
    try {
      final v = jsonDecode(res.text);
      if (v is Map) data = v.cast<String, dynamic>();
    } catch (_) {
      if (throwOnHttpError) {
        throw ApiException('服务端返回了非 JSON 内容（HTTP ${res.status}）', status: res.status);
      }
      return data;
    }
    if (throwOnHttpError && (res.status >= 400 || data['ok'] == false)) {
      throw ApiException(
        asStr(data['error'], 'HTTP ${res.status}'),
        status: res.status,
        needPw: data['needPw'] == true,
        noPwSet: data['noPwSet'] == true,
        pwFor: data['pwFor'] == null ? null : asStr(data['pwFor']),
        retryAfter: int.tryParse(res.header('retry-after') ?? ''),
      );
    }
    return data;
  }

  Future<Map<String, dynamic>> _get(String action, [Map<String, String>? params]) async =>
      _decode(await _send(HttpRequest(method: 'GET', uri: config.api(action, params))));

  Future<Map<String, dynamic>> _post(Map<String, dynamic> body) async => _decode(await _send(
        HttpRequest(
          method: 'POST',
          uri: config.apiUri,
          headers: const {'Content-Type': 'application/json;charset=utf-8'},
          body: utf8.encode(jsonEncode(body)),
        ),
      ));

  /// 写操作（PUT/DELETE）不走 `?action=`，直接用查询参数
  Uri _q(Map<String, String?> params) => config.apiUri.replace(
        queryParameters: {
          for (final e in params.entries)
            if (e.value != null && e.value!.isNotEmpty) e.key: e.value!,
        },
      );

  // ============================================================ 探活 / 校验

  /// 建站向导用：一次请求同时验证"地址对不对"和"密码对不对"。
  ///
  /// 用 `list` 而不是别的接口，因为它是**唯一不需要 KV / 索引**的基础能力：
  /// 只要 R2 绑好了就一定有响应。
  Future<DirListing> probe() => list();

  // ============================================================ 读

  Future<DirListing> list({
    String path = '',
    int pageSize = 0,
    String? cursor,
    String sort = 'name',
    bool desc = false,
  }) async {
    final j = await _get('list', {
      'path': path,
      if (pageSize > 0) 'pageSize': '$pageSize',
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      'sort': sort,
      if (desc) 'desc': '1',
    });
    return DirListing.fromJson(j);
  }

  /// 一次拿整棵树（含每层子项数与递归体积）→ 客户端侧栏
  Future<TreeResult> treeFull() async => TreeResult.fromJson(await _get('treeFull'));

  /// 递归清单。**同步引擎的 ground truth**，也是上传前"云端有没有同名"的依据。
  Future<ManifestPage> manifest({String path = ''}) async =>
      ManifestPage.fromJson(await _get('manifest', {'path': path}));

  Future<SearchPage> search(
    String query, {
    String ftype = '',
    int limit = 60,
    int offset = 0,
  }) async {
    final j = await _get('search', {
      'q': query,
      if (ftype.isNotEmpty) 'ftype': ftype,
      'limit': '$limit',
      'offset': '$offset',
    });
    return SearchPage.fromJson(j);
  }

  Future<IdxStat> idxStat() async => IdxStat.fromJson(await _get('idxstat'));

  /// 深搜单个文件 —— 索引只留前 8K 正文，这里读全文精确验证，**带行号**。
  Future<DeepResult> deepSearch({required String path, required String query}) async =>
      DeepResult.fromJson(await _get('deepsearch', {'path': path, 'q': query}));

  /// 读文本正文。服务端已做 GBK/Big5/UTF-16 编码识别，所以拿到的永远是正常字符串。
  ///
  /// **注意服务端上限 2MB**（超了回 413）。大文件请走 [download] 落盘再用本地编辑器打开。
  Future<String> readText(String path) async {
    final res = await _send(HttpRequest(method: 'GET', uri: config.api('read', {'path': path})));
    if (res.status == 304) return '';
    if (res.status >= 400) _decode(res); // 必然抛（413 会带上服务端文案）
    return res.text;
  }

  /// 原字节 + 真实 `Content-Type`（图片 / 音视频 / PDF 预览用）
  Future<Uint8List> rawBytes(String path) async {
    final res = await _send(HttpRequest(method: 'GET', uri: config.api('raw', {'path': path})));
    if (res.status >= 400) _decode(res);
    return res.body;
  }

  /// 流式下载到文件。**服务端不支持 Range，所以这是"整包成功或从头再来"**，
  /// 中途失败会抛异常并清掉半截文件（不会留下一个看起来完整的坏文件）。
  Future<void> download(
    String path,
    String destPath, {
    void Function(int received, int? total)? onProgress,
  }) async {
    await session.ensure(password: _password);
    var req = HttpRequest(method: 'GET', uri: config.api('download', {'path': path}));
    final c = session.cookie;
    if (c != null) req = req.withHeaders({'Cookie': c});

    try {
      await gate.run(() => transport.download(req, destPath, onProgress: onProgress));
    } on ApiException catch (e) {
      if (!e.isAuth || !config.hasPassword) rethrow;
      session.clear();
      await session.ensure(password: _password);
      var retry = HttpRequest(method: 'GET', uri: config.api('download', {'path': path}));
      final c2 = session.cookie;
      if (c2 != null) retry = retry.withHeaders({'Cookie': c2});
      await gate.run(() => transport.download(retry, destPath, onProgress: onProgress));
    }
  }

  /// 打包清单（**ZIP 在客户端本地打**，服务端只有 10ms CPU 打不了 zip）
  Future<PackList> packList(String path) async =>
      PackList.fromJson(await _get('packList', {'path': path}));

  // ============================================================ 写

  /// 写整个文件（上传 / 保存文本）。**`X-File-Mtime` 一定要带**：
  /// 服务端会把它存进 `customMetadata.mtime`，`manifest` 会回传 —— 那是同步引擎
  /// 判断"文件变没变"的唯一依据。
  Future<void> writeFile(
    String path,
    List<int> bytes, {
    String? contentType,
    DateTime? mtime,
  }) async {
    final res = await _send(HttpRequest(
      method: 'PUT',
      uri: _q({'path': path}),
      headers: {
        'Content-Type': contentType ?? guessContentType(path),
        if (mtime != null) 'X-File-Mtime': '${mtime.millisecondsSinceEpoch}',
      },
      body: bytes,
    ));
    _decode(res);
  }

  /// 流式写文件（大文件走这条，避免把整份内容读进内存）
  Future<void> writeFileStream(
    String path,
    Stream<List<int>> stream, {
    required int length,
    String? contentType,
    DateTime? mtime,
  }) async {
    final res = await _send(HttpRequest(
      method: 'PUT',
      uri: _q({'path': path}),
      headers: {
        'Content-Type': contentType ?? guessContentType(path),
        if (mtime != null) 'X-File-Mtime': '${mtime.millisecondsSinceEpoch}',
      },
      bodyStream: stream,
      contentLength: length,
    ));
    _decode(res);
  }

  /// 删文件 / 删目录。受保护文件夹内的删除会抛 [ApiException] 且 `needPw == true`。
  Future<DeleteResult> delete({
    required String path,
    bool isDir = false,
    String? password,
  }) async {
    final res = await _send(HttpRequest(
      method: 'DELETE',
      uri: _q({'path': path, if (isDir) 'type': 'dir', 'password': password}),
    ));
    return DeleteResult.fromJson(_decode(res));
  }

  Future<String> mkdir({required String dir, required String name, bool isProtected = false}) async {
    final j = await _post({'action': 'mkdir', 'path': dir, 'name': name, 'protected': isProtected});
    return asStr(j['path']);
  }

  /// 改名（同目录内）。目录级改名只对管理员有效。
  Future<String> rename({
    required String path,
    required String newName,
    bool isDir = false,
  }) async {
    final j = await _post({'action': 'rename', 'path': path, 'newName': newName, 'isDir': isDir});
    return asStr(j['path']);
  }

  /// 移动（可顺便改名）。跨保护区边界时会抛 `needPw`。
  Future<String> move({
    required String path,
    required String toDir,
    String? newName,
    bool isDir = false,
    String? password,
  }) async {
    final j = await _post({
      'action': 'move',
      'path': path,
      'toDir': toDir,
      if (newName != null && newName.isNotEmpty) 'newName': newName,
      'isDir': isDir,
      if (password != null && password.isNotEmpty) 'password': password,
    });
    return asStr(j['path']);
  }

  Future<BatchResult> deleteBatch(
    List<Map<String, dynamic>> items, {
    String? password,
  }) async =>
      BatchResult.fromJson(await _post({
        'action': 'deleteBatch',
        'items': items,
        if (password != null && password.isNotEmpty) 'password': password,
      }));

  Future<BatchResult> moveBatch(
    List<Map<String, dynamic>> items,
    String toDir, {
    String? password,
  }) async =>
      BatchResult.fromJson(await _post({
        'action': 'moveBatch',
        'items': items,
        'toDir': toDir,
        if (password != null && password.isNotEmpty) 'password': password,
      }));

  /// 上锁（免密）/ 解锁（要密码）。站点没设 PASSWORD 时解锁会回 `noPwSet`。
  Future<void> setProtected({
    required String path,
    required bool isProtected,
    String? password,
  }) async =>
      _post({
        'action': 'setProtected',
        'path': path,
        'protected': isProtected,
        if (password != null && password.isNotEmpty) 'password': password,
      });

  // ============================================================ 分享 / 发布

  /// 建分享链接。**服务端建完会立刻发布当前版本**，所以链接直接可用。
  Future<CreatedShare> createShare({
    required String path,
    String? token,
    int expiresIn = 0,
  }) async =>
      CreatedShare.fromJson(await _post({
        'action': 'share',
        'path': path,
        if (token != null && token.isNotEmpty) 'token': token,
        'expiresIn': expiresIn,
      }));

  Future<List<ShareRecord>> shares() async {
    final j = await _post({'action': 'shares'});
    final list = (j['shares'] as List?) ?? const [];
    return list
        .whereType<Map>()
        .map((e) => ShareRecord.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  Future<void> unshare(String token) => _post({'action': 'unshare', 'token': token});

  Future<int> unshareAll() async => asInt((await _post({'action': 'unshareAll'}))['removed']);

  /// **发布**：把草稿树当前版本复制到影子树，分享页立刻可见。
  /// `unchanged == true` 表示内容与已发布版本一致（服务端没白拷一遍）。
  Future<PublishResult> publish({required String path, bool isDir = false}) async =>
      PublishResult.fromJson(await _post({'action': 'publish', 'path': path, 'isDir': isDir}));

  /// 查"再发布一次会不会有变化"。返回 `{path: true/false/null}`；
  /// null = 服务端判断不了（对象太多），UI 应当**保守地当成可发布**（别把按钮置灰）。
  Future<Map<String, bool?>> pubState(List<Map<String, dynamic>> items) async {
    final j = await _post({'action': 'pubState', 'items': items});
    final raw = (j['states'] as Map?)?.cast<String, dynamic>() ?? const {};
    return raw.map((k, v) => MapEntry(k, v == null ? null : asBool(v)));
  }

  /// 撤回发布：分享页暂时不可见，**草稿与链接都还在**，随时能发回来。
  Future<int> unpublish({required String path, bool isDir = false}) async =>
      asInt((await _post({'action': 'unpublish', 'path': path, 'isDir': isDir}))['removed']);

  /// 存量分享一键补发（老版本升级上来时用）
  Future<PublishAllResult> publishAll() async =>
      PublishAllResult.fromJson(await _post({'action': 'publishAll'}));

  // ============================================================ 索引

  /// 重建正文索引。服务端**每批只处理几个文件**（免费版 10ms CPU），
  /// 所以这里循环调用到 `done == true`。
  Future<void> reindexAll({
    void Function(ReindexResult last)? onBatch,
    int maxRounds = 10000,
  }) async {
    String? lastKey;
    for (var i = 0; i < maxRounds; i++) {
      final r = ReindexResult.fromJson(await _post({
        'action': 'reindex',
        if (lastKey != null && lastKey.isNotEmpty) 'lastKey': lastKey,
      }));
      onBatch?.call(r);
      if (r.done) return;
      if (r.lastKey == lastKey) return; // 服务端没前进，防死循环
      lastKey = r.lastKey;
    }
  }

  // ============================================================ 分片上传

  static const int largeFileThreshold = 8 * 1024 * 1024; // 与客户端分片大小一致
  static const int defaultPartSize = 8 * 1024 * 1024;

  Future<MpSession> mpCreate({
    required String path,
    required int size,
    String? contentType,
    DateTime? mtime,
  }) async =>
      MpSession.fromJson(await _post({
        'action': 'mpCreate',
        'path': path,
        'size': size,
        'ct': contentType ?? guessContentType(path),
        'mtime': mtime?.millisecondsSinceEpoch ?? DateTime.now().millisecondsSinceEpoch,
      }));

  /// 传一个分片。`data` 是这一片的**原始字节**（8MB）。
  Future<void> mpPart(String uploadId, int partNumber, List<int> data) async {
    final res = await _send(HttpRequest(
      method: 'POST',
      uri: _q({'action': 'mpPart', 'uploadId': uploadId, 'part': '$partNumber'}),
      headers: const {'Content-Type': 'application/octet-stream'},
      body: data,
    ));
    _decode(res);
  }

  Future<void> mpComplete(String uploadId) async => _post({'action': 'mpComplete', 'uploadId': uploadId});

  Future<void> mpAbort(String uploadId) => _post({'action': 'mpAbort', 'uploadId': uploadId});

  /// 未完成的分片上传（服务端存在 KV 里）→ **刷新 / 换设备后仍可续传**。
  Future<List<MpSessionInfo>> mpList() async {
    final j = await _post({'action': 'mpList'});
    final list = (j['sessions'] as List?) ?? const [];
    return list
        .whereType<Map>()
        .map((e) => MpSessionInfo.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  /// 上传一个本地文件：**小文件走 PUT，大文件自动走分片**。
  ///
  /// 分片这条支持续传：如果服务端已有同名未完成会话（[mpList] 能查到），
  /// 传 [resumeUploadId] 即可跳过已传分片。
  Future<void> uploadFile(
    String remotePath,
    File file, {
    void Function(int sent, int? total)? onProgress,
    int partConcurrency = 3,
    bool resume = true,
  }) async {
    final stat = await file.stat();
    final size = stat.size;
    final ct = guessContentType(remotePath);
    final mtime = stat.modified;

    if (size <= largeFileThreshold) {
      onProgress?.call(0, size);
      await writeFileStream(
        remotePath,
        file.openRead(),
        length: size,
        contentType: ct,
        mtime: mtime,
      );
      onProgress?.call(size, size);
      return;
    }

    // ---- 大文件：分片 ----
    String? uploadId;
    final done = <int>{};
    if (resume) {
      try {
        final sessions = await mpList();
        for (final s in sessions) {
          if (s.path == remotePath && s.size == size) {
            uploadId = s.uploadId;
            done.addAll(s.parts);
            break;
          }
        }
      } catch (_) {
        // KV 没绑 / 查询失败 → 老老实实重传，不影响正确性
      }
    }

    // 这里刻意写成 if/else 而不是三元：三元里那句 `uploadId == null` 依赖流分析的
    // 类型提升，换成显式分支后，`final MpSession mp` 由两个分支各自definite-assign，
    // 完全没有可争议的地方（这类细节在无法本地编译的情况下不值得冒险）。
    final MpSession mp;
    if (uploadId == null) {
      mp = await mpCreate(path: remotePath, size: size, contentType: ct, mtime: mtime);
    } else {
      mp = MpSession(uploadId: uploadId, path: remotePath, partSize: defaultPartSize);
    }

    final partSize = mp.partSize > 0 ? mp.partSize : defaultPartSize;
    final total = (size + partSize - 1) ~/ partSize;
    final missing = [
      for (var i = 1; i <= total; i++)
        if (!done.contains(i)) i,
    ];

    var sentBytes = done.length * partSize;
    onProgress?.call(sentBytes > size ? size : sentBytes, size);

    // 固定并发的工作队列 —— 传 1GB 就是 128 个分片，串着传太慢
    var cursor = 0;
    final errors = <Object>[];
    Future<void> worker() async {
      while (true) {
        if (cursor >= missing.length) return;
        final idx = missing[cursor++];
        final start = (idx - 1) * partSize;
        final end = (start + partSize > size) ? size : start + partSize;
        try {
          final bytes = await _readRange(file, start, end);
          await mpPart(mp.uploadId, idx, bytes);
          sentBytes += bytes.length;
          onProgress?.call(sentBytes > size ? size : sentBytes, size);
        } catch (e) {
          errors.add(e);
          return;
        }
      }
    }

    final n = partConcurrency < 1 ? 1 : partConcurrency;
    await Future.wait([for (var i = 0; i < n; i++) worker()]);

    if (errors.isNotEmpty) {
      // **不 abort**：已传的分片留在服务端 KV 里，下次还能续传
      final e = errors.first;
      throw e is ApiException ? e : ApiException('分片上传中断：$e', status: 0);
    }

    await mpComplete(mp.uploadId);
  }

  static Future<Uint8List> _readRange(File f, int start, int end) async {
    final raf = await f.open();
    try {
      await raf.setPosition(start);
      return await raf.read(end - start);
    } finally {
      await raf.close();
    }
  }
}

/// 按扩展名猜 Content-Type。上传图片 / 视频时要给对，否则预览会坏
/// （服务端存的就是这个值，`raw` 直接吐出来；`read` 那条会强制 text/plain）。
String guessContentType(String path) {
  final i = path.lastIndexOf('.');
  if (i <= 0) return 'application/octet-stream';
  final ext = path.substring(i + 1).toLowerCase();
  return _mime[ext] ?? 'application/octet-stream';
}

const Map<String, String> _mime = {
  'txt': 'text/plain;charset=utf-8',
  'text': 'text/plain;charset=utf-8',
  'log': 'text/plain;charset=utf-8',
  'md': 'text/markdown;charset=utf-8',
  'markdown': 'text/markdown;charset=utf-8',
  'csv': 'text/csv;charset=utf-8',
  'tsv': 'text/tab-separated-values;charset=utf-8',
  'json': 'application/json;charset=utf-8',
  'jsonl': 'application/x-ndjson;charset=utf-8',
  'xml': 'application/xml;charset=utf-8',
  'yaml': 'text/yaml;charset=utf-8',
  'yml': 'text/yaml;charset=utf-8',
  'toml': 'text/plain;charset=utf-8',
  'ini': 'text/plain;charset=utf-8',
  'html': 'text/html;charset=utf-8',
  'htm': 'text/html;charset=utf-8',
  'css': 'text/css;charset=utf-8',
  'js': 'text/javascript;charset=utf-8',
  'ts': 'text/plain;charset=utf-8',
  'py': 'text/x-python;charset=utf-8',
  'sh': 'text/x-shellscript;charset=utf-8',
  'sql': 'text/plain;charset=utf-8',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'avif': 'image/avif',
  'bmp': 'image/bmp',
  'ico': 'image/x-icon',
  'svg': 'image/svg+xml',
  'pdf': 'application/pdf',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'wav': 'audio/wav',
  'flac': 'audio/flac',
  'ogg': 'audio/ogg',
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  'mkv': 'video/x-matroska',
  'zip': 'application/zip',
  'gz': 'application/gzip',
  'tar': 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
