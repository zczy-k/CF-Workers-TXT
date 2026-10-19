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
      await windowManager.hide();
    } else {
      await _quit();
    }
  }

  @override
  void onWindowMinimize() async {
    // "最小化到托盘"：任务栏里也不留（收干净），想回来点托盘图标。
    if (hideToTray()) await windowManager.hide();
  }

  // ------------------------------------------------------------- 托盘事件

  @override
  void onTrayIconMouseDown() async {
    await windowManager.show();
    await windowManager.focus();
  }

  @override
  void onTrayIconRightMouseDown() async {
    // Windows 上菜单不会自己弹，要手动调一次。
    if (Platform.isWindows) await trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem item) async {
    if (item.key == 'show') {
      await windowManager.show();
      await windowManager.focus();
    } else if (item.key == 'quit') {
      await _quit();
    }
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
