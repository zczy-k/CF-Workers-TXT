/// App 的全部可持久化状态：站点列表、当前站点、下载设置、品牌信息。
///
/// 读写走 JSON 文件，原子写（`.tmp` + rename），被截断的配置会留一份 `.corrupt` 备份
/// 然后从默认值开始 —— "配置坏了 App 就起不来"是最糟糕的体验。
library;

import 'dart:convert';
import 'dart:io';

import 'models.dart';
import 'url_utils.dart';

class ShellConfig {
  ShellConfig({
    List<SiteProfile>? sites,
    this.activeSiteId,
    this.maxConcurrentDownloads = 2,
    this.downloadDir,
    this.askWhereToSave = false,
    this.wifiOnlyDownloads = false,
    this.loadImages = true,
    this.saveLogin = true,
    this.closeToTray = true,
    this.lastUpdateCheckMs = 0,
    this.presetSignature = '',
    List<String>? presetIds,
    Branding? branding,
  })  : sites = sites ?? <SiteProfile>[],
        presetIds = presetIds ?? <String>[],
        branding = branding ?? Branding.generic;

  /// 站点列表（顺序就是 UI 里的顺序）。
  final List<SiteProfile> sites;

  /// 当前站点（加载哪个）。
  String? activeSiteId;

  int maxConcurrentDownloads;

  /// 用户选定的下载目录。
  /// Android 上是 SAF 的 tree URI（`content://…`），Windows 上是普通路径。
  String? downloadDir;

  /// 每次下载都问"存哪儿"。
  bool askWhereToSave;

  /// 只在 Wi-Fi 下下载（移动端省流量）。
  bool wifiOnlyDownloads;

  /// 加载图片（关掉 = 省流模式）。
  bool loadImages;

  /// 允许站点保持登录（Cookie 持久化）。
  bool saveLogin;

  /// 桌面端：点关闭/最小化时收进系统托盘，而不是退出/缩到任务栏。
  bool closeToTray;

  /// 上次自动检查更新的时间（ms）。自动检查按 24h 节流，手动检查不受限。
  int lastUpdateCheckMs;

  /// 上一次把预置站点同步进本配置时，那一版预置站点的指纹
  /// （[Branding.presetSignature]）。空串 = 通用壳，或老配置没这个字段。
  String presetSignature;

  /// 上一版预置同步亲手建出来的那些站点的 id。
  ///
  /// 这是「该删谁」的唯一依据：下一版预置换了地址，只删这里记过的、且这一版
  /// 不再预置的站点；用户自己加的站点永远不在这个名单里，动不到。
  /// 老配置（这个字段还不存在时写下的）里是空的 —— [syncPresetSites] 会先按
  /// 地址认领一次，把对得上预置地址的站点补记进来，之后的差异才准。
  final List<String> presetIds;

  Branding branding;

  SiteProfile? get active {
    final String? id = activeSiteId;
    if (id != null) {
      for (final SiteProfile s in sites) {
        if (s.id == id) return s;
      }
    }
    return sites.isEmpty ? null : sites.first;
  }

  SiteProfile? byId(String? id) {
    if (id == null) return null;
    for (final SiteProfile s in sites) {
      if (s.id == id) return s;
    }
    return null;
  }

  /// 同一个地址是不是已经加过了（地址会被规整后比较，加站点时提示用户，但不阻止）。
  SiteProfile? findByUrl(String url) {
    final String? normalized = normalizeUrl(url);
    if (normalized == null) return null;
    for (final SiteProfile s in sites) {
      if ((normalizeUrl(s.startUrl) ?? s.startUrl) == normalized) return s;
    }
    return null;
  }

  /// 加入站点。**按 id 去重**：同一个 id 已经在列表里就只把它设为"当前站点"，
  /// 不再塞一份重复条目。返回 true 表示这次真的新增了。
  ///
  /// 为什么必须去重：UI 上"添加站点"是「表单 → 新建档案 → 写进配置 → 打开浏览页」，
  /// 中间任何一次重试（用户连点、以后改成异步、或调用方忘了先查重）都会把同一个站点
  /// 写两遍，列表里出现两个一模一样的条目。浏览页是按 id 找站点的，重了只会更难查。
  bool addSite(SiteProfile site, {bool makeActive = true}) {
    if (byId(site.id) != null) {
      if (makeActive) activeSiteId = site.id;
      return false;
    }
    sites.add(site);
    if (makeActive || activeSiteId == null) activeSiteId = site.id;
    return true;
  }

