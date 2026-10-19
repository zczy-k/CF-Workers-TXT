import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_file_dialog/flutter_file_dialog.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:file_picker/file_picker.dart';
import 'package:webshell_core/webshell_core.dart';

import 'icons.dart';
import 'paths.dart';

/// 一个正在接收的 `blob:` 下载（前端生成的文件走这条通道）。
class _BlobSession {
  _BlobSession({required this.task, required this.sink});

  final DownloadTask task;
  final DownloadSink sink;
}

/// App 的全部运行时状态：站点、配置、下载队列、图标缓存、密码。
///
/// 逻辑尽量放在 core（可单测），这里只做"接线"：把 core 的下载队列接到引擎的
/// Cookie / UA 上，把配置落到磁盘，把变化通知给 UI。
class ShellState extends ChangeNotifier {
  ShellState._({
    required this.branding,
    required this.config,
    required this.configFile,
    required this.downloads,
    required this.icons,
    required this.secure,
    required this.downloadsFile,
  });

  final Branding branding;
  final ShellConfig config;
  final ConfigFile configFile;
  final DownloadManager downloads;
  final IconFetcher icons;
  final FlutterSecureStorage secure;
  final File downloadsFile;

  /// 引擎的真实 UA（向 WebView 问来的）。下载时带上它，站点才不会把我们当爬虫。
  String? engineUserAgent;

  final Map<String, _BlobSession> _blobs = <String, _BlobSession>{};
  Timer? _configTimer;
  Timer? _downloadsTimer;

  static Future<ShellState> create(Branding branding) async {
    final Directory dir = await appDataDir();
    final ConfigFile configFile =
        ConfigFile(File(joinPath(dir.path, ConfigFile.defaultFileName)));
    final ShellConfig config = configFile.load(branding);

    if (config.downloadDir == null || config.downloadDir!.isEmpty) {
      config.downloadDir = await defaultDownloadDirectory();
      configFile.save(config);
    }

    late final ShellState state;
    final DownloadManager downloads = DownloadManager(
      transport: FileDownloadTransport(),
      maxConcurrent: config.maxConcurrentDownloads,
      resolvePath: (DownloadTask task, String name) => state.resolveDownloadPath(name),
      headers: (DownloadTask task) => state.downloadHeaders(task),
    );

    state = ShellState._(
      branding: branding,
      config: config,
      configFile: configFile,
      downloads: downloads,
      icons: IconFetcher(await iconCacheDir()),
      secure: const FlutterSecureStorage(),
      downloadsFile: File(joinPath(dir.path, 'downloads.json')),
    );
    downloads.onChanged = (DownloadTask task) => state._onDownloadsChanged();
    state.restoreDownloads();
    return state;
  }

  @override
  void dispose() {
    _configTimer?.cancel();
    _downloadsTimer?.cancel();
    downloads.close();
    saveNow();
    saveDownloadsNow();
    super.dispose();
  }

  /// 只给单测用的构造：绕开 path_provider / 安全存储这些平台插件。
  ///
  /// 为什么要留这么一个口子：这台机器上真的漏过一次"添加站点只建了档案、没有写进
  /// 配置"，用户看到的是浏览页一句"这个站点已经被删除了"、首页永远空着。这类
  /// "UI 流程忘了调某个函数"的 bug，`flutter analyze` 和纯 Dart 单测都抓不到，
  /// 只有能把界面流程跑一遍的测试才抓得到 —— 见 `test/add_site_test.dart`。
  /// 传入的 [icons] 可以换成不联网的替身，避免测试里真的发 HTTP 请求。
  @visibleForTesting
  static ShellState forTest({
    required ShellConfig config,
    required File configFile,
    required File downloadsFile,
    Branding branding = Branding.generic,
    DownloadTransport? transport,
    IconFetcher? icons,
  }) {
    late final ShellState state;
    final DownloadManager downloads = DownloadManager(
      transport: transport ?? FileDownloadTransport(),
      maxConcurrent: config.maxConcurrentDownloads,
      resolvePath: (DownloadTask task, String name) => state.resolveDownloadPath(name),
      headers: (DownloadTask task) => state.downloadHeaders(task),
    );
    state = ShellState._(
      branding: branding,
      config: config,
      configFile: ConfigFile(configFile),
      downloads: downloads,
      icons: icons ?? IconFetcher(Directory.systemTemp),
      secure: const FlutterSecureStorage(),
      downloadsFile: downloadsFile,
    );
    downloads.onChanged = (DownloadTask task) => state._onDownloadsChanged();
    return state;
  }

  // ------------------------------------------------------------------ 配置

  void saveSoon() {
    _configTimer?.cancel();
    _configTimer = Timer(const Duration(milliseconds: 400), saveNow);
  }

  void saveNow() {
    try {
      configFile.save(config);
    } catch (_) {
      // 存不下去不该让 App 挂掉（磁盘满、权限被改），下次改动会再试
    }
  }

  /// 站点被改动过（改名、改地址、改头…），存盘并刷新界面。
  void siteEdited() {
    configFile.save(config);
    notifyListeners();
  }

