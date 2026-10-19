/// WebShell 的数据模型：站点档案、Cookie、品牌信息。
///
/// 全是纯数据 + JSON 往返，不含任何平台调用，所以能直接单测。
library;

import 'dart:math';

import 'url_utils.dart';

/// 当前毫秒时间戳。
int nowMs() => DateTime.now().millisecondsSinceEpoch;

final Random _rand = Random();

/// 生成一个够用的唯一 id（时间戳 + 随机数，纯 Dart，不引第三方 uuid）。
String newId() =>
    '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
    '-${_rand.nextInt(1 << 30).toRadixString(36)}';

/// 一条站点档案 —— App 里的一个"网站"。
///
/// 字段刻意都可变：它直接绑在设置页的表单上，改完存盘即可，
/// 没必要为了"不可变"把 UI 代码写成 copyWith 地狱。
class SiteProfile {
  SiteProfile({
    required this.id,
    required this.name,
    required this.startUrl,
    this.iconUrl,
    this.iconPath,
    this.themeColor = defaultThemeColor,
    this.userAgent,
    Map<String, String>? headers,
    this.hasBasicAuth = false,
    this.basicUser,
    this.stayInSite = false,
    this.allowSelfSignedCert = false,
    this.createdAtMs = 0,
    this.lastOpenedMs = 0,
  }) : headers = Map<String, String>.of(headers ?? const <String, String>{});

  /// 默认主题色（靛蓝），和客户端保持同一套观感。
  static const int defaultThemeColor = 0xFF2962FF;

  final String id;
  String name;
  String startUrl;

  /// 远端图标地址（apple-touch-icon / favicon）。
  String? iconUrl;

  /// 已缓存到本地的图标文件路径。
  String? iconPath;

  int themeColor;

  /// 留空 = 用引擎默认 UA。
  String? userAgent;

  /// 自定义请求头（如 `Authorization`）。密码本体不进配置。
  final Map<String, String> headers;

  /// 是否配了 Basic Auth（密码在系统安全存储里，这里只有标记）。
  bool hasBasicAuth;

  /// Basic Auth 用户名（密码不在配置文件里）。
  String? basicUser;

  /// 只允许站内导航；默认关 —— 关了才"像浏览器"。
  bool stayInSite;

  /// 信任这个站点的自签 / 过期证书（内网服务、自建站点常见）。
  ///
  /// 默认关：只对这一个站点放行，别的站点照常走系统校验 —— 绝不能做成
  /// "全局忽略证书错误"，那是把整个 App 的 HTTPS 安全性一次性废掉。
  bool allowSelfSignedCert;

  final int createdAtMs;
  int lastOpenedMs;

  String get host => prettyHost(hostOf(startUrl));

  /// 顶栏/列表里显示的名字：用户起的名字优先，否则退化成主机名。
  String get displayName {
    final String n = name.trim();
    if (n.isNotEmpty) return n;
    final String h = host;
    return h.isEmpty ? startUrl : h;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'startUrl': startUrl,
        if (iconUrl != null && iconUrl!.isNotEmpty) 'iconUrl': iconUrl,
        if (iconPath != null && iconPath!.isNotEmpty) 'iconPath': iconPath,
        'themeColor': themeColor,
        if (userAgent != null && userAgent!.isNotEmpty) 'userAgent': userAgent,
        if (headers.isNotEmpty) 'headers': headers,
        if (hasBasicAuth) 'hasBasicAuth': true,
        if (basicUser != null && basicUser!.isNotEmpty) 'basicUser': basicUser,
        if (stayInSite) 'stayInSite': true,
        if (allowSelfSignedCert) 'allowSelfSignedCert': true,
        'createdAtMs': createdAtMs,
        'lastOpenedMs': lastOpenedMs,
      };

  /// 宽容解析：坏数据返回 null。
  ///
  /// 配置文件是用户可能手改的东西（也可能被掉电截断），一条烂记录不该让整个 App 起不来。
  static SiteProfile? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? rawUrl = raw['startUrl'];
    final String? url = rawUrl is String ? normalizeUrl(rawUrl) : null;
    if (url == null) return null;

    final Object? rawId = raw['id'];
    final String id =
        (rawId is String && rawId.trim().isNotEmpty) ? rawId : newId();

    final Map<String, String> headers = <String, String>{};
    final Object? rawHeaders = raw['headers'];
    if (rawHeaders is Map) {
      rawHeaders.forEach((Object? k, Object? v) {
        if (k is String && k.trim().isNotEmpty && v is String) {
          headers[k] = v;
        }
      });
    }

