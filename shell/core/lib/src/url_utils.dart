/// URL 规整与判断。全部是纯函数，方便单测。
///
/// 所有规则都服务于一个目标：**用户粘什么进来都得能用**。
/// 他只记得 `example.com/oa`，我们补成 `https://example.com/oa`；
/// 他从聊天软件复制的地址常带引号、尖括号、首尾空格；他要是粘个 `ftp://` 就明确拒绝。
library;

/// 交给系统处理的协议：引擎不导航这些，转交 url_launcher / 系统应用。
const Set<String> kExternalSchemes = <String>{
  'tel',
  'mailto',
  'sms',
  'smsto',
  'geo',
  'market',
  'intent',
  'weixin',
  'alipay',
  'baiduyun',
  'thunder',
  'magnet',
  'ed2k',
};

/// 常见"点一下就下载"的扩展名：用于长按链接时的判断（用户已经明确说要下载）。
const Set<String> kDownloadExtensions = <String>{
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz',
  'apk', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage',
  'pdf', 'epub', 'mobi', 'azw3',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'log',
  'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg',
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic',
  'iso', 'img', 'bin', 'dat', 'db', 'sqlite',
  'torrent', 'ipa', 'jar', 'crx', 'xpi',
};

/// "WebView 基本没法内联显示"的类型 —— 点它当下载是**安全**的。
///
/// 和 [kDownloadExtensions] 的区别很重要：
/// * 自动接管一次点击/导航时用**这个**（保守）：图片、音视频、纯文本、csv/json
///   都被排除掉了，因为用户点它们多半是想"看"，把它们变成下载是倒退；
/// * 用户已经明说"我要下载"的场合（长按菜单「下载这个链接」）才用全量表。
const Set<String> kBinaryExtensions = <String>{
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'apk', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'appx', 'ipa',
  'pdf', 'epub', 'mobi', 'azw3', 'djvu',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'iso', 'img', 'bin', 'dat', 'db', 'sqlite', 'bak',
  'torrent', 'jar', 'crx', 'xpi', 'whl',
};

/// Windows 上不允许作为文件名的保留字。
const Set<String> _windowsReserved = <String>{
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
};

/// 用户输入 → 可加载的 http(s) 地址；不能用的返回 null。
///
/// 接受：`example.com`、`example.com:8080/a/b`、`http://192.168.1.5:8000`、
/// `localhost:3000`、带引号/尖括号/空格的粘贴、已带协议的大写协议。
/// 拒绝：`ftp://…`、`file://…`、空串、只有协议没有主机。
String? normalizeUrl(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;

  // 从聊天软件复制过来的常见包装（含中文/手机输入法的弯引号）
  s = s
      .replaceAll(RegExp(r'''^[\s<>"'`“”‘’]+'''), '')
      .replaceAll(RegExp(r'''[\s<>"'`“”‘’]+$'''), '');
  if (s.isEmpty) return null;

  if (s.startsWith('//')) {
    s = 'https:$s';
  }

  var addedScheme = false;
  if (!s.contains('://')) {
    s = 'https://$s';
    addedScheme = true;
  }

  final Uri? uri = Uri.tryParse(s);
  if (uri == null) return null;

  final String scheme = uri.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') return null;
  if (uri.host.isEmpty) return null;

  // 补协议时要求主机"长得像域名"：`note` 这种单词会被补成 https://note 而打不开，
  // 用户还以为是 App 坏了。显式写了 http://note 的则照常接受（内网单段主机名很常见）。
  if (addedScheme && !_looksLikeHost(uri.host)) return null;

  // 根路径的 `/` 去掉，`https://a.com` 与 `https://a.com/` 才算同一个站点。
  var path = uri.path;
  if (path == '/' && !uri.hasQuery && !uri.hasFragment) path = '';
  return _compose(uri, path: path);
}

