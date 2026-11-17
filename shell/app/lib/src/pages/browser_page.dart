import 'dart:async';
import 'dart:collection';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:webshell_core/webshell_core.dart';
import 'package:window_manager/window_manager.dart';

import '../engine/scripts.dart';
import '../open.dart';
import '../state.dart';
import 'downloads_page.dart';
import 'settings_page.dart';
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

  /// 进度条刷新台阶（5% 一档）。见 onProgressChanged 的节流说明。
  int _lastProgressStep = -1;

  /// 下拉刷新（Android/iOS）。Windows 的 WebView2 没这套手势，保持 null 即禁用。
  /// 控制器传非 null 就是开关本身（插件侧无额外 setting）。
  PullToRefreshController? _refreshController;

  /// 被我们接管成下载的导航（url → 发生时间）。
  ///
  /// Windows 上我们靠"链接像文件"提前把导航掐掉，WebView2 会因此报一个
  /// 导航失败；这张表用来认出"那是我们自己掐的"，别把红条弹给用户。
  final Map<String, int> _interceptedAsDownload = <String, int>{};

  /// 悬浮工具条的不透明度。
  ///
  /// 三个取值都有明确含义，别随手改：
  ///   * `1.0`  —— 常显（手指端点按后、鼠标悬停中、页面回到顶部）；
  ///   * `0.35` —— 桌面"待机"：鼠标离开 1.5 秒后淡到这儿，看得见但不挡网页；
  ///   * `0.0`  —— 触摸端"读文章模式"：往下滑时整条收起，让出屏幕。
  double _chromeOpacity = 1;

  /// 桌面端"鼠标离开 → 淡出"的延时器。每次进入都要取消，否则会出现
  /// "刚移回来又被上一次的定时器按下去"的鬼畜。
  Timer? _chromeTimer;

  /// 触摸端上一次的滚动位置，用来判断方向（往下滑收、往上滑出）。
  int _lastScrollY = 0;

  /// 手机 / 平板。工具条的尺寸与隐藏策略按这个分叉，见 [_floatingToolbar]。
  /// 桌面（Windows / Linux / macOS）一律走鼠标那一套：指针精确，可以做小。
  bool get _isTouch => Platform.isAndroid || Platform.isIOS;

  SiteProfile? get _site => widget.state.config.byId(widget.siteId);

  @override
  void initState() {
    super.initState();
    if (Platform.isAndroid || Platform.isIOS) {
      _refreshController = PullToRefreshController(
        // 松手即刷新当前页；转圈的收口在 onLoadStop / onReceivedError 里做，
        // 两条路都收，避免报错页把下拉动画挂成"永动"。
        onRefresh: () => _controller?.reload(),
      );
    }
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

    // Android 返回键：有网页历史就回退一页，没历史才允许退出路由。
    // 不拦这一层，返回键会直接把整个路由 pop 掉 —— 用户按一次返回就"退出网站"，
    // 这是网页转 App 最典型的残废点（P0）。桌面端无感：PopScope 只拦 pop 请求。
    return PopScope(
      canPop: !_canGoBack,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) _controller?.goBack();
      },
      child: Scaffold(
        // 没有 AppBar 了：那 56dp 是"布局元素"，多高就实打实吃掉多少网页高度，
        // 而且直达模式下标题区本来就是空的 —— 用户看到的是一条空白带。
        // 现在网页从窗口顶边一直铺到底栏，三个功能按钮改成右上角悬浮胶囊
        // （_floatingToolbar），加载进度退化成最上沿 2dp 的一条细线，
        // 两者都用 Stack 叠在 WebView 上、不参与布局，占用的垂直空间是 0。
        body: Column(
          children: <Widget>[
            if (_error != null) _errorBar(context),
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  InAppWebView(
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
                    pullToRefreshController: _refreshController,
                    // 触摸端靠滚动方向决定胶囊收不收（桌面端在这个回调里直接 return）。
                    onScrollChanged: _onScrollChanged,
                    onLoadStart: (InAppWebViewController controller, WebUri? url) {
                      setState(() {
                        _loading = true;
                        _error = null;
                        _lastProgressStep = -1; // 新导航：重置进度台阶
                        _lastScrollY = 0; // 换页了，滚动基线归零
                        if (url != null) _url = url.toString();
                      });
                    },
                    onLoadStop: (InAppWebViewController controller, WebUri? url) async {
                      if (mounted) setState(() => _loading = false);
                      await _syncNavigation(controller);
                      _refreshController?.endRefreshing();
                    },
                    onProgressChanged: (InAppWebViewController controller, int progress) {
                      if (!mounted) return;
                      // 节流：WebView 的进度回调很密（约每 1% 一次），每次 setState
                      // 都重建整个 Scaffold。按 5% 台阶刷新，肉眼无差、build 次数
                      // 降一个量级；100% 和 0 恒放行，保证起止状态准确。
                      final int step = progress ~/ 5;
                      if (progress > 0 && progress < 100 && step == _lastProgressStep) {
                        return;
                      }
                      _lastProgressStep = step;
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
                      _refreshController?.endRefreshing();
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
                  // 加载进度：贴窗口最上沿的 2dp 细线。IgnorePointer 是必须的 ——
                  // 它是横贯全宽的一层，不关掉命中测试就等于在网页顶上钉了一条
                  // 点不动的死带，而且正好压在网页第一个可点元素上。
                  if (!_fullscreen && _loading)
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: IgnorePointer(
                        child: LinearProgressIndicator(
                          value: _progress <= 0 || _progress >= 1 ? null : _progress,
                          minHeight: 2,
                        ),
                      ),
                    ),
                  if (!_fullscreen) _floatingToolbar(context),
                ],
              ),
            ),
            if (!_fullscreen) _bottomBar(context),
          ],
        ),
      ),
    );
  }

  /// 悬浮胶囊工具条（方案 A）。
  ///
  /// 为什么不做顶栏：顶栏是布局元素，它有多高网页就矮多少；胶囊是叠加层，
  /// 只盖住右上角约 120×44 的一块，其余像素全归网页。原来被"56dp 顶栏 +
  /// 2dp 进度条"吃掉的高度，现在一像素不剩地还给了内容。
  ///
  /// 两端的手感差异（同一份代码，两套参数）：
  ///   * 桌面（Windows / Linux / macOS）：鼠标是精确指针 → 胶囊做小（40 高、
  ///     单键 36×36、图标 20）；鼠标离开 1.5 秒后淡到 35% 让位给内容，一移回来
  ///     立刻恢复，符合桌面软件"chrome 让位"的惯例。
  ///   * 手机 / 平板（Android / iOS）：手指要更大的命中区 → 44 高、单键 40×40、
  ///     图标 22；触摸屏没有 hover，所以绝不能自动淡出（淡出了就点不到），
  ///     改成跟着滚动走：往下读时收起、往回滑或回到顶部时冒出。
  ///     收起时顺手把命中测试一起关掉，不留透明死区。
  Widget _floatingToolbar(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    final bool touch = _isTouch;

    final double barHeight = touch ? 44 : 40;
    final double buttonSize = touch ? 40 : 36;

    // 顶部留白跟着系统走：Android 的 body 一般已经在状态栏之下，padding.top
    // 为 0、不吃额外空间；万一开了 edge-to-edge 或者在刘海屏 / 折叠屏上，
    // 也不会把胶囊顶进摄像头挖孔。
    final EdgeInsets safe = MediaQuery.paddingOf(context);
    final double top = safe.top + 8;
    final double right = touch ? 8 : 12;

    return Positioned(
      top: top,
      right: right,
      child: MouseRegion(
        // 鼠标进出只对桌面有意义；触摸端交给 onScrollChanged。
        onEnter: touch ? null : (_) => _setChrome(1),
        onExit: touch ? null : (_) => _scheduleChromeFade(),
        child: AnimatedOpacity(
          opacity: _chromeOpacity,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          child: IgnorePointer(
            // 门限放在 0.1：桌面"淡到 35%"那档必须还能点（它只是让位，不是消失），
            // 只有触摸端真正收起到 0 时才关掉命中测试，免得网页顶上留一块死区。
            ignoring: _chromeOpacity < 0.1,
            child: Material(
              // 刻意不用 BackdropFilter 做毛玻璃：Android 上 WebView 是平台视图、
              // Windows 上是独立的 WebView2 子窗口，Flutter 的 BackdropFilter
              // 采样不到底下的网页像素，只会糊出一块死灰。改用高不透明度实色 +
              // 细描边 + 轻投影，三端观感一致，也没有逐帧采样的开销。
              color: colors.surface.withValues(alpha: 0.94),
              surfaceTintColor: Colors.transparent,
              elevation: 3,
              shadowColor: Colors.black.withValues(alpha: 0.22),
              clipBehavior: Clip.antiAlias,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(barHeight / 2),
                side: BorderSide(color: colors.outlineVariant.withValues(alpha: 0.7)),
              ),
              child: SizedBox(
                height: barHeight,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    // 下载入口留在工具条里（手机拇指热区让给底栏的后退/回家/前进）。
                    // 浏览页是 push 出来的独立路由，App 级的 ListenableBuilder
                    // 不会重建它 —— 必须自己监听 state，否则下载一开始角标亮不起来。
                    ListenableBuilder(
                      listenable: widget.state,
                      builder: (BuildContext ctx, Widget? _) {
                        final int active = widget.state.activeDownloadCount;
                        return _capsuleButton(
                          context: context,
                          tooltip: '下载',
                          size: buttonSize,
                          onPressed: () => Navigator.of(context).push<void>(
                            MaterialPageRoute<void>(
                              builder: (BuildContext _) => DownloadsPage(state: widget.state),
                            ),
                          ),
                          child: Badge(
                            isLabelVisible: active > 0,
                            label: Text('$active'),
                            child: const Icon(Icons.download_outlined),
                          ),
                        );
                      },
                    ),
                    _capsuleButton(
                      context: context,
                      tooltip: '刷新',
                      size: buttonSize,
                      onPressed: () => _controller?.reload(),
                      child: const Icon(Icons.refresh),
                    ),
                    _capsuleButton(
                      context: context,
                      tooltip: '更多',
                      size: buttonSize,
                      onPressed: () => _showPageMenu(context),
                      child: const Icon(Icons.more_vert),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 胶囊里的一个图标按钮。
  ///
  /// 刻意不用 `IconButton`：它的最小命中区被硬编码成 48×48
  /// （`kMinInteractiveDimension`），塞进 40 高的胶囊会直接溢出；用
  /// `InkResponse` + 定尺 `SizedBox` 才能把视觉尺寸压到 36/40，同时保住
  /// 圆形水波，而且不依赖 `IconButton.style` 的参数在 Flutter 版本间漂移。
  Widget _capsuleButton({
    required BuildContext context,
    required String tooltip,
    required VoidCallback? onPressed,
    required Widget child,
    required double size,
  }) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    final Color iconColor = onPressed == null
        ? colors.onSurfaceVariant.withValues(alpha: 0.35)
        : colors.onSurfaceVariant;
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 600),
      child: InkResponse(
        onTap: onPressed,
        radius: size * 0.62,
        containedInkWell: true,
        highlightShape: BoxShape.circle,
        child: SizedBox(
          width: size,
          height: size,
          child: Center(
            child: IconTheme(
              data: IconThemeData(size: _isTouch ? 22 : 20, color: iconColor),
              child: child,
            ),
          ),
        ),
      ),
    );
  }

  /// 桌面：鼠标离开胶囊 1.5 秒后淡到 35%。
  ///
  /// 只在"用完之后"才淡，页面刚打开时不淡 —— 用户第一眼得先看清按钮在哪儿。
  void _scheduleChromeFade() {
    _chromeTimer?.cancel();
    _chromeTimer = Timer(const Duration(milliseconds: 1500), () {
      if (!mounted) return;
      _setChrome(0.35);
    });
  }

  /// 改工具条不透明度。同值直接返回，避免滚动回调逐帧 setState。
  void _setChrome(double value) {
    if (!mounted) return;
    if ((_chromeOpacity - value).abs() < 0.01) return;
    setState(() => _chromeOpacity = value);
  }

  /// 触摸端：往下读 → 收起胶囊；往回滑 / 回到顶部 → 放出胶囊。
  ///
  /// 12px 死区是为了不吃手指的轻微抖动（否则轻微回弹就来回闪）；
  /// `y <= 8` 一律当"到顶"，保证任何时刻往上一滑都能立刻拿回按钮。
  void _onScrollChanged(InAppWebViewController controller, int x, int y) {
    if (!_isTouch) return;
    final int delta = y - _lastScrollY;
    _lastScrollY = y;
    if (y <= 8) {
      _setChrome(1);
      return;
    }
    if (delta > 12) {
      _setChrome(0);
    } else if (delta < -12) {
      _setChrome(1);
    }
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
    // 手机拇指热区惯例：后退贴左下角、前进贴右下角、回家居中。
    // 用 spaceBetween 让两端真正贴到 BottomAppBar 的两侧边缘，
    // 而不是挤在中间（用户反馈：第一个/第二个挤在一起不符合使用习惯）。
    // 下载入口已移到右上角悬浮胶囊（见 _floatingToolbar）。
    return SafeArea(
      top: false,
      child: BottomAppBar(
        height: 56,
        padding: EdgeInsets.zero,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: <Widget>[
            IconButton(
              tooltip: '后退',
              onPressed: _canGoBack ? () => _controller?.goBack() : null,
              icon: const Icon(Icons.arrow_back),
            ),
            IconButton(
              tooltip: '回到首页',
              onPressed: () {
                final SiteProfile? site = _site;
                if (site != null) _controller?.loadUrl(urlRequest: URLRequest(url: WebUri(site.startUrl)));
              },
              icon: const Icon(Icons.home_outlined),
            ),
            IconButton(
              tooltip: '前进',
              onPressed: _canForward ? () => _controller?.goForward() : null,
              icon: const Icon(Icons.arrow_forward),
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
      // 缓存策略：有缓存就用缓存、没有才走网络。WebView 默认的 LOAD_DEFAULT
      // 每次都回源验证（304 也要等一个来回），用户感知就是"每次重开 App 都卡一下
      // 重新加载"。LOAD_CACHE_ELSE_NETWORK 让二次打开直接吃本地缓存、秒出。
      // "保持登录"关掉时 incognito 已经把缓存一并禁了，不受这里影响。
      cacheMode: CacheMode.LOAD_CACHE_ELSE_NETWORK,
      // 安全第一：不允许网页通过 file:// 读本机文件；上传走系统文件选择器，不受影响
      allowFileAccess: false,
      allowContentAccess: false,
      // 保留 WebView 自带的上下文菜单 —— 长按文本框的"全选/复制/剪切/粘贴"
      // 就是它弹的。曾 here 设过 true，结果 Android 上长按输入框完全没有菜单
      // （插件在 Android 是把 ActionMode 的 menu clear 掉再 finish，等于连文本
      // 选择菜单一起禁了），表现为"文本没法复制/剪切/全选"。
      // 长按链接的自定义菜单不依赖这个开关：JS 的 DOM contextmenu 事件照常触发，
      // 脚本会先判断命中目标，只对 <a> preventDefault 并弹我们自己的菜单；
      // 普通文本不 preventDefault，于是系统菜单正常出现，两者不冲突。
      disableContextMenu: false,
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
    // 工具条淡出的定时器必须在这里掐掉：它持有 this，页面 pop 之后还会往回
    // setState（虽然被 mounted 挡住，但定时器本身会一直挂着）。
    _chromeTimer?.cancel();
    _refreshController?.dispose();
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
      callback: (List<dynamic> args) async {
        final Map<String, dynamic> data = payload(args);
        final bool on = data['on'] == true;
        if (mounted) setState(() => _fullscreen = on);
        // 网页全屏（主要是 <video>）时，WebView2 会自己把宿主窗口顶成无边框
        // 全屏；退出全屏时它不一定能干净还原，一旦还原失败，窗口就卡在
        // 无边框全屏状态盖住整个桌面 —— 用户看到的就是"桌面点不动了"，
        // 点任务栏的「显示桌面」把窗口最小化之后才恢复。
        //
        // 这里跟着网页的全屏状态显式调一次 setFullScreen：进则进、退则退，
        // 保证窗口状态始终由我们掌控、不会卡在全屏。
        if (Platform.isWindows) {
          try {
            await windowManager.setFullScreen(on);
          } catch (_) {
            // 窗口已销毁 / 托盘未启用（windowManager 没初始化）等边界情况：
            // 忽略即可，网页本身的全屏不受影响。
          }
        }
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
    final ColorScheme colors = Theme.of(context).colorScheme;

    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 标题 / 地址从顶栏搬到这儿：胶囊不放文字（一放就又变成"占空间的
            // 横条"），但"我现在在哪个页面、地址是什么"这个信息不能丢，
            // 于是改成点「更多」时先看一眼。showAddressBar 的开关语义照旧。
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    _title.isEmpty ? site.displayName : _title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: colors.onSurface,
                    ),
                  ),
                  if (widget.state.branding.showAddressBar)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        displayUrl(current),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
                      ),
                    ),
                ],
              ),
            ),
            const Divider(height: 1),
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
            // 直达模式下没有首页，App 设置（下载目录、保持登录这些）从这里进。
            if (widget.state.branding.singleSiteMode)
              ListTile(
                leading: const Icon(Icons.settings_outlined),
                title: const Text('设置'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(
                      builder: (BuildContext _) => SettingsPage(state: widget.state),
                    ),
                  );
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
