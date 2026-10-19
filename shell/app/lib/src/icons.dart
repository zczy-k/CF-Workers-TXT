import 'dart:io';

import 'package:webshell_core/webshell_core.dart';

/// 站点图标：抓站点自己的 favicon 缓存到本地。
///
/// 只用站点自己的文件，不接任何第三方 favicon 服务 —— 那等于把用户访问了哪些站点
/// 告诉第三方，属于隐私问题。
class IconFetcher {
  IconFetcher(this.cacheDir);

  final Directory cacheDir;

  /// 成功返回本地文件路径；全失败返回 null（UI 会退化成首字母方块）。
  Future<String?> fetch(SiteProfile site) async {
    if (!cacheDir.existsSync()) cacheDir.createSync(recursive: true);
    for (final String url in faviconCandidates(site.startUrl)) {
      final String? path = await _download(url, site);
      if (path != null) return path;
    }
    return null;
  }

  Future<String?> _download(String url, SiteProfile site) async {
    final HttpClient client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8);
    try {
      final HttpClientRequest req = await client.getUrl(Uri.parse(url));
      // 有些站点会看 UA 决定给不给图标
      req.headers.set('User-Agent', site.userAgent ?? 'Mozilla/5.0 (compatible; WebShell)');
      final HttpClientResponse resp = await req.close();
      if (resp.statusCode != 200) return null;

      final String mime = (resp.headers.contentType?.mimeType ?? '').toLowerCase();
      if (mime.isNotEmpty && !mime.startsWith('image/')) return null;
      // Flutter 画不出 SVG，别把它当图标存下来
      if (mime.contains('svg')) return null;

      final List<int> bytes = <int>[];
      await for (final List<int> chunk in resp) {
        bytes.addAll(chunk);
        if (bytes.length > 512 * 1024) return null; // 图标不该这么大
      }
      if (bytes.isEmpty) return null;

      final File out = File(joinPath(cacheDir.path, '${site.id}${_ext(mime, url)}'));
      await out.writeAsBytes(bytes, flush: true);
      return out.path;
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  String _ext(String mime, String url) {
    if (mime.contains('png')) return '.png';
    if (mime.contains('jpeg') || mime.contains('jpg')) return '.jpg';
    if (mime.contains('gif')) return '.gif';
    if (mime.contains('webp')) return '.webp';
    if (mime.contains('icon')) return '.ico';
    final int dot = url.lastIndexOf('.');
    if (dot > 0 && url.length - dot <= 5) return url.substring(dot);
    return '.png';
  }
}