/// 按 URL 规范拼回字符串。
///
/// 不用 `uri.toString()` 的原因：它会把根路径补成 `/`（`https://a.com/`），
/// 还会把"空 query/fragment"渲染成 `?#`；这些都会让"同一个站点"的比较失败。
/// 主机名保持 Dart 给的百分号编码形式（浏览器的 IDN 写法），显示时用 [prettyHost] 还原。
String _compose(Uri uri, {String? path}) {
  final String scheme = uri.scheme.toLowerCase();
  final String host = uri.host.contains(':') ? '[${uri.host}]' : uri.host;
  final String port = uri.hasPort ? ':${uri.port}' : '';
  final String userInfo = uri.userInfo.isEmpty ? '' : '${uri.userInfo}@';
  final String p = path ?? uri.path;
  final String query = uri.hasQuery ? '?${uri.query}' : '';
  final String fragment = uri.hasFragment ? '#${uri.fragment}' : '';
  return '$scheme://$userInfo$host$port$p$query$fragment';
}

bool _looksLikeHost(String host) {
  if (host == 'localhost') return true;
  if (host.contains('.')) return true; // 域名 / IPv4
  if (host.contains(':')) return true; // IPv6
  return false;
}

/// 主机名（小写）；解析不出来时返回空串。
String hostOf(String url) {
  final Uri? u = Uri.tryParse(url);
  return (u == null || u.host.isEmpty) ? '' : u.host.toLowerCase();
}

/// 去掉 `www.` 的主机名，用于比较与显示。
String bareHost(String host) {
  final String h = host.toLowerCase();
  return h.startsWith('www.') ? h.substring(4) : h;
}

/// 显示用的主机名：把 URL 规范的百分号编码还原成中文（IDN）。
///
/// URL 里中文域名必须是 `https://%E4%BE%8B%E5%AD%90...` 这种形式（浏览器也这么存），
/// 但地址栏里显示它就没法看了，所以显示时还原。
String prettyHost(String host) {
  if (host.isEmpty || !host.contains('%')) return host;
  try {
    return Uri.decodeComponent(host);
  } catch (_) {
    return host;
  }
}

/// 两个地址是不是"同一个站点"（含子域）。
///
/// 刻意不做完整 eTLD+1（那需要公共后缀列表，几百 KB），
/// 只按"主机相等或互为子域"判断——对"只允许站内导航"这个用途足够。
bool sameSite(String a, String b) {
  final String ha = bareHost(hostOf(a));
  final String hb = bareHost(hostOf(b));
  if (ha.isEmpty || hb.isEmpty) return false;
  if (ha == hb) return true;
  return ha.endsWith('.$hb') || hb.endsWith('.$ha');
}

bool isHttpUrl(String url) {
  final String scheme = (Uri.tryParse(url)?.scheme ?? '').toLowerCase();
  return scheme == 'http' || scheme == 'https';
}

/// 非 http(s) 的协议（小写）→ 返回它；是普通网页地址 → 返回 null。
/// 调用方据此决定"交给系统"还是"交给引擎"。
String? externalScheme(String url) {
  final String scheme = (Uri.tryParse(url)?.scheme ?? '').toLowerCase();
  if (scheme.isEmpty || scheme == 'http' || scheme == 'https') return null;
  return kExternalSchemes.contains(scheme) ? scheme : null;
}

/// 地址栏显示用：去掉协议与 `www.`，根路径只留主机。
String displayUrl(String url) {
  final Uri? u = Uri.tryParse(url);
  if (u == null || u.host.isEmpty) return url;
  final String host = prettyHost(bareHost(u.host));
  final String path = u.path == '/' ? '' : u.path;
  final String query = u.hasQuery ? '?${u.query}' : '';
  return '$host$path$query';
}

/// 猜一个站点名：主机名去掉 `www.`（用户可以随时改名）。
String guessSiteName(String url) {
  final String host = prettyHost(bareHost(hostOf(url)));
  return host.isEmpty ? url : host;
}

