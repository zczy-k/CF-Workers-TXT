import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:test/test.dart';

/// 站点地址解析是这个客户端**最容易被低估的一块**：
/// 用户会从浏览器地址栏整条复制管理入口，里面可能有尾斜杠、可能有 `?action=`、
/// 也可能只填了域名。而且这块逻辑必须在 CI 里能跑（不能靠"打开 App 手点一遍"）。
void main() {
  group('ServerConfig.tryParse —— 站点地址可以随便填', () {
    test('整条管理入口 URL（最常见）', () {
      final c = ServerConfig.tryParse('https://mysite.workers.dev/a1b2c3d4')!;
      expect(c.baseUrl, 'https://mysite.workers.dev');
      expect(c.adminUuid, 'a1b2c3d4');
      expect(c.isValid, isTrue);
    });

    test('省掉 scheme 也能认（Cloudflare 上不存在 http 站点，补 https）', () {
      final c = ServerConfig.tryParse('mysite.workers.dev/a1b2c3d4')!;
      expect(c.baseUrl, 'https://mysite.workers.dev');
      expect(c.adminUuid, 'a1b2c3d4');
    });

    test('尾斜杠 / 多余路径段都丢掉，只取最后一段当 ADMIN_UUID', () {
      final c = ServerConfig.tryParse('https://txt.example.com/secret/')!;
      expect(c.baseUrl, 'https://txt.example.com');
      expect(c.adminUuid, 'secret');
    });

    test('把 API 地址一起粘进来也认（末尾的 api 不算 adminUuid）', () {
      final c = ServerConfig.tryParse('https://x.workers.dev/a1b2/api')!;
      expect(c.adminUuid, 'a1b2');
    });

    test('带 query 的地址：query 直接丢掉', () {
      final c = ServerConfig.tryParse('https://x.workers.dev/a1b2?action=list')!;
      expect(c.adminUuid, 'a1b2');
      expect(c.baseUrl, 'https://x.workers.dev');
    });

    test('只填域名 → adminUuid 为空（由 UI 再问一次），但 baseUrl 是对的', () {
      final c = ServerConfig.tryParse('https://x.workers.dev')!;
      expect(c.baseUrl, 'https://x.workers.dev');
      expect(c.adminUuid, isEmpty);
      expect(c.isValid, isFalse, reason: '少一段就不算配好，UI 要拦住');
    });

    test('乱填 → null', () {
      expect(ServerConfig.tryParse(''), isNull);
      expect(ServerConfig.tryParse('   '), isNull);
      expect(ServerConfig.tryParse('https://'), isNull);
    });

    test('端口保留（自建反代常用）', () {
      final c = ServerConfig.tryParse('http://192.168.1.9:8787/abc')!;
      expect(c.baseUrl, 'http://192.168.1.9:8787');
      expect(c.adminUuid, 'abc');
    });

    test('http 也接受（本机/内网反代是真的会用）', () {
      final c = ServerConfig.tryParse('http://localhost:8787/abc')!;
      expect(c.baseUrl, 'http://localhost:8787');
    });
  });

  group('拼 URL', () {
    final c = ServerConfig(baseUrl: 'https://x.workers.dev', adminUuid: 'abc');

    test('api() 把 action 放在最前，其余参数跟随', () {
      final u = c.api('list', {'path': 'a/b', 'sort': 'size'});
      expect(u.toString(), 'https://x.workers.dev/abc/api?action=list&path=a%2Fb&sort=size');
    });

    test('adminUri / apiUri', () {
      expect(c.adminUri.toString(), 'https://x.workers.dev/abc');
      expect(c.apiUri.toString(), 'https://x.workers.dev/abc/api');
    });

    test('fileUri 逐段编码（中文 / 空格 / # 都要转义）', () {
      final u = c.fileUri('笔记/我的 文件.txt');
      // 断言 pathSegments（已解码）而不是 path —— 后者依赖百分号编码的大小写细节，
      // 测的是 Uri 的实现而不是我们的意图
      expect(u.pathSegments, ['abc', 'f', '笔记', '我的 文件.txt']);
      expect(u.query, isEmpty);
    });

    test('fileUri 的空段被丢掉，不会拼出双斜杠', () {
      expect(c.fileUri('/a//b.txt').pathSegments, ['abc', 'f', 'a', 'b.txt']);
    });

    test('fileUri(doc:true) 带上 ?doc=1', () {
      expect(c.fileUri('x.html', doc: true).queryParameters['doc'], '1');
    });
  });

  group('持久化 —— 站点档案里绝不能有密码', () {
    test('toJson 只有 baseUrl / adminUuid / hasPassword', () {
      final c = ServerConfig(baseUrl: 'https://x.workers.dev', adminUuid: 'abc', hasPassword: true);
      expect(c.toJson().keys.toSet(), {'baseUrl', 'adminUuid', 'hasPassword'});
      expect(c.toJson().containsValue('我的密码'), isFalse);
    });

    test('往返一致', () {
      final c = ServerConfig(baseUrl: 'https://x.workers.dev', adminUuid: 'abc', hasPassword: true);
      expect(ServerConfig.fromJson(c.toJson()), c);
    });
  });
}