  /// 删除站点；如果删的是当前站点，自动切到第一个。
  bool removeSite(String id) {
    final int i = sites.indexWhere((SiteProfile s) => s.id == id);
    if (i < 0) return false;
    sites.removeAt(i);
    if (activeSiteId == id) {
      activeSiteId = sites.isEmpty ? null : sites.first.id;
    }
    return true;
  }

  void moveSite(int from, int to) {
    if (from < 0 || from >= sites.length) return;
    final int target = to.clamp(0, sites.length - 1);
    final SiteProfile s = sites.removeAt(from);
    sites.insert(target, s);
  }

  void touch(SiteProfile site) {
    site.lastOpenedMs = nowMs();
    activeSiteId = site.id;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'version': 1,
        'sites': sites.map((SiteProfile s) => s.toJson()).toList(),
        if (activeSiteId != null) 'activeSiteId': activeSiteId,
        'maxConcurrentDownloads': maxConcurrentDownloads,
        if (downloadDir != null && downloadDir!.isNotEmpty) 'downloadDir': downloadDir,
        'askWhereToSave': askWhereToSave,
        'wifiOnlyDownloads': wifiOnlyDownloads,
        'loadImages': loadImages,
        'saveLogin': saveLogin,
        'closeToTray': closeToTray,
        'lastUpdateCheckMs': lastUpdateCheckMs,
        if (presetSignature.isNotEmpty) 'presetSignature': presetSignature,
        if (presetIds.isNotEmpty) 'presetIds': presetIds,
        'branding': branding.toJson(),
      };

  static ShellConfig fromJson(Object? raw) {
    final Map<dynamic, dynamic> map =
        raw is Map ? raw : const <dynamic, dynamic>{};

    final List<SiteProfile> list = <SiteProfile>[];
    final Object? rawSites = map['sites'];
    if (rawSites is List) {
      for (final Object? e in rawSites) {
        final SiteProfile? s = SiteProfile.tryFromJson(e);
        if (s != null) list.add(s);
      }
    }

    final ShellConfig config = ShellConfig(
      sites: list,
      branding: Branding.fromJson(map['branding']),
    );

    final Object? rawActive = map['activeSiteId'];
    config.activeSiteId = (rawActive is String && config.byId(rawActive) != null)
        ? rawActive
        : (list.isEmpty ? null : list.first.id);
    config.maxConcurrentDownloads =
        _clampInt(_asInt(map['maxConcurrentDownloads'], 2), 1, 6);
    config.downloadDir = _asString(map['downloadDir']);
    config.askWhereToSave = _asBool(map['askWhereToSave'], false);
    config.wifiOnlyDownloads = _asBool(map['wifiOnlyDownloads'], false);
    config.loadImages = _asBool(map['loadImages'], true);
    config.saveLogin = _asBool(map['saveLogin'], true);
    config.closeToTray = _asBool(map['closeToTray'], true);
    config.lastUpdateCheckMs = _asInt(map['lastUpdateCheckMs'], 0);
    config.presetSignature = _asString(map['presetSignature']) ?? '';

    final Object? rawPresetIds = map['presetIds'];
    if (rawPresetIds is List) {
      for (final Object? e in rawPresetIds) {
        if (e is String && e.trim().isNotEmpty) config.presetIds.add(e.trim());
      }
    }
    return config;
  }