    final Object? rawName = raw['name'];
    return SiteProfile(
      id: id,
      name: rawName is String && rawName.trim().isNotEmpty
          ? rawName.trim()
          : guessSiteName(url),
      startUrl: url,
      iconUrl: _asString(raw['iconUrl']),
      iconPath: _asString(raw['iconPath']),
      themeColor: _asInt(raw['themeColor'], defaultThemeColor),
      userAgent: _asString(raw['userAgent']),
      headers: headers,
      hasBasicAuth: _asBool(raw['hasBasicAuth'], false),
      basicUser: _asString(raw['basicUser']),
      stayInSite: _asBool(raw['stayInSite'], false),
      allowSelfSignedCert: _asBool(raw['allowSelfSignedCert'], false),
      createdAtMs: _asInt(raw['createdAtMs'], 0),
      lastOpenedMs: _asInt(raw['lastOpenedMs'], 0),
    );
  }

  SiteProfile clone() => SiteProfile(
        id: id,
        name: name,
        startUrl: startUrl,
        iconUrl: iconUrl,
        iconPath: iconPath,
        themeColor: themeColor,
        userAgent: userAgent,
        headers: headers,
        hasBasicAuth: hasBasicAuth,
        basicUser: basicUser,
        stayInSite: stayInSite,
        allowSelfSignedCert: allowSelfSignedCert,
        createdAtMs: createdAtMs,
        lastOpenedMs: lastOpenedMs,
      );
}

/// 一条 Cookie。引擎（WebView / WebView2）给我们的就是这些，我们原样带回请求头里。
class ShellCookie {
  const ShellCookie({
    required this.name,
    required this.value,
    this.domain,
    this.path = '/',
    this.secure = false,
    this.httpOnly = false,
    this.expiresMs,
  });

  final String name;
  final String value;
  final String? domain;
  final String path;
  final bool secure;
  final bool httpOnly;

  /// 会话 Cookie 为 null；`0` 一般也不是有效的过期时间。
  final int? expiresMs;

  bool get isExpired {
    final int? e = expiresMs;
    return e != null && e > 0 && e <= nowMs();
  }

  /// 这个 Cookie 该不该出现在 [url] 的请求里。
  bool matchesUrl(Uri url) {
    if (isExpired) return false;
    if (secure && url.scheme != 'https') return false;
    final String d = (domain ?? '').toLowerCase();
    if (d.isNotEmpty) {
      final String h = url.host.toLowerCase();
      final String bare = d.startsWith('.') ? d.substring(1) : d;
      if (h != bare && !h.endsWith('.$bare')) return false;
    }
    final String p = path.isEmpty ? '/' : path;
    if (p != '/' && !url.path.startsWith(p)) return false;
    return true;
  }

  /// 拼成 `Cookie:` 请求头的值。
  static String headerValue(Iterable<ShellCookie> cookies) => cookies
      .where((ShellCookie c) => !c.isExpired && c.name.isNotEmpty)
      .map((ShellCookie c) => '${c.name}=${c.value}')
      .join('; ');

  /// 从 `Set-Cookie` 的值解析（引擎大多直接给结构体，这个留给下载器/自测用）。
  static ShellCookie? tryParse(String setCookie, {String? defaultDomain}) {
    final List<String> parts = setCookie.split(';');
    if (parts.isEmpty) return null;
    final int eq = parts.first.indexOf('=');
    if (eq <= 0) return null;
    final String name = parts.first.substring(0, eq).trim();
    final String value = parts.first.substring(eq + 1).trim();
    if (name.isEmpty) return null;

    String domain = defaultDomain ?? '';
    String path = '/';
    bool secure = false;
    bool httpOnly = false;
    int? expires;
    for (final String raw in parts.skip(1)) {
      final String attr = raw.trim();
      final int i = attr.indexOf('=');
      final String key = (i < 0 ? attr : attr.substring(0, i)).trim().toLowerCase();
      final String val = i < 0 ? '' : attr.substring(i + 1).trim();
      switch (key) {
        case 'domain':
          domain = val.startsWith('.') ? val.substring(1) : val;
          break;
        case 'path':
          path = val.isEmpty ? '/' : val;
          break;
        case 'secure':
          secure = true;
          break;
        case 'httponly':
          httpOnly = true;
          break;
        case 'max-age':
          final int? secs = int.tryParse(val);
          if (secs != null) expires = nowMs() + secs * 1000;
          break;
        case 'expires':
          final DateTime? dt = _tryParseHttpDate(val);
          if (dt != null) expires = dt.millisecondsSinceEpoch;
          break;
      }
    }
    return ShellCookie(
      name: name,
      value: value,
      domain: domain.isEmpty ? null : domain,
      path: path,
      secure: secure,
      httpOnly: httpOnly,
      expiresMs: expires,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name,
        'value': value,
        if (domain != null && domain!.isNotEmpty) 'domain': domain,
        'path': path,
        if (secure) 'secure': true,
        if (httpOnly) 'httpOnly': true,
        if (expiresMs != null) 'expiresMs': expiresMs,
      };

  static ShellCookie? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final String name = _asString(raw['name']) ?? '';
    if (name.isEmpty) return null;
    return ShellCookie(
      name: name,
      value: _asString(raw['value']) ?? '',
      domain: _asString(raw['domain']),
      path: _asString(raw['path']) ?? '/',
      secure: _asBool(raw['secure'], false),
      httpOnly: _asBool(raw['httpOnly'], false),
      expiresMs: raw['expiresMs'] is int ? raw['expiresMs'] as int : null,
    );
  }
}