/// 站点的图标候选地址（按"质量从高到低"排）。
///
/// 只用站点自己的文件，不接任何第三方 favicon 服务——那是把用户访问了哪些站点
/// 告诉第三方，属于隐私问题。
List<String> faviconCandidates(String url) {
  final Uri? u = Uri.tryParse(url);
  if (u == null || u.host.isEmpty) return const <String>[];
  // 用 authority（不含 path/query/fragment），避免拼出 `…png?#` 这种脏地址
  final String origin = '${u.scheme.toLowerCase()}://${u.authority}';
  return <String>[
    '$origin/apple-touch-icon.png',
    '$origin/apple-touch-icon-precomposed.png',
    '$origin/favicon.ico',
    '$origin/favicon.png',
  ];
}

/// 路径里的扩展名（小写、不含点）；拿不到就返回空串。
///
/// 只看**最后一段**：`/v1.2/download` 的末段是 `download`（没有扩展名），
/// 不能把父目录里的 `.2` 当成扩展名。
String extensionOf(String path) {
  final String p = path.toLowerCase();
  final int slash = p.lastIndexOf('/');
  final int dot = p.lastIndexOf('.');
  if (dot < 0 || dot < slash + 1) return '';
  final String ext = p.substring(dot + 1);
  // 末段以点结尾（`/file.`）不算扩展名；带分隔符的也不是（防 `?`/`#` 混进来）
  if (ext.isEmpty || ext.contains('/') || ext.contains('?') || ext.contains('#')) {
    return '';
  }
  if (ext.length > 12) return '';
  return ext;
}

/// 按扩展名判断"这个地址八成是个文件"，用于长按链接直接下载（全量表）。
bool isProbablyDownloadUrl(String url) {
  final Uri? u = Uri.tryParse(url);
  if (u == null) return false;
  final String ext = extensionOf(u.path);
  if (ext.isEmpty) return u.query.toLowerCase().contains('download');
  return kDownloadExtensions.contains(ext);
}

/// **自动**接管点击/导航时用的保守判断：宁可漏，不可误伤。
///
/// 命中条件（二选一）：
///   * 扩展名属于 [kBinaryExtensions]（WebView 显示不了的类型）；
///   * 末段没有扩展名，但查询串里带 `download`（`?download=1`、`?action=download`）。
///
/// 不包含"链接文字写着下载"这类判断 —— 那是注入脚本在页面里做的事（能拿到 DOM）。
bool isLikelyFileAttachment(String url) {
  final Uri? u = Uri.tryParse(url);
  if (u == null) return false;
  final String ext = extensionOf(u.path);
  if (ext.isNotEmpty) return kBinaryExtensions.contains(ext);
  return u.query.toLowerCase().contains('download');
}

/// URL → 候选文件名（已做安全清理）。
String fileNameFromUrl(String url, {String fallback = 'download'}) {
  final Uri? u = Uri.tryParse(url);
  if (u == null) return fallback;
  final List<String> segs =
      u.pathSegments.where((String s) => s.trim().isNotEmpty).toList();
  if (segs.isEmpty) return fallback;
  // pathSegments 已经是解码后的，别再 decodeComponent 一次（会破坏 %2520 这类）
  final String name = segs.last.trim();
  if (name.isEmpty) return fallback;
  return sanitizeFileName(name);
}

/// 文件名清理：跨平台安全（含 Windows 保留名与长度限制）。
String sanitizeFileName(String name, {int maxLength = 180}) {
  var s = name
      .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')
      .replaceAll(RegExp(r'[\x00-\x1F]'), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .replaceAll(RegExp(r'_+'), '_')
      .trim();
  // 开头的点/下划线/空白一律去掉：`.` 开头会变成隐藏文件，`..` 更是路径穿越的写法，
  // 而这里的前导下划线本来就是上面的替换产生的（`..\..\etc` → `_.._etc`）。
  s = s.replaceFirst(RegExp(r'^[.\s_]+'), '');
  if (s.isEmpty) return 'download';

  final String stem = s.split('.').first.toUpperCase();
  if (_windowsReserved.contains(stem)) s = '_$s';

  if (s.length > maxLength) {
    final int dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 12) {
      final String ext = s.substring(dot);
      s = s.substring(0, maxLength - ext.length) + ext;
    } else {
      s = s.substring(0, maxLength);
    }
  }
  return s;
}
