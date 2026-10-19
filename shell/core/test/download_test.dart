import 'dart:convert';

import 'package:test/test.dart';
import 'package:webshell_core/webshell_core.dart';

import 'support/fake_transport.dart';

final List<int> _body = List<int>.generate(32, (int i) => i % 251);
const String _url = 'https://example.com/f.bin';

DownloadManager _manager(
  FakeTransport transport, {
  int maxConcurrent = 2,
  int maxAttempts = 3,
  DownloadPathResolver? resolve,
  DownloadHeaderProvider? headers,
}) =>
    DownloadManager(
      transport: transport,
      maxConcurrent: maxConcurrent,
      maxAttempts: maxAttempts,
      retryDelay: const Duration(milliseconds: 5),
      resolvePath: resolve ?? (DownloadTask task, String name) async => '/dl/$name',
      headers: headers,
    );

void main() {
  group('Content-Disposition', () {
    test('带引号的名字', () {
      expect(parseContentDisposition('attachment; filename="报告.pdf"'), '报告.pdf');
      expect(parseContentDisposition('attachment; filename=plain.txt'), 'plain.txt');
    });

    test('RFC 5987 的 filename*', () {
      expect(
        parseContentDisposition(
          "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.pdf",
        ),
        '中文 文件.pdf',
      );
    });

    test('服务端把 UTF-8 当 latin1 塞进 filename= 时救回来', () {
      // 真实场景：服务端把 UTF-8 字节直接当 latin1 字符写进响应头
      final String mojibake = String.fromCharCodes(utf8.encode('中文.txt'));
      expect(parseContentDisposition('attachment; filename="$mojibake"'), '中文.txt');
    });

    test('大小写与多余空格', () {
      expect(parseContentDisposition('ATTACHMENT;  FILENAME = "a b.txt" '), 'a b.txt');
    });

    test('没有就是没有', () {
      expect(parseContentDisposition(null), isNull);
      expect(parseContentDisposition(''), isNull);
      expect(parseContentDisposition('inline'), isNull);
      expect(parseContentDisposition('attachment; filename=""'), isNull);
    });

    test('非法字符会被清理', () {
      expect(parseContentDisposition('attachment; filename="a/b:c.txt"'), 'a_b_c.txt');
    });
  });

  group('文件名与体积工具', () {
    test('服务端名字优先于 URL', () {
      expect(
        resolveFileName(url: 'https://a.com/x.bin', contentDisposition: 'attachment; filename="y.zip"'),
        'y.zip',
      );
      expect(resolveFileName(url: 'https://a.com/x.bin'), 'x.bin');
    });

    test('同名时补序号', () {
      final Set<String> taken = <String>{'/dl/a.txt', '/dl/a (1).txt'};
      expect(uniquePath('/dl/a.txt', exists: taken.contains), '/dl/a (2).txt');
      expect(uniquePath('/dl/new.txt', exists: taken.contains), '/dl/new.txt');
    });

    test('humanBytes', () {
      expect(humanBytes(0), '0 B');
      expect(humanBytes(999), '999 B');
      expect(humanBytes(1536), '1.5 KB');
      expect(humanBytes(5 * 1024 * 1024), '5.0 MB');
      expect(humanBytes(150 * 1024 * 1024), '150 MB');
    });
  });

  group('下载流程', () {
    test('完整下载：字节对、状态对、进度到 1', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's1');
      await m.waitIdle();

      expect(task.status, DownloadStatus.done);
      expect(t.saved['/dl/f.bin'], _body);
      expect(task.received, _body.length);
      expect(task.total, _body.length);
      expect(task.progress, 1.0);
      expect(task.displaySize, contains(' / '));
      expect(task.error, isNull);
      expect(m.isBusy, isFalse);
    });

    test('服务端给的文件名会覆盖 URL 猜的名字', () async {
      final FakeTransport t = FakeTransport(
        files: <String, FakeFile>{_url: FakeFile(_body, fileName: '报告 2026.pdf')},
      );
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();

      expect(task.fileName, '报告 2026.pdf');
      expect(t.saved.containsKey('/dl/报告 2026.pdf'), isTrue);
    });

    test('下载会带上调用方给的 Cookie / Referer / UA', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      final DownloadManager m = _manager(
        t,
        headers: (DownloadTask task) async => <String, String>{
          'Cookie': 'sid=1',
          'Referer': 'https://example.com/page',
          'User-Agent': 'WebShell/1.0',
        },
      );
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();

      expect(t.lastHeaders['Cookie'], 'sid=1');
      expect(t.lastHeaders['Referer'], 'https://example.com/page');
      expect(t.lastHeaders['User-Agent'], 'WebShell/1.0');
      expect(task.status, DownloadStatus.done);
    });

    test('同一站点同一地址不重复入队', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      final DownloadManager m = _manager(t);
      final DownloadTask a = m.enqueue(url: _url, siteId: 's');
      final DownloadTask b = m.enqueue(url: _url, siteId: 's');
      expect(identical(a, b), isTrue);
      expect(m.tasks, hasLength(1));
      await m.waitIdle();
    });
  });

  group('断点续传', () {
    test('有半截文件时带 Range 继续，拼成完整文件', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's', startPaused: true);

      // 模拟"上次下到 12 字节就被打断"
      task.received = 12;
      task.savePath = '/dl/f.bin';
      t.saved['/dl/f.bin'] = _body.sublist(0, 12);

      m.resume(task.id);
      await m.waitIdle();

      expect(t.requestedOffsets, contains(12));
      expect(t.saved['/dl/f.bin'], _body);
      expect(task.status, DownloadStatus.done);
      expect(task.resumable, isTrue);
      expect(task.received, _body.length);
    });

    test('服务端不支持 Range 时从头重下，不留脏数据', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)})
        ..honourRange = false;
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's', startPaused: true);
      task.received = 12;
      task.savePath = '/dl/f.bin';
      t.saved['/dl/f.bin'] = _body.sublist(0, 12);

      m.resume(task.id);
      await m.waitIdle();

      expect(t.saved['/dl/f.bin'], _body);
      expect(task.received, _body.length);
      expect(task.status, DownloadStatus.done);
    });
  });

  group('并发、重试、暂停、取消', () {
    test('并发闸门：同时最多 2 个', () async {
      final Map<String, FakeFile> files = <String, FakeFile>{
        for (int i = 0; i < 3; i++)
          'https://example.com/f$i.bin': FakeFile(List<int>.generate(16, (int j) => j)),
      };
      final FakeTransport t = FakeTransport(
        files: files,
        chunkSize: 1,
        chunkDelay: const Duration(milliseconds: 1),
      );
      final DownloadManager m = _manager(t, maxConcurrent: 2);
      for (int i = 0; i < 3; i++) {
        m.enqueue(url: 'https://example.com/f$i.bin', siteId: 's');
      }
      expect(m.tasks, hasLength(3));
      await m.waitIdle();

      expect(t.maxInFlight, 2);
      expect(m.tasks.where((DownloadTask x) => x.status == DownloadStatus.done), hasLength(3));
      expect(m.isBusy, isFalse);
    });

    test('网络中断会重试，最终成功', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      t.failTimes = 2;
      final DownloadManager m = _manager(t, maxAttempts: 3);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();

      expect(task.status, DownloadStatus.done);
      expect(t.openCount, 3);
      expect(t.saved['/dl/f.bin'], _body);
    });

    test('404 重试到上限就标记失败，不无限重试', () async {
      final FakeTransport t = FakeTransport();
      final DownloadManager m = _manager(t, maxAttempts: 3);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();

      expect(task.status, DownloadStatus.failed);
      expect(task.error, contains('找不到'));
      expect(t.openCount, 3);
    });

    test('失败后可以手动重试', () async {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      t.failTimes = 99;
      final DownloadManager m = _manager(t, maxAttempts: 1);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();
      expect(task.status, DownloadStatus.failed);

      t.failTimes = 0;
      m.resume(task.id);
      await m.waitIdle();
      expect(task.status, DownloadStatus.done);
      expect(task.error, isNull);
      expect(t.saved['/dl/f.bin'], _body);
    });

    test('暂停后继续：从断开处接着下', () async {
      final FakeTransport t = FakeTransport(
        files: <String, FakeFile>{_url: FakeFile(_body)},
        chunkSize: 1,
        chunkDelay: const Duration(milliseconds: 2),
      );
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');

      await Future<void>.delayed(const Duration(milliseconds: 15));
      m.pause(task.id);
      await m.waitIdle();

      expect(task.status, DownloadStatus.paused);
      expect(task.received, lessThan(_body.length));
      final int pausedAt = task.received;

      m.resume(task.id);
      await m.waitIdle();

      expect(task.status, DownloadStatus.done);
      expect(t.saved['/dl/f.bin'], _body);
      expect(t.requestedOffsets, contains(pausedAt));
    });

    test('取消会删掉半截文件', () async {
      final FakeTransport t = FakeTransport(
        files: <String, FakeFile>{_url: FakeFile(_body)},
        chunkSize: 1,
        chunkDelay: const Duration(milliseconds: 2),
      );
      final DownloadManager m = _manager(t);
      final DownloadTask task = m.enqueue(url: _url, siteId: 's');

      await Future<void>.delayed(const Duration(milliseconds: 15));
      await m.cancel(task.id);
      await m.waitIdle();

      expect(task.status, DownloadStatus.canceled);
      expect(t.deleted, contains('/dl/f.bin'));
      expect(t.saved.containsKey('/dl/f.bin'), isFalse);
    });

    test('进度回调控件会收到变化', () async {
      final FakeTransport t = FakeTransport(
        files: <String, FakeFile>{_url: FakeFile(_body)},
        chunkSize: 1,
        chunkDelay: const Duration(milliseconds: 1),
      );
      final DownloadManager m = _manager(t);
      final List<DownloadStatus> seen = <DownloadStatus>[];
      m.onChanged = (DownloadTask task) {
        if (seen.isEmpty || seen.last != task.status) seen.add(task.status);
      };
      m.enqueue(url: _url, siteId: 's');
      await m.waitIdle();

      expect(seen.first, DownloadStatus.queued);
      expect(seen, contains(DownloadStatus.running));
      expect(seen.last, DownloadStatus.done);
    });
  });

  group('持久化', () {
    test('重启后"正在下载"的任务变回暂停', () {
      final DownloadTask? task = DownloadTask.tryFromJson(<String, dynamic>{
        'url': _url,
        'siteId': 's',
        'status': 'running',
        'received': 10,
        'total': 32,
      });
      expect(task, isNotNull);
      expect(task!.status, DownloadStatus.paused);
      expect(task.received, 10);
      expect(task.total, 32);
      expect(task.fileName, 'f.bin');
    });

    test('JSON 往返', () {
      final DownloadTask t = DownloadTask(
        id: '1',
        siteId: 's',
        url: _url,
        fileName: 'f.bin',
        savePath: '/dl/f.bin',
      )..received = 5;
      t.total = 10;
      t.status = DownloadStatus.paused;
      final DownloadTask? back = DownloadTask.tryFromJson(t.toJson());
      expect(back?.received, 5);
      expect(back?.total, 10);
      expect(back?.status, DownloadStatus.paused);
      expect(back?.savePath, '/dl/f.bin');
    });

    test('restore 只收未完成的', () {
      final FakeTransport t = FakeTransport(files: <String, FakeFile>{_url: FakeFile(_body)});
      final DownloadManager m = _manager(t);
      m.restore(<DownloadTask>[
        DownloadTask.tryFromJson(<String, dynamic>{'url': _url, 'status': 'done'})!,
        DownloadTask.tryFromJson(
            <String, dynamic>{'url': 'https://example.com/g.bin', 'status': 'paused'})!,
      ]);
      expect(m.tasks, hasLength(1));
      expect(m.tasks.first.status, DownloadStatus.paused);
    });

    test('坏条目返回 null', () {
      expect(DownloadTask.tryFromJson(null), isNull);
      expect(DownloadTask.tryFromJson(<String, dynamic>{'url': ''}), isNull);
    });
  });
}
