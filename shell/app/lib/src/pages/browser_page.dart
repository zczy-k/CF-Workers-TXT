import 'dart:async';
import 'dart:collection';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:webshell_core/webshell_core.dart';

import '../engine/scripts.dart';
import '../open.dart';
import '../state.dart';
import 'downloads_page.dart';
import 'site_edit_page.dart';

/// 站点浏览页：一个站点一个 WebView。
///
/// 这里是"全功能"的落地处 —— 把下列能力接起来，缺一样就会退化成残废壳：
///   * 新窗口（`target=_blank` / `window.open`）→ 在同一个视图里打开，不丢目标；
///   * 下载事件（`onDownloadStartRequest`）→ 交给自己的下载器（带 Cookie/UA/Referer）；
///   * 文件上传（引擎自带文件选择器）；
///   * Basic Auth（密码从系统安全存储取）；
///   * 权限申请（摄像头/麦克风/定位）→ 询问用户，只对 https 站点放行；
///   * 长按链接 → 下载 / 复制 / 交给系统浏览器；
///   * 非 http(s) 协议（tel:/mailto:/微信…）→ 交给系统。
class BrowserPage extends StatefulWidget {
  const BrowserPage({super.key, required this.state, required this.siteId});

  final ShellState state;
  final String siteId;

  static Route<void> route(ShellState state, String siteId) {
    return MaterialPageRoute<void>(
      builder: (BuildContext _) => BrowserPage(state: state, siteId: siteId),
    );
  }

  @override
  State<BrowserPage> createState() => _BrowserPageState();
}

class _BrowserPageState extends State<BrowserPage> {
  InAppWebViewController? _controller;
  double _progress = 0;
  bool _loading = false;
  bool _fullscreen = false;
  String _title = '';
  String _url = '';
  bool _canGoBack = false;
  bool _canForward = false;
  String? _error;

  /// 被我们接管成下载的导航（url → 发生时间）。
  ///
  /// Windows 上我们靠"链接像文件"提前把导航掐掉，WebView2 会因此报一个
  /// 导航失败；这张表用来认出"那是我们自己掐的"，别把红条弹给用户。
  final Map<String, int> _interceptedAsDownload = <String, int>{};

  SiteProfile? get _site => widget.state.config.byId(widget.siteId);

