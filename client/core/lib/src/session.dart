import 'dart:async';
import 'dart:convert';

import 'config.dart';
import 'errors.dart';
import 'transport.dart';

/// 登录态。**只走表单登录**，不在本地算 `sha256(PASSWORD::ADMIN_UUID)`。
///
/// 为什么放弃"本地派生 Cookie"那条捷径：
/// 服务端的会话令牌是 `sha256(PASSWORD + '::' + ADMIN_UUID)`，客户端确实可以自己算出来，
/// 少一次往返。但那就等于把**服务端的实现细节**焊死在客户端里 —— 哪天服务端换成
/// 加盐 / 换哈希 / 换 token 方案，所有已发布的 App 会一起失效，且用户无法自救
/// （只能回去用网页版）。
///
/// 表单登录只依赖公开行为：`POST /<ADMIN>?action=login` 拿 `Set-Cookie`。
/// 客户端不是浏览器，但**完全能吃表单**（`application/x-www-form-urlencoded` 对任何
/// HTTP 客户端都成立），所以这个"保守"选择没有任何实现代价，只多一次请求。
class Session {
  final ServerConfig config;
  final Transport transport;

  /// `wbauth=xxxx`，直接原样塞进 Cookie 头
  String? _cookie;

  Future<void>? _inflight;

  Session({required this.config, required this.transport, String? cookie}) : _cookie = cookie;

  String? get cookie => _cookie;

  /// 站点没设 PASSWORD 时服务端不鉴权，永远算"已登录"
  bool get isLoggedIn => !config.hasPassword || _cookie != null;

  /// 从持久化存储里恢复时用（app 侧用安全存储保存它）
  void adopt(String? cookie) => _cookie = cookie;

  void clear() => _cookie = null;

  /// 确保可以发请求。没有密码就直接返回；有密码但没 Cookie 就登录。
  ///
  /// **并发去重**：启动时好几个请求一起发，不能同时打 4 次登录接口
  /// （服务端登录失败 10 分钟错 8 次就锁，虽然成功不计数，但也没必要浪费）。
  Future<void> ensure({required String? password}) async {
    if (!config.hasPassword) return;
    if (_cookie != null) return;

    if (_inflight != null) {
      await _inflight;
      return;
    }

    if (password == null || password.isEmpty) {
      throw const ApiException('该站点需要管理员密码', status: 401, needPw: true);
    }

    final f = login(password);
    _inflight = f;
    try {
      await f;
    } finally {
      _inflight = null;
    }
  }

  /// 真正打登录接口。
  ///
  /// 两个必须做对的地方：
  ///   1. **关掉自动跟随重定向**（`followRedirects: false`）—— 服务端把 `Set-Cookie`
  ///      放在 **302** 的响应头上，跟随了就永远读不到。
  ///   2. body 是 urlencoded 的 `password=<值>`，服务端用 `request.formData()` 解析。
  Future<void> login(String password) async {
    final uri = config.adminUri.replace(queryParameters: {'action': 'login'});
    final res = await transport.send(HttpRequest(
      method: 'POST',
      uri: uri,
      headers: const {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Accept': 'text/html,application/json',
      },
      body: utf8.encode('password=${Uri.encodeQueryComponent(password)}'),
      followRedirects: false,
    ));

    final setCookie = res.header('set-cookie');
    if (setCookie != null) {
      final m = RegExp(r'wbauth=([^;,\s]+)').firstMatch(setCookie);
      if (m != null && (res.status == 302 || res.status == 303 || res.isOk)) {
        _cookie = 'wbauth=${m.group(1)}';
        return;
      }
    }

    switch (res.status) {
      case 401:
        throw const ApiException('密码错误', status: 401, needPw: true);
      case 429:
        throw const ApiException('密码错误次数过多，请 10 分钟后再试', status: 429);
      default:
        throw ApiException('登录失败（HTTP ${res.status}）', status: res.status);
    }
  }
}
