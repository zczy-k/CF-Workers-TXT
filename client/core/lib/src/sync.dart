import 'dart:io';

import 'api.dart';
import 'errors.dart';
import 'state_store.dart';

/// 冲突处理策略。**绝不做"静默覆盖"** —— 这是个人文本盘，丢一个字用户都会恨你。
enum ConflictPolicy {
  /// 默认：本地改名留一份（`x (本机冲突 2026-10-19 1530).txt`），另一份按远端覆盖，两份都不丢
  keepBoth,

  /// 本机优先：用本地覆盖远端
  preferLocal,

  /// 远端优先：用远端覆盖本地
  preferRemote,

  /// 不动，记进冲突清单交给用户手动处理
  skip,
}

class ConflictItem {
  final String path;
  final String reason;
  final String keptAs;

  const ConflictItem(this.path, this.reason, {this.keptAs = ''});
}

/// 一次同步的结果。给 UI 展示用，**如实报数**（尤其是"被截断"和"跳过"）。
class SyncReport {
  int downloaded = 0;
  int uploaded = 0;
  int deletedLocal = 0;
  int deletedRemote = 0;
  int skipped = 0;
  int unchanged = 0;
  int bytesIn = 0;
  int bytesOut = 0;

  bool manifestTruncated = false;
  final List<ConflictItem> conflicts = [];
  final List<String> errors = [];

  String get summary {
    final b = StringBuffer();
    b.write('下载 $downloaded / 上传 $uploaded');
    if (deletedLocal > 0) b.write(' / 删除本地 $deletedLocal');
    if (deletedRemote > 0) b.write(' / 删除远端 $deletedRemote');
    if (unchanged > 0) b.write(' / 未变 $unchanged');
    if (skipped > 0) b.write(' / 跳过 $skipped');
    if (conflicts.isNotEmpty) b.write(' / ⚠️ 冲突 ${conflicts.length}');
    if (errors.isNotEmpty) b.write(' / ❌ 失败 ${errors.length}');
    return b.toString();
  }
}

/// 增量同步引擎（pull / push）。
///
/// 判据：**只比 `size + mtime`**，不比内容哈希 —— 因为服务端**没有给客户端
/// 任何内容哈希接口**（`manifest` 只回 size 和 mtime；`head` 的 etag 不对客户端开放）。
/// 想按内容比对就得改服务端，本期约束是不改。
///
/// 所有远端路径统一用 `/`（Dart 在 Windows 上接受 `/`，所以不需要平台分支）。
class SyncEngine {
  final CfwClient client;

  /// 本地根目录（同步的落地位置）
  final Directory root;

  final LocalState state;
  final ConflictPolicy policy;

  /// 单文件上限：超过就不参与同步（避免拿手机流量拉一个 2GB 的视频）
  final int maxFileBytes;

  final void Function(String message)? log;

  SyncEngine({
    required this.client,
    required this.root,
    required this.state,
    this.policy = ConflictPolicy.keepBoth,
    this.maxFileBytes = 200 * 1024 * 1024,
    this.log,
  });

  // ---------------------------------------------------------------- 工具

  File _localFile(String rel) => File('${root.path}/$rel');

  /// 远端路径安全化：拒绝绝对路径与 `..`，防止服务端的恶意/异常数据写到本地别处
  static String? safeRel(String remotePath) {
    final clean = remotePath.replaceAll('\\', '/');
    final segs = clean.split('/').where((s) => s.isNotEmpty && s != '.').toList();
    if (segs.isEmpty) return null;
    if (segs.any((s) => s == '..')) return null;
    if (clean.startsWith('/')) return null;
    if (clean.length > 2 && clean[1] == ':') return null; // Windows 盘符
    return segs.join('/');
  }

  static Future<FileStamp?> stampOf(File f) async {
    if (!await f.exists()) return null;
    final st = await f.stat();
    if (st.type != FileSystemEntityType.file) return null;
    return FileStamp(st.size, st.modified.millisecondsSinceEpoch);
  }

