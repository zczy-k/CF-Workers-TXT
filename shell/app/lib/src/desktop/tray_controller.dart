import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart' show ByteData, rootBundle;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';
import 'package:webshell_core/webshell_core.dart';

import '../paths.dart';
import 'webview_window_guard.dart';

/// 桌面端的窗口与托盘行为（Windows 规范版）。
///
/// * **最小化按钮 = 系统默认（进任务栏），不接管。**
///   window_manager 0.5.x 没有 preventMinimize：`onWindowMinimize` 是窗口
///   【已经最小化之后】的事后通知。在通知里再补 `hide()` 会造出
///   "最小化 + 隐藏"叠加态 —— 恢复链必须同时解两层，错一层桌面就剩一块
///   点不动的区域（本仓库曾出现过的故障形态）。系统默认最小化进任务栏，
///   任务栏由系统管理、永不失灵，也是用户的肌肉记忆。
/// * **关闭按钮 = 收进系统托盘**（[hideToTray] 开关，默认开；关掉后点关闭
///   = 真退出）。隐藏就是一次 `hide()`（`SW_HIDE`）：
///   - SW_HIDE 会**保留**最大化样式（Chrome 最小化再打开就是这个行为），
///     恢复时 `maximize()` 原样带回 —— 所以隐藏前【不做】预防性 unmaximize，
///     那会在屏幕上闪一次"从全屏缩回小窗"的还原动画，还附带一次焦点转移；
///   - 也不做 setAlwaysOnTop 折腾：TOPMOST 是窗口样式，hide() 不会放大它，
///     恢复链自有兜底。
/// * **恢复**：show → (最小化则 restore) → (曾是最大化则 maximize) → focus。
///   托盘单击是用户真实输入，自带前台授权（SetForegroundWindow 锁放行），
///   focus() 一次即可；"置顶→立刻取消"抖动只在授权失效（键盘/脚本触发）
///   没拿到前台时才作为兜底执行一次。
/// * **WebView2 残留窗清扫（Windows 专项，[WebViewWindowGuard]）**：
///   flutter_inappwebview 的内容窗是 `msedgewebview2.exe` 名下的独立顶层
///   LAYERED 弹窗（`Chrome_WidgetWin_1`），跟宿主窗口没有父子/属主关系 ——
///   宿主最小化或 hide 时它**不跟着走**，残留在原处；它对 `WM_NCHITTEST`
///   恒回 `HTNOWHERE`，覆盖区域的鼠标点击被**静默吞掉**（最大化后收托盘
///   = 整个桌面点不动即由此而来）。所以：所有让宿主不可见的路径补一次
///   `hideOrphaned()`，所有让宿主重新可见的路径补一次 `showSwept()`。
/// * **历史教训（不许回潮）**：**绝对不要调 `windowManager.setSkipTaskbar()`**。
///   window_manager 的 Windows 插件在这个方法里用构造期缓存的 `ITaskbarList*`；
///   该指针没建起来时为 NULL，方法内没有判空，一调用就 `mov rax,[rcx]` 读
///   NULL->vtable 直接访问违例（window_manager_plugin.dll+0xb2af，
///   0xC0000005 进程级崩溃，Dart 侧 try/catch 拦不住）。hide() 之后任务栏
///   按钮本来就会消失，这一步没有任何收益。
///
/// 移动端没有"托盘"概念：[supported] 为 false，全部逻辑短路。
class TrayController with TrayListener, WindowListener {
  TrayController({required this.appName, required this.hideToTray});

  /// 展示在托盘提示与菜单里的名字。
  final String appName;

  /// 每次都现问：用户可能随时在设置里开关"关闭时收进托盘"。
  final bool Function() hideToTray;

  bool _started = false;

  /// 关闭收托盘那一刻窗口是否最大化。恢复时按它还原。
  /// （SW_HIDE 保留最大化样式，但恢复链显式 maximize() 一次更稳，
  /// 也把"曾经最大化过但恢复时已被用户改小"的窗口区分开。）
  bool _wasMaximized = false;

  /// 只有桌面平台才启用（本仓库只出 Windows 包，但 mac/linux 逻辑同构）。
  static bool get supported =>
      !kIsWeb &&
      (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  Future<void> start() async {
    if (!supported || _started) return;
    _started = true;

    await windowManager.ensureInitialized();
    await windowManager.setPreventClose(true);
    // 把窗口标题钉在 branding 名上：单实例守卫按"类名+标题"找旧窗口，
    // 标题必须与 branding 一致（哪怕 runner 的 main.cpp 没被 CI patch）。
    await windowManager.setTitle(appName);
    windowManager.addListener(this);
    trayManager.addListener(this);

    // tray_manager 只吃磁盘路径：把 assets 里的图标解到数据目录再用。
    // 用 appDataDir() 而不是系统临时目录 —— 便携版下所有运行数据都在程序目录，
    // 连这个解出来的图标也一样，C 盘不留东西。
    try {
      final ByteData data = await rootBundle.load('assets/tray_icon.ico');
      final Directory dir = await appDataDir();
      final File icon = File(joinPath(dir.path, 'webshell_tray.ico'));
      await icon.writeAsBytes(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        flush: true,
      );
      await trayManager.setIcon(icon.path);
    } catch (_) {
      // 图标解不出来不挡启动：托盘里没图标，但窗口行为不受影响。
    }
    await trayManager.setToolTip(appName);
    // tray_manager 0.5.x 的 API 叫 setContextMenu（不是 setMenu）
    await trayManager.setContextMenu(Menu(items: <MenuItem>[
      MenuItem(key: 'show', label: '打开 $appName'),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: '退出'),
    ]));
  }

