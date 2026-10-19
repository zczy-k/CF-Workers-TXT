import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:test/test.dart';

import 'support/fake_server.dart';

ServerConfig _cfg({bool hasPassword = false}) => ServerConfig(
      baseUrl: 'https://x.workers.dev',
      adminUuid: 'abc',
      hasPassword: hasPassword,
    );

/// 客户端"跟服务端说得对不对"的测试。用的是照着 worker.js 形状写的内存服务端
/// （见 `support/fake_server.dart`），不是打桩返回固定 JSON。
void main() {
  group('认证', () {
    test('站点没设 PASSWORD 时不登录、不带 Cookie', () async {
      final s = FakeServer()..files['a.txt'] = utf8.encode('hi');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      final listing = await c.probe();
      expect(listing.files.map((f) => f.name), ['a.txt']);
      expect(s.requests.where((r) => r.uri.queryParameters['action'] == 'login'), isEmpty);
      expect(s.requests.every((r) => r.header('cookie') == null), isTrue);
    });

    test('设了 PASSWORD → 先表单登录，拿到 Set-Cookie 再发业务请求', () async {
      final s = FakeServer()
        ..password = 'p@ss word' // 故意带空格，验证 urlencode
        ..files['a.txt'] = utf8.encode('hi');
      final c = CfwClient(config: _cfg(hasPassword: true), transport: s, password: 'p@ss word', gate: RateGate(perMinute: 0));

      await c.probe();

      final login = s.requests.firstWhere((r) => r.uri.queryParameters['action'] == 'login');
      expect(login.method, 'POST');
      expect(login.followRedirects, isFalse, reason: '必须关掉跟随重定向，否则读不到 302 的 Set-Cookie');
      expect(login.headers['Content-Type'], contains('x-www-form-urlencoded'));
      expect(Uri.splitQueryString(String.fromCharCodes(login.body!))['password'], 'p@ss word');

      final apiCalls = s.requests.where((r) => r.uri.path.endsWith('/api')).toList();
      expect(apiCalls, isNotEmpty);
      expect(apiCalls.every((r) => r.header('cookie') == 'wbauth=fake-session-token'), isTrue);
      expect(c.cookie, 'wbauth=fake-session-token');
    });

    test('没给密码就直接请求 → 抛 needPw（UI 据此弹密码框）', () async {
      final s = FakeServer()..password = 'pw';
      final c = CfwClient(config: _cfg(hasPassword: true), transport: s, gate: RateGate(perMinute: 0));
      await expectLater(
        c.probe(),
        throwsA(isA<ApiException>()
            .having((e) => e.needPw, 'needPw', isTrue)
            .having((e) => e.status, 'status', 401)),
      );
    });

    test('密码错 → 401', () async {
      final s = FakeServer()..password = 'right';
      final c = CfwClient(config: _cfg(hasPassword: true), transport: s, password: 'wrong', gate: RateGate(perMinute: 0));
      await expectLater(c.probe(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
    });

    test('会话过期（401）→ 自动重登并重放原请求一次', () async {
      final s = FakeServer()
        ..password = 'pw'
        ..files['a.txt'] = utf8.encode('hi')
        ..inject401 = 1;
      final c = CfwClient(
        config: _cfg(hasPassword: true),
        transport: s,
        password: 'pw',
        cookie: 'wbauth=fake-session-token', // 手上有个过期 Cookie
        gate: RateGate(perMinute: 0),
      );

      final listing = await c.probe();
      expect(listing.files, isNotEmpty, reason: '重放之后应该成功');
      expect(s.requests.where((r) => r.uri.queryParameters['action'] == 'login').length, 1);
    });
  });

  group('限速', () {
    test('429 按 Retry-After 退避后重试一次', () async {
      final s = FakeServer()
        ..files['a.txt'] = utf8.encode('hi')
        ..inject429 = 1;
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      final listing = await c.probe();
      expect(listing.files, isNotEmpty);
    });

    test('并发闸门：同时发 8 个请求，任何时刻在跑的都不超过 concurrency', () async {
      final s = FakeServer()
        ..files['a.txt'] = utf8.encode('hi')
        ..latency = const Duration(milliseconds: 20);
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(concurrency: 2, perMinute: 0));

      // 用请求时间戳粗略验证"没有 8 个一起冲进去"：8 个 20ms 的请求串成 2 并发 ≈ 80ms
      final sw = Stopwatch()..start();
      await Future.wait([for (var i = 0; i < 8; i++) c.list()]);
      sw.stop();
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(60));
    });
  });

  group('读写', () {
    test('readText 拿正文', () async {
      final s = FakeServer()..files['笔记/a.txt'] = utf8.encode('你好');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      expect(await c.readText('笔记/a.txt'), '你好');
    });

    test('readText 缺文件 → 404 且带服务端文案', () async {
      final c = CfwClient(config: _cfg(), transport: FakeServer(), gate: RateGate(perMinute: 0));
      await expectLater(
        c.readText('nope.txt'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 404)
            .having((e) => e.message, 'message', '文件不存在')),
      );
    });

    test('超过 2MB → 413，文案原样透出（编辑器要据此提示"请下载后编辑"）', () async {
      final s = FakeServer()..files['big.txt'] = Uint8List(2 * 1024 * 1024 + 1);
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      await expectLater(
        c.readText('big.txt'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 413)),
      );
    });

    test('writeFile 必须带 X-File-Mtime（同步判断"文件变没变"的唯一依据）', () async {
      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      final mt = DateTime.fromMillisecondsSinceEpoch(1700000000000);
      await c.writeFile('a/b.md', utf8.encode('内容'), contentType: 'text/markdown;charset=utf-8', mtime: mt);

      final put = s.requests.singleWhere((r) => r.method == 'PUT');
      expect(put.uri.queryParameters['path'], 'a/b.md');
      expect(put.header('x-file-mtime'), '1700000000000');
      expect(put.header('content-type'), 'text/markdown;charset=utf-8');
      expect(s.mtimes['a/b.md'], 1700000000000, reason: '服务端要把它存进 customMetadata');
    });

    test('writeFile 不给 contentType 时按扩展名猜（否则图片预览会坏）', () async {
      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      await c.writeFile('p.png', [1, 2, 3]);
      expect(s.requests.singleWhere((r) => r.method == 'PUT').header('content-type'), 'image/png');
    });

    test('delete 受保护目录 → needPw', () async {
      final s = FakeServer()..password = 'pw';
      s.dirs.add('保险箱');
      s.protectedDirs.add('保险箱');
      s.files['保险箱/x.txt'] = utf8.encode('x');
      final c = CfwClient(
        config: _cfg(hasPassword: true),
        transport: s,
        password: 'pw',
        gate: RateGate(perMinute: 0),
      );
      await expectLater(
        c.delete(path: '保险箱/x.txt'),
        throwsA(isA<ApiException>().having((e) => e.needPw, 'needPw', isTrue)),
      );
      expect(await c.delete(path: '保险箱/x.txt', password: 'pw'), isA<DeleteResult>());
      expect(s.files.containsKey('保险箱/x.txt'), isFalse);
    });

    test('mkdir / rename / move / deleteBatch 参数形状正确', () async {
      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      expect(await c.mkdir(dir: '', name: '笔记'), '笔记');
      await c.writeFile('笔记/a.txt', [1]);
      expect(await c.rename(path: '笔记/a.txt', newName: 'b.txt'), '笔记/b.txt');
      expect(await c.mkdir(dir: '笔记', name: '子目录'), '笔记/子目录');
      expect(await c.move(path: '笔记/b.txt', toDir: '笔记/子目录'), '笔记/子目录/b.txt');

      final r = await c.deleteBatch([
        {'path': '笔记/子目录/b.txt', 'isDir': false}
      ]);
      expect(r.removed, 1);
    });
  });

  group('搜索', () {
    test('search 解析结果与分组计数', () async {
      final s = FakeServer()
        ..files['笔记/菜鸟.txt'] = utf8.encode('x')
        ..files['other.txt'] = utf8.encode('y');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      final page = await c.search('菜鸟');
      expect(page.results.map((r) => r.path), ['笔记/菜鸟.txt']);
      expect(page.total, 1);
      expect(page.nameHits, 1);
      expect(s.requests.last.uri.queryParameters['q'], '菜鸟');
      expect(s.requests.last.uri.queryParameters['limit'], '60');
    });
  });

  group('分享 / 发布', () {
    test('建分享 → 服务端当场发布，链接可用', () async {
      final s = FakeServer()..files['报告.md'] = utf8.encode('x');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      final sh = await c.createShare(path: '报告.md');
      expect(sh.url, contains('/s/'));
      expect(sh.published, greaterThan(0));
      expect(s.published, contains('报告.md'));

      final list = await c.shares();
      expect(list.single.path, '报告.md');
      expect(list.single.published, isTrue);
    });

    test('撤回发布 → 影子树清掉，但分享记录还在（链接还能发回来）', () async {
      final s = FakeServer()..files['报告.md'] = utf8.encode('x');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      await c.createShare(path: '报告.md');

      await c.unpublish(path: '报告.md');
      expect(s.published, isEmpty);
      expect(await c.shares(), hasLength(1));
      expect((await c.shares()).single.published, isFalse);
    });

    test('publish 幂等标记 unchanged 原样透出', () async {
      final s = FakeServer()..files['a.txt'] = utf8.encode('x');
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));
      final r = await c.publish(path: 'a.txt');
      expect(r.published, greaterThan(0));
      expect(r.path, 'a.txt');
    });
  });

  group('上传：小文件 PUT，大文件分片', () {
    late Directory tmp;

    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('cfwtxt-up-');
    });

    tearDown(() async {
      if (await tmp.exists()) await tmp.delete(recursive: true);
    });

    test('小文件走 PUT，且 Content-Length 正确', () async {
      final f = File('${tmp.path}/small.txt')..writeAsStringSync('hello');
      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      var last = 0;
      await c.uploadFile('dir/small.txt', f, onProgress: (sent, total) {
        last = sent;
        expect(total, 5);
      });

      expect(s.requests.where((r) => r.method == 'PUT'), hasLength(1));
      expect(s.files['dir/small.txt']!.length, 5);
      expect(last, 5);
      expect(s.mtimes['dir/small.txt'], isNotNull);
    });

    test('超过 8MB 自动走分片（mpCreate → mpPart × N → mpComplete），内容拼回来正确', () async {
      const size = 9 * 1024 * 1024; // 9MB → 8MB + 1MB 两片
      final bytes = Uint8List(size);
      for (var i = 0; i < size; i++) {
        bytes[i] = i % 251;
      }
      final f = File('${tmp.path}/big.bin')..writeAsBytesSync(bytes);

      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      await c.uploadFile('big.bin', f);

      expect(s.requests.where((r) => r.method == 'PUT'), isEmpty, reason: '大文件不该走 PUT');
      final parts = s.requests.where((r) => r.uri.queryParameters['action'] == 'mpPart').toList();
      expect(parts, hasLength(2));
      expect(s.files['big.bin']!.length, size);
      expect(s.files['big.bin']!.sublist(0, 64), bytes.sublist(0, 64), reason: '分片顺序不能错');
      expect(s.files['big.bin']!.sublist(size - 64), bytes.sublist(size - 64));
      expect(s.mpSessions, isEmpty, reason: '完成后会话要清掉');
    });

    test('断点续传：服务端已有同名未完成会话时跳过已传分片', () async {
      const partSize = 8 * 1024 * 1024;
      const size = 9 * 1024 * 1024;
      final f = File('${tmp.path}/big.bin')..writeAsBytesSync(Uint8List(size));

      final s = FakeServer();
      final c = CfwClient(config: _cfg(), transport: s, gate: RateGate(perMinute: 0));

      // 先造一个"第 1 片已经传好了"的会话
      final created = await c.mpCreate(path: 'big.bin', size: size);
      await c.mpPart(created.uploadId, 1, Uint8List(partSize));

      await c.uploadFile('big.bin', f);

      final partCalls = s.requests.where((r) => r.uri.queryParameters['action'] == 'mpPart').toList();
      expect(partCalls, hasLength(2), reason: '续传只该补第 2 片（第 1 片那次 + 续传的 1 次）');
      expect(partCalls.last.uri.queryParameters['part'], '2');
      expect(s.files['big.bin']!.length, size);
    });
  });
}