  Future<void> addSite(SiteProfile site) async {
    final bool added = config.addSite(site);
    saveNow();
    notifyListeners();
    // 重复提交（同一个 id 已经在列表里）就不必再抓一次图标了
    if (added) unawaited(refreshIcon(site));
  }

  void removeSite(String id) {
    config.removeSite(id);
    saveNow();
    notifyListeners();
  }

  /// 打开站点：更新"最近使用"，顺手把它设为当前站点。
  void openSite(SiteProfile site) {
    config.touch(site);
    saveNow();
    notifyListeners();
  }

  /// 抓站点图标（走缓存，失败就退化成首字母方块）。
  Future<void> refreshIcon(SiteProfile site) async {
    final String? path = await icons.fetch(site);
    if (path == null) return;
    site.iconPath = path;
    saveNow();
    notifyListeners();
  }

  /// 清掉某个站点的登录态（只清这个域名的 Cookie，不影响别的站点）。
  Future<void> clearSiteData(SiteProfile site) async {
    try {
      final Uri? u = Uri.tryParse(site.startUrl);
      if (u == null) return;
      await CookieManager.instance()
          .deleteCookies(url: WebUri('${u.scheme}://${u.authority}'));
    } catch (_) {
      // 引擎不支持就算了，别把 UI 卡住
    }
  }

  Future<void> clearAllCookies() async {
    try {
      await CookieManager.instance().deleteAllCookies();
    } catch (_) {}
  }

  // ------------------------------------------------------------ Basic Auth

  String _basicKey(String siteId) => 'basic:$siteId';

  Future<void> setBasicPassword(String siteId, String? password) async {
    try {
      if (password == null || password.isEmpty) {
        await secure.delete(key: _basicKey(siteId));
      } else {
        await secure.write(key: _basicKey(siteId), value: password);
      }
    } catch (_) {}
  }