  /// 下载后**把本地 mtime 设成远端的 mtime** —— 这一步是必须的：
  /// 不设的话本地 mtime 是"下载那一刻"，于是下次 push 会认为"本地文件变了"，
  /// 把每个文件重传一遍（同步引擎最经典的假阳性）。
  static Future<void> adoptMtime(File f, int mtimeMs) async {
    if (mtimeMs <= 0) return;
    try {
      await f.setLastModified(DateTime.fromMillisecondsSinceEpoch(mtimeMs));
    } catch (_) {
      // 某些文件系统 / 权限下设置失败，不影响正确性，只是下次可能多传一次
    }
  }

  static String conflictName(String rel, DateTime now) {
    final slash = rel.lastIndexOf('/');
    final dir = slash >= 0 ? rel.substring(0, slash + 1) : '';
    final name = slash >= 0 ? rel.substring(slash + 1) : rel;
    final dot = name.lastIndexOf('.');
    final stem = dot > 0 ? name.substring(0, dot) : name;
    final ext = dot > 0 ? name.substring(dot) : '';
    final ts = '${now.year}-${_2(now.month)}-${_2(now.day)} ${_2(now.hour)}${_2(now.minute)}';
    return '$dir$stem (本机冲突 $ts)$ext';
  }

  static String _2(int n) => n < 10 ? '0$n' : '$n';

  /// 扫本地根目录，返回 `{相对路径: 指纹}`
  Future<Map<String, FileStamp>> scanLocal() async {
    final out = <String, FileStamp>{};
    if (!await root.exists()) return out;
    await for (final e in root.list(recursive: true, followLinks: false)) {
      if (e is! File) continue;
      final rel = e.path
          .substring(root.path.length)
          .replaceAll('\\', '/')
          .replaceFirst(RegExp(r'^/+'), '');
      if (rel.isEmpty) continue;
      // 同步状态文件自己不参与同步
      if (rel.startsWith('.cfwtxt/')) continue;
      final st = await e.stat();
      out[rel] = FileStamp(st.size, st.modified.millisecondsSinceEpoch);
    }
    return out;
  }

  Future<Map<String, FileStamp>> fetchRemoteManifest() async {
    final m = await client.manifest();
    state.manifestTruncated = m.truncated;
    final map = <String, FileStamp>{
      for (final e in m.entries) e.path: FileStamp(e.size, e.mtimeMs),
    };
    return map;
  }

  // ---------------------------------------------------------------- pull

