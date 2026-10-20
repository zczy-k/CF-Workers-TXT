import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart' show ByteData, rootBundle;
import 'package:path_provider/path_provider.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

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

    // tray_manager 只吃磁盘路径：把 assets 里的图标解到临时目录再用。
    try {
      final ByteData data = await rootBundle.load('assets/tray_icon.ico');
      final Directory tmp = await getTemporaryDirectory();
      final File icon =
          File('${tmp.path}${Platform.pathSeparator}webshell_tray.ico');
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
  /// 隐藏前先把"始终置顶"抹掉：window_manager 的 hide() 在 Windows 上就是
  /// ShowWindow(SW_HIDE)，如果隐藏时窗口还挂着 TOPMOST 这个附加样式，重新
  /// 显示后它会带着样式回来，压在别的窗口（包括桌面）上面 —— 表现就是
  /// "桌面上有一层看不见/点不动的东西"。隐藏前清掉，恢复后就是普通窗口。
  Future<void> _hideToTray() async {
    try {
      await windowManager.setAlwaysOnTop(false);
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
  /// 这里的顺序：显示 → 若被最小化则还原 → 抢前台 → 置顶再立刻取消。
  /// "置顶→取消"是 Win32 上通行的合法抢前台手法（置顶会强制把窗口置前，
  /// 马上取消又不会让它一直压着别人），能让刚恢复的窗口真正成为前台窗口。
  Future<void> _restore() async {
    await windowManager.show();
    try {
      if (await windowManager.isMinimized()) {
        await windowManager.restore();
      }
    } catch (_) {}
    await windowManager.focus();
    try {
      await windowManager.setAlwaysOnTop(true);
      await windowManager.setAlwaysOnTop(false);
    } catch (_) {}
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
