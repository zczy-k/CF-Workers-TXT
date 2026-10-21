import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:webshell_core/webshell_core.dart';

import 'state.dart';

/// Android 下载通知（进度 / 完成 / 失败）+ 下载期间前台保活。
///
/// 原生侧由 CI 注入（`shell/tools/patch_platform.py` 的 `notify` 子命令）：
/// `MethodChannel("webshell/download_notify")` → `DownloadService`（前台服务，
/// 单一通知槽）。Dart 这边只做三件事：监听 [ShellState]、把所有任务聚合成
/// 一条通知、节流推送（下载状态机每 200ms 广播一次，直接转发会把 Binder 打爆）。
///
/// 设计取舍：
/// * **聚合而非逐任务通知**：多任务并行时用户要的是"总体还剩多少"，
///   一条槽位足够，也省得通知栏被刷屏；
/// * **零新依赖**：不加 flutter_local_notifications 之类的插件 —— 那玩意
///   带一串传递依赖，AGP / Gradle 升级时两头翻车，而平台 API 完全够用；
/// * **其他平台 no-op**：[attach] 里判一次 `Platform.isAndroid`，调用方
///   （main.dart）不需要写任何平台分支。
class DownloadNotifier {
  DownloadNotifier._();

  static final DownloadNotifier instance = DownloadNotifier._();

  static const MethodChannel _channel = MethodChannel('webshell/download_notify');

  /// 进度节流窗口：200ms 的状态广播 → 400ms 的通知更新。
  static const Duration _throttle = Duration(milliseconds: 400);

  ShellState? _state;

  /// 上次快照里各任务的状态 —— 用来判"这一轮谁刚到终态"。
  final Map<String, DownloadStatus> _prev = <String, DownloadStatus>{};

  /// 上次快照的活跃任务数 —— 数量变了（新增/完成）立刻推，不等节流窗口。
  int _prevActiveCount = 0;

  /// 是否已发过进度通知 —— 决定"全部停下"时要不要发终态通知。
  bool _pushed = false;

  /// 是否已请求过 Android 13+ 的通知权限（每次冷启动问一次就够）。
  bool _askedPermission = false;

  Timer? _timer;

  /// 挂到状态流上。只在 Android 生效，其他平台直接返回。
  void attach(ShellState state) {
    if (!Platform.isAndroid) return;
    _state = state;
    state.addListener(_onChange);
  }

  void _onChange() {
    final ShellState? state = _state;
    if (state == null) return;
    final List<DownloadTask> tasks = state.downloads.tasks;

    final List<DownloadTask> active =
        tasks.where((DownloadTask t) => t.isActive).toList();
    final List<DownloadTask> finishedNow = tasks
        .where((DownloadTask t) => t.isFinished && _prev[t.id] != t.status)
        .toList();

    // 第一个下载开跑时顺口要一下通知权限（Android 13+；低版本原生侧自己判）。
    if (active.isNotEmpty && !_askedPermission) {
      _askedPermission = true;
      _invoke('permission');
    }

    if (active.isEmpty) {
      // 活跃清零：撤销节流，通知转终态、前台服务退出。
      if (_pushed) {
        _pushed = false;
        _timer?.cancel();
        _timer = null;
        _sendDone(finishedNow, tasks);
      }
    } else {
      final bool immediate =
          finishedNow.isNotEmpty || active.length != _prevActiveCount;
      _schedule(active, immediate: immediate);
    }

    for (final DownloadTask t in tasks) {
      _prev[t.id] = t.status;
    }
    _prevActiveCount = active.length;
  }

  void _schedule(List<DownloadTask> active, {required bool immediate}) {
    _pushed = true;
    if (immediate) {
      _timer?.cancel();
      _timer = null;
      _push(active);
      return;
    }
    _timer ??= Timer(_throttle, () {
      _timer = null;
      _push(active);
    });
  }

  void _push(List<DownloadTask> active) {
    if (active.length == 1) {
      final DownloadTask t = active.first;
      final int? total = t.total;
      final int progress = (total != null && total > 0)
          ? (t.received * 100 / total).round()
          : -1; // -1 = 原生侧转圈（未知大小）
      _invoke('progress', <String, Object?>{
        'title': t.fileName,
        'text': total != null && total > 0
            ? '${(t.received * 100 / total).toStringAsFixed(0)}% · ${t.displaySize}'
            : t.displaySize,
        'progress': progress,
      });
      return;
    }
    // 多任务并行：汇总成一条"总进度"。
    int received = 0;
    int? total;
    for (final DownloadTask t in active) {
      received += t.received;
      final int? tt = t.total;
      if (tt == null || tt <= 0) {
        total = null; // 有一个未知大小就整体转圈，别给假进度
        break;
      }
      total = (total ?? 0) + tt;
    }
    final int progress =
        (total != null && total > 0) ? (received * 100 / total).round() : -1;
    _invoke('progress', <String, Object?>{
      'title': '正在下载 ${active.length} 个文件',
      'text': total != null && total > 0
          ? '${(received * 100 / total).toStringAsFixed(0)}% · ${humanBytes(received)} / ${humanBytes(total)}'
          : humanBytes(received),
      'progress': progress,
    });
  }

  void _sendDone(List<DownloadTask> finishedNow, List<DownloadTask> all) {
    String title;
    String text;
    if (finishedNow.isEmpty) {
      // 没有新终态却清零了活跃：全是暂停。通知收掉，服务退出。
      title = '下载已暂停';
      text = '可在下载管理里继续';
    } else {
      final List<DownloadTask> failed =
          finishedNow.where((DownloadTask t) => t.status == DownloadStatus.failed).toList();
      final List<DownloadTask> done =
          finishedNow.where((DownloadTask t) => t.status == DownloadStatus.done).toList();
      if (failed.isNotEmpty && done.isNotEmpty) {
        title = '下载结束（${failed.length} 个失败）';
        text = _names(finishedNow);
      } else if (failed.isNotEmpty) {
        title = '下载失败';
        text = _names(failed);
        final String? err = failed.first.error;
        if (err != null && err.isNotEmpty) text = '$text\n$err';
      } else {
        title = finishedNow.length == 1 ? '下载完成' : '下载完成（${done.length} 个）';
        text = _names(done);
      }
    }
    _invoke('done', <String, Object?>{'title': title, 'text': text});
  }

  /// 通知正文最多报两个文件名，多了就用"等 N 个文件"收口 —— 通知栏不是文件列表。
  static String _names(List<DownloadTask> tasks) {
    if (tasks.isEmpty) return '';
    if (tasks.length == 1) return tasks.first.fileName;
    if (tasks.length == 2) {
      return '${tasks[0].fileName}、${tasks[1].fileName}';
    }
    return '${tasks[0].fileName} 等 ${tasks.length} 个文件';
  }

  void _invoke(String method, [Map<String, Object?>? args]) {
    // 通道不在（测试环境 / 原生注入失败）时不许炸主流程 —— 通知是增强，不是命脉。
    _channel.invokeMethod(method, args).catchError((Object _) {});
  }
}
