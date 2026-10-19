/// 服务端响应的类型化模型。
///
/// 一条硬规矩：**解析失败一律退化成空 / 默认值，绝不抛异常**。
/// 服务端是"边用边加字段"的（`unchanged` / `synced` / `capFull` 都是后来补的），
/// 客户端不该因为多了一个 / 少了一个字段就打不开网盘。
library;

int asInt(Object? v, [int d = 0]) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? d;
  return d;
}

String asStr(Object? v, [String d = '']) => v == null ? d : '$v';

bool asBool(Object? v) => v == true || v == 1 || v == '1' || v == 'true';

DateTime? asTime(Object? v) {
  if (v is DateTime) return v;
  if (v is num) {
    final ms = v.toInt();
    return ms <= 0 ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v);
  return null;
}

// ------------------------------------------------------------------ 目录

/// `list` 里的一个文件
class RemoteFile {
  final String name;
  final int size;
  final String contentType;
  final DateTime? mtime;

  const RemoteFile({
    required this.name,
    this.size = 0,
    this.contentType = '',
    this.mtime,
  });

  factory RemoteFile.fromJson(Map<String, dynamic> j) => RemoteFile(
        name: asStr(j['name']),
        size: asInt(j['size']),
        contentType: asStr(j['ct']),
        mtime: asTime(j['mtime']),
      );

  bool get isTexty =>
      contentType.startsWith('text/') || contentType.contains('json') || contentType.contains('xml');
}

/// `list` 的结果：文件夹永远在最前并按名称排（服务端保证）
class DirListing {
  final String path;
  final List<String> folders;
  final List<RemoteFile> files;
  final bool more;
  final String? cursor;
  final int total;
  final String sort;
  final bool desc;
  final int pageSize;

  const DirListing({
    required this.path,
    this.folders = const [],
    this.files = const [],
    this.more = false,
    this.cursor,
    this.total = 0,
    this.sort = 'name',
    this.desc = false,
    this.pageSize = 0,
  });

