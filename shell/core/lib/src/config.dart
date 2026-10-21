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
    Branding? branding,
  })  : sites = sites ?? <SiteProfile>[],
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
    return config;
  }

  /// 首次启动 / 白标版启动：把预置站点建出来。
  static ShellConfig bootstrap(Branding branding) {
    final ShellConfig config = ShellConfig(branding: branding);
    final String preset = (branding.presetUrl ?? '').trim();
    if (preset.isEmpty) return config;

    final String? url = normalizeUrl(preset);
    if (url == null) return config;

    final String name = (branding.presetName ?? '').trim();
    final SiteProfile site = SiteProfile(
      id: newId(),
      name: name.isEmpty ? guessSiteName(url) : name,
      startUrl: url,
      themeColor: branding.themeColor,
      createdAtMs: nowMs(),
    );
    config.addSite(site);
    return config;
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
      return ShellConfig.fromJson(raw);
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
