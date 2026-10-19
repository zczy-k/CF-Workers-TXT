import 'dart:convert';

import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一个"站点档案"。
///
/// **站点地址必须运行时可改**是这个客户端的核心需求之一（域名 / Workers 项目以后会换），
/// 所以配置里唯一稳定的东西是 [id]，`baseUrl` / `adminUuid` 随时可改，
/// 改完只需要重新登录（密码不用重填）。
class SiteProfile {
  final String id;

  /// 用户自己起的名字（"我的文本盘"），用于多站点切换时区分
  final String label;

  final ServerConfig config;

  SiteProfile({required this.id, required this.label, required this.config});

  SiteProfile copyWith({String? label, ServerConfig? config}) =>
      SiteProfile(id: id, label: label ?? this.label, config: config ?? this.config);

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        ...config.toJson(),
      };

  static SiteProfile fromJson(Map<String, dynamic> j) => SiteProfile(
        id: (j['id'] ?? '').toString(),
        label: (j['label'] ?? '').toString(),
        config: ServerConfig.fromJson(j),
      );
}

/// 全局状态。**故意不引 provider / riverpod** —— 一个 ChangeNotifier + AnimatedBuilder
/// 就够了，少一个依赖就少一次 CI 崩的机会。
class AppStore extends ChangeNotifier {
  static const _kSites = 'sites';
  static const _kActive = 'activeId';

  static const _secure = FlutterSecureStorage();

  final List<SiteProfile> sites = [];

  String? _activeId;

  /// 当前站点的 API 客户端（切站点时会重建）
  CfwClient? client;

  /// 非敏感偏好
  bool autoWrap = true;
  double fontSize = 14;
  ConflictPolicy conflictPolicy = ConflictPolicy.keepBoth;

  bool ready = false;

  SiteProfile? get active {
    if (_activeId == null) return null;
    for (final s in sites) {
      if (s.id == _activeId) return s;
    }
    return null;
  }

  String? get activeId => _activeId;

  bool get hasSite => active != null;

  /// 应用私有目录：每个站点一个子目录，本地缓存 / 同步落地 / 状态文件互不污染
  Future<String> siteDir(String siteId) async {
    final base = await getApplicationSupportDirectory();
    return '${base.path}/$siteId';
  }

  Future<String> syncRoot(String siteId) async => '${await siteDir(siteId)}/files';

  Future<void> init() async {
    final sp = await SharedPreferences.getInstance();

    sites.clear();
    final raw = sp.getString(_kSites);
    if (raw != null && raw.isNotEmpty) {
      // 存的是一个 JSON 数组；解析失败就当没有站点（下次进向导），不崩
      try {
        final list = decodeSiteList(raw);
        sites.addAll(list);
      } catch (_) {}
    }
    _activeId = sp.getString(_kActive);

    autoWrap = sp.getBool('autoWrap') ?? true;
    fontSize = sp.getDouble('fontSize') ?? 14;

    if (sites.isNotEmpty && active == null) _activeId = sites.first.id;

    await _makeClient();
    ready = true;
    notifyListeners();
  }

  static List<SiteProfile> decodeSiteList(String raw) {
    final v = jsonDecode(raw);
    if (v is! List) return const [];
    return v
        .whereType<Map>()
        .map((e) => SiteProfile.fromJson(e.cast<String, dynamic>()))
        .where((s) => s.id.isNotEmpty)
        .toList();
  }

  Future<void> _persist() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kSites, jsonEncode([for (final s in sites) s.toJson()]));
    if (_activeId == null) {
      await sp.remove(_kActive);
    } else {
      await sp.setString(_kActive, _activeId!);
    }
  }

  Future<void> _makeClient() async {
    final s = active;
    if (s == null) {
      client = null;
      return;
    }
    final c = CfwClient(config: s.config);
    c.password = await passwordOf(s.id);
    c.session.adopt(await _cookieOf(s.id));
    client = c;
  }

  /// 重新建客户端（改了站点地址 / 密码之后调用）
  Future<void> reload() async {
    await _makeClient();
    notifyListeners();
  }

  // ------------------------------------------------------------ 站点增删改

  Future<SiteProfile> addSite({
    required String rawUrl,
    String label = '',
    String? password,
  }) async {
    final cfg = ServerConfig.tryParse(rawUrl);
    if (cfg == null || !cfg.isValid) {
      throw const ApiException('站点地址不对，请填完整的管理入口，例如 https://xxx.workers.dev/你的ADMIN_UUID');
    }
    final site = SiteProfile(
      id: 'site_${DateTime.now().microsecondsSinceEpoch}',
      label: label.trim().isEmpty ? cfg.baseUrl.replaceFirst(RegExp(r'^https?://'), '') : label.trim(),
      config: cfg.copyWith(hasPassword: password != null && password.isNotEmpty),
    );
    sites.add(site);
    _activeId = site.id;
    if (password != null && password.isNotEmpty) await _putPassword(site.id, password);
    await _persist();
    await reload();
    return site;
  }

  Future<void> updateSite(SiteProfile site, {String? password}) async {
    final i = sites.indexWhere((s) => s.id == site.id);
    if (i < 0) return;
    // 注意用**已存的档案**判断 hasPassword，而不是编辑页交上来的草稿：
    // 用户改域名时不会重新输入密码，草稿里的 hasPassword 是 false。
    // 若照草稿写回，App 会以为"站点没设密码"，从此不再走表单登录。
    final hasPw = (password != null && password.isNotEmpty) || sites[i].config.hasPassword;
    sites[i] = SiteProfile(
      id: site.id,
      label: site.label,
      config: site.config.copyWith(hasPassword: hasPw),
    );
    if (password != null && password.isNotEmpty) await _putPassword(site.id, password);
    await _persist();
    if (site.id == _activeId) await reload();
  }

  Future<void> useSite(String id) async {
    if (_activeId == id) return;
    _activeId = id;
    await _persist();
    await reload();
  }

  Future<void> removeSite(String id) async {
    sites.removeWhere((s) => s.id == id);
    await _secure.delete(key: 'pw:$id');
    await _secure.delete(key: 'cookie:$id');
    if (_activeId == id) _activeId = sites.isEmpty ? null : sites.first.id;
    await _persist();
    await reload();
  }

  Future<void> clearCookie(String id) async {
    await _secure.delete(key: 'cookie:$id');
    if (id == _activeId) client?.session.clear();
  }

  // ------------------------------------------------------------ 密码 / Cookie

  Future<String?> passwordOf(String siteId) => _secure.read(key: 'pw:$siteId');

  Future<void> _putPassword(String siteId, String password) async {
    if (password.isEmpty) {
      await _secure.delete(key: 'pw:$siteId');
    } else {
      await _secure.write(key: 'pw:$siteId', value: password);
    }
  }

  Future<String?> _cookieOf(String siteId) => _secure.read(key: 'cookie:$siteId');

  /// 登录成功后把会话 Cookie 存进安全存储（下次开 App 不用再登一次）
  Future<void> persistCookie() async {
    final c = client;
    final id = _activeId;
    if (c == null || id == null) return;
    final cookie = c.cookie;
    if (cookie == null) return;
    await _secure.write(key: 'cookie:$id', value: cookie);
  }

  // ------------------------------------------------------------ 偏好

  Future<void> setAutoWrap(bool v) async {
    autoWrap = v;
    notifyListeners();
    (await SharedPreferences.getInstance()).setBool('autoWrap', v);
  }

  Future<void> setFontSize(double v) async {
    fontSize = v;
    notifyListeners();
    (await SharedPreferences.getInstance()).setDouble('fontSize', v);
  }
}
