/// 站点配置：把用户输入的"一段文本"解析成可用坐标（baseUrl + adminUuid）。
///
/// 为什么单独一个类：**站点地址必须运行时可改**（域名 / Workers 项目以后会换），
/// 所以绝不允许把任何域名硬编码进代码。core 只负责解析与拼 URL，不负责持久化
/// —— 持久化由 app 侧用 shared_preferences / 安全存储完成，core 不依赖任何平台插件。
library;

class ServerConfig {
  /// 形如 `https://mysite.workers.dev`，**不带尾斜杠**，path 一律清空。
  final String baseUrl;

  /// `ADMIN_UUID`（管理入口的最后一段）。允许为空：用户可能只填了域名，
  /// 这时 app 会引导他补上这一段。
  final String adminUuid;

  /// 站点是否设了 `PASSWORD`（环境变量）。**这里不存密码本身**——
  /// 密码只在登录那一刻用一次，之后留下的是服务端发的会话 Cookie。
  final bool hasPassword;

  const ServerConfig({
    required this.baseUrl,
    this.adminUuid = '',
    this.hasPassword = false,
  });

  // ---------------------------------------------------------------- 坐标

  /// 管理入口：`https://<域名>/<ADMIN_UUID>`
  Uri get adminUri => Uri.parse('$baseUrl/$adminUuid');

  /// API 入口：`https://<域名>/<ADMIN_UUID>/api`
  Uri get apiUri => Uri.parse('$baseUrl/$adminUuid/api');

  /// 拼一个 API 请求地址：`?action=` 放在最前，其余参数跟随。
  Uri api(String action, [Map<String, String>? params]) {
    final q = <String, String>{'action': action};
    if (params != null) q.addAll(params);
    return apiUri.replace(queryParameters: q);
  }

  /// 管理端"文件直出"地址：`/<ADMIN>/f/<路径>`。
  /// 给原生客户端的图片 / 音视频 / PDF 预览直接用（带会话 Cookie 请求即可）。
  /// 路径必须**逐段百分号编码**，否则带中文 / 空格的路径一律 404。
  Uri fileUri(String path, {bool doc = false}) {
    final enc = path
        .split('/')
        .where((s) => s.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    final base = Uri.parse('$baseUrl/$adminUuid/f/$enc');
    return doc ? base.replace(queryParameters: {'doc': '1'}) : base;
  }

  // ---------------------------------------------------------------- 校验

  bool get isValid =>
      baseUrl.isNotEmpty &&
      adminUuid.isNotEmpty &&
      // 别写 `Uri.tryParse(baseUrl)?.host.isNotEmpty == true`：那依赖 `?.` 对整条
      // 选择器链的短路语义，写清楚 `?? ''` 就没有任何歧义了。
      (Uri.tryParse(baseUrl)?.host ?? '').isNotEmpty;

  // ---------------------------------------------------------------- 解析

  /// 把用户输入解析成配置。接受这些形式（末尾多余的段会被丢掉）：
  ///
  ///   https://mysite.workers.dev/a1b2c3d4   ← 网页端管理入口，整条粘贴
  ///   mysite.workers.dev/a1b2c3d4           ← 省掉 scheme
  ///   https://txt.example.com/secret/       ← 尾斜杠
  ///   https://mysite.workers.dev/a1b2c3d4/api  ← 连 API 路径一起粘进来
  ///   https://mysite.workers.dev            ← 只有域名（adminUuid 留空，由 UI 再问一次）
  ///
  /// 返回 null 只表示"连域名都不合法"，不表示"位置错了" —— 位置错了让服务端回 404
  /// 更直观，也比在客户端猜规则更不容易误伤（比如自定义口令里带奇怪字符）。
  static ServerConfig? tryParse(String raw, {bool hasPassword = false}) {
    var s = raw.trim();
    if (s.isEmpty) return null;

    // 没写协议就补 https：Cloudflare 上不存在 http 站点，猜 http 只会让用户多绕一圈
    if (!RegExp(r'^[a-zA-Z][a-zA-Z0-9+.\-]*://').hasMatch(s)) s = 'https://$s';

    final Uri u;
    try {
      u = Uri.parse(s);
    } catch (_) {
      return null;
    }
    if (u.host.isEmpty) return null;

    final segs = u.pathSegments.where((p) => p.isNotEmpty).toList();
    // 用户把 API 地址一起粘进来时，最后一段是 'api'，那不算 adminUuid
    if (segs.length > 1 && segs.last.toLowerCase() == 'api') segs.removeLast();

    // baseUrl 只保留 scheme + host +（非默认）端口，path / query / fragment 全部丢弃
    final base = Uri(
      scheme: u.scheme.isEmpty ? 'https' : u.scheme,
      host: u.host,
      port: u.hasPort ? u.port : null,
    ).toString();

    return ServerConfig(
      baseUrl: base,
      adminUuid: segs.isEmpty ? '' : segs.last,
      hasPassword: hasPassword,
    );
  }

  /// 只需要规范化域名时用它（解析失败返回 null）。
  static String? normalizeBase(String raw) => tryParse(raw)?.baseUrl;

  // ---------------------------------------------------------------- 持久化

  /// 多站点档案用的 JSON。**注意不含密码**（见 [hasPassword]）。
  factory ServerConfig.fromJson(Map<String, dynamic> j) => ServerConfig(
        baseUrl: (j['baseUrl'] ?? '').toString(),
        adminUuid: (j['adminUuid'] ?? '').toString(),
        hasPassword: j['hasPassword'] == true,
      );

  Map<String, dynamic> toJson() => {
        'baseUrl': baseUrl,
        'adminUuid': adminUuid,
        'hasPassword': hasPassword,
      };

  ServerConfig copyWith({String? baseUrl, String? adminUuid, bool? hasPassword}) => ServerConfig(
        baseUrl: baseUrl ?? this.baseUrl,
        adminUuid: adminUuid ?? this.adminUuid,
        hasPassword: hasPassword ?? this.hasPassword,
      );

  /// 界面上显示用的短名（域名 + 管理入口尾段），不泄露密码
  String get displayName => '$baseUrl/$adminUuid';

  @override
  String toString() => 'ServerConfig($displayName, hasPassword=$hasPassword)';

  @override
  bool operator ==(Object other) =>
      other is ServerConfig &&
      other.baseUrl == baseUrl &&
      other.adminUuid == adminUuid &&
      other.hasPassword == hasPassword;

  @override
  int get hashCode => Object.hash(baseUrl, adminUuid, hasPassword);
}