  /// 首次启动 / 白标版启动：把预置站点建出来。
  /// 支持多个：填一个直达，填两个及以上进列表（singleSiteMode 在 Branding 里判）。
  static ShellConfig bootstrap(Branding branding) {
    final ShellConfig config = ShellConfig(branding: branding);
    final Set<String> seen = <String>{};
    for (final PresetSite item in branding.effectivePresetSites) {
      final String? url = normalizeUrl(item.url.trim());
      // 无效地址 / 重复地址都跳过：一个写错不能拖垮其余站点，
      // 同一站点写两遍也不该在列表里出现两次。
      if (url == null || !seen.add(url)) continue;

      final String name = (item.name ?? '').trim();
      final SiteProfile site = SiteProfile(
        id: newId(),
        name: name.isEmpty ? guessSiteName(url) : name,
        startUrl: url,
        themeColor: branding.themeColor,
        createdAtMs: nowMs(),
      );
      // 必须 makeActive: false —— addSite 默认会把新站点设为当前，
      // 循环里一路覆盖下来，"当前站点"会变成最后一个预置站点。
      // 多站点时这会让列表里高亮错人（用户看到的第一个站点却不是当前站点）。
      config.addSite(site, makeActive: false);
      // 记下来源：下一版预置换了站点时，靠这份名单精确删掉"上一版的预置"，
      // 而不是靠地址猜（用户改名/改地址后就猜不出来了）。
      config.presetIds.add(site.id);
    }
    // 当前站点固定为第一个：空列表时保持 null。
    config.activeSiteId = config.sites.isEmpty ? null : config.sites.first.id;
    config.presetSignature = branding.presetSignature;
    return config;
  }

  /// 把这一版白标包预置的站点同步进**已有**配置。
  ///
  /// 为什么必须有这一步：配置文件一旦存在，[ConfigFile.load] 走的是
  /// [ShellConfig.fromJson]，[bootstrap] 再也不会跑 —— 预置站点永远进不来。
  /// 用户先装通用壳、再装白标包（同包名，配置文件保留），或者白标包升级换了
  /// 站点，看到的都是上一版的列表；上一版是通用壳时就是个空列表，看着像
  /// "构建出来的包是空壳"。
  ///
  /// 同步规则（按 [presetIds] 精确 diff，不是按地址猜）：
  /// * 指纹没变 → 一个字节都不改（用户手动删掉的预置站点不会自己长回来）。
  /// * 指纹变了 → 先删「上一版预置生成、这一版不再预置」的站点，
  ///   再把这一版缺的补上。
  /// * 用户自己加的站点从不在 [presetIds] 里，任何情况下都不会被删。
  ///
  /// 老配置（写的时候还没有 [presetIds] 这个字段）会先做一次"认领"：
  /// 地址和这一版预置对得上的站点补记进 [presetIds]，这样从下一版起
  /// 差异就算得准。
  static ShellConfig syncPresetSites(ShellConfig config, Branding branding) {
    final String signature = branding.presetSignature;
    final List<PresetSite> items = branding.effectivePresetSites;

    // 这一版预置的地址集合（规整后）—— 同时也是"哪些站点算预置"的判定依据。
    final Set<String> wanted = <String>{};
    for (final PresetSite item in items) {
      final String? url = normalizeUrl(item.url.trim());
      if (url != null) wanted.add(url);
    }

    if (config.presetSignature == signature) {
      // 同一版：只补做一次认领（老配置 presetIds 为空时才需要），
      // 别的都不动 —— 用户删掉的东西绝不能因为一次重启就复活。
      config.adoptPresetIds(wanted);
      return config;
    }
    config.presetSignature = signature;

    // 1) 先删：上一版预置建过、这一版不再预置的站点。
    final Set<String> previous = config.presetIds.toSet();
    final Set<String> dropped = <String>{};
    if (previous.isNotEmpty) {
      config.sites.removeWhere((SiteProfile s) {
        final String url = normalizeUrl(s.startUrl) ?? s.startUrl;
        final bool drop = previous.contains(s.id) && !wanted.contains(url);
        if (drop) dropped.add(s.id);
        return drop;
      });
    }

    // 2) 再补：这一版预置里有、列表里还没有的地址。
    final Set<String> existing = <String>{};
    for (final SiteProfile s in config.sites) {
      existing.add(normalizeUrl(s.startUrl) ?? s.startUrl);
    }

    final List<String> nextIds = <String>[];
    for (final String id in config.presetIds) {
      if (dropped.contains(id)) continue;
      if (config.byId(id) != null) nextIds.add(id);
    }
    for (final PresetSite item in items) {
      final String? url = normalizeUrl(item.url.trim());
      if (url == null || !existing.add(url)) continue;
      final String name = (item.name ?? '').trim();
      final SiteProfile site = SiteProfile(
        id: newId(),
        name: name.isEmpty ? guessSiteName(url) : name,
        startUrl: url,
        themeColor: branding.themeColor,
        createdAtMs: nowMs(),
      );
      config.sites.add(site);
      nextIds.add(site.id);
    }
    config.presetIds
      ..clear()
      ..addAll(nextIds);

    // 当前站点被删掉时自动落到第一个，否则列表页没有"当前"。
    if (config.sites.isEmpty) {
      config.activeSiteId = null;
    } else if (config.byId(config.activeSiteId) == null) {
      config.activeSiteId = config.sites.first.id;
    }
    return config;
  }

