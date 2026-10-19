import 'package:test/test.dart';
import 'package:webshell_core/webshell_core.dart';

SiteProfile _site({Map<String, String>? headers, String? ua, String? user}) => SiteProfile(
      id: 's1',
      name: '测试',
      startUrl: 'https://example.com',
      headers: headers,
      userAgent: ua,
      hasBasicAuth: user != null,
      basicUser: user,
    );

void main() {
  group('buildRequestHeaders', () {
    test('站点自定义头会带上，但危险头被丢掉', () {
      final Map<String, String> out = buildRequestHeaders(
        site: _site(headers: <String, String>{
          'Authorization': 'Bearer abc',
          'X-Token': 't',
          'Host': 'evil.com',
          'Content-Length': '999',
          'Range': 'bytes=0-',
        }),
      );
      expect(out['Authorization'], 'Bearer abc');
      expect(out['X-Token'], 't');
      expect(out.containsKey('Host'), isFalse);
      expect(out.containsKey('Content-Length'), isFalse);
      expect(out.containsKey('Range'), isFalse);
    });

    test('UA 优先级：调用方 > 站点 > 不给', () {
      expect(
        buildRequestHeaders(site: _site(ua: 'A'), userAgentOverride: 'B')['User-Agent'],
        'B',
      );
      expect(buildRequestHeaders(site: _site(ua: 'A'))['User-Agent'], 'A');
      expect(buildRequestHeaders(site: _site())['User-Agent'], isNull);
    });

    test('Cookie 与 Referer', () {
      final Map<String, String> out = buildRequestHeaders(
        site: _site(),
        cookies: const <ShellCookie>[
          ShellCookie(name: 'a', value: '1'),
          ShellCookie(name: 'b', value: '2'),
          ShellCookie(name: 'dead', value: 'x', expiresMs: 1),
        ],
        referer: 'https://example.com/page',
      );
      expect(out['Cookie'], 'a=1; b=2');
      expect(out['Referer'], 'https://example.com/page');
    });

    test('Basic Auth 由用户名+密码生成', () {
      final Map<String, String> out = buildRequestHeaders(
        site: _site(user: 'u'),
        basicUser: 'u',
        basicPassword: 'p',
      );
      // dTpw
      expect(out['Authorization'], 'Basic dTpw');
    });

    test('密码缺失时不用 Basic Auth', () {
      final Map<String, String> out = buildRequestHeaders(site: _site(user: 'u'), basicUser: 'u');
      expect(out.containsKey('Authorization'), isFalse);
    });
  });

  group('ShellCookie', () {
    test('过期与会话 Cookie', () {
      const ShellCookie live = ShellCookie(name: 'a', value: '1');
      const ShellCookie dead = ShellCookie(name: 'b', value: '2', expiresMs: 1);
      expect(live.isExpired, isFalse);
      expect(dead.isExpired, isTrue);
      expect(ShellCookie.headerValue(<ShellCookie>[live, dead]), 'a=1');
    });

    test('matchesUrl 看域名/路径/secure', () {
      const ShellCookie c = ShellCookie(
        name: 'a',
        value: '1',
        domain: 'example.com',
        path: '/app',
        secure: true,
      );
      expect(c.matchesUrl(Uri.parse('https://example.com/app/x')), isTrue);
      expect(c.matchesUrl(Uri.parse('https://sub.example.com/app/x')), isTrue);
      expect(c.matchesUrl(Uri.parse('https://example.com/other')), isFalse);
      expect(c.matchesUrl(Uri.parse('http://example.com/app/x')), isFalse);
      expect(c.matchesUrl(Uri.parse('https://evil.com/app')), isFalse);
    });

    test('从 Set-Cookie 解析', () {
      final ShellCookie? c = ShellCookie.tryParse(
        'sid=abc123; Path=/app; Domain=.example.com; Secure; HttpOnly; Max-Age=3600',
      );
      expect(c, isNotNull);
      expect(c!.name, 'sid');
      expect(c.value, 'abc123');
      expect(c.domain, 'example.com');
      expect(c.path, '/app');
      expect(c.secure, isTrue);
      expect(c.httpOnly, isTrue);
      expect(c.isExpired, isFalse);
    });

    test('JSON 往返', () {
      const ShellCookie c = ShellCookie(name: 'a', value: '1', domain: 'example.com');
      final ShellCookie? back = ShellCookie.tryFromJson(c.toJson());
      expect(back?.name, 'a');
      expect(back?.value, '1');
      expect(back?.domain, 'example.com');
    });
  });

  group('设置页的头文本', () {
    test('解析每行一个 Key: Value', () {
      final Map<String, String> parsed = parseHeaderLines('''
# 注释
Authorization: Bearer x

X-A: 1
没有冒号的行
Host: evil.com
''');
      expect(parsed, <String, String>{'Authorization': 'Bearer x', 'X-A': '1'});
    });

    test('格式化后能原样解析回来', () {
      final Map<String, String> src = <String, String>{'A': '1', 'B': '2'};
      expect(parseHeaderLines(formatHeaderLines(src)), src);
    });
  });
}
