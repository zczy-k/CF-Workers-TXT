import 'dart:convert';
import 'dart:io';

import 'models.dart';

/// 一个文件的"指纹"。同步判断**只看 size + mtime**：
///
/// 服务端 PUT 时会用 `X-File-Mtime` 把头把**原文件的修改时间**存进
/// `customMetadata.mtime`，`manifest` 再把它回传。所以同一份文件往返一圈
/// mtime 不会丢 —— 这才让"内容没变就不同步"变得可靠（而不是拿"上传时间"去比，
/// 那个每传一次都会变）。
class FileStamp {
  final int size;
  final int mtimeMs;

  const FileStamp(this.size, this.mtimeMs);

  factory FileStamp.fromJson(Map<String, dynamic> j) =>
      FileStamp(asInt(j['s']), asInt(j['m']));

  Map<String, dynamic> toJson() => {'s': size, 'm': mtimeMs};

  bool sameAs(FileStamp? o) => o != null && o.size == size && o.mtimeMs == mtimeMs;

  @override
  String toString() => '$size@$mtimeMs';
}

/// 基线里的一条：本地某文件 ⇄ 远端某路径（冲突改名后两者可能不同名）
class BaselineEntry {
  final String remotePath;
  final FileStamp stamp;

  const BaselineEntry(this.remotePath, this.stamp);

  factory BaselineEntry.fromJson(Map<String, dynamic> j) => BaselineEntry(
        asStr(j['r']),
        FileStamp(asInt(j['s']), asInt(j['m'])),
      );

  Map<String, dynamic> toJson() => {'r': remotePath, 's': stamp.size, 'm': stamp.mtimeMs};
}

/// 本地状态。就一个 JSON 文件，**不引 sqflite / hive** —— 个人文本盘的量级
/// （几千个文件）用 Map 足够，引个嵌入式数据库只会让 Android 打包多一堆 so 库。
///
/// 三个表各司其职：
///   - `manifest`：上次拉到的**远端**清单（用于 push 时判断"远端变没变"）
///   - `local`   ：上次扫到的**本地**指纹（用于 push 时判断"本地变没变"）
///   - `baseline`：**上次双方一致时**的快照 —— 只有它才能区分
///                 "本地被我改了" 和 "远端被别人改了"，这是冲突检测的关键
class LocalState {
  final File file;

  final Map<String, FileStamp> manifest = {};
  final Map<String, FileStamp> local = {};
  final Map<String, BaselineEntry> baseline = {};

  /// 上次同步时间
  DateTime? lastSync;

  /// 上次拉到的远端清单是否被服务端截断（超过 20000 个对象）
  bool manifestTruncated = false;

  LocalState(this.file);

  static Future<LocalState> open(File file) async {
    final s = LocalState(file);
    await s.load();
    return s;
  }

  Future<void> load() async {
    if (!await file.exists()) return;
    try {
      final j = jsonDecode(await file.readAsString());
      if (j is! Map) return;
      final m = j.cast<String, dynamic>();

      _read(m['manifest'], manifest);
      _read(m['local'], local);

      final b = m['baseline'];
      if (b is Map) {
        for (final e in b.entries) {
          if (e.value is Map) {
            baseline[e.key.toString()] =
                BaselineEntry.fromJson((e.value as Map).cast<String, dynamic>());
          }
        }
      }
      lastSync = asTime(m['lastSync']);
      manifestTruncated = asBool(m['manifestTruncated']);
    } catch (_) {
      // 状态文件坏了就当没有 —— 重新全量比一遍，绝不会因此丢数据
      manifest.clear();
      local.clear();
      baseline.clear();
    }
  }

  Future<void> save() async {
    await file.parent.create(recursive: true);
    final j = <String, dynamic>{
      'version': 1,
      'manifest': {for (final e in manifest.entries) e.key: e.value.toJson()},
      'local': {for (final e in local.entries) e.key: e.value.toJson()},
      'baseline': {for (final e in baseline.entries) e.key: e.value.toJson()},
      'lastSync': lastSync?.millisecondsSinceEpoch,
      'manifestTruncated': manifestTruncated,
    };
    // 先写临时文件再改名：写一半被 kill 也不会留下一个坏的状态文件
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(const JsonEncoder.withIndent('  ').convert(j), flush: true);
    await tmp.rename(file.path);
  }

  void clear() {
    manifest.clear();
    local.clear();
    baseline.clear();
  }

  static void _read(Object? raw, Map<String, FileStamp> into) {
    if (raw is! Map) return;
    for (final e in raw.entries) {
      if (e.value is Map) {
        final v = (e.value as Map).cast<String, dynamic>();
        into[e.key.toString()] = FileStamp(asInt(v['s']), asInt(v['m']));
      }
    }
  }
}
