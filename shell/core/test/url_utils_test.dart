import 'package:test/test.dart';
import 'package:webshell_core/webshell_core.dart';

void main() {
  group('normalizeUrl', () {
    test('没写协议时补 https', () {
      expect(normalizeUrl('example.com'), 'https://example.com');
      expect(normalizeUrl('example.com/oa/login'), 'https://example.com/oa/login');
      expect(normalizeUrl('//example.com/a'), 'https://example.com/a');
    });

    test('带端口的也认', () {
      expect(normalizeUrl('example.com:8080/a'), 'https://example.com:8080/a');
      expect(normalizeUrl('http://192.168.1.5:8000'), 'http://192.168.1.5:8000');
    });

    test('清掉聊天软件复制来的包装', () {
      expect(normalizeUrl('  "https://example.com/a"  '), 'https://example.com/a');
      expect(normalizeUrl('<https://example.com/a>'), 'https://example.com/a');
      expect(normalizeUrl('“https://example.com/a”'), 'https://example.com/a');
    });

    test('协议大小写与多余内容', () {
      expect(normalizeUrl('HTTPS://Example.COM/a'), 'https://example.com/a');
    });

    test('明确拒绝非 http(s)', () {
      expect(normalizeUrl('ftp://example.com'), isNull);
      expect(normalizeUrl('file:///c:/x.txt'), isNull);
      expect(normalizeUrl('javascript:alert(1)'), isNull);
      expect(normalizeUrl(''), isNull);
      expect(normalizeUrl('   '), isNull);
    });

    test('不带协议的单段主机名会被拒绝（否则会变成打不开的 https://note）', () {
      expect(normalizeUrl('note'), isNull);
      expect(normalizeUrl('intranet'), isNull);
    });

    test('但显式写了协议的照样接受（内网单段主机名很常见）', () {
      expect(normalizeUrl('http://intranet'), 'http://intranet');
      expect(normalizeUrl('https://localhost:3000'), 'https://localhost:3000');
    });

    test('中文域名用 URL 规范的百分号编码形式，显示时再还原', () {
      final String? out = normalizeUrl('例子.中国/a');
      expect(out, 'https://%E4%BE%8B%E5%AD%90.%E4%B8%AD%E5%9B%BD/a');
      expect(prettyHost(hostOf(out!)), '例子.中国');
      expect(displayUrl(out), '例子.中国/a');
    });

    test('根路径的斜杠会被去掉，同一个站点才比得出来', () {
      expect(normalizeUrl('https://a.com/'), 'https://a.com');
      expect(normalizeUrl('https://a.com'), 'https://a.com');
      expect(normalizeUrl('https://a.com/?x=1'), 'https://a.com/?x=1');
      expect(normalizeUrl('http://a.com:8080/'), 'http://a.com:8080');
    });
  });

  group('主机与同站判断', () {
    test('hostOf / bareHost', () {
      expect(hostOf('https://WWW.Example.com/a'), 'www.example.com');
      expect(bareHost('www.example.com'), 'example.com');
      expect(bareHost('example.com'), 'example.com');
      expect(hostOf('乱七八糟'), '');
    });

    test('sameSite 认子域，不认别的域名', () {
      expect(sameSite('https://a.example.com/x', 'https://example.com'), isTrue);
      expect(sameSite('https://www.example.com', 'https://example.com'), isTrue);
      expect(sameSite('https://example.com', 'https://evil.com'), isFalse);
      expect(sameSite('https://notexample.com', 'https://example.com'), isFalse);
    });

    test('externalScheme 只放行交给系统的那几个', () {
      expect(externalScheme('tel:10086'), 'tel');
      expect(externalScheme('mailto:a@b.com'), 'mailto');
      expect(externalScheme('magnet:?xt=urn:btih:x'), 'magnet');
      expect(externalScheme('weixin://dl/chat'), 'weixin');
      expect(externalScheme('https://example.com'), isNull);
      expect(externalScheme('unsupported-scheme:whatever'), isNull);
    });

    test('isHttpUrl', () {
      expect(isHttpUrl('https://a.com'), isTrue);
      expect(isHttpUrl('http://a.com'), isTrue);
      expect(isHttpUrl('tel:1'), isFalse);
    });
  });

  group('显示与命名', () {
    test('displayUrl 去掉协议与 www', () {
      expect(displayUrl('https://www.example.com/'), 'example.com');
      expect(displayUrl('https://www.example.com/a/b?x=1'), 'example.com/a/b?x=1');
    });

    test('guessSiteName', () {
      expect(guessSiteName('https://www.example.com/a'), 'example.com');
      expect(guessSiteName('https://192.168.1.5:8000'), '192.168.1.5');
    });
  });

  group('图标候选', () {
    test('只用站点自己的文件，不接第三方服务', () {
      final List<String> list = faviconCandidates('https://www.example.com/a/b');
      expect(list, hasLength(4));
      expect(list.first, 'https://www.example.com/apple-touch-icon.png');
      expect(list.last, 'https://www.example.com/favicon.png');
      for (final String u in list) {
        expect(u, startsWith('https://www.example.com'));
      }
    });

    test('解析不出来的地址给空列表', () {
      expect(faviconCandidates('不是地址'), isEmpty);
    });
  });

  group('文件名', () {
    test('从 URL 取名，路径段要解码', () {
      expect(fileNameFromUrl('https://a.com/x/%E4%B8%AD%E6%96%87.pdf'), '中文.pdf');
      expect(fileNameFromUrl('https://a.com/f.zip?token=1'), 'f.zip');
      expect(fileNameFromUrl('https://a.com/'), 'download');
      expect(fileNameFromUrl('https://a.com'), 'download');
    });

    test('清理跨平台非法字符', () {
      expect(sanitizeFileName('a/b:c*d?"e<f>g|h'), 'a_b_c_d_e_f_g_h');
      expect(sanitizeFileName('  多  空格  '), '多 空格');
      expect(sanitizeFileName('..\\..\\etc\\passwd'), 'etc_passwd');
      expect(sanitizeFileName(''), 'download');
    });

    test('Windows 保留名要避开', () {
      expect(sanitizeFileName('CON.txt'), '_CON.txt');
      expect(sanitizeFileName('nul'), '_nul');
      expect(sanitizeFileName('console.txt'), 'console.txt');
    });

    test('超长名字截断但保留扩展名', () {
      final String long = '${'a' * 400}.pdf';
      final String out = sanitizeFileName(long);
      expect(out.length, 180);
      expect(out, endsWith('.pdf'));
    });

    test('按扩展名判断是不是文件', () {
      expect(isProbablyDownloadUrl('https://a.com/x.zip'), isTrue);
      expect(isProbablyDownloadUrl('https://a.com/x.apk?v=1'), isTrue);
      expect(isProbablyDownloadUrl('https://a.com/page'), isFalse);
      expect(isProbablyDownloadUrl('https://a.com/d?download=1'), isTrue);
      // 长按菜单用的全量表：图片/文本也算"可能是文件"（用户已经说要下载）
      expect(isProbablyDownloadUrl('https://a.com/pic.jpg'), isTrue);
      expect(isProbablyDownloadUrl('https://a.com/note.md'), isTrue);
    });

    test('取扩展名只看最后一段（父目录里的点不算）', () {
      expect(extensionOf('/a/b/file.tar.gz'), 'gz');
      expect(extensionOf('/a/b/FILE.PDF'), 'pdf');
      expect(extensionOf('/v1.2/download'), '');
      expect(extensionOf('/a/b/file.'), '');
      expect(extensionOf('/a/b'), '');
      expect(extensionOf('/a/b/file.verylongextension'), ''); // 长得不像扩展名
    });

    test('自动接管用保守判断：图片/音视频/纯文本不算，二进制与 ?download 才算', () {
      // 该接管的
      expect(isLikelyFileAttachment('https://a.com/x.zip'), isTrue);
      expect(isLikelyFileAttachment('https://a.com/doc.pdf'), isTrue);
      expect(isLikelyFileAttachment('https://a.com/app.apk?ver=2'), isTrue);
      expect(isLikelyFileAttachment('https://a.com/note1?download=1'), isTrue);
      expect(isLikelyFileAttachment('https://a.com/export?action=DOWNLOAD'), isTrue);
      // 不该误伤：用户点它们是想"看"
      expect(isLikelyFileAttachment('https://a.com/pic.jpg'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/clip.mp4'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/song.mp3'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/note.md'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/data.csv'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/index.html'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/page'), isFalse);
      expect(isLikelyFileAttachment('https://a.com/v1.2/download'), isFalse);
    });
  });
}
