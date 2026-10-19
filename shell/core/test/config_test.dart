import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:webshell_core/webshell_core.dart';

SiteProfile _site(String id, String url, {String? name}) =>
    SiteProfile(id: id, name: name ?? id, startUrl: url);

void main() {
  group('Branding', () {
    test('通用壳没有预置站点', () {
      expect(Branding.generic.isWhiteLabel, isFalse);
      expect(Branding.generic.allowAddSite, isTrue);
    });

    test('白标配置解析（地址顺便被规整）', () {
      final Branding b = Branding.fromJson(<String, dynamic>{
        'appName': '公司 OA',
        'presetUrl': 'oa.example.com',
        'presetName': 'OA',
        'themeColor': 0xFF112233,
        'allowAddSite': false,
      });
      expect(b.appName, '公司 OA');
      expect(b.presetUrl, 'https://oa.example.com');
      expect(b.presetName, 'OA');
      expect(b.themeColor, 0xFF112233);
      expect(b.allowAddSite, isFalse);
      expect(b.isWhiteLabel, isTrue);
    });

    test('坏数据回落到默认值而不是抛异常', () {
      final Branding b = Branding.fromJson('这不是个对象');
      expect(b.appName, 'WebShell');
      expect(b.isWhiteLabel, isFalse);
    });
  });

  group('bootstrap', () {
    test('通用壳：空站点列表', () {
      final ShellConfig c = ShellConfig.bootstrap(Branding.generic);
      expect(c.sites, isEmpty);
      expect(c.activeSiteId, isNull);
      expect(c.active, isNull);
    });

    test('白标版：预置站点并设为当前', () {
      final ShellConfig c = ShellConfig.bootstrap(
        const Branding(appName: '公司 OA', presetUrl: 'oa.example.com'),
      );
      expect(c.sites, hasLength(1));
      expect(c.sites.first.startUrl, 'https://oa.example.com');
      expect(c.sites.first.name, 'oa.example.com');
      expect(c.activeSiteId, c.sites.first.id);
      expect(c.active?.name, 'oa.example.com');
    });

    test('预置名字优先于主机名', () {
      final ShellConfig c = ShellConfig.bootstrap(
        const Branding(presetUrl: 'https://oa.example.com/login', presetName: '办公系统'),
      );
      expect(c.sites.single.name, '办公系统');
    });

    test('预置地址非法时忽略，不建站点', () {
      final ShellConfig c = ShellConfig.bootstrap(
        const Branding(presetUrl: 'ftp://bad.example.com'),
      );
      expect(c.sites, isEmpty);
      expect(c.activeSiteId, isNull);
    });
  });

  group('站点增删改查', () {
    test('添加 / 删除 / 删除当前站点后自动切换', () {
      final ShellConfig c = ShellConfig();
      c.addSite(_site('a', 'https://a.com'));
      c.addSite(_site('b', 'https://b.com'));
      expect(c.activeSiteId, 'b');
      expect(c.removeSite('b'), isTrue);
      expect(c.activeSiteId, 'a');
      expect(c.removeSite('a'), isTrue);
      expect(c.activeSiteId, isNull);
      expect(c.removeSite('nope'), isFalse);
    });

    test('排序', () {
      final ShellConfig c = ShellConfig(sites: <SiteProfile>[
        _site('a', 'https://a.com'),
        _site('b', 'https://b.com'),
        _site('c', 'https://c.com'),
      ]);
      c.moveSite(0, 2);
      expect(c.sites.map((SiteProfile s) => s.id).toList(), <String>['b', 'c', 'a']);
      c.moveSite(2, 0);
      expect(c.sites.map((SiteProfile s) => s.id).toList(), <String>['a', 'b', 'c']);
      // 越界不炸
      c.moveSite(99, 0);
      expect(c.sites, hasLength(3));
    });

    test('按地址找站点（地址会被规整后比较）', () {
      final ShellConfig c = ShellConfig(sites: <SiteProfile>[
        _site('a', 'https://a.example.com'),
      ]);
      expect(c.findByUrl('https://a.example.com/')?.id, 'a');
      expect(c.findByUrl('https://other.com'), isNull);
      expect(c.findByUrl('不是地址'), isNull);
    });

    test('同一个 id 重复 addSite 不会产生重复条目（只切当前站点）', () {
      final ShellConfig c = ShellConfig();
      final SiteProfile s = _site('a', 'https://a.com');
      expect(c.addSite(s), isTrue);
      expect(c.addSite(s), isFalse);
      expect(c.addSite(_site('a', 'https://a.com')), isFalse);
      expect(c.sites, hasLength(1));
      expect(c.activeSiteId, 'a');
    });

    test('带路径的地址也能当站点（例：note.istudy.qzz.io/note1）', () {
      final ShellConfig c = ShellConfig();
      final SiteProfile s = SiteProfile(
        id: newId(),
        name: guessSiteName('https://note.istudy.qzz.io/note1'),
        startUrl: normalizeUrl('note.istudy.qzz.io/note1')!,
        createdAtMs: nowMs(),
      );
      c.addSite(s);
      expect(s.startUrl, 'https://note.istudy.qzz.io/note1');
      expect(s.name, 'note.istudy.qzz.io');
      expect(c.byId(s.id), same(s));
      // 用户再粘一次同样的地址，能找到已有的那个（用来提示"已经加过了"）
      expect(c.findByUrl('https://note.istudy.qzz.io/note1')?.id, s.id);
    });

    test('touch 会更新当前站点', () {
      final ShellConfig c = ShellConfig(sites: <SiteProfile>[
        _site('a', 'https://a.com'),
        _site('b', 'https://b.com'),
      ]);
      c.activeSiteId = 'a';
      c.touch(c.byId('b')!);
      expect(c.activeSiteId, 'b');
      expect(c.byId('b')!.lastOpenedMs, greaterThan(0));
    });
  });

  group('JSON 往返与容错', () {
    test('完整往返', () {
      final ShellConfig c = ShellConfig(
        sites: <SiteProfile>[_site('a', 'https://a.com'), _site('b', 'https://b.com')],
        activeSiteId: 'b',
        maxConcurrentDownloads: 3,
        downloadDir: '/dl',
        askWhereToSave: true,
        wifiOnlyDownloads: true,
        loadImages: false,
        branding: const Branding(appName: '我的壳'),
      );
      final ShellConfig back = ShellConfig.fromJson(
        jsonDecode(jsonEncode(c.toJson())),
      );
      expect(back.sites.map((SiteProfile s) => s.id).toList(), <String>['a', 'b']);
      expect(back.activeSiteId, 'b');
      expect(back.maxConcurrentDownloads, 3);
      expect(back.downloadDir, '/dl');
      expect(back.askWhereToSave, isTrue);
      expect(back.wifiOnlyDownloads, isTrue);
      expect(back.loadImages, isFalse);
      expect(back.branding.appName, '我的壳');
    });

    test('保持登录开关与站点"信任自签证书"能往返', () {
      final ShellConfig c = ShellConfig(
        sites: <SiteProfile>[_site('a', 'https://a.com')],
        activeSiteId: 'a',
        saveLogin: false,
      );
      c.sites.first.allowSelfSignedCert = true;
      final ShellConfig back = ShellConfig.fromJson(
        jsonDecode(jsonEncode(c.toJson())),
      );
      expect(back.saveLogin, isFalse);
      expect(back.sites.first.allowSelfSignedCert, isTrue);

      // 默认值：老配置里没有这两个字段时，回落 true / false，别把老配置读坏。
      final ShellConfig dflt = ShellConfig.fromJson(<String, dynamic>{
        'sites': <Object?>[
          <String, dynamic>{'startUrl': 'https://a.com'},
        ],
      });
      expect(dflt.saveLogin, isTrue);
      expect(dflt.sites.first.allowSelfSignedCert, isFalse);
    });

    test('坏站点条目被丢掉，好的留下；坏 activeSiteId 回落到第一个', () {
      final ShellConfig back = ShellConfig.fromJson(<String, dynamic>{
        'sites': <Object?>[
          <String, dynamic>{'startUrl': 'https://ok.com'},
          'garbage',
          42,
          <String, dynamic>{'nope': true},
          <String, dynamic>{'startUrl': 'ftp://bad.com'},
        ],
        'activeSiteId': '不存在的 id',
        'maxConcurrentDownloads': 99,
      });
      expect(back.sites, hasLength(1));
      expect(back.sites.first.startUrl, 'https://ok.com');
      expect(back.activeSiteId, back.sites.first.id);
      expect(back.maxConcurrentDownloads, 6); // 被夹到上限
    });

    test('站点名字缺失时用主机名兜底', () {
      final ShellConfig back = ShellConfig.fromJson(<String, dynamic>{
        'sites': <Object?>[
          <String, dynamic>{'startUrl': 'https://www.example.com/x'},
          <String, dynamic>{'startUrl': 'https://b.com', 'name': '   '},
        ],
      });
      expect(back.sites.map((SiteProfile s) => s.name).toList(),
          <String>['example.com', 'b.com']);
    });

    test('完全不是对象也不炸', () {
      expect(ShellConfig.fromJson(null).sites, isEmpty);
      expect(ShellConfig.fromJson('x').sites, isEmpty);
    });
  });

  group('ConfigFile', () {
    late Directory dir;
    late ConfigFile file;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('webshell_cfg');
      file = ConfigFile(File('${dir.path}${Platform.pathSeparator}webshell.json'));
    });

    tearDown(() {
      try {
        dir.deleteSync(recursive: true);
      } catch (_) {}
    });

    test('文件不存在时给出 bootstrap 配置', () {
      final ShellConfig c = file.load(const Branding(presetUrl: 'https://a.com'));
      expect(c.sites, hasLength(1));
    });

    test('存了能读回来（原子写不留 .tmp）', () {
      final ShellConfig c = ShellConfig(sites: <SiteProfile>[_site('a', 'https://a.com')]);
      file.save(c);
      expect(file.load().sites.single.id, 'a');
      expect(File('${file.file.path}.tmp').existsSync(), isFalse);
    });

    test('配置被写坏时备份并从默认值启动', () {
      file.file.writeAsStringSync('{ 这不是 json');
      final ShellConfig c = file.load(const Branding(presetUrl: 'https://fallback.com'));
      expect(c.sites.single.startUrl, 'https://fallback.com');
      expect(File('${file.file.path}.corrupt').existsSync(), isTrue);
    });

    test('目录不存在也能存', () {
      final ConfigFile nested = ConfigFile(
        File('${dir.path}${Platform.pathSeparator}a${Platform.pathSeparator}b${Platform.pathSeparator}c.json'),
      );
      nested.save(ShellConfig(sites: <SiteProfile>[_site('a', 'https://a.com')]));
      expect(nested.file.existsSync(), isTrue);
    });
  });
}