  factory DirListing.fromJson(Map<String, dynamic> j) => DirListing(
        path: asStr(j['path']),
        folders: (j['folders'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
        files: (j['files'] as List?)
                ?.whereType<Map>()
                .map((e) => RemoteFile.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        more: asBool(j['more']),
        cursor: j['cursor'] == null ? null : asStr(j['cursor']),
        total: asInt(j['total']),
        sort: asStr(j['sort'], 'name'),
        desc: asBool(j['desc']),
        pageSize: asInt(j['pageSize']),
      );
}

/// `treeFull` 里的一个文件（服务端用极短字段名压体积：n=名、s=体积、t=时间）
class TreeFile {
  final String name;
  final int size;
  final DateTime? mtime;

  const TreeFile({required this.name, this.size = 0, this.mtime});

  factory TreeFile.fromJson(Map<String, dynamic> j) =>
      TreeFile(name: asStr(j['n']), size: asInt(j['s']), mtime: asTime(j['t']));
}

/// `treeFull` 的一个节点：d=子目录、f=文件、c=直接子项数、z=递归体积、x=被截断的数量、pr=受保护
class TreeNode {
  final String name;
  final String path;
  final List<TreeNode> dirs;
  final List<TreeFile> files;
  final int childCount;
  final int size;
  final int extra;
  final bool isProtected;

  const TreeNode({
    required this.name,
    required this.path,
    this.dirs = const [],
    this.files = const [],
    this.childCount = 0,
    this.size = 0,
    this.extra = 0,
    this.isProtected = false,
  });

  factory TreeNode.fromJson(Map<String, dynamic> j) => TreeNode(
        name: asStr(j['n']),
        path: asStr(j['p']),
        dirs: (j['d'] as List?)
                ?.whereType<Map>()
                .map((e) => TreeNode.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        files: (j['f'] as List?)
                ?.whereType<Map>()
                .map((e) => TreeFile.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        childCount: asInt(j['c']),
        size: asInt(j['z']),
        extra: asInt(j['x']),
        isProtected: asBool(j['pr']),
      );
}

class TreeResult {
  final TreeNode tree;
  final int nodes;
  final bool truncated;
  final List<String> protectedPaths;

  const TreeResult({
    required this.tree,
    this.nodes = 0,
    this.truncated = false,
    this.protectedPaths = const [],
  });

  factory TreeResult.fromJson(Map<String, dynamic> j) => TreeResult(
        tree: TreeNode.fromJson((j['tree'] as Map?)?.cast<String, dynamic>() ?? const {}),
        nodes: asInt(j['nodes']),
        truncated: asBool(j['truncated']),
        protectedPaths:
            (j['protected'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
      );
}

/// `manifest` 里的一条：p=相对路径、s=体积、m=原文件修改时间(ms)、t=上传时间(ms)
class ManifestEntry {
  final String path;
  final int size;

  /// **原文件的修改时间**（服务端 PUT 时从 `X-File-Mtime` 存下来的）。
  /// 同步引擎判断"变没变"就靠它 + size，而不是上传时间。
  final int mtimeMs;

  /// 对象在 R2 里的上传时间，仅作展示
  final int uploadedMs;

  const ManifestEntry({
    required this.path,
    this.size = 0,
    this.mtimeMs = 0,
    this.uploadedMs = 0,
  });

  factory ManifestEntry.fromJson(Map<String, dynamic> j) => ManifestEntry(
        path: asStr(j['p']),
        size: asInt(j['s']),
        mtimeMs: asInt(j['m']),
        uploadedMs: asInt(j['t']),
      );

  bool sameAs(int size, int mtimeMs) => this.size == size && this.mtimeMs == mtimeMs;
}

class ManifestPage {
  final String path;
  final List<ManifestEntry> entries;

  /// 超过 20000 个对象时服务端会截断 —— 同步前必须如实告诉用户"清单不全"
  final bool truncated;

  const ManifestPage({required this.path, this.entries = const [], this.truncated = false});

  factory ManifestPage.fromJson(Map<String, dynamic> j) => ManifestPage(
        path: asStr(j['path']),
        entries: (j['entries'] as List?)
                ?.whereType<Map>()
                .map((e) => ManifestEntry.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        truncated: asBool(j['truncated']),
      );
}

// ------------------------------------------------------------------ 搜索

class SearchItem {
  final String path;
  final bool isDir;
  final int size;
  final String contentType;
  final DateTime? mtime;
  final bool nameHit;
  final bool pathHit;
  final bool dirHit;
  final String? snippet;
  final int count;
  final int cut;

  const SearchItem({
    required this.path,
    this.isDir = false,
    this.size = 0,
    this.contentType = '',
    this.mtime,
    this.nameHit = false,
    this.pathHit = false,
    this.dirHit = false,
    this.snippet,
    this.count = 0,
    this.cut = 2,
  });

  factory SearchItem.fromJson(Map<String, dynamic> j) => SearchItem(
        path: asStr(j['path']),
        isDir: asBool(j['isDir']),
        size: asInt(j['size']),
        contentType: asStr(j['ct']),
        mtime: asTime(j['mtime']),
        nameHit: asBool(j['nameHit']),
        pathHit: asBool(j['pathHit']),
        dirHit: asBool(j['dirHit']),
        snippet: j['snippet'] == null ? null : asStr(j['snippet']),
        count: asInt(j['cnt']),
        cut: asInt(j['cut'], 2),
      );

  String get name => path.split('/').last;
}

class SearchPage {
  final List<SearchItem> results;
  final int total;
  final int offset;
  final int limit;
  final bool hasMore;
  final String ftype;
  final bool indexed;
  final int indexedCount;
  final int stale;
  final int nameHits;
  final int pathHits;
  final int dirHits;
  final int textHits;
  final int cutHits;
  final bool capFull;

  const SearchPage({
    this.results = const [],
    this.total = 0,
    this.offset = 0,
    this.limit = 60,
    this.hasMore = false,
    this.ftype = '',
    this.indexed = false,
    this.indexedCount = 0,
    this.stale = 0,
    this.nameHits = 0,
    this.pathHits = 0,
    this.dirHits = 0,
    this.textHits = 0,
    this.cutHits = 0,
    this.capFull = false,
  });

  factory SearchPage.fromJson(Map<String, dynamic> j) => SearchPage(
        results: (j['results'] as List?)
                ?.whereType<Map>()
                .map((e) => SearchItem.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        total: asInt(j['total']),
        offset: asInt(j['offset']),
        limit: asInt(j['limit'], 60),
        hasMore: asBool(j['hasMore']),
        ftype: asStr(j['ftype']),
        indexed: asBool(j['indexed']),
        indexedCount: asInt(j['indexedCount']),
        stale: asInt(j['stale']),
        nameHits: asInt(j['nameHits']),
        pathHits: asInt(j['pathHits']),
        dirHits: asInt(j['dirHits']),
        textHits: asInt(j['textHits']),
        cutHits: asInt(j['cutHits']),
        capFull: asBool(j['capFull']),
      );
}

class IdxStat {
  final bool hasKv;
  final int count;
  final int full;
  final int part;
  final int none;
  final DateTime? at;
  final int textCap;

  const IdxStat({
    this.hasKv = false,
    this.count = 0,
    this.full = 0,
    this.part = 0,
    this.none = 0,
    this.at,
    this.textCap = 0,
  });

  factory IdxStat.fromJson(Map<String, dynamic> j) => IdxStat(
        hasKv: asBool(j['hasKv']),
        count: asInt(j['count']),
        full: asInt(j['full']),
        part: asInt(j['part']),
        none: asInt(j['none']),
        at: asTime(j['at']),
        textCap: asInt(j['textCap']),
      );
}

/// 深搜命中：n=行号、c=该行出现次数、t=以命中为中心的片段
class DeepHit {
  final int line;
  final int count;
  final String? text;

  const DeepHit({required this.line, this.count = 0, this.text});

  factory DeepHit.fromJson(Map<String, dynamic> j) =>
      DeepHit(line: asInt(j['n']), count: asInt(j['c']), text: j['t'] == null ? null : asStr(j['t']));
}

class DeepResult {
  final String path;
  final bool found;
  final int count;

  /// 同时含**全部**关键词的行数
  final int lines;
  final bool approx;
  final List<String> terms;
  final String encoding;
  final int size;
  final List<DeepHit> hits;
  final bool hitsMore;
  final String? snippet;

  const DeepResult({
    required this.path,
    this.found = false,
    this.count = 0,
    this.lines = 0,
    this.approx = false,
    this.terms = const [],
    this.encoding = '',
    this.size = 0,
    this.hits = const [],
    this.hitsMore = false,
    this.snippet,
  });

  factory DeepResult.fromJson(Map<String, dynamic> j) => DeepResult(
        path: asStr(j['path']),
        found: asBool(j['found']),
        count: asInt(j['count']),
        lines: asInt(j['lines']),
        approx: asBool(j['approx']),
        terms: (j['terms'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
        encoding: asStr(j['enc']),
        size: asInt(j['size']),
        hits: (j['hits'] as List?)
                ?.whereType<Map>()
                .map((e) => DeepHit.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        hitsMore: asBool(j['hitsMore']),
        snippet: j['snippet'] == null ? null : asStr(j['snippet']),
      );
}

// ------------------------------------------------------------------ 分享

class ShareRecord {
  final String token;
  final String path;
  final bool isDir;
  final DateTime? at;
  final DateTime? exp;
  final bool published;

  /// true=内容与影子树一致（再发布也不会有变化）；null=判断不了（条数多时服务端不算）
  final bool? synced;

  const ShareRecord({
    required this.token,
    required this.path,
    this.isDir = false,
    this.at,
    this.exp,
    this.published = false,
    this.synced,
  });

  factory ShareRecord.fromJson(Map<String, dynamic> j) => ShareRecord(
        token: asStr(j['token']),
        path: asStr(j['path']),
        isDir: asStr(j['kind'], 'dir') == 'dir',
        at: asTime(j['at']),
        exp: asTime(j['exp']),
        published: asBool(j['published']),
        synced: j['synced'] == null ? null : asBool(j['synced']),
      );

  bool get expired => exp != null && exp!.isBefore(DateTime.now());
}

class CreatedShare {
  final String token;
  final String path;
  final bool isDir;
  final DateTime? exp;
  final int published;
  final String publishError;
  final String url;
  final String urlNoName;

  const CreatedShare({
    required this.token,
    required this.path,
    this.isDir = false,
    this.exp,
    this.published = 0,
    this.publishError = '',
    this.url = '',
    this.urlNoName = '',
  });

  factory CreatedShare.fromJson(Map<String, dynamic> j) => CreatedShare(
        token: asStr(j['token']),
        path: asStr(j['path']),
        isDir: asStr(j['kind'], 'dir') == 'dir',
        exp: asTime(j['exp']),
        published: asInt(j['published']),
        publishError: asStr(j['publishError']),
        url: asStr(j['url']),
        urlNoName: asStr(j['urlNoName']),
      );
}

class PublishResult {
  final int published;
  final bool unchanged;
  final String path;
  final bool isDir;

  const PublishResult({
    this.published = 0,
    this.unchanged = false,
    this.path = '',
    this.isDir = false,
  });

  factory PublishResult.fromJson(Map<String, dynamic> j) => PublishResult(
        published: asInt(j['published']),
        unchanged: asBool(j['unchanged']),
        path: asStr(j['path']),
        isDir: asBool(j['isDir']),
      );
}

class PublishAllResult {
  final int published;
  final int objects;
  final int skipped;
  final List<String> failed;
  final int count;

  const PublishAllResult({
    this.published = 0,
    this.objects = 0,
    this.skipped = 0,
    this.failed = const [],
    this.count = 0,
  });

  factory PublishAllResult.fromJson(Map<String, dynamic> j) => PublishAllResult(
        published: asInt(j['published']),
        objects: asInt(j['objects']),
        skipped: asInt(j['skipped']),
        failed: (j['failed'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
        count: asInt(j['count']),
      );
}

// ------------------------------------------------------------------ 批量 / 打包

class BatchResult {
  final int removed;
  final int moved;
  final int shares;
  final List<String> failed;
  final bool needPw;
  final bool noPwSet;
  final int count;

  const BatchResult({
    this.removed = 0,
    this.moved = 0,
    this.shares = 0,
    this.failed = const [],
    this.needPw = false,
    this.noPwSet = false,
    this.count = 0,
  });

  factory BatchResult.fromJson(Map<String, dynamic> j) => BatchResult(
        removed: asInt(j['removed']),
        moved: asInt(j['moved']),
        shares: asInt(j['shares']),
        failed: (j['failed'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
        needPw: asBool(j['needPw']),
        noPwSet: asBool(j['noPwSet']),
        count: asInt(j['count']),
      );
}

class PackFile {
  final String path;
  final int size;

  const PackFile({required this.path, this.size = 0});

  factory PackFile.fromJson(Map<String, dynamic> j) =>
      PackFile(path: asStr(j['p']), size: asInt(j['s']));
}

/// 打包清单。**ZIP 在客户端本地打**（服务端只有 10ms CPU，打不了 zip）。
class PackList {
  final String dir;
  final bool isFile;
  final List<PackFile> files;
  final List<String> dirs;
  final bool truncated;
  final int count;
  final int bytes;
  final int maxFiles;
  final int maxBytes;

  const PackList({
    this.dir = '',
    this.isFile = false,
    this.files = const [],
    this.dirs = const [],
    this.truncated = false,
    this.count = 0,
    this.bytes = 0,
    this.maxFiles = 300,
    this.maxBytes = 0,
  });

  factory PackList.fromJson(Map<String, dynamic> j) => PackList(
        dir: asStr(j['dir']),
        isFile: asBool(j['isFile']),
        files: (j['files'] as List?)
                ?.whereType<Map>()
                .map((e) => PackFile.fromJson(e.cast<String, dynamic>()))
                .toList() ??
            const [],
        dirs: (j['dirs'] as List?)?.map((e) => asStr(e)).toList() ?? const [],
        truncated: asBool(j['truncated']),
        count: asInt(j['count']),
        bytes: asInt(j['bytes']),
        maxFiles: asInt(j['maxFiles'], 300),
        maxBytes: asInt(j['maxBytes']),
      );
}

// ------------------------------------------------------------------ 分片上传

class MpSession {
  final String uploadId;
  final String path;
  final int partSize;

  const MpSession({required this.uploadId, required this.path, this.partSize = 8388608});

  factory MpSession.fromJson(Map<String, dynamic> j) => MpSession(
        uploadId: asStr(j['uploadId']),
        path: asStr(j['path']),
        partSize: asInt(j['partSize'], 8388608),
      );
}

/// 未完成的分片上传（服务端存在 KV 里，刷新/换机后仍可续传）
class MpSessionInfo {
  final String uploadId;
  final String path;
  final int size;
  final String contentType;
  final DateTime? at;
  final List<int> parts;
  final int totalParts;

  const MpSessionInfo({
    required this.uploadId,
    required this.path,
    this.size = 0,
    this.contentType = '',
    this.at,
    this.parts = const [],
    this.totalParts = 1,
  });

  factory MpSessionInfo.fromJson(Map<String, dynamic> j) => MpSessionInfo(
        uploadId: asStr(j['uploadId']),
        path: asStr(j['path']),
        size: asInt(j['size']),
        contentType: asStr(j['ct']),
        at: asTime(j['at']),
        parts: (j['parts'] as List?)?.map((e) => asInt(e)).toList() ?? const [],
        totalParts: asInt(j['totalParts'], 1),
      );

  /// 还差哪些分片没传（配合服务端记录，续传时直接跳过）
  List<int> missingParts() {
    final have = parts.toSet();
    return [for (var i = 1; i <= totalParts; i++) if (!have.contains(i)) i];
  }
}

class ReindexResult {
  final bool done;
  final int scanned;
  final int indexed;
  final int skipped;
  final String lastKey;
  final int files;
  final int textBytes;
  final int textCap;

  const ReindexResult({
    this.done = true,
    this.scanned = 0,
    this.indexed = 0,
    this.skipped = 0,
    this.lastKey = '',
    this.files = 0,
    this.textBytes = 0,
    this.textCap = 0,
  });

  factory ReindexResult.fromJson(Map<String, dynamic> j) => ReindexResult(
        done: asBool(j['done']),
        scanned: asInt(j['scanned']),
        indexed: asInt(j['indexed']),
        skipped: asInt(j['skipped']),
        lastKey: asStr(j['lastKey']),
        files: asInt(j['files']),
        textBytes: asInt(j['textBytes']),
        textCap: asInt(j['textCap']),
      );
}

/// 删除结果（`DELETE ?path=`）
class DeleteResult {
  final int removed;
  final int shares;

  const DeleteResult({this.removed = 0, this.shares = 0});

  factory DeleteResult.fromJson(Map<String, dynamic> j) =>
      DeleteResult(removed: asInt(j['removed']), shares: asInt(j['shares']));
}
