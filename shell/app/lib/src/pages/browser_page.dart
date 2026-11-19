import 'dart:async';
import 'dart:collection';
import 'dart:convert';
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

  /// 触摸端 PDF 预览的字节缓冲（key → 文件 sink / 路径）。
  ///
  /// Android WebView 不会内联渲染 `blob:` 的 PDF，会把预览当下载导航。
  /// 拦到这种导航后让页面把 Blob 分片送回来，落到临时文件，再交系统 PDF
  /// 应用打开 —— 全程不进下载列表（用户没点下载，就不该多出一条记录）。
  final Map<String, IOSink> _pdfSinks = <String, IOSink>{};
  final Map<String, String> _pdfPaths = <String, String>{};

  /// 手机 / 平板。底栏高度按这个分叉：触摸端给拇指留 56，桌面压到 48。
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
        // 没有 AppBar：那 56dp 是"布局元素"，多高就实打实吃掉多少网页高度，
        // 而直达模式下标题区本来是空的 —— 用户看到的就是一条空白带。
        // 现在只保留一条底栏装功能按钮（见 _bottomBar），网页从状态栏下沿
        // 一直铺到底栏；手机 / 平板的状态栏由下面的 SafeArea 让开。
        // 硬规矩不变：壳的控件只存在于**布局占位区**里，不盖网页任何东西。
        body: SafeArea(
          // 没有 AppBar 之后，Scaffold 不再替 body 吃掉系统状态栏那一截。
          // Android 15+ 强制 edge-to-edge：WebView 会从窗口 y=0 开始画，
          // 站点自己的顶栏（根目录 / 刷新 / 退出）直接钻到状态栏底下，
          // 和时间、信号、电量叠成一团（手机截图已复现；平板同一套代码同样会中）。
          // SafeArea 是布局占位、不是浮层 —— 网页整体让开一个状态栏高度，
          // 不遮任何网页内容；桌面 padding 为 0，等于没有这一层。
          top: true,
          // 底栏自带 SafeArea(top: false) 处理手势条 / 导航栏，这里别重复吃。
          bottom: false,
          child: Column(
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
                          // 触摸端：blob PDF 预览转系统阅读器，别当下载/别留空白
                          pdfPreviewInApp: _isTouch,
                        ),
                        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                        forMainFrameOnly: false,
                      ),
                    ],
                  ),
                  onWebViewCreated: _onWebViewCreated,
                  pullToRefreshController: _refreshController,
                  onLoadStart: (InAppWebViewController controller, WebUri? url) {
                    setState(() {
                      _loading = true;
                      _error = null;
                      _lastProgressStep = -1; // 新导航：重置进度台阶
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
              ),
              if (!_fullscreen) _bottomBar(context),
            ],
          ),
        ),
      ),
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

  /// 底栏：壳唯一的一条常驻工具条。
  ///
  /// 为什么所有按钮都塞在这里、而不是在网页上方叠一层悬浮工具条：
  /// 叠加层（悬浮胶囊）再怎么调位置，网页自己的右上角按钮、右侧滚动条、
  /// 顶部的编辑工具栏都可能被它压住 —— 而网页长什么样是站点决定的，壳不知道。
  /// 只要壳的控件画在网页"上面"，就一定存在被网页内容撞上的那一天。
  ///
  /// 所以规则是死的一条：**壳的控件只允许出现在布局占位区里**。
  /// 底栏是 Column 的一个兄弟节点，它占多高网页就矮多少，两者永不重叠，
  /// 也就永远不会有"挡着别人按钮"这种事。代价只是底部固定几十 dp，
  /// 换来的是零概率的遮挡 —— 这个交换对笔记类站点明显划算。
  Widget _bottomBar(BuildContext context) {
    // 「站点列表」只在真有列表页的时候出现。
    // singleSiteMode = 白标包 + 预置恰好一个站点 + 禁止加站 —— 此时
    // BrowserPage 本身就是根路由（见 app.dart 的 _homeFor），背后没有列表页，
    // 按钮按下去只会是死键。用户的要求也是"单网站不要显示"。
    final bool showSiteList = !widget.state.branding.singleSiteMode;

    // 底栏布局（2026-11-19 改版）：
    //
    //        [后退] [首页] [前进]              [站点列表] [更多]
    //                ↑ 屏幕正中
    //
    // ① 导航组整组居中、首页正压在屏幕中线上，前后对称 —— 拇指从左右任一侧
    //    伸过来位移一样，不用先"找"按钮在哪。
    // ② 功能组贴右。Align 不带 widthFactor 时铺满 Stack，与居中的导航组天然
    //    分层；320dp 窄屏上导航组 3×44=132 占 94~226，功能组 2×44=88 占
    //    232~320，中间还剩 6dp，不会撞。
    // ③ 底栏从 7 个键砍到 5 个：下载列表挪进「更多」菜单（那里本来就有一份
    //    刷新，底栏的刷新键同理删掉，同一功能不留两个入口）。
    // 触摸端 56dp、桌面 48dp：鼠标是精确指针，48 已经够点；手指需要更多余量。
    // 键间距只在桌面端加（窗口宽，留白好看）；触摸端 44dp 命中区里图标本身
    // 就有内边距，再加间距会把窄屏挤爆，反而更挤。
    final double navGap = _isTouch ? 0 : 8;

    return SafeArea(
      top: false,
      child: BottomAppBar(
        height: _isTouch ? 56 : 48,
        padding: EdgeInsets.zero,
        child: Stack(
          // 居中：底栏 56 / 48 比按钮的 48 命中区高时，让那一排按键垂直居中，
          // 而不是顶着上沿留一条空档。Positioned 的进度线不受影响。
          alignment: Alignment.center,
          children: <Widget>[
            // 导航组：后退 / 首页 / 前进，整组居中。
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                _barIcon(
                  tooltip: '后退',
                  icon: Icons.arrow_back,
                  onPressed: _canGoBack ? () => _controller?.goBack() : null,
                ),
                if (navGap > 0) SizedBox(width: navGap),
                _barIcon(
                  tooltip: '回到首页',
                  icon: Icons.home_outlined,
                  onPressed: () {
                    final SiteProfile? site = _site;
                    if (site != null) {
                      _controller?.loadUrl(
                        urlRequest: URLRequest(url: WebUri(site.startUrl)),
                      );
                    }
                  },
                ),
                if (navGap > 0) SizedBox(width: navGap),
                _barIcon(
                  tooltip: '前进',
                  icon: Icons.arrow_forward,
                  onPressed: _canForward ? () => _controller?.goForward() : null,
                ),
              ],
            ),
            // 功能组贴右：站点列表 / 更多。
            Align(
              alignment: Alignment.centerRight,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // 站点列表（退出当前站点）。
                  //
                  // **必须用 pop()，绝不能用 maybePop()。** 本页外面套着
                  // PopScope(canPop: !_canGoBack)（见本文件 _build 的返回键
                  // 拦截）。maybePop 会先问路由的 popDisposition，只要网页还有
                  // 历史（_canGoBack == true）这次 pop 就被判成 doNotPop，转而
                  // 执行 onPopInvokedWithResult 里的 _controller.goBack() ——
                  // 于是这个键实际等于"后退一页"，用户点完还停在同一个站点里。
                  // 桌面端 WebView 历史几乎总是非空 → 100% 退化；手机端只有历史
                  // 退到底那一下才碰巧能退出，这就是"时灵时不灵"的全部来源。
                  // pop() 是硬退栈，不查 popDisposition，语义才是"退出站点"。
                  if (showSiteList)
                    _barIcon(
                      tooltip: '站点列表',
                      icon: Icons.apps,
                      onPressed: () {
                        final NavigatorState nav = Navigator.of(context);
                        // canPop 兜底：单站点/根路由场景下按钮本来就不显示，
                        // 这里再挡一次，避免任何异常栈形态下抛 StateError。
                        if (nav.canPop()) nav.pop();
                      },
                    ),
                  _barIcon(
                    tooltip: '更多',
                    icon: Icons.more_vert,
                    onPressed: () => _showPageMenu(context),
                  ),
                ],
              ),
            ),
            // 加载进度：压在底栏自己的上沿，横贯全宽。
            // 放在底栏内部是因为它不占任何额外高度（Bar 的高度是定死的），
            // 同时又绝不可能跑到网页上去盖住东西。
            if (_loading)
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
          ],
        ),
      ),
    );
  }

  /// 底栏上的一个图标按钮。
  ///
  /// 命中区从 IconButton 默认的 48dp 收到 44（触摸端）/ 40（桌面），不是随手
  /// 缩的：底栏最挤的时候（多站点模式）有 7 个按钮，7×48 = 336 —— 360dp 的
  /// 窄屏刚好卡死，320dp（iPhone SE 一类老机型）直接 RenderFlex overflow 报
  /// 红条。44 仍在 Material 触摸尺寸下限附近，手指点得中；7×44 = 308 留出余量。
  /// 现在底栏只剩 5 个键（下载、刷新都收进「更多」菜单），这套尺寸没动 ——
  /// 44/40 的命中区手感是验证过的，换布局不跟着改手感。
  Widget _barIcon({
    required String tooltip,
    required VoidCallback? onPressed,
    IconData? icon,
    Widget? iconWidget,
  }) {
    final double size = _isTouch ? 44 : 40;
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: iconWidget ?? Icon(icon),
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
    );
  }

  // ---------------------------------------------------------------- 引擎配置

  InAppWebViewSettings _settings(SiteProfile site) {
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
      // 缓存策略：优先吃 HTTP 缓存，但**必须回源校验**。
      //
      // 这里曾经是 LOAD_CACHE_ELSE_NETWORK（"有缓存就不回源"），看着更快，
      // 代价是 Cloudflare 一类挑战站会彻底卡死：挑战流程是
      //   页面 → 302 /cdn-cgi/challenge-platform/…/orchestrate/jsch/v1?ray=…
      //   → JS 生成带 ray id + 时间戳的 token → 回传校验
      // 缓存策略把 orchestrator 脚本和挑战页整段复用，token 里的时间戳早就过期，
      // 服务端校验必然失败，Cloudflare 就把它归类成"客户端状态/时钟不对"，
      // 于是无限重开挑战 —— 用户看到的就是"一直要验证，还说我设备时间不正确"。
      //
      // 为什么只有手机中招：`cacheMode` 是 Android WebView 的专有设置，
      // WebView2（Windows）根本不认这一项，走自己的 HTTP 缓存。同一个站点
      // 电脑能进、手机进不去，根子就在这。
      //
      // LOAD_DEFAULT 一样吃 HTTP 缓存（304 很便宜），正确性优先。
      cacheMode: CacheMode.LOAD_DEFAULT,
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
      userAgent: _effectiveUa(site),
      isInspectable: kDebugMode,
    );
  }

  /// 真正要用的 User-Agent：站点自己填了就用站点的，否则触摸端用「去掉 `wv` 标记」
  /// 的原生 UA。
  ///
  /// Android System WebView 的默认 UA 长这样：
  ///   `Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 … Mobile Safari/537.36`
  /// 那个 `; wv` 是"我在 WebView 里"的公开标记，Cloudflare 的 Bot Management
  /// 见到它直接把风险分拉满，站点就会把用户按在 Managed Challenge 上反复验证
  /// （实测某订阅站手机端就是被这么卡死的；WebView2 的 UA 不带 wv，所以
  /// 同一个站点电脑端直接进）。
  ///
  /// 只删 `; wv` 这一段，其余原样保留 —— 还是同一台设备、同一个 Chrome 版本、
  /// 同一个 `Mobile Safari`，站点不会因此给桌面版页面。
  /// 桌面端返回 null，让各平台用自己的原生 UA（WebView2 本来就干净）。
  String? _effectiveUa(SiteProfile site) {
    final String own = (site.userAgent ?? '').trim();
    if (own.isNotEmpty) return own;
    if (!_isTouch) return null;
    final String base = (widget.state.engineUserAgent ?? '').trim();
    if (base.isEmpty) return null;
    return base.replaceAll('; wv', '');
  }

  /// 顶层导航能带的头；页面内部请求由注入脚本补（WebView 平台不让改内部请求头）。
  Map<String, String> _topLevelHeaders(SiteProfile site) {
    final Map<String, String> headers = <String, String>{};
    site.headers.forEach((String key, String value) {
      if (value.isEmpty) return;
      if (kForbiddenHeaderNames.contains(key.toLowerCase())) return;
      headers[key] = value;
    });
    final String? ua = _effectiveUa(site);
    if (ua != null && ua.isNotEmpty) headers['User-Agent'] = ua;
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
    for (final String key in _pdfSinks.keys.toList()) {
      unawaited(_pdfAbort(key));
    }
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
    // PDF 预览字节通道：页面把 blob: PDF 分片送回来，落临时文件后交系统阅读器。
    // 与 blobStart/blobData/blobEnd 分开 —— 那是"真的下载"，要进下载列表。
    controller.addJavaScriptHandler(
      handlerName: 'pdfOpenStart',
      callback: (List<dynamic> args) async {
        final Map<String, dynamic> d = payload(args);
        final String key = (d['url'] as Object?)?.toString() ?? '';
        final int size = int.tryParse((d['size'] as Object?)?.toString() ?? '') ?? 0;
        await _pdfStart(key, size);
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'pdfOpenData',
      callback: (List<dynamic> args) {
        final Map<String, dynamic> d = payload(args);
        final String key = (d['url'] as Object?)?.toString() ?? '';
        final String data = (d['data'] as Object?)?.toString() ?? '';
        if (data.isEmpty) return null;
        try {
          _pdfSinks[key]?.add(base64Decode(data));
        } catch (_) {}
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'pdfOpenEnd',
      callback: (List<dynamic> args) async {
        final Map<String, dynamic> d = payload(args);
        final String key = (d['url'] as Object?)?.toString() ?? '';
        await _pdfFinish(key);
        return null;
      },
    );
    controller.addJavaScriptHandler(
      handlerName: 'pdfOpenError',
      callback: (List<dynamic> args) async {
        final Map<String, dynamic> d = payload(args);
        final String key = (d['url'] as Object?)?.toString() ?? '';
        final String message = (d['message'] as Object?)?.toString() ?? '预览失败';
        await _pdfAbort(key);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('PDF 预览失败：$message')),
          );
        }
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

  // -------------------------------------------------- PDF 预览（触摸端）

  /// 开一个临时文件接 PDF 字节。放在系统临时目录，不碰下载目录 ——
  /// 用户没点下载，下载列表和 Download 文件夹都不该多出东西。
  Future<void> _pdfStart(String key, int size) async {
    await _pdfAbort(key);
    if (key.isEmpty) return;
    try {
      final Directory dir = await Directory.systemTemp.createTemp('webshell-pdf-');
      final String path = '${dir.path}${Platform.pathSeparator}preview.pdf';
      _pdfPaths[key] = path;
      _pdfSinks[key] = File(path).openWrite();
    } catch (_) {
      _pdfPaths.remove(key);
    }
  }

  /// 字节收齐 → 关文件 → 调系统 PDF 应用。打开失败时提示，不留垃圾。
  Future<void> _pdfFinish(String key) async {
    final IOSink? sink = _pdfSinks.remove(key);
    final String? path = _pdfPaths.remove(key);
    if (sink == null || path == null) return;
    try {
      await sink.close();
    } catch (_) {}
    final String? error = await openLocalFile(path);
    if (error != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('打开 PDF 失败：$error')),
      );
    }
  }

  /// 出错 / 重开：丢掉半成品，删临时文件。
  Future<void> _pdfAbort(String key) async {
    final IOSink? sink = _pdfSinks.remove(key);
    final String? path = _pdfPaths.remove(key);
    if (sink != null) {
      try {
        await sink.close();
      } catch (_) {}
    }
    if (path != null) {
      try {
        final File f = File(path);
        if (f.existsSync()) await f.delete();
        final Directory parent = f.parent;
        if (parent.existsSync()) await parent.delete();
      } catch (_) {}
    }
  }

  Future<void> _onDownloadStart(
    InAppWebViewController controller,
    DownloadStartRequest request,
  ) async {
    final String url = request.url.toString();
    final String mime = (request.mimeType ?? '').toLowerCase();
    final String name = (request.suggestedFilename ?? '').toLowerCase();

    // 触摸端 PDF 预览：站点把 PDF 读成 blob 塞进 <iframe src="blob:…">，
    // Android WebView 渲染不了 PDF，直接把它当下载导航，于是"没点下载却下了一堆"。
    // 这里认出 blob: + PDF，拦下来让页面把字节送回来交系统阅读器，不入下载队列。
    if (_isTouch &&
        url.startsWith('blob:') &&
        (mime.contains('pdf') || name.endsWith('.pdf'))) {
      final String js = 'window.__wsOpenPdf && window.__wsOpenPdf(${jsonEncode(url)})';
      try {
        await controller.evaluateJavascript(source: js);
      } catch (_) {}
      return;
    }

    _enqueueDownload(
      url,
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
    // 打开菜单这一刻的下载数。菜单是 showModalBottomSheet 的一次性构建，
    // 不会跟着 state 重建 —— 这里只要个快照，够表达"有没有活儿在跑"。
    final int activeDownloads = widget.state.activeDownloadCount;

    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 标题 / 地址收在这里：底栏是纯图标条（一放文字就又变成"占空间的
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
            // 下载列表：从底栏挪进来的。底栏图标条上它的信息量最低（正常
            // 浏览时那个位置只显示一个"有没有下载"），却要占一整个 44dp 命中
            // 区，还跟刷新、站点列表挤在一起。挪到这里以后：底栏腾出位置给
            // 居中的导航组，下载入口的语义反而更清楚（"文件相关的事都在菜单里"）。
            ListTile(
              leading: Badge(
                isLabelVisible: activeDownloads > 0,
                label: Text('$activeDownloads'),
                child: const Icon(Icons.download_outlined),
              ),
              title: Text(
                activeDownloads > 0 ? '下载列表（$activeDownloads 个进行中）' : '下载列表',
              ),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (BuildContext _) => DownloadsPage(state: widget.state),
                  ),
                );
              },
            ),
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
