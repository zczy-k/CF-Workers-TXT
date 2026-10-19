/// 请求头组装：站点自定义头 + UA + Referer + Cookie + Basic Auth → 最终请求头。
///
/// 下载器和引擎适配层共用这套规则，避免"网页里能看、下载下来是 403"这类不一致。
library;

import 'dart:convert';

import 'models.dart';

/// 这些头由传输层自己决定，站点配置里写了也不能放行 —— 放行反而会把请求弄坏
/// （比如手工设了错的 Content-Length，服务端会直接挂住等数据）。
const Set<String> kForbiddenHeaderNames = <String>{
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'range',
};

/// 组装一次请求要用的头。
///
/// [cookies] 由调用方从引擎的 Cookie 仓库取（按 URL 过滤过），
/// [basicPassword] 来自系统安全存储（绝不来自配置文件）。
Map<String, String> buildRequestHeaders({
  required SiteProfile site,
  Iterable<ShellCookie> cookies = const <ShellCookie>[],
  String? referer,
  String? userAgentOverride,
  String? basicUser,
  String? basicPassword,
}) {
  final Map<String, String> out = <String, String>{};

  site.headers.forEach((String key, String value) {
    final String k = key.trim();
    if (k.isEmpty || value.isEmpty) return;
    if (kForbiddenHeaderNames.contains(k.toLowerCase())) return;
    out[k] = value;
  });

  final String ua = (userAgentOverride ?? site.userAgent ?? '').trim();
  if (ua.isNotEmpty) out['User-Agent'] = ua;

  if (referer != null && referer.isNotEmpty) out['Referer'] = referer;

  if (basicUser != null && basicUser.isNotEmpty && basicPassword != null) {
    out['Authorization'] = basicAuthHeader(basicUser, basicPassword);
  }

  final String cookie = ShellCookie.headerValue(cookies);
  if (cookie.isNotEmpty) out['Cookie'] = cookie;

  return out;
}

/// `Basic base64(user:pass)`。
///
/// 注意：base64 不是加密，只是协议要求的形式；所以明文密码必须走 HTTPS，
/// 而我们只在用户自己配了 Basic Auth 的站点上才用它。
String basicAuthHeader(String user, String password) =>
    'Basic ${base64Encode(utf8.encode('$user:$password'))}';

/// 把用户手录的"每行一个 `Key: Value`"解析成头表（设置页用）。
///
/// 宽容：忽略空行、`#` 注释、没有冒号的行、以及被禁的头。
Map<String, String> parseHeaderLines(String text) {
  final Map<String, String> out = <String, String>{};
  for (final String raw in text.split('\n')) {
    final String line = raw.trim();
    if (line.isEmpty || line.startsWith('#') || line.startsWith('//')) continue;
    final int i = line.indexOf(':');
    if (i <= 0) continue;
    final String key = line.substring(0, i).trim();
    final String value = line.substring(i + 1).trim();
    if (key.isEmpty || value.isEmpty) continue;
    if (kForbiddenHeaderNames.contains(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/// 反向：头表 → 可编辑文本（设置页回显用）。
String formatHeaderLines(Map<String, String> headers) => headers.entries
    .where((MapEntry<String, String> e) => !kForbiddenHeaderNames.contains(e.key.toLowerCase()))
    .map((MapEntry<String, String> e) => '${e.key}: ${e.value}')
    .join('\n');