  @override
  void initState() {
    super.initState();
    final SiteProfile? site = _site;
    if (site != null) {
      _url = site.startUrl;
      _title = site.displayName;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.state.openSite(site);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final SiteProfile? site = _site;
    if (site == null) {
      // 正常不会走到这里（站点在"添加"时就写进配置了）。真走到这里说明站点已被删除，
      // 或者哪个调用方拿着一个不在配置里的 id 进来了 —— 别让用户对着空白页猜。
      return Scaffold(
        appBar: AppBar(),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(
                  Icons.link_off,
                  size: 48,
                  color: Theme.of(context).colorScheme.outline,
                ),
                const SizedBox(height: 12),
                const Text('这个站点已经不在了'),
                const SizedBox(height: 6),
                Text(
                  '它可能已经被删除。返回上一页重新添加即可，已经下载到本机的文件不受影响。',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  child: const Text('返回'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: _fullscreen ? null : _appBar(context, site),
      body: Column(
        children: <Widget>[
          if (_error != null) _errorBar(context),
          Expanded(
            child: InAppWebView(
              key: ValueKey<String>(site.id),
              initialUrlRequest: URLRequest(
                url: WebUri(site.startUrl),
                headers: _topLevelHeaders(site),
              ),
              initialSettings: _settings(site),
              initialUserScripts: UnmodifiableListView<UserScript>(
                <UserScript>[
                  UserScript(
                    // Windows 上 WebView2 的下载事件没接到原生（ARCHITECTURE §7）；
                    // Android 的原生 `onDownloadStartRequest` 只在"WebView 发起导航 →
                    // 服务端回附件"时才触发，页面用 JS（fetch/XHR/动态 a.click/
                    // window.open）触发的下载它照样漏。所以两端的自动接管规则都开满：
                    // 扩展名 + `?download` 查询串 + "链接文字写着下载"。
                    // 漏拦的代价是"文件不知去向"，误拦最多多一次下载，宁可多猜。
                    source: buildBridgeScript(
                      site,
                      guessQuery: true,
                      guessByLabel: true,
                    ),
                    injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                    forMainFrameOnly: false,
                  ),
                ],
              ),
              onWebViewCreated: _onWebViewCreated,
              onLoadStart: (InAppWebViewController controller, WebUri? url) {
                setState(() {
                  _loading = true;
                  _error = null;
                  if (url != null) _url = url.toString();
                });
              },
              onLoadStop: (InAppWebViewController controller, WebUri? url) async {
                if (mounted) setState(() => _loading = false);
                await _syncNavigation(controller);
              },
              onProgressChanged: (InAppWebViewController controller, int progress) {
                if (!mounted) return;
                setState(() => _progress = progress / 100);
              },
              onTitleChanged: (InAppWebViewController controller, String? title) {
                if (!mounted) return;
                setState(() => _title = title ?? '');
              },
              onUpdateVisitedHistory: (InAppWebViewController controller, WebUri? url, bool? isReload) async {
                if (url != null && mounted) setState(() => _url = url.toString());
                await _syncNavigation(controller);
              },
              onReceivedError: (InAppWebViewController controller, WebResourceRequest request, WebResourceError error) {
                // 子资源（图片、广告）失败不要弹错，只有主文档失败才提示
                if (request.isForMainFrame != true) return;
                // 我们自己把"看起来是下载"的导航 abort 掉时，WebView2 会报一个
                // "操作已取消" —— 那是预期内的，不是真错误，别在页面上弹红条。
                final String failedUrl = request.url.toString();
                final int? interceptedAt = _interceptedAsDownload[failedUrl];
                final bool ourAbort = error.type == WebResourceErrorType.CANCELLED ||
                    (interceptedAt != null && nowMs() - interceptedAt < 10000);
                if (ourAbort) {
                  _interceptedAsDownload.remove(failedUrl);
                  return;
                }
                if (!mounted) return;
                setState(() => _error = error.description.isEmpty ? '页面加载失败' : error.description);
              },
              shouldOverrideUrlLoading: _shouldOverride,
              onCreateWindow: _onCreateWindow,
              onCloseWindow: (InAppWebViewController controller) async {},
              onDownloadStartRequest: _onDownloadStart,
              // 站点开了"信任自签证书"才放行（Android / iOS 走这里）。
              onReceivedServerTrustAuthRequest: _onServerTrust,
              onReceivedHttpAuthRequest: _onHttpAuth,
              onPermissionRequest: _onPermissionRequest,
            ),
          ),
          if (!_fullscreen) _bottomBar(context),
        ],
      ),
    );
  }

  PreferredSizeWidget _appBar(BuildContext context, SiteProfile site) {
    final ThemeData theme = Theme.of(context);
    return AppBar(
      titleSpacing: 4,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            _title.isEmpty ? site.displayName : _title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
          if (widget.state.branding.showAddressBar)
            Text(
              displayUrl(_url.isEmpty ? site.startUrl : _url),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurfaceVariant),
            ),
        ],
      ),
      actions: <Widget>[
        IconButton(
          tooltip: '刷新',
          onPressed: () => _controller?.reload(),
          icon: const Icon(Icons.refresh),
        ),
        IconButton(
          tooltip: '更多',
          onPressed: () => _showPageMenu(context),
          icon: const Icon(Icons.more_vert),
        ),
      ],
      bottom: _loading
          ? PreferredSize(
              preferredSize: const Size.fromHeight(2),
              child: LinearProgressIndicator(
                value: _progress <= 0 || _progress >= 1 ? null : _progress,
                minHeight: 2,
              ),
            )
          : null,
    );
  }

  Widget _errorBar(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.errorContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
        child: Row(
          children: <Widget>[
            Icon(Icons.wifi_off_outlined, size: 18, color: colors.onErrorContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                _error!,
                style: TextStyle(color: colors.onErrorContainer, fontSize: 13),
              ),
            ),
            TextButton(
              onPressed: () {
                setState(() => _error = null);
                _controller?.reload();
              },
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bottomBar(BuildContext context) {
    return SafeArea(
      top: false,
      child: BottomAppBar(
        height: 56,
        padding: EdgeInsets.zero,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: <Widget>[
            IconButton(
              tooltip: '后退',
              onPressed: _canGoBack ? () => _controller?.goBack() : null,
              icon: const Icon(Icons.arrow_back),
            ),
            IconButton(
              tooltip: '前进',
              onPressed: _canForward ? () => _controller?.goForward() : null,
              icon: const Icon(Icons.arrow_forward),
            ),
            IconButton(
              tooltip: '回到首页',
              onPressed: () {
                final SiteProfile? site = _site;
                if (site != null) _controller?.loadUrl(urlRequest: URLRequest(url: WebUri(site.startUrl)));
              },
              icon: const Icon(Icons.home_outlined),
            ),
            // 浏览页是 push 出来的路由，App 级的 ListenableBuilder 不会重建它 ——
            // 必须自己监听 state，否则下载一开始角标永远亮不起来（用户以为没在下载）。
            ListenableBuilder(
              listenable: widget.state,
              builder: (BuildContext ctx, Widget? _) => IconButton(
                tooltip: '下载',
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(builder: (BuildContext _) => DownloadsPage(state: widget.state)),
                ),
                icon: Badge(
                  isLabelVisible: widget.state.activeDownloadCount > 0,
                  label: Text('${widget.state.activeDownloadCount}'),
                  child: const Icon(Icons.download_outlined),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- 引擎配置

  InAppWebViewSettings _settings(SiteProfile site) {
    final String ua = (site.userAgent ?? '').trim();
    return InAppWebViewSettings(
      javaScriptEnabled: true,
      javaScriptCanOpenWindowsAutomatically: true,
      supportMultipleWindows: true,
      useShouldOverrideUrlLoading: true,
      useOnDownloadStart: true,
      useHybridComposition: true,
      mediaPlaybackRequiresUserGesture: false,
      domStorageEnabled: true,
      databaseEnabled: true,
      thirdPartyCookiesEnabled: true,
      loadsImagesAutomatically: widget.state.config.loadImages,
      // 用户关掉"保持登录"时改用无痕会话：Cookie / localStorage 都不落盘，
      // 重开 App 天然是未登录状态（和系统浏览器的"隐私模式"一致）。
      incognito: !widget.state.config.saveLogin,
      // 安全第一：不允许网页通过 file:// 读本机文件；上传走系统文件选择器，不受影响
      allowFileAccess: false,
      allowContentAccess: false,
      // 关掉 WebView 自带的上下文菜单，长按才会落到我们的桥接脚本里
      disableContextMenu: true,
      useWideViewPort: true,
      loadWithOverviewMode: true,
      verticalScrollBarEnabled: false,
      displayZoomControls: false,
      userAgent: ua.isEmpty ? null : ua,
      isInspectable: kDebugMode,
    );
  }

  /// 顶层导航能带的头；页面内部请求由注入脚本补（WebView 平台不让改内部请求头）。
  Map<String, String> _topLevelHeaders(SiteProfile site) {
    final Map<String, String> headers = <String, String>{};
    site.headers.forEach((String key, String value) {
      if (value.isEmpty) return;
      if (kForbiddenHeaderNames.contains(key.toLowerCase())) return;
      headers[key] = value;
    });
    final String ua = (site.userAgent ?? '').trim();
    if (ua.isNotEmpty) headers['User-Agent'] = ua;
    return headers;
  }

  @override
  void dispose() {
    // 关了"保持登录"：离开浏览页就把这个站点的登录态擦掉（无痕语义）。
    // Cookie 在这里清；WebView 侧已用 incognito，让新会话天然干净。
    if (!widget.state.config.saveLogin) {
      final SiteProfile? site = widget.state.config.byId(widget.siteId);
      if (site != null) unawaited(widget.state.clearSiteData(site));
    }
    widget.state.activeController = null;
    super.dispose();
  }

  // ------------------------------------------------------------------ 回调

  /// 站点的 HTTPS 证书校验失败（自签 / 过期 / 域名不匹配）时的处理。
  ///
  /// 只有站点自己开了"信任自签证书"才放行，否则交回系统判断（默认拒绝）；
  /// 刻意不做全局忽略 —— 那等于把整个 App 的 HTTPS 安全一次性废掉。
  /// Windows（WebView2）不触发这个回调，证书校验由平台自己处理。
  Future<ServerTrustAuthResponse?> _onServerTrust(
    InAppWebViewController controller,
    URLAuthenticationChallenge challenge,
  ) async {
    final SiteProfile? site = _site;
    final bool allow = site != null && site.allowSelfSignedCert;
    return ServerTrustAuthResponse(
      action: allow
          ? ServerTrustAuthResponseAction.PROCEED
          : ServerTrustAuthResponseAction.CANCEL,
    );
  }

  Future<void> _onWebViewCreated(InAppWebViewController controller) async {
    _controller = controller;
    widget.state.activeController = controller;

    // 记下引擎的真实 UA：下载时要用它，否则很多站点会回 403
    try {
      final String ua = await InAppWebViewController.getDefaultUserAgent();
      if (ua.isNotEmpty) widget.state.engineUserAgent = ua;
    } catch (_) {}

    Map<String, dynamic> payload(List<dynamic> args) {
      if (args.isNotEmpty && args.first is Map) {
        return Map<String, dynamic>.from(args.first as Map<dynamic, dynamic>);
      }
      return <String, dynamic>{};
    }

    // blob/data 导出通道（前端生成的文件）
    controller.addJavaScriptHandler(
      handlerName: 'blobStart',
      callback: (List<dynamic> args) {
        widget.state.onBlobStart(payload(args));
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'blobData',
      callback: (List<dynamic> args) {
        widget.state.onBlobData(payload(args));
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'blobEnd',
      callback: (List<dynamic> args) {
        widget.state.onBlobEnd(payload(args));
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'blobError',
      callback: (List<dynamic> args) {
        widget.state.onBlobError(payload(args));
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'longPressLink',
      callback: (List<dynamic> args) {
        _showLinkMenu(payload(args));
        return null;
      },
    );
    // 注入脚本报上来的下载意图（Windows 上这是唯一能把下载交给我们的通道）
    controller.addJavaScriptHandler(
      handlerName: 'downloadRequest',
      callback: (List<dynamic> args) {
        final Map<String, dynamic> data = payload(args);
        _enqueueDownload(
          (data['url'] as Object?)?.toString() ?? '',
          suggestedName: (data['name'] as Object?)?.toString(),
        );
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'fullscreen',
      callback: (List<dynamic> args) {
        final Map<String, dynamic> data = payload(args);
        if (mounted) setState(() => _fullscreen = data['on'] == true);
        return null;
      },
    );
  }

  Future<void> _syncNavigation(InAppWebViewController controller) async {
    try {
      final bool back = await controller.canGoBack();
      final bool forward = await controller.canGoForward();
      final WebUri? url = await controller.getUrl();
      if (!mounted) return;
      setState(() {
        _canGoBack = back;
        _canForward = forward;
        if (url != null) _url = url.toString();
      });
    } catch (_) {}
  }

  Future<NavigationActionPolicy> _shouldOverride(
    InAppWebViewController controller,
    NavigationAction action,
  ) async {
    final WebUri? target = action.request.url;
    if (target == null) return NavigationActionPolicy.ALLOW;

    final String url = target.toString();
    final String? scheme = externalScheme(url);

    // 非 http(s)：交给系统（电话、邮件、微信、支付宝…）
    if (scheme != null) {
      final bool ok = await openExternal(url);
      if (!ok && mounted) {
        _snack('没有能处理 $scheme: 的应用，链接已复制');
        await Clipboard.setData(ClipboardData(text: url));
      }
      return NavigationActionPolicy.CANCEL;
    }

    if (!isHttpUrl(url)) return NavigationActionPolicy.CANCEL;

    // Windows：WebView2 的下载事件没有接到原生，导航到"看起来是文件"的地址时
    // 我们自己接管下载 —— 否则 WebView2 会自己下完，下载列表里一行都不会出现，
    // 用户也不知道文件去了哪（"下载的东西没到本机"）。
    //
    // 判断刻意用保守的 [isLikelyFileAttachment]（图片/音视频/纯文本不算）：
    // 在这里误伤一次，用户点开一张图就变成了下载，比漏拦更难受。
    if (Platform.isWindows && isLikelyFileAttachment(url)) {
      _interceptedAsDownload[url] = nowMs();
      if (_interceptedAsDownload.length > 16) _interceptedAsDownload.clear();
      _enqueueDownload(url);
      return NavigationActionPolicy.CANCEL;
    }

    // 「只在本站内导航」的站点：站外链接交给系统浏览器，不把用户带跑
    final SiteProfile? site = _site;
    if (site != null && site.stayInSite && !sameSite(url, site.startUrl)) {
      final bool ok = await openExternal(url);
      if (mounted) {
        _snack(ok ? '已用浏览器打开站外链接' : '站外链接被拦截（可在站点设置里放开）');
      }
      return NavigationActionPolicy.CANCEL;
    }

    return NavigationActionPolicy.ALLOW;
  }

  /// `target=_blank` / `window.open`：在当前视图打开。
  ///
  /// 不这么做的话，点了"在新窗口打开"的按钮会毫无反应 —— 这是"网页转 APP"工具
  /// 最常见的残废点之一。
  Future<bool> _onCreateWindow(
    InAppWebViewController controller,
    CreateWindowAction action,
  ) async {
    final WebUri? target = action.request.url;
    if (target != null) {
      final String url = target.toString();
      if (url.startsWith('blob:') || url.startsWith('data:')) return false;
      final SiteProfile? site = _site;
      await controller.loadUrl(
        urlRequest: URLRequest(
          url: target,
          headers: site == null ? null : _topLevelHeaders(site),
        ),
      );
    }
    // false = 没有另开窗口（我们已经自己处理了）
    return false;
  }

  Future<void> _onDownloadStart(
    InAppWebViewController controller,
    DownloadStartRequest request,
  ) async {
    _enqueueDownload(
      request.url.toString(),
      suggestedName: request.suggestedFilename,
    );
  }

  /// 统一的下载入口（引擎事件 / 注入脚本 / 长按菜单都走这里）。
  ///
  /// 提示里**一定要写清楚存到哪儿**：Windows 上如果只有一句"已加入下载"，
  /// 用户点完还是不知道文件跑哪去了（这也是他被"网页转 APP"工具坑过的地方）。
  void _enqueueDownload(String url, {String? suggestedName}) {
    if (url.trim().isEmpty) return;
    final SiteProfile? site = _site;
    final DownloadTask task = widget.state.enqueueDownload(
      url: url,
      siteId: site?.id ?? '',
      suggestedName: suggestedName,
      referer: _url.isEmpty ? site?.startUrl : _url,
    );
    if (!mounted) return;
    final String dir = widget.state.downloadDirectoryLabel;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('已加入下载：${task.fileName}\n保存到 $dir'),
        duration: const Duration(seconds: 6),
        action: Platform.isAndroid
            // Android 没有"打开文件夹"这种 intent，这里改成"去下载列表看进度"
            ? SnackBarAction(
                label: '下载列表',
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (BuildContext _) =>
                        DownloadsPage(state: widget.state),
                  ),
                ),
              )
            : SnackBarAction(
                label: '打开文件夹',
                onPressed: () => openDirectory(dir),
              ),
      ),
    );
  }

  Future<HttpAuthResponse?> _onHttpAuth(
    InAppWebViewController controller,
    URLAuthenticationChallenge challenge,
  ) async {
    final SiteProfile? site = _site;
    if (site == null) return HttpAuthResponse(action: HttpAuthResponseAction.CANCEL);
    final String? user = site.basicUser;
    final String? password = await widget.state.basicPassword(site.id);
    if (user != null && user.isNotEmpty && password != null) {
      return HttpAuthResponse(
        username: user,
        password: password,
        permanentPersistence: true,
        action: HttpAuthResponseAction.PROCEED,
      );
    }
    if (mounted) {
      _snack('这个网站需要 Basic 认证，请在站点设置里填账号密码');
    }
    return HttpAuthResponse(action: HttpAuthResponseAction.CANCEL);
  }

  Future<PermissionResponse?> _onPermissionRequest(
    InAppWebViewController controller,
    PermissionRequest request,
  ) async {
    final SiteProfile? site = _site;
    final Uri? uri = Uri.tryParse(_url.isEmpty ? (site?.startUrl ?? '') : _url);
    // 只对 https 站点放行：http 页面上任何权限申请都可能是中间人塞进来的
    if (uri == null || uri.scheme != 'https') {
      return PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.DENY,
      );
    }
    if (!mounted) {
      return PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.DENY,
      );
    }

    final bool? allow = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('网站请求使用设备权限'),
        content: Text('${uri.host} 想使用摄像头 / 麦克风 / 定位等权限。\n\n只有你在这里同意，它才能拿到。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('拒绝'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('允许'),
          ),
        ],
      ),
    );

    return PermissionResponse(
      resources: request.resources,
      action: allow == true ? PermissionResponseAction.GRANT : PermissionResponseAction.DENY,
    );
  }

  // ------------------------------------------------------------------ 菜单

  Future<void> _showLinkMenu(Map<String, dynamic> payload) async {
    final String url = payload['url'] as String? ?? '';
    final String text = payload['text'] as String? ?? '';
    if (url.isEmpty || !mounted) return;

    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (text.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis),
              ),
            ListTile(
              leading: const Icon(Icons.download_outlined),
              title: const Text('下载这个链接'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                _enqueueDownload(url);
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('复制链接'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                await Clipboard.setData(ClipboardData(text: url));
                _snack('链接已复制');
              },
            ),
            ListTile(
              leading: const Icon(Icons.open_in_new),
              title: const Text('用系统浏览器打开'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                await openExternal(url);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showPageMenu(BuildContext context) async {
    final SiteProfile? site = _site;
    if (site == null) return;
    final String current = _url.isEmpty ? site.startUrl : _url;

    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.refresh),
              title: const Text('刷新'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _controller?.reload();
              },
            ),
            ListTile(
              leading: const Icon(Icons.open_in_new),
              title: const Text('用系统浏览器打开'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                final bool ok = await openExternal(current);
                if (!ok) _snack('没有找到可用的浏览器');
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('复制当前链接'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                await Clipboard.setData(ClipboardData(text: current));
                _snack('链接已复制');
              },
            ),
            ListTile(
              leading: const Icon(Icons.tune),
              title: const Text('站点设置'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (BuildContext _) => SiteEditPage(state: widget.state, siteId: site.id),
                  ),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.image_outlined),
              title: const Text('重新抓取图标'),
              onTap: () {
                Navigator.of(sheetContext).pop();
                widget.state.refreshIcon(site);
              },
            ),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('清除该站点登录态'),
              onTap: () async {
                Navigator.of(sheetContext).pop();
                await widget.state.clearSiteData(site);
                _snack('已清除登录态');
              },
            ),
          ],
        ),
      ),
    );
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }
}