  /// 远端 → 本地
  Future<SyncReport> pull() async {
    final report = SyncReport();
    await root.create(recursive: true);

    final remote = await fetchRemoteManifest();
    state.manifest
      ..clear()
      ..addAll(remote);
    report.manifestTruncated = state.manifestTruncated;

    final now = DateTime.now();

    for (final e in remote.entries) {
      final rel = safeRel(e.key);
      if (rel == null) {
        report.skipped++;
        continue;
      }
      final remoteStamp = e.value;
      if (remoteStamp.size > maxFileBytes) {
        report.skipped++;
        log?.call('跳过（超过单文件上限）：$rel');
        continue;
      }

      final local = _localFile(rel);
      final localStamp = await stampOf(local);
      final base = state.baseline[rel];

      final remoteChanged = base == null || !remoteStamp.sameAs(base.stamp);
      final localChanged = localStamp == null || base == null || !localStamp.sameAs(base.stamp);

      if (!remoteChanged) {
        report.unchanged++;
        continue;
      }

      if (localStamp != null && localChanged) {
        // 两边都变了 → 冲突
        switch (policy) {
          case ConflictPolicy.preferRemote:
            // 落到下面下载覆盖
            break;
          case ConflictPolicy.preferLocal:
            report.conflicts.add(ConflictItem(rel, '保留本机版本（本机优先）'));
            report.skipped++;
            continue;
          case ConflictPolicy.skip:
            report.conflicts.add(ConflictItem(rel, '两边都改过，已跳过'));
            report.skipped++;
            continue;
          case ConflictPolicy.keepBoth:
            final kept = conflictName(rel, now);
            try {
              await local.copy(_localFile(kept).path);
              await adoptMtime(_localFile(kept), localStamp.mtimeMs);
              report.conflicts
                  .add(ConflictItem(rel, '两边都改过，本机版本另存一份', keptAs: kept));
            } catch (ex) {
              report.errors.add('$rel：冲突备份失败 $ex');
              report.skipped++;
              continue;
            }
        }
      }

      try {
        await client.download(rel, local.path);
        await adoptMtime(local, remoteStamp.mtimeMs);
        final st = await stampOf(local) ?? remoteStamp;
        state.local[rel] = st;
        state.baseline[rel] = BaselineEntry(rel, st);
        report.downloaded++;
        report.bytesIn += remoteStamp.size;
      } catch (ex) {
        report.errors.add('$rel：${ex is ApiException ? ex.message : ex}');
      }
    }

    // 远端没了 → 本地删掉。只在"基线里有、而且本地没被改过"时才删，
    // 免得把用户刚写的东西跟着删了。
    for (final e in state.baseline.entries.toList()) {
      final rel = e.key;
      if (remote.containsKey(rel)) continue;
      final local = _localFile(rel);
      final localStamp = await stampOf(local);
      if (localStamp != null && !localStamp.sameAs(e.value.stamp)) {
        report.conflicts.add(ConflictItem(rel, '远端已删除，但本地已修改，保留本地'));
        continue;
      }
      try {
        if (localStamp != null) {
          await local.delete();
          report.deletedLocal++;
        }
        state.baseline.remove(rel);
        state.local.remove(rel);
      } catch (ex) {
        report.errors.add('$rel：删除本地失败 $ex');
      }
    }

    state.lastSync = DateTime.now();
    await state.save();
    return report;
  }

  // ---------------------------------------------------------------- push