  Future<String?> basicPassword(String siteId) async {
    try {
      return await secure.read(key: _basicKey(siteId));
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------- 下载

  DownloadTask enqueueDownload({
    required String url,
    required String siteId,
    String? suggestedName,
    String? referer,
  }) {
    final DownloadTask task = downloads.enqueue(
      url: url,
      siteId: siteId,
      fileName: (suggestedName ?? '').trim().isEmpty ? null : suggestedName,
      referer: referer,
    );
    saveDownloadsSoon();
    notifyListeners();
    return task;
  }

  /// 落盘位置：目录取自设置，文件名唯一化，避免覆盖上一次的同名文件。
  Future<String> resolveDownloadPath(String name) async {
    return uniquePath(joinPath(_effectiveDownloadDir(), sanitizeFileName(name)));
  }

  /// 当前生效的下载目录（给 UI 显示用：用户最常问的就是"文件存哪了"）。
  String get downloadDirectoryLabel => _effectiveDownloadDir();

  String _effectiveDownloadDir() {
    final String? dir = config.downloadDir;
    // `content://` 是 Android 的 SAF 目录（P3 支持），现在还用不了，先落到应用目录
    if (dir != null && dir.isNotEmpty && !dir.startsWith('content://')) return dir;
    // 兜底也必须是"用户找得到的地方"：以前这里退到系统临时目录，
    // 结果文件确实下下来了，但没人能找到 —— 比失败还糟（静默）。
    return defaultDownloadDir();
  }

  /// 下载要带的请求头：站点自定义头 + 引擎 UA + Referer + Cookie（向引擎要）。
  ///
  /// 这几样缺一样，很多站点就会回 403 —— 这也正是"网页转 APP"工具下载失败的主因。
  Future<Map<String, String>> downloadHeaders(DownloadTask task) async {
    final SiteProfile? site = config.byId(task.siteId);
    final List<ShellCookie> cookies = <ShellCookie>[];

    for (final String target in <String>[task.referer ?? '', task.url]) {
      if (target.isEmpty || !target.startsWith('http')) continue;
      try {
        final List<Cookie> found =
            await CookieManager.instance().getCookies(url: WebUri(target));
        for (final Cookie c in found) {
          cookies.add(ShellCookie(
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path ?? '/',
            secure: c.isSecure ?? false,
            httpOnly: c.isHttpOnly ?? false,
            expiresMs: c.expiresDate,
          ));
        }
      } catch (_) {}
    }

    String? password;
    if (site != null && site.hasBasicAuth) {
      password = await basicPassword(site.id);
    }

    return buildRequestHeaders(
      site: site ??
          SiteProfile(id: task.siteId, name: '', startUrl: task.url),
      cookies: cookies,
      referer: task.referer,
      userAgentOverride: site?.userAgent ?? engineUserAgent,
      basicUser: site?.basicUser,
      basicPassword: password,
    );
  }

  void pauseDownload(String id) {
    downloads.pause(id);
    _onDownloadsChanged();
  }

  void resumeDownload(String id) {
    downloads.resume(id);
    _onDownloadsChanged();
  }

  Future<void> cancelDownload(String id) async {
    await downloads.cancel(id);
    _onDownloadsChanged();
  }

  void removeDownload(String id) {
    downloads.remove(id);
    _onDownloadsChanged();
  }

  void clearFinishedDownloads() {
    downloads.clearFinished();
    _onDownloadsChanged();
  }

  /// 「另存为」：Android 走系统选择器（SAF，不需要存储权限）；桌面端走系统保存对话框。
  /// 返回 null 表示成功（或用户取消），否则是错误信息。
  Future<String?> exportDownload(DownloadTask task) async {
    final String? path = task.savePath;
    if (path == null || path.isEmpty || !File(path).existsSync()) {
      return '文件还没下载完';
    }
    try {
      if (Platform.isAndroid) {
        await FlutterFileDialog.saveFile(
          params: SaveFileDialogParams(
            sourceFilePath: path,
            fileName: task.fileName,
          ),
        );
        return null;
      }
      final String? target = await FilePicker.getDirectoryPath(
        dialogTitle: '另存为：选择目标文件夹',
      );
      if (target == null || target.isEmpty) return null; // 用户取消
      await File(path).copy(uniquePath(joinPath(target, task.fileName)));
      return null;
    } catch (e) {
      return e.toString();
    }
  }

  // ------------------------------------------------- blob/data 导出通道

  Future<void> onBlobStart(Map<String, dynamic> payload) async {
    final String key = (payload['url'] as Object?)?.toString() ?? '';
    final String name = sanitizeFileName((payload['name'] as Object?)?.toString() ?? 'download');
    final int size = int.tryParse((payload['size'] as Object?)?.toString() ?? '') ?? 0;

    final String path = await resolveDownloadPath(name);
    final DownloadTask task = DownloadTask(
      id: 'blob-${DateTime.now().microsecondsSinceEpoch}',
      siteId: config.activeSiteId ?? '',
      url: key.isEmpty ? 'blob:' : key,
      fileName: name,
      savePath: path,
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    task.status = DownloadStatus.running;
    if (size > 0) task.total = size;

    final DownloadSink sink =
        await FileDownloadTransport().openSink(path, append: false);
    _blobs[key] = _BlobSession(task: task, sink: sink);
    downloads.tasks.insert(0, task);
    notifyListeners();
  }

  Future<void> onBlobData(Map<String, dynamic> payload) async {
    final _BlobSession? session = _blobs[(payload['url'] as Object?)?.toString() ?? ''];
    if (session == null) return;
    final String data = (payload['data'] as Object?)?.toString() ?? '';
    if (data.isEmpty) return;
    try {
      final List<int> bytes = base64Decode(data);
      session.sink.add(bytes);
      session.task.received += bytes.length;
      notifyListeners();
    } catch (e) {
      await onBlobError(<String, dynamic>{
        'url': (payload['url'] as Object?)?.toString() ?? '',
        'message': '解码失败：$e',
      });
    }
  }

  Future<void> onBlobEnd(Map<String, dynamic> payload) async {
    final String key = (payload['url'] as Object?)?.toString() ?? '';
    final _BlobSession? session = _blobs.remove(key);
    if (session == null) return;
    await session.sink.close();
    session.task.status = DownloadStatus.done;
    _onDownloadsChanged();
  }

  Future<void> onBlobError(Map<String, dynamic> payload) async {
    final String key = (payload['url'] as Object?)?.toString() ?? '';
    final _BlobSession? session = _blobs.remove(key);
    if (session == null) return;
    await session.sink.close();
    session.task.status = DownloadStatus.failed;
    session.task.error = (payload['message'] as Object?)?.toString() ?? '导出失败';
    try {
      final String? path = session.task.savePath;
      if (path != null) await File(path).delete();
    } catch (_) {}
    _onDownloadsChanged();
  }

  // ------------------------------------------------------------ 下载历史

  void restoreDownloads() {
    try {
      if (!downloadsFile.existsSync()) return;
      final Object? raw = jsonDecode(downloadsFile.readAsStringSync());
      if (raw is! List) return;
      final List<DownloadTask> restored = <DownloadTask>[];
      for (final Object? entry in raw) {
        final DownloadTask? t = DownloadTask.tryFromJson(entry);
        if (t != null) restored.add(t);
      }
      downloads.restore(restored);
    } catch (_) {
      // 历史坏了不影响使用
    }
  }

  void _onDownloadsChanged() {
    saveDownloadsSoon();
    notifyListeners();
  }

  void saveDownloadsSoon() {
    _downloadsTimer?.cancel();
    _downloadsTimer = Timer(const Duration(milliseconds: 400), saveDownloadsNow);
  }

  void saveDownloadsNow() {
    try {
      final List<Map<String, dynamic>> list = downloads.tasks
          .take(200)
          .map((DownloadTask t) => t.toJson())
          .toList();
      downloadsFile.writeAsStringSync(jsonEncode(list));
    } catch (_) {}
  }

  int get activeDownloadCount =>
      downloads.tasks.where((DownloadTask t) => t.isActive).length;
}
