import 'dart:async';
import 'dart:collection';

/// 并发闸门 + 滑动窗口限速。
///
/// 服务端的限速是 **每 IP 每分钟 N 次**（默认 240，`RATE_LIMIT` 可调），只算 GET 类的
/// 通用请求；管理端的 PUT/POST/DELETE 不计入。但客户端做"批量下载 / 打开大目录 /
/// 同步"时，恰恰是**一堆 GET**砸过去，很容易撞 429。
///
/// 所以这里做两件事：
///   1. **并发上限**（默认 4）—— 也顺带避免一口气开 50 个 socket 把自己拖死；
///   2. **滑动窗口**（默认 200 次/分钟，比服务端 240 留一点余量）—— 超过就等窗口滑过去。
///
/// 真正撞上 429 时，调用方还会按 `Retry-After` 退避（见 `CfwClient._send`），这里是第一道。
class RateGate {
  final int concurrency;
  final int perMinute;

  int _active = 0;
  final Queue<Completer<void>> _waiters = Queue<Completer<void>>();
  final Queue<DateTime> _recent = Queue<DateTime>();

  RateGate({this.concurrency = 4, this.perMinute = 200});

  /// 把一个请求包起来跑：会自动排队、限速、并在结束时唤醒下一个等待者。
  Future<T> run<T>(Future<T> Function() task) async {
    await _acquire();
    try {
      return await task();
    } finally {
      _release();
    }
  }

  Future<void> _acquire() async {
    while (_active >= concurrency) {
      final c = Completer<void>();
      _waiters.add(c);
      await c.future;
    }
    _active++;
    await _respectRate();
  }

  void _release() {
    if (_active > 0) _active--;
    if (_waiters.isNotEmpty) _waiters.removeFirst().complete();
  }

  Future<void> _respectRate() async {
    if (perMinute <= 0) return;
    for (;;) {
      final now = DateTime.now();
      while (_recent.isNotEmpty && now.difference(_recent.first).inSeconds >= 60) {
        _recent.removeFirst();
      }
      if (_recent.length < perMinute) {
        _recent.add(now);
        return;
      }
      // 等到最早那次请求滑出窗口
      final wait = Duration(seconds: 60 - now.difference(_recent.first).inSeconds);
      await Future<void>.delayed(wait.isNegative ? const Duration(seconds: 1) : wait);
    }
  }
}
