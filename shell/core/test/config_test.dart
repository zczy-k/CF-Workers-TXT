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

    test('singleSiteMode：白标且禁止加站才成立', () {
      // 通用壳：列表首屏
      expect(Branding.generic.singleSiteMode, isFalse);
      // 通用壳就算禁止加站也不是直达模式（没有预置站点可直达）
      expect(const Branding(allowAddSite: false).singleSiteMode, isFalse);
      // 白标 + 允许加站：列表首屏，方便用户加自己的站
      expect(
        const Branding(presetUrl: 'oa.example.com').singleSiteMode,
        isFalse,
      );
      // 白标 + 禁止加站：直达模式
      expect(
        const Branding(presetUrl: 'oa.example.com', allowAddSite: false)
            .singleSiteMode,
        isTrue,
      );
      // preset.json 里的字段解析过来同样成立
      expect(
        Branding.fromJson(const <String, dynamic>{
          'presetUrl': 'oa.example.com',
          'allowAddSite': false,
        }).singleSiteMode,
        isTrue,
      );
    });

    test('多站点白标：解析 + 直达判定', () {
      final Branding b = Branding.fromJson(const <String, dynamic>{
        'presetSites': <Object>[
          <String, Object>{'url': 'oa.example.com', 'name': 'OA'},
          <String, Object>{'url': 'mail.example.com', 'name': '邮箱'},
        ],
        'allowAddSite': false,
      });
      expect(b.isWhiteLabel, isTrue);
      expect(b.effectivePresetSites, hasLength(2));
      expect(b.effectivePresetSites.first.name, 'OA');
      // 两个及以上站点必须进列表，否则第二个站点没有入口
      expect(b.singleSiteMode, isFalse);

      final Branding one = Branding.fromJson(const <String, dynamic>{
        'presetSites': <Object>[
          <String, Object>{'url': 'oa.example.com', 'name': 'OA'},
        ],
        'allowAddSite': false,
      });
      expect(one.singleSiteMode, isTrue);
    });

    test('旧格式 preset_url 仍作为单站点兜底', () {
      const Branding b = Branding(presetUrl: 'oa.example.com', presetName: 'OA');
      expect(b.effectivePresetSites, hasLength(1));
      expect(b.effectivePresetSites.single.name, 'OA');
      expect(b.isWhiteLabel, isTrue);
    });

    test('presetSignature：地址与名字都算进去，通用壳为空', () {
      expect(Branding.generic.presetSignature, isEmpty);
      const Branding a = Branding(presetUrl: 'oa.example.com', presetName: 'OA');
      // 地址规整后相同 → 指纹相同（`https://oa.example.com/` 与 `oa.example.com` 是一回事）
      const Branding b = Branding(presetUrl: 'https://oa.example.com/', presetName: 'OA');
      expect(a.presetSignature, b.presetSignature);
      // 名字不同 → 指纹不同（改名也要能同步下去）
      const Branding c = Branding(presetUrl: 'oa.example.com', presetName: '办公');
      expect(a.presetSignature, isNot(c.presetSignature));
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

    test('多站点：全部建出来，第一个为当前', () {
      final ShellConfig c = ShellConfig.bootstrap(Branding.fromJson(
        const <String, dynamic>{
          'presetSites': <Object>[
            <String, Object>{'url': 'oa.example.com', 'name': 'OA'},
            <String, Object>{'url': 'mail.example.com', 'name': '邮箱'},
            <String, Object>{'url': 'note.example.com', 'name': '笔记'},
          ],
        },
      ));
      expect(c.sites, hasLength(3));
      expect(c.sites.map((SiteProfile s) => s.name).toList(), <String>['OA', '邮箱', '笔记']);
      expect(c.activeSiteId, c.sites.first.id);
    });

    test('多站点：非法地址与重复地址跳过，不影响其余', () {
      final ShellConfig c = ShellConfig.bootstrap(Branding.fromJson(
        const <String, dynamic>{
          'presetSites': <Object>[
            <String, Object>{'url': 'ftp://bad.example.com', 'name': '坏'},
            <String, Object>{'url': 'oa.example.com', 'name': '第一个'},
            <String, Object>{'url': 'https://oa.example.com/', 'name': '重复'},
            <String, Object>{'url': 'mail.example.com'},
          ],
        },
      ));
      expect(c.sites, hasLength(2));
      expect(c.sites.first.name, '第一个');
      expect(c.sites.last.name, 'mail.example.com');
    });
  });

  group('预置站点同步（换包 / 升级）', () {
    // 场景：用户先装了通用壳（配置文件里站点是空的），再装白标包。
    // 配置文件存在 → bootstrap 不再跑 → 预置站点必须靠 syncPresetSites 补进来。
    const Branding wl = Branding(
      appName: '公司壳',
      presetSites: <PresetSite>[
        PresetSite(url: 'oa.example.com', name: 'OA'),
        PresetSite(url: 'mail.example.com', name: '邮箱'),
      ],
    );

    test('空配置 + 白标包 → 两个预置站点都补进列表', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      expect(c.sites, hasLength(2));
      expect(c.sites.map((SiteProfile s) => s.name).toList(), <String>['OA', '邮箱']);
      expect(c.sites.first.startUrl, 'https://oa.example.com');
      // 列表是空的，得有个当前站点，否则列表页没有"当前"
      expect(c.activeSiteId, c.sites.first.id);
      expect(c.presetSignature, wl.presetSignature);
    });

    test('指纹没变时重复同步不会加重复条目', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      final int before = c.sites.length;
      ShellConfig.syncPresetSites(c, wl);
      expect(c.sites, hasLength(before));
    });

    test('用户自己加的站点保留，预置站点只补缺的', () {
      final ShellConfig c = ShellConfig();
      c.addSite(_site('mine', 'https://mine.example.com'));
      ShellConfig.syncPresetSites(c, wl);
      expect(c.sites, hasLength(3));
      expect(c.sites.first.id, 'mine');
      // 已有的当前站点不被抢走
      expect(c.activeSiteId, 'mine');
    });

    test('白标包升级：新增的站点补进来，已有的不重复', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      const Branding v2 = Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'oa.example.com', name: 'OA'),
          PresetSite(url: 'mail.example.com', name: '邮箱'),
          PresetSite(url: 'note.example.com', name: '笔记'),
        ],
      );
      ShellConfig.syncPresetSites(c, v2);
      expect(c.sites, hasLength(3));
      expect(c.sites.last.name, '笔记');
    });

    test('用户删掉的预置站点，指纹没变就不会自己长回来', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      c.removeSite(c.sites.first.id);
      expect(c.sites, hasLength(1));
      // 再同步一次（同一版白标包）：指纹相同 → 什么都不动
      ShellConfig.syncPresetSites(c, wl);
      expect(c.sites, hasLength(1));
    });

    test('通用壳不会因为同步而凭空多出站点', () {
      final ShellConfig c = ShellConfig();
      ShellConfig.syncPresetSites(c, Branding.generic);
      expect(c.sites, isEmpty);
      expect(c.activeSiteId, isNull);
    });

    // 这是"用户报的 bug"那一幕：上一版留下的站点不跟着下一版消失，
    // 列表越滚越长（预置 4 个，屏幕上却显示 5 个）。
    test('升级换了预置地址：旧预置站点被删掉，用户自己的站点保留', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      c.addSite(_site('mine', 'https://mine.example.com'));
      expect(c.sites, hasLength(3));

      // 新版白标把 mail 换成 note（oa 不变）
      const Branding v2 = Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'oa.example.com', name: 'OA'),
          PresetSite(url: 'note.example.com', name: '笔记'),
        ],
      );
      ShellConfig.syncPresetSites(c, v2);

      final List<String> urls =
          c.sites.map((SiteProfile s) => s.startUrl).toList();
      expect(urls, contains('https://oa.example.com'));
      expect(urls, contains('https://note.example.com'));
      // 上一版预置的 mail 必须消失
      expect(urls, isNot(contains('https://mail.example.com')));
      // 用户自己加的一个都不能少
      expect(urls, contains('https://mine.example.com'));
      expect(c.sites, hasLength(3));
    });

    test('老配置（没有 presetIds）：先认领，之后换预置才删得掉', () {
      // 老版本写下的配置：有站点、有指纹、但没有 presetIds
      final ShellConfig legacy = ShellConfig(
        sites: <SiteProfile>[
          _site('old-oa', 'https://oa.example.com', name: 'OA'),
          _site('mine', 'https://mine.example.com', name: '我的'),
        ],
      );
      legacy.presetSignature = wl.presetSignature;
      expect(legacy.presetIds, isEmpty);

      // 同一版：只认领，站点数量不变
      ShellConfig.syncPresetSites(legacy, wl);
      expect(legacy.presetIds, <String>['old-oa']);

      // 下一版不要 oa 了：认领过的 old-oa 被删，mine 留着
      const Branding v2 = Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'mail.example.com', name: '邮箱'),
        ],
      );
      ShellConfig.syncPresetSites(legacy, v2);
      final List<String> ids =
          legacy.sites.map((SiteProfile s) => s.id).toList();
      expect(ids, isNot(contains('old-oa')));
      expect(ids, contains('mine'));
    });

    test('当前站点被预置变更删掉后自动落到第一个', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      c.activeSiteId = c.sites.first.id; // 指向 oa
      const Branding v2 = Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'mail.example.com', name: '邮箱'),
        ],
      );
      ShellConfig.syncPresetSites(c, v2);
      expect(c.sites, hasLength(1));
      expect(c.activeSiteId, c.sites.first.id);
    });

    test('presetIds 能往返 JSON', () {
      final ShellConfig c = ShellConfig.syncPresetSites(ShellConfig(), wl);
      final ShellConfig back = ShellConfig.fromJson(c.toJson());
      expect(back.presetIds, c.presetIds);
      expect(back.presetSignature, c.presetSignature);
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

    test('带路径的地址也能当站点（例：note.example.com/note1）', () {
      final ShellConfig c = ShellConfig();
      final SiteProfile s = SiteProfile(
        id: newId(),
        name: guessSiteName('https://note.example.com/note1'),
        startUrl: normalizeUrl('note.example.com/note1')!,
        createdAtMs: nowMs(),
      );
      c.addSite(s);
      expect(s.startUrl, 'https://note.example.com/note1');
      expect(s.name, 'note.example.com');
      expect(c.byId(s.id), same(s));
      // 用户再粘一次同样的地址，能找到已有的那个（用来提示"已经加过了"）
      expect(c.findByUrl('https://note.example.com/note1')?.id, s.id);
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

    test('配置文件已存在时，白标包的新预置站点照样进得来', () {
      // 先按通用壳存一份（站点为空）—— 这就是"装过通用壳"的状态
      file.save(ShellConfig());
      // 再装白标包启动
      final ShellConfig c = file.load(const Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'oa.example.com', name: 'OA'),
          PresetSite(url: 'mail.example.com', name: '邮箱'),
        ],
      ));
      expect(c.sites, hasLength(2));
      expect(c.sites.first.name, 'OA');
    });

    test('同步结果会落盘：重启后不会重复补站点，删掉的也不会长回来', () {
      file.save(ShellConfig());
      const Branding wl = Branding(
        presetSites: <PresetSite>[
          PresetSite(url: 'oa.example.com', name: 'OA'),
          PresetSite(url: 'mail.example.com', name: '邮箱'),
        ],
      );
      final ShellConfig first = file.load(wl);
      expect(first.sites, hasLength(2));

      // 模拟重启：重新读盘，站点不该变成 4 个
      final ShellConfig second = file.load(wl);
      expect(second.sites, hasLength(2));

      // 用户删掉一个，再重启 —— 指纹已经落盘，不会又补回来
      second.removeSite(second.sites.first.id);
      file.save(second);
      final ShellConfig third = file.load(wl);
      expect(third.sites, hasLength(1));
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