  /// 本地 → 远端
  ///
  /// [deleteRemoteMissing] 默认 **false**：远端有、本地没有的文件**不动**。
  /// 打开它才是"镜像模式"（本地删了远端也删）—— 危险动作，必须在 UI 上二次确认。
  Future<SyncReport> push({bool deleteRemoteMissing = false}) async {
    final report = SyncReport();

    final remote = await fetchRemoteManifest();
    state.manifest
      ..clear()
      ..addAll(remote);
    report.manifestTruncated = state.manifestTruncated;

    final localNow = await scanLocal();
    final now = DateTime.now();

    for (final e in localNow.entries) {
      final rel = e.key;
      final localStamp = e.value;
      final base = state.baseline[rel];
      final remoteStamp = remote[rel];

      if (localStamp.size > maxFileBytes) {
        report.skipped++;
        log?.call('跳过（超过单文件上限）：$rel');
        continue;
      }

      final baseStamp = base?.stamp;
      final localChanged = baseStamp == null || !localStamp.sameAs(baseStamp);
      final remoteChanged =
          remoteStamp != null && (baseStamp == null || !remoteStamp.sameAs(baseStamp));

      if (!localChanged) {
        // 本地没动：远端还在就什么都不做。
        // （baseStamp 非空才可能走到这里，所以"远端被删了"这一支不用单独判 base）
        report.unchanged++;
        state.local[rel] = localStamp;
        continue;
      }

      if (remoteChanged) {
        // remoteChanged 为真就已经蕴含 remoteStamp 非空（见上面的表达式），这里不再重复判空
        final rs = remoteStamp;
        switch (policy) {
          case ConflictPolicy.preferRemote:
            try {
              await client.download(rel, _localFile(rel).path);
              await adoptMtime(_localFile(rel), rs.mtimeMs);
              final st = await stampOf(_localFile(rel)) ?? rs;
              state.local[rel] = st;
              state.baseline[rel] = BaselineEntry(rel, st);
              report.downloaded++;
            } catch (ex) {
              report.errors.add('$rel：${ex is ApiException ? ex.message : ex}');
            }
            report.conflicts.add(ConflictItem(rel, '两边都改过，已按远端覆盖本地'));
            continue;

          case ConflictPolicy.preferLocal:
            report.conflicts.add(ConflictItem(rel, '两边都改过，已按本机覆盖远端'));
            break; // 继续往下上传

          case ConflictPolicy.skip:
            report.conflicts.add(ConflictItem(rel, '两边都改过，已跳过'));
            report.skipped++;
            continue;

          case ConflictPolicy.keepBoth:
            final kept = conflictName(rel, now);
            try {
              await _localFile(rel).copy(_localFile(kept).path);
              report.conflicts.add(ConflictItem(rel, '两边都改过，本机版本另存一份后按远端覆盖', keptAs: kept));
            } catch (ex) {
              report.errors.add('$rel：冲突备份失败 $ex');
              report.skipped++;
              continue;
            }
            // 本机版本已另存，这一份按远端覆盖
            try {
              await client.download(rel, _localFile(rel).path);
              await adoptMtime(_localFile(rel), rs.mtimeMs);
              final st = await stampOf(_localFile(rel)) ?? rs;
              state.local[rel] = st;
              state.baseline[rel] = BaselineEntry(rel, st);
              report.downloaded++;
            } catch (ex) {
              report.errors.add('$rel：${ex is ApiException ? ex.message : ex}');
            }
            continue;
        }
      }

      // ---- 上传 ----
      try {
        final f = _localFile(rel);
        await client.uploadFile(rel, f);
        final st = await stampOf(f) ?? localStamp;
        state.local[rel] = st;
        state.baseline[rel] = BaselineEntry(rel, st);
        report.uploaded++;
        report.bytesOut += st.size;
      } catch (ex) {
        report.errors.add('$rel：${ex is ApiException ? ex.message : ex}');
      }
    }

    // 本地文件被删了 —— 只有显式要求镜像时才删远端
    for (final e in state.baseline.entries.toList()) {
      final rel = e.key;
      if (localNow.containsKey(rel)) continue;
      if (!deleteRemoteMissing) {
        state.baseline.remove(rel);
        state.local.remove(rel);
        continue;
      }
      final remoteStamp = remote[rel];
      if (remoteStamp == null) {
        state.baseline.remove(rel);
        state.local.remove(rel);
        continue;
      }
      if (!remoteStamp.sameAs(e.value.stamp)) {
        report.conflicts.add(ConflictItem(rel, '本地已删除，但远端已修改，保留远端'));
        continue;
      }
      try {
        await client.delete(path: rel);
        state.baseline.remove(rel);
        state.local.remove(rel);
        report.deletedRemote++;
      } catch (ex) {
        report.errors.add('$rel：删除远端失败 $ex');
      }
    }

    state.lastSync = DateTime.now();
    await state.save();
    return report;
  }

  /// 先拉后推。**顺序不能反**：先 pull 把远端的新内容落下来，
  /// 那些文件在 push 阶段就会因为"本地=远端"而被判定为未变，不会来回传。
  Future<SyncReport> sync({bool deleteRemoteMissing = false}) async {
    final a = await pull();
    final b = await push(deleteRemoteMissing: deleteRemoteMissing);
    return SyncReport()
      ..downloaded = a.downloaded + b.downloaded
      ..uploaded = a.uploaded + b.uploaded
      ..deletedLocal = a.deletedLocal + b.deletedLocal
      ..deletedRemote = a.deletedRemote + b.deletedRemote
      ..skipped = a.skipped + b.skipped
      ..unchanged = b.unchanged
      ..bytesIn = a.bytesIn + b.bytesIn
      ..bytesOut = a.bytesOut + b.bytesOut
      ..manifestTruncated = a.manifestTruncated || b.manifestTruncated
      ..conflicts.addAll(a.conflicts)
      ..conflicts.addAll(b.conflicts)
      ..errors.addAll(a.errors)
      ..errors.addAll(b.errors);
  }
}