DateTime? _tryParseHttpDate(String value) {
  // HttpDate 在 dart:io 里；这里手写，避免 core 的模型层依赖 dart:io。
  const List<String> months = <String>[
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  ];
  final RegExp re = RegExp(
      r'^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})');
  final RegExpMatch? m = re.firstMatch(value.trim());
  if (m == null) return null;
  final int? day = int.tryParse(m.group(1)!);
  final int month = months.indexOf(m.group(2)!.toLowerCase()) + 1;
  final int? year = int.tryParse(m.group(3)!);
  final int? hour = int.tryParse(m.group(4)!);
  final int? minute = int.tryParse(m.group(5)!);
  final int? second = int.tryParse(m.group(6)!);
  if (day == null || month == 0 || year == null ||
      hour == null || minute == null || second == null) {
    return null;
  }
  return DateTime.utc(year, month, day, hour, minute, second);
}

/// 品牌/白标信息。
///
/// 构建期由 CI 写进 `assets/preset.json`（仓库里也有一份"通用壳"默认值），
/// 首个启动版本把它落进配置；之后用户改名换图标都不影响它。
class Branding {
  const Branding({
    this.appName = 'WebShell',
    this.themeColor = SiteProfile.defaultThemeColor,
    this.presetUrl,
    this.presetName,
    this.allowAddSite = true,
    this.showAddressBar = true,
  });

  final String appName;
  final int themeColor;

  /// 预置站点入口 —— 白标版的核心。
  final String? presetUrl;
  final String? presetName;

  /// 白标版是否仍允许用户自己加站点（默认允许）。
  final bool allowAddSite;

  /// 是否显示地址栏（想更"像原生 App"可以关）。
  final bool showAddressBar;

  static const Branding generic = Branding();

  bool get isWhiteLabel => (presetUrl ?? '').trim().isNotEmpty;

  /// 白标 + 禁止加站 = 单站点直达模式：启动直接进站点内容页，不显示站点列表。
  /// 只要还允许加站（或根本不是白标），就维持列表首屏，方便用户管理自己的站点。
  bool get singleSiteMode => isWhiteLabel && !allowAddSite;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'appName': appName,
        'themeColor': themeColor,
        if (presetUrl != null && presetUrl!.isNotEmpty) 'presetUrl': presetUrl,
        if (presetName != null && presetName!.isNotEmpty) 'presetName': presetName,
        'allowAddSite': allowAddSite,
        'showAddressBar': showAddressBar,
      };

  static Branding fromJson(Object? raw) {
    if (raw is! Map) return generic;
    final Object? rawUrl = raw['presetUrl'];
    return Branding(
      appName: _asString(raw['appName']) ?? 'WebShell',
      themeColor: _asInt(raw['themeColor'], SiteProfile.defaultThemeColor),
      presetUrl: rawUrl is String ? normalizeUrl(rawUrl) : null,
      presetName: _asString(raw['presetName']),
      allowAddSite: _asBool(raw['allowAddSite'], true),
      showAddressBar: _asBool(raw['showAddressBar'], true),
    );
  }
}

String? _asString(Object? v) {
  if (v is String) {
    final String s = v.trim();
    return s.isEmpty ? null : s;
  }
  if (v is num || v is bool) return v.toString();
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