  // ------------------------------------------------------------- 窗口事件

  /// 关闭按钮：收托盘或真退出。
  ///
  /// 隐藏前只**记录**最大化状态，不动窗口 —— 隐藏动作本身只有一次
  /// `hide()`，不加任何前置窗口操作（见类注释）。hide() 之后立刻清掉
  /// WebView2 残留窗，否则它会留在桌面吞点击。
  @override
  void onWindowClose() async {
    if (hideToTray()) {
      try {
        _wasMaximized = await windowManager.isMaximized();
      } catch (_) {
        _wasMaximized = false;
      }
      await windowManager.hide();
      // WebView2 的内容窗是独立顶层弹窗，不会跟着宿主隐藏 —— 不清掉它
      // 就残留在桌面吞点击（见 WebViewWindowGuard 类注释）。
      WebViewWindowGuard.instance.hideOrphaned();
    } else {
      await _quit();
    }
  }

  /// 最小化按钮仍是**系统默认**（进任务栏），这里绝不碰宿主窗口一根毫毛；
  /// 只清 WebView2 残留窗 —— 最小化时它同样会留在原区域吞点击。
  /// （别把"事后通知里补 hide()"加回来：那才是"最小化+隐藏"叠加态的
  /// 设计根源，见类注释。）
  @override
  void onWindowMinimize() {
    WebViewWindowGuard.instance.hideOrphaned();
  }

  /// 任务栏还原（从最小化回来）：把清掉的 WebView2 窗放回来。
  @override
  void onWindowRestore() {
    WebViewWindowGuard.instance.showSwept();
  }

  /// 焦点兜底：万一 restore 事件因插件时序没到，窗口拿到焦点时也一定
  /// 已经可见 —— 这时补放一次（名单已清空时是空操作，零成本）。
  @override
  void onWindowFocus() {
    WebViewWindowGuard.instance.showSwept();
  }

  // ------------------------------------------------------------- 托盘事件

  @override
  void onTrayIconMouseDown() async {
    await _restore();
  }

  @override
  void onTrayIconRightMouseDown() async {
    // Windows 上菜单不会自己弹，要手动调一次。
    if (Platform.isWindows) await trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    if (menuItem.key == 'show') {
      await _restore();
    } else if (menuItem.key == 'quit') {
      await _quit();
    }
  }

  /// 从托盘恢复窗口。
  ///
  /// 顺序：显示 → 若最小化则还原 → 若收托盘前是最大化则还原最大化
  /// → 补放 WebView2 残留窗 → 抢前台。托盘单击带前台授权，focus() 一次就够；
  /// 只有没拿到前台时才抖一次"置顶→取消"兜底（置顶会强制把窗口置前，马上取消
  /// 又不会让它一直压着别人）。
  Future<void> _restore() async {
    await windowManager.show();
    try {
      if (await windowManager.isMinimized()) {
        await windowManager.restore();
      }
    } catch (_) {}
    if (_wasMaximized) {
      _wasMaximized = false;
      try {
        await windowManager.maximize();
      } catch (_) {}
    }
    // 宿主已可见：把收托盘/最小化时清掉的 WebView2 窗放回来。
    WebViewWindowGuard.instance.showSwept();
    await windowManager.focus();
    // 兜底：前台授权失效（键盘/脚本触发）导致 focus 没生效时才抖。
    try {
      if (!await windowManager.isFocused()) {
        await windowManager.setAlwaysOnTop(true);
        await windowManager.setAlwaysOnTop(false);
        await windowManager.focus();
      }
    } catch (_) {}
  }

  Future<void> _quit() async {
    // 退出前再清一次：进程树销毁前那几秒，别让残留窗继续吃桌面点击。
    // （清扫内部已改 ShowWindowAsync：跨进程投递不等回执，WebView2 正忙也
    // 不会把退出卡在这里。）
    WebViewWindowGuard.instance.hideOrphaned();
    try {
      await trayManager.destroy();
    } catch (_) {
      // 退出路径上任何托盘问题都不该挡住退出本身。
    }
    await windowManager.destroy();
    // 兜底硬切：destroy() 返回 ≠ 进程已退 —— Flutter 引擎优雅关闭 +
    // WebView2 子进程树退出常要 0.5~2s（用户感知就是"点了退出没反应"），
    // 极端时消息循环卡住进程根本不退。给 300ms：正常路径引擎早退完了
    // 轮不到这一刀；没退完就切，WebView2 子进程随宿主进程树一起被系统收走。
    Timer(const Duration(milliseconds: 300), () => exit(0));
  }
}