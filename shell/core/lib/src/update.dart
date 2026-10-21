/// 更新检查：拉一个 JSON，比版本号，返回"有没有新版"。
///
/// 为什么自己写而不是上 upgrader/ota_update 这类插件：需求只是
/// "GET 一个 JSON → 语义化版本比较 → UI 提示"，dart:io 的 HttpClient
/// 十几行就够，不值得为此引入一串传递依赖（还要过 AGP/MSVC 两端编译）。
///
/// JSON 约定（CI 输入 update_url 指向它）：
/// ```json
/// { "version": "1.2.0", "url": "https://…/app.apk", "note": "修复了下载" }
/// ```
/// `version` 必填；`url` 是新版本下载页/安装包地址；`note` 可选，展示用。
library;

import 'dart:convert';
import 'dart:io';

import 'models.dart';

/// 一次检查的结果。null = 没有新版（或没配检查地址）。
class UpdateInfo {
  const UpdateInfo({required this.version, required this.url, this.note});

  final String version;
  final String url;
  final String? note;
}

class UpdateChecker {
  UpdateChecker._();

  /// 拉取并比较。[Branding.updateUrl] 为空直接返回 null（通用壳默认不检查）。
  ///
  /// 网络失败/超时/JSON 不合法都返回 null：更新检查永远不该让用户看到报错弹窗，
  /// "查不到"和"没有新版"在体验上是同一件事。
  static Future<UpdateInfo?> fetch(Branding branding) async {
    final String? url = (branding.updateUrl ?? '').trim().isEmpty
        ? null
        : branding.updateUrl!.trim();
    if (url == null) return null;

    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
      final HttpClientRequest req = await client
          .getUrl(Uri.parse(url))
          .timeout(const Duration(seconds: 8));
      req.headers.set(HttpHeaders.userAgentHeader,
          'WebShell-UpdateCheck/${branding.appVersion}');
      final HttpClientResponse res =
          await req.close().timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;

      final String body = await res
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 10));
      final Object? raw = jsonDecode(body);
      if (raw is! Map) return null;

      final String? remoteVersion = _cleanVersion(raw['version']);
      if (remoteVersion == null) return null;
      if (!isNewer(remoteVersion, branding.appVersion)) return null;

      return UpdateInfo(
        version: remoteVersion,
        url: (raw['url'] is String && (raw['url'] as String).trim().isNotEmpty)
            ? (raw['url'] as String).trim()
            : url,
        note: raw['note'] is String ? (raw['note'] as String).trim() : null,
      );
    } catch (_) {
      return null;
    } finally {
      client?.close(force: true);
    }
  }

  static String? _cleanVersion(Object? v) {
    if (v is! String) return null;
    final String s = v.trim();
    return s.isEmpty ? null : s;
  }

  /// 语义化版本比较：`a` 严格大于 `b` 才返回 true。
  ///
  /// 规则（按段从左到右）：
  /// * 段数不同补 `0`（`1.2` == `1.2.0`，`1.2.0.1` > `1.2`）；
  /// * 带后缀的段先取**前导数字**比较（`1.2.1-beta` 第三段取 1，
  ///   所以 > `1.2.0`）；
  /// * 前导数字相等时，**纯数字段 > 带后缀段**（`1.2.0` > `1.2.0-beta`，
  ///   即正式版高于预发布版——字符串序 `'0-beta' > '0'` 与习惯相反，必须特判）；
  /// * 都带后缀按字符串比（`beta` < `rc` 恰好符合习惯）；
  /// * `+build` 元数据不参与比较。
  /// * 一侧无数字前缀（乱输入）：有数字的一侧高，保证不抛异常、结果稳定。
  static bool isNewer(String a, String b) {
    final List<String> sa = _stripBuild(a.trim());
    final List<String> sb = _stripBuild(b.trim());
    final int n = sa.length > sb.length ? sa.length : sb.length;
    for (int i = 0; i < n; i++) {
      final String pa = i < sa.length ? sa[i] : '0';
      final String pb = i < sb.length ? sb[i] : '0';
      final int? na = _numPrefix(pa);
      final int? nb = _numPrefix(pb);
      if (na != null && nb != null) {
        if (na != nb) return na > nb;
      } else if (na != null) {
        return true;
      } else if (nb != null) {
        return false;
      }
      // 前导数字相等（或都无数字）：纯数字段视为更高（正式 > 预发布）。
      final bool paPlain = int.tryParse(pa) != null;
      final bool pbPlain = int.tryParse(pb) != null;
      if (paPlain != pbPlain) return paPlain;
      final int c = pa.compareTo(pb);
      if (c != 0) return c > 0;
    }
    return false;
  }

  /// 段的前导数字（`'0-beta'` → 0；`'x'` → null）。
  static int? _numPrefix(String s) {
    final RegExpMatch? m = _leadingDigits.firstMatch(s);
    return m == null ? null : int.tryParse(m.group(1)!);
  }

  static final RegExp _leadingDigits = RegExp(r'^(\d+)');

  /// 去掉 `+build` 元数据（语义化版本里它不参与比较）。
  static List<String> _stripBuild(String v) {
    final String core = v.split('+').first;
    return core
        .split('.')
        .map((String s) => s.trim())
        .where((String s) => s.isNotEmpty)
        .toList();
  }
}