  /// 把地址和这一版预置对得上的已有站点认作"预置生成"，补记进 [presetIds]。
  ///
  /// 只处理老配置（[presetIds] 为空）。这一步是为了让下一版预置换站点时
  /// 能精准删，而不是留下一堆再也删不掉的旧条目。
  void adoptPresetIds(Set<String> wanted) {
    if (wanted.isEmpty || presetIds.isNotEmpty) return;
    for (final SiteProfile s in sites) {
      final String url = normalizeUrl(s.startUrl) ?? s.startUrl;
      if (wanted.contains(url)) presetIds.add(s.id);
    }
  }
}

/// 配置文件读写：原子写，读坏了自动备份。
class ConfigFile {
  ConfigFile(this.file);

  final File file;

  static const String defaultFileName = 'webshell.json';

  ShellConfig load([Branding fallback = Branding.generic]) {
    if (!file.existsSync()) return ShellConfig.bootstrap(fallback);
    try {
      final Object? raw = jsonDecode(file.readAsStringSync());
      final ShellConfig config = ShellConfig.fromJson(raw);
      // 配置文件存在 = 这不是首次启动，但预置站点可能换了（换包 / 白标升级），
      // 所以读完还要和这一版的 branding 对一次指纹。
      final int sitesBefore = config.sites.length;
      final String sigBefore = config.presetSignature;
      final String idsBefore = config.presetIds.join(',');
      final ShellConfig synced = ShellConfig.syncPresetSites(config, fallback);
      // 同步结果必须立刻落盘：指纹不持久化的话，每次启动都会重新同步一遍，
      // 用户手动删掉的预置站点下次启动又会长回来。presetIds 的"认领"同理 ——
      // 只补记一次，之后按 id 精确 diff 才不会误删用户自己的站点。
      if (synced.sites.length != sitesBefore ||
          synced.presetSignature != sigBefore ||
          synced.presetIds.join(',') != idsBefore) {
        try {
          save(synced);
        } catch (_) {
          // 目录只读之类：本次启动照常用同步后的配置，下次再试
        }
      }
      return synced;
    } catch (_) {
      // 配置坏了不能让 App 起不来：留证据，然后从默认配置开始。
      try {
        file.copySync('${file.path}.corrupt');
      } catch (_) {
        // 备份失败也不影响启动
      }
      return ShellConfig.bootstrap(fallback);
    }
  }

  void save(ShellConfig config) {
    final Directory dir = file.parent;
    if (!dir.existsSync()) dir.createSync(recursive: true);
    final String text = const JsonEncoder.withIndent('  ').convert(config.toJson());
    final File tmp = File('${file.path}.tmp');
    tmp.writeAsStringSync(text, flush: true);
    // Windows 上 rename 到已存在的文件会失败，先删目标。
    if (file.existsSync()) file.deleteSync();
    tmp.renameSync(file.path);
  }
}

int _clampInt(int value, int low, int high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

String? _asString(Object? v) {
  if (v is String) {
    final String s = v.trim();
    return s.isEmpty ? null : s;
  }
  return null;
}

int _asInt(Object? v, int fallback) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v.trim()) ?? fallback;
  return fallback;
}

bool _asBool(Object? v, bool fallback) {
  if (v is bool) return v;
  if (v is num) return v != 0;
  if (v is String) {
    final String s = v.trim().toLowerCase();
    if (s == 'true' || s == '1' || s == 'yes') return true;
    if (s == 'false' || s == '0' || s == 'no') return false;
  }
  return fallback;
}
