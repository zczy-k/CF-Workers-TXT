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

  /// 当前浏览页的控制器（由 BrowserPage 挂上 / 摘掉）。清某个站点的
  /// localStorage / IndexedDB 时要用它在页面里跑一段 JS —— 这几样东西在引擎侧
  /// 没有"按域删除"的接口。为 null（没开浏览页）时只清 Cookie。
  InAppWebViewController? activeController;

  final Map<String, _BlobSession> _blobs = <String, _BlobSession>{};
  Timer? _configTimer;
  Timer? _downloadsTimer;

  static Future<ShellState> create(Branding branding) async {
    final Directory dir = await appDataDir();
    final ConfigFile configFile =
        ConfigFile(File(joinPath(dir.path, ConfigFile.defaultFileName)));
    final ShellConfig config = configFile.load(branding);

    if (config.downloadDir == null || config.downloadDir!.isEmpty) {
      // 首次启动：探测默认下载目录（Android 是公共 Download/<App 名文件夹>，
      // 中文名取拼音首字母，如「成都」→ Download/cd），结果写进配置，
      // 下载时不再反复探测。
      config.downloadDir = await defaultDownloadDirectory(branding.appName);
      configFile.save(config);
    } else if (Platform.isAndroid) {
      // 升级迁移：老版本的 Android 落点是 Android/data/<包名>/files/Download，
      // Android 11+ 文件管理器看不到它（用户以为"文件没下到手机上"）。
      // 只要配的是应用私有目录，就悄悄换成可见的 Android/media/<包名>/Download。
      final String old = config.downloadDir!;
      final String? media = androidMediaDirOf(old);
      if (media != null && old.contains('/Android/data/')) {
        config.downloadDir = joinPath(media, 'Download');
        try {
          Directory(config.downloadDir!).createSync(recursive: true);
          configFile.save(config);
        } catch (_) {
          // 建不出来就保持原样，写文件时会给出更清楚的错误
          config.downloadDir = old;
        }
      }
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
    // 退出即不保留：关了"保持登录"就把痕迹擦掉（浏览页侧还有 incognito 兜底）。
    if (!config.saveLogin) unawaited(_wipeAllLoginState());
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

  /// 清掉某个站点的登录态：这个域的 Cookie，**以及**页面自己存的会话数据。
  ///
  /// 只清这个域名，别的站点不受影响。localStorage / IndexedDB 在引擎侧没有
  /// "按域删除"的接口，所以靠一段注入的 JS 在页面里逐个删 —— 不少站点把登录
  /// 令牌放在 localStorage，只清 Cookie 会出现"Cookie 没了、一刷新又自动登录
  /// 回去"的假退出。
  Future<void> clearSiteData(SiteProfile site) async {
    final Uri? u = Uri.tryParse(site.startUrl);
    if (u == null) return;
    try {
      await CookieManager.instance()
          .deleteCookies(url: WebUri('${u.scheme}://${u.authority}'));
    } catch (_) {
      // 引擎不支持就算了，别把 UI 卡住
    }
    await _clearWebStorage(u);
  }

  /// 如果当前浏览页正好是这个来源，就在页面里清掉它的本地存储。
  Future<void> _clearWebStorage(Uri origin) async {
    final InAppWebViewController? c = activeController;
    if (c == null) return;
    try {
      final WebUri? current = await c.getUrl();
      if (current == null || current.host != origin.host) return;
      await c.evaluateJavascript(source: _clearStorageScript);
    } catch (_) {
      // 页面已经销毁 / 引擎不支持，忽略
    }
  }

  /// 清空所有站点的登录态（设置里的"清空所有 Cookie"、关闭"保持登录状态"）。
  Future<void> clearAllCookies() => _wipeAllLoginState();

  /// 把整个 App 的登录痕迹擦干净：Cookie + 全部 Web Storage。
  ///
  /// [WebStorageManager.deleteAllData] 覆盖所有来源的 localStorage /
  /// sessionStorage / IndexedDB / CacheStorage，一步到位。
  Future<void> _wipeAllLoginState() async {
    try {
      await CookieManager.instance().deleteAllCookies();
    } catch (_) {}
    try {
      await WebStorageManager.instance().deleteAllData();
    } catch (_) {
      // Windows 等平台可能没实现，忽略；Cookie 已经清了
    }
    try {
      await InAppWebViewController.clearAllCache();
    } catch (_) {
      // 没有打开的浏览页 / 平台没实现：拿不到 controller 就跳过
    }
  }

  /// 切换"保持登录"。关掉时**立刻**擦掉已经落地的登录态，否则 Cookie 还留在
  /// 磁盘上，用户以为关了、重启后却仍是登录状态 —— 开关形同虚设。
  Future<void> setSaveLogin(bool value) async {
    if (config.saveLogin == value) return;
    config.saveLogin = value;
    saveNow();
    notifyListeners();
    if (!value) await _wipeAllLoginState();
  }

  /// 在页面里清掉当前来源的本地存储（localStorage / sessionStorage /
  /// IndexedDB / caches）。引擎没有按域清这些的 API，只能走 JS。
  static const String _clearStorageScript = r'''
(function () {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  try {
    if (window.caches && caches.keys) {
      caches.keys().then(function (ks) {
        ks.forEach(function (k) { try { caches.delete(k); } catch (e) {} });
      });
    }
  } catch (e) {}
  try {
    if (window.indexedDB && indexedDB.databases) {
      indexedDB.databases().then(function (dbs) {
        dbs.forEach(function (db) {
          try { indexedDB.deleteDatabase(db.name); } catch (e) {}
        });
      });
    }
  } catch (e) {}
  return true;
})();
''';

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
    // blob/data 导出是页面把内存里的字节分片推过来，没有"暂停"可言（不能去暂停
    // 浏览器的 FileReader）。要中止只能取消；这里对 blob 任务不置状态，免得出现
    // "已暂停、文件却还在长"的假象。
    if (_blobKeyOf(id) != null) return;
    downloads.pause(id);
    _onDownloadsChanged();
  }

  void resumeDownload(String id) {
    downloads.resume(id);
    _onDownloadsChanged();
  }

  Future<void> cancelDownload(String id) async {
    // blob/data 导出不走网络下载管线（它由页面脚本分片 POST 过来），所以不能只靠
    // downloads.cancel：那样任务虽然标成"已取消"，脚本还在继续推数据、半截文件也
    // 留在磁盘上（假取消 + 文件泄漏）。这里先把这条 blob 会话收干净。
    final String? blobKey = _blobKeyOf(id);
    if (blobKey != null) {
      await _dropBlobSession(blobKey);
      downloads.cancel(id);
      _onDownloadsChanged();
      return;
    }
    await downloads.cancel(id);
    _onDownloadsChanged();
  }

  /// 这条下载任务对应的 blob 会话 key（不是 blob 任务就返回 null）。
  String? _blobKeyOf(String id) {
    for (final MapEntry<String, _BlobSession> e in _blobs.entries) {
      if (e.value.task.id == id) return e.key;
    }
    return null;
  }

  /// 关闭并丢弃一条 blob 会话：关掉写句柄、删掉半截文件。
  Future<void> _dropBlobSession(String key) async {
    final _BlobSession? session = _blobs.remove(key);
    if (session == null) return;
    try {
      await session.sink.close();
    } catch (_) {}
    try {
      final String? path = session.task.savePath;
      if (path != null && File(path).existsSync()) await File(path).delete();
    } catch (_) {}
  }

  void removeDownload(String id) {
    // 还在写的 blob 任务直接删记录会漏掉没关的文件句柄和半截文件，先收干净。
    final String? blobKey = _blobKeyOf(id);
    if (blobKey != null) unawaited(_dropBlobSession(blobKey));
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
