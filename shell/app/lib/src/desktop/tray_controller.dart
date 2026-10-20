import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart' show ByteData, rootBundle;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';
import 'package:webshell_core/webshell_core.dart';

import '../paths.dart';

/// 桌面端的窗口与托盘行为。
///
/// * 关闭按钮：默认收进系统托盘（微信 / 钉钉 / OneDrive 的通行做法），
///   设置里可以关掉（关掉后点关闭 = 真退出）；
/// * 最小化按钮：同样收进托盘；
/// * 托盘左键单击 = 恢复窗口；右键 = 菜单（打开 / 退出）；
/// * 「退出」= 真正退出（先摘托盘图标，再销毁窗口）。
///
/// 移动端没有"托盘"这个概念：[supported] 为 false，全部逻辑短路。
class TrayController with TrayListener, WindowListener {
  TrayController({required this.appName, required this.hideToTray});

  /// 展示在托盘提示与菜单里的名字。
  final String appName;

  /// 每次都现问：用户可能随时在设置里开关"收进托盘"。
  final bool Function() hideToTray;

  bool _started = false;

  /// 隐藏窗口前它是不是最大化。最大化 + SW_HIDE 是这套问题的核心组合：
  /// 最大化窗口被隐藏后，Windows 把它的还原状态记成 SW_SHOWMAXIMIZED，
  /// 但重新显示时 SetForegroundWindow 又常被拒 —— 于是窗口既没真正回到
  /// 前台、又占着"最大化全屏"的激活位置，桌面上就出现一层点不动的东西。
  /// 所以隐藏前先还原成普通大小，恢复时再按这个标记还原回去。
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

  @override
  void onWindowClose() async {
    if (hideToTray()) {
      await _hideToTray();
    } else {
      await _quit();
    }
  }

  @override
  void onWindowMinimize() async {
    // "最小化到托盘"：任务栏里也不留（收干净），想回来点托盘图标。
    if (hideToTray()) await _hideToTray();
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
  void onTrayMenuItemClick(MenuItem item) async {
    if (item.key == 'show') {
      await _restore();
    } else if (item.key == 'quit') {
      await _quit();
    }
  }

  /// 收进托盘（真正隐藏窗口）。
  ///
  /// 顺序很重要，两步都不能省：
  ///
  /// 1. **先退出最大化**：`window_manager.hide()` 在 Windows 上就是
  ///    `ShowWindow(SW_HIDE)`。如果藏起来的是最大化窗口，系统记下的还原
  ///    状态是 `SW_SHOWMAXIMIZED`；下次显示时它自带"最大化 + 抢不回前台"，
  ///    桌面就会剩一块点不动的区域。藏之前先还成普通大小，恢复后再按
  ///    [_wasMaximized] 还原，避免这个组合。
  /// 2. **再抹掉"始终置顶"**：TOPMOST 是窗口的附加样式，`hide()` 不会清它；
  ///    带着样式隐藏、带着样式回来，就会压在别的窗口（含桌面）上面。
  ///
  /// 最后补一个 `setSkipTaskbar(true)`：把任务栏按钮也收掉，回来时再重建
  /// （用户看到的效果是"最小化到托盘"，任务栏里干净）。
  Future<void> _hideToTray() async {
    try {
      if (await windowManager.isMaximized()) {
        _wasMaximized = true;
        await windowManager.unmaximize();
      }
    } catch (_) {}
    try {
      await windowManager.setAlwaysOnTop(false);
    } catch (_) {}
    try {
      await windowManager.setSkipTaskbar(true);
    } catch (_) {}
    await windowManager.hide();
  }

  /// 从托盘恢复窗口，并保证它**真正拿到前台激活**。
  ///
  /// 只 show() + focus() 在 Windows 上不可靠：被 hide() 隐藏过的窗口重新
  /// 显示时，SetForegroundWindow 常常被系统拒绝（"非前台进程不能抢前台"），
  /// 于是窗口虽然可见，鼠标点上去却像打在空气里、键盘也没反应 —— 只能点任务
  /// 栏的「显示桌面」把别的窗口全最小化，或再点一次托盘图标，输入才恢复。
  ///
  /// 恢复顺序：
  ///   显示 → 重建任务栏按钮 → 若最小化则还原 → 若藏之前是最大化则还原
  ///   → 抢前台 → "置顶再立刻取消"强制置前 → 再抢一次前台。
  ///
  /// "置顶→取消"是 Win32 上通行的合法抢前台手法（置顶会强制把窗口置前，
  /// 马上取消又不会让它一直压着别人）。
  Future<void> _restore() async {
    await windowManager.show();
    try {
      await windowManager.setSkipTaskbar(false);
    } catch (_) {}
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
    await windowManager.focus();
    try {
      await windowManager.setAlwaysOnTop(true);
      await windowManager.setAlwaysOnTop(false);
    } catch (_) {}
    // 前面几次都可能被前台锁吞掉，最后再要一次焦点作为兜底。
    await windowManager.focus();
  }

  Future<void> _quit() async {
    try {
      await trayManager.destroy();
    } catch (_) {
      // 退出路径上任何托盘问题都不该挡住退出本身。
    }
    await windowManager.destroy();
  }
}
