import 'dart:convert';
import 'dart:io';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:test/test.dart';

import 'support/fake_server.dart';

/// 同步引擎的语义测试。
///
/// 这段逻辑**必须**在 CI 里跑：它一旦错就是"把用户文件覆盖掉"这一级的后果，
/// 而靠手动点 App 根本测不出"冲突时两边都改了会怎样"。
void main() {
  late Directory tmp;
  late Directory root;
  late FakeServer server;
  late LocalState state;
  late SyncEngine engine;

  ServerConfig cfg() =>
      ServerConfig(baseUrl: 'https://x.workers.dev', adminUuid: 'abc');

  Future<void> rebuild({ConflictPolicy policy = ConflictPolicy.keepBoth}) async {
    state = await LocalState.open(File('${root.path}/.cfwtxt/state.json'));
    engine = SyncEngine(
      client: CfwClient(config: cfg(), transport: server, gate: RateGate(perMinute: 0)),
      root: root,
      state: state,
      policy: policy,
    );
  }

  /// 直接改"远端"：内容 + 原文件修改时间一起改（模拟别人在网页端编辑并保存）。
  /// 注意用 **utf8.encode** 而不是 `codeUnits` —— 后者对中文会给出 >255 的码元，
  /// 当成字节写进 Uint8List 会被就地截断（这是测试桩最容易埋的一个假阳性）。
  void editRemote(String path, String content, int mtimeMs) {
    server.files[path] = utf8.encode(content);
    server.mtimes[path] = mtimeMs;
  }

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('cfwtxt-sync-');
    root = Directory('${tmp.path}/local')..createSync(recursive: true);
    server = FakeServer();
    await rebuild();
  });

  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  File local(String rel) => File('${root.path}/$rel');

  group('pull', () {
    test('首次拉取：下载全部文件，并把本地 mtime 对齐成远端的', () async {
      editRemote('笔记/a.txt', 'AAA', 1700000000000);
      editRemote('笔记/子/b.md', 'BBB', 1700000001000);

      final r = await engine.pull();
      expect(r.downloaded, 2);
      expect(local('笔记/a.txt').readAsStringSync(), 'AAA');
      expect(local('笔记/子/b.md').readAsStringSync(), 'BBB');

      // mtime 对齐是必须的：不对齐的话下次 push 会认为"本地变了"，把每个文件重传一遍
      expect(local('笔记/a.txt').lastModifiedSync().millisecondsSinceEpoch, 1700000000000);
      expect(state.baseline, hasLength(2));
    });

    test('再拉一次：什么都没变 → 一个都不下载（这才是"增量"）', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      final before = server.requests.where((r) => r.uri.queryParameters['action'] == 'download').length;
      final r = await engine.pull();
      expect(r.downloaded, 0);
      expect(r.unchanged, 1);
      final after = server.requests.where((r) => r.uri.queryParameters['action'] == 'download').length;
      expect(after, before, reason: '不该再打一次 download');
    });

    test('远端改了 → 覆盖本地', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      editRemote('a.txt', '新版', 1700000009000);
      final r = await engine.pull();
      expect(r.downloaded, 1);
      expect(local('a.txt').readAsStringSync(), '新版');
      expect(local('a.txt').lastModifiedSync().millisecondsSinceEpoch, 1700000009000);
    });

    test('远端删了 → 本地跟着删（前提是本地没被改过）', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      editRemote('b.txt', 'BBB', 1700000000000);
      await engine.pull();

      server.files.remove('a.txt');
      final r = await engine.pull();
      expect(r.deletedLocal, 1);
      expect(local('a.txt').existsSync(), isFalse);
      expect(local('b.txt').existsSync(), isTrue);
    });

    test('远端删了但本地也改过 → 保留本地，并报冲突（绝不静默删用户的字）', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      local('a.txt').writeAsStringSync('我刚写的东西');
      server.files.remove('a.txt');

      final r = await engine.pull();
      expect(r.deletedLocal, 0);
      expect(local('a.txt').readAsStringSync(), '我刚写的东西');
      expect(r.conflicts, hasLength(1));
    });

    test('两边都改了（keepBoth）→ 本地另存一份，两边内容都还在', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      local('a.txt').writeAsStringSync('本机版本');
      editRemote('a.txt', '远端版本', 1700000009000);

      final r = await engine.pull();
      expect(r.conflicts, hasLength(1));
      final kept = r.conflicts.single.keptAs;
      expect(kept, isNotEmpty);
      expect(local(kept).readAsStringSync(), '本机版本', reason: '本机版本要留一份');
      expect(local('a.txt').readAsStringSync(), '远端版本', reason: '原路径按远端覆盖');
      expect(kept, contains('本机冲突'));
    });

    test('safeRel：拒绝路径穿越与绝对路径（服务端数据不可信）', () {
      expect(SyncEngine.safeRel('a/b.txt'), 'a/b.txt');
      expect(SyncEngine.safeRel('/etc/passwd'), isNull);
      expect(SyncEngine.safeRel('../../x'), isNull);
      expect(SyncEngine.safeRel('a/../../x'), isNull);
      expect(SyncEngine.safeRel('C:/windows/x'), isNull);
      expect(SyncEngine.safeRel(''), isNull);
    });
  });

  group('push', () {
    test('本地新文件 → 上传（小文件走 PUT）', () async {
      local('新笔记.md').writeAsStringSync('hello');

      final r = await engine.push();
      expect(r.uploaded, 1);
      expect(server.files['新笔记.md']!.length, 5);
      // 上传要带着本地 mtime，否则服务端记的是"上传时间"，下次比对就假阳性了
      expect(server.mtimes['新笔记.md'],
          local('新笔记.md').lastModifiedSync().millisecondsSinceEpoch);
    });

    test('本地没改 → 不上传（一个请求都不发）', () async {
      local('a.txt').writeAsStringSync('AAA');
      await engine.push();

      final before = server.requests.where((r) => r.method == 'PUT').length;
      final r = await engine.push();
      expect(r.uploaded, 0);
      expect(r.unchanged, 1);
      expect(server.requests.where((r) => r.method == 'PUT').length, before);
    });

    test('本地改了 → 上传新内容', () async {
      local('a.txt').writeAsStringSync('AAA');
      await engine.push();

      local('a.txt').writeAsStringSync('AAA 改过了');
      // 显式抬高 mtime：两次写盘可能落在同一毫秒内，那样本地就"看起来没变"
      local('a.txt').setLastModifiedSync(DateTime.fromMillisecondsSinceEpoch(1750000000000));

      final r = await engine.push();
      expect(r.uploaded, 1);
      expect(utf8.decode(server.files['a.txt']!), 'AAA 改过了');
    });

    test('两边都改了（keepBoth）→ 本机版本另存 + 本地被远端覆盖，服务器拿到两边', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull(); // 建立基线，本地 = AAA

      local('a.txt').writeAsStringSync('本机版本');
      editRemote('a.txt', '远端版本', 1700000009000);

      final r = await engine.push();
      expect(r.conflicts, hasLength(1));
      expect(local('a.txt').readAsStringSync(), '远端版本');
      expect(r.conflicts.single.keptAs, isNotEmpty);
      expect(local(r.conflicts.single.keptAs).readAsStringSync(), '本机版本');
    });

    test('preferLocal：本机优先，直接覆盖远端', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();
      local('a.txt').writeAsStringSync('本机说了算');
      editRemote('a.txt', '远端版本', 1700000009000);

      await rebuild(policy: ConflictPolicy.preferLocal);
      final r = await engine.push();
      expect(r.uploaded, 1);
      expect(utf8.decode(server.files['a.txt']!), '本机说了算');
      expect(local('a.txt').readAsStringSync(), '本机说了算');
    });

    test('默认不删远端（镜像模式要显式打开）', () async {
      editRemote('远端独有.txt', 'x', 1700000000000);
      await engine.push(); // 只推不删
      expect(server.files.containsKey('远端独有.txt'), isTrue);
    });

    test('镜像模式：本地删了 → 远端也删', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();
      await local('a.txt').delete();

      final r = await engine.push(deleteRemoteMissing: true);
      expect(r.deletedRemote, 1);
      expect(server.files.containsKey('a.txt'), isFalse);
    });
  });

  group('sync（先拉后推）', () {
    test('第一次就双边同步：远端落下来、本地推上去，互不打架', () async {
      editRemote('远端.txt', '来自远端', 1700000000000);
      local('本地.txt').writeAsStringSync('来自本地');

      final r = await engine.sync();
      expect(r.downloaded, 1);
      expect(r.uploaded, 1);
      expect(local('远端.txt').readAsStringSync(), '来自远端');
      expect(utf8.decode(server.files['本地.txt']!), '来自本地');
      expect(r.errors, isEmpty);
    });

    test('第二批：都已经一致 → 两个方向都不动', () async {
      editRemote('远端.txt', '来自远端', 1700000000000);
      local('本地.txt').writeAsStringSync('来自本地');
      await engine.sync();

      final r = await engine.sync();
      expect(r.downloaded, 0);
      expect(r.uploaded, 0);
      expect(r.errors, isEmpty);
    });
  });

  group('状态文件', () {
    test('往返持久化（重开引擎后仍然是增量）', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      // 模拟 App 重启：重新 open 状态文件
      await rebuild();
      final r = await engine.pull();
      expect(r.downloaded, 0);
      expect(r.unchanged, 1);
    });

    test('状态文件坏掉 → 当没有，重新全量比一遍（绝不因此丢数据）', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();

      File('${root.path}/.cfwtxt/state.json').writeAsStringSync('{ 这不是 json');
      await rebuild();

      expect(state.baseline, isEmpty);
      final r = await engine.pull();
      expect(r.downloaded, 1, reason: '重下一遍，但文件内容是对的');
      expect(local('a.txt').readAsStringSync(), 'AAA');
    });

    test('同步状态文件自己不会被当成同步对象', () async {
      editRemote('a.txt', 'AAA', 1700000000000);
      await engine.pull();
      final scanned = await engine.scanLocal();
      expect(scanned.keys.any((k) => k.startsWith('.cfwtxt/')), isFalse);
    });
  });
}
