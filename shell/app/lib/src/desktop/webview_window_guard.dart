import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// Win32 `PROCESSENTRY32W`（只声明用得到的字段；x64 下按 C ABI 自动对齐，
/// sizeOf == 568）。`Struct` 是 `base` 类，子类必须 `final`。
final class _ProcessEntry32W extends Struct {
  @Uint32()
  external int dwSize;

  @Uint32()
  external int cntUsage;

  @Uint32()
  external int th32ProcessID;

  @IntPtr()
  external int th32DefaultHeapID;

  @Uint32()
  external int th32ModuleID;

  @Uint32()
  external int cntThreads;

  @Uint32()
  external int th32ParentProcessID;

  @Int32()
  external int pcPriClassBase;

  @Uint32()
  external int dwFlags;

  @Array(260)
  external Array<Uint16> szExeFile;
}

// --------------------------------------------------------------- 原生签名
//
// 注：顶层窗口枚举走 `GetWindow(GetDesktopWindow(), GW_CHILD)` +
// `GW_HWNDNEXT` 链，**不碰 `EnumWindows` 回调** —— 省掉 `Pointer.fromFunction`
// 与 `NativeFunction<...>` 的 FFI 类型推导坑，行为等价（拿到的是同一份
// 顶层窗口 Z 序列表）。

typedef _GetDesktopWindowNative = IntPtr Function();
typedef _GetDesktopWindowDart = int Function();

typedef _GetWindowNative = IntPtr Function(IntPtr hwnd, Uint32 cmd);
typedef _GetWindowDart = int Function(int hwnd, int cmd);

typedef _GetClassNameWNative = Int32 Function(
  IntPtr hwnd,
  Pointer<Uint16> buf,
  Int32 maxCount,
);
typedef _GetClassNameWDart = int Function(
  int hwnd,
  Pointer<Uint16> buf,
  int maxCount,
);

typedef _GetWindowThreadProcessIdNative = Uint32 Function(
  IntPtr hwnd,
  Pointer<Uint32> pid,
);
typedef _GetWindowThreadProcessIdDart = int Function(
  int hwnd,
  Pointer<Uint32> pid,
);

typedef _IsWindowVisibleNative = Int32 Function(IntPtr hwnd);
typedef _IsWindowVisibleDart = int Function(int hwnd);

typedef _ShowWindowAsyncNative = Int32 Function(IntPtr hwnd, Int32 cmd);
typedef _ShowWindowAsyncDart = int Function(int hwnd, int cmd);

typedef _GetCurrentProcessIdNative = Uint32 Function();
typedef _GetCurrentProcessIdDart = int Function();

typedef _CreateToolhelp32SnapshotNative = IntPtr Function(
  Uint32 flags,
  Uint32 pid,
);
typedef _CreateToolhelp32SnapshotDart = int Function(int flags, int pid);

typedef _Process32WNative = Int32 Function(
  IntPtr snap,
  Pointer<_ProcessEntry32W> entry,
);
typedef _Process32WDart = int Function(
  int snap,
  Pointer<_ProcessEntry32W> entry,
);

typedef _CloseHandleNative = Int32 Function(IntPtr handle);
typedef _CloseHandleDart = int Function(int handle);

typedef _OpenProcessNative = IntPtr Function(
  Uint32 desiredAccess,
  Int32 inheritHandle,
  Uint32 pid,
);
typedef _OpenProcessDart = int Function(
  int desiredAccess,
  int inheritHandle,
  int pid,
);

typedef _TerminateProcessNative = Int32 Function(IntPtr handle, Uint32 exitCode);
typedef _TerminateProcessDart = int Function(int handle, int exitCode);

typedef _GetWindowRectNative = Int32 Function(
  IntPtr hwnd,
  Pointer<_Rect> rect,
);
typedef _GetWindowRectDart = int Function(int hwnd, Pointer<_Rect> rect);

typedef _GetClientRectNative = Int32 Function(
  IntPtr hwnd,
  Pointer<_Rect> rect,
);
typedef _GetClientRectDart = int Function(int hwnd, Pointer<_Rect> rect);

typedef _ClientToScreenNative = Int32 Function(
  IntPtr hwnd,
  Pointer<_Point> pt,
);
typedef _ClientToScreenDart = int Function(int hwnd, Pointer<_Point> pt);

typedef _GetWindowLongNative = Int32 Function(IntPtr hwnd, Int32 index);
typedef _GetWindowLongDart = int Function(int hwnd, int index);

typedef _SetWindowPosNative = Int32 Function(
  IntPtr hwnd,
  IntPtr hwndInsertAfter,
  Int32 x,
  Int32 y,
  Int32 cx,
  Int32 cy,
  Uint32 flags,
);
typedef _SetWindowPosDart = int Function(
  int hwnd,
  int hwndInsertAfter,
  int x,
  int y,
  int cx,
  int cy,
  int flags,
);

/// Win32 RECT（GetWindowRect / SetWindowPos 出参）。
final class _Rect extends Struct {
  @Int32()
  external int left;

  @Int32()
  external int top;

  @Int32()
  external int right;

  @Int32()
  external int bottom;
}

/// Win32 POINT（ClientToScreen 出入参）。
final class _Point extends Struct {
  @Int32()
  external int x;

  @Int32()
  external int y;
}

/// Flutter Windows 宿主窗口类名（模板固定值），找宿主 HWND 用。
const String _flutterWindowClass = 'FLUTTER_RUNNER_WIN32_WINDOW';

/// WebView2 残留窗口清扫器（仅 Windows；其它平台全部短路）。
///
/// **故障本体**：flutter_inappwebview 在 Windows 上把 WebView2 的内容渲染在
/// 一个属于 `msedgewebview2.exe` 进程的**独立顶层 LAYERED 弹窗**
/// （类名 `Chrome_WidgetWin_1`）里。这个弹窗跟 Flutter 宿主窗口之间
/// **没有父子/属主关系**（实测 `GA_ROOT == 自身`、owner 为 0），所以宿主
/// 最小化或 `SW_HIDE` 收托盘时它**不会跟着隐藏**，原样留在屏幕上。
///
/// **它为什么吃点击**：该窗样式为 `WS_POPUP|WS_VISIBLE` +
/// `WS_EX_LAYERED|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`（无 `WS_EX_TRANSPARENT`），
/// 参与系统命中测试；而它对 `WM_NCHITTEST` 恒答 `HTNOWHERE(0x0)`，
/// 消息循环活着（不是卡死）——系统就把覆盖区域的鼠标点击**静默丢弃**，
/// 既不穿透也不转发。于是：非最大化时残留在"窗口原尺寸"上 → 原区域点不动；
/// 最大化后残留铺满整屏 → **整个桌面点不动**。杀掉 msedgewebview2.exe
/// 立即恢复，实测坐实。
///
/// **处置**：宿主不可见时，把本进程系下 WebView2 的可视顶层弹窗一并
/// `SW_HIDE`；宿主重新可见时，只把**我们亲手藏过的**句柄 `SW_SHOW` 回来
/// （页面自己关掉的弹窗不在名单里，不会被复活）。
///
/// 只碰**本进程后代**里的 msedgewebview2.exe，绝不误伤机器上别的
/// WebView2 宿主（新版 Outlook、小组件等同样跑在 msedgewebview2.exe 上）。
class WebViewWindowGuard {
  WebViewWindowGuard._();

  /// 单例：窗口事件都经 TrayController 进来，全局一份状态即可。
  static final WebViewWindowGuard instance = WebViewWindowGuard._();

  static const int _swHide = 0;
  static const int _swShow = 5;
  static const int _th32csSnapProcess = 0x2; // TH32CS_SNAPPROCESS
  static const int _processTerminate = 0x0001; // PROCESS_TERMINATE
  static const int _gwChild = 5; // GW_CHILD
  static const int _gwHwndNext = 2; // GW_HWNDNEXT
  static const int _swpAsyncWindowPos = 0x4000; // SWP_ASYNCWINDOWPOS
  static const int _swpNoActivate = 0x0010; // SWP_NOACTIVATE
  static const int _swpNoZOrder = 0x0004; // SWP_NOZORDER
  static const int _gwlStyle = -16; // GWL_STYLE
  static const int _wsPopup = 0x80000000; // WS_POPUP
  static const int _wsCaption = 0x00C00000; // WS_CAPTION（DevTools 等带边框窗）

  /// 我们亲手藏起来的句柄。恢复时只放行这份名单。
  final List<int> _sweptHandles = <int>[];

  DynamicLibrary? _user32Lib;
  DynamicLibrary get _user32 => _user32Lib ??= DynamicLibrary.open('user32.dll');

  DynamicLibrary? _kernel32Lib;
  DynamicLibrary get _kernel32 =>
      _kernel32Lib ??= DynamicLibrary.open('kernel32.dll');

  late final _GetDesktopWindowDart _getDesktopWindow = _user32
      .lookupFunction<_GetDesktopWindowNative, _GetDesktopWindowDart>(
    'GetDesktopWindow',
  );

  late final _GetWindowDart _getWindow = _user32
      .lookupFunction<_GetWindowNative, _GetWindowDart>('GetWindow');

  late final _GetClassNameWDart _getClassName = _user32
      .lookupFunction<_GetClassNameWNative, _GetClassNameWDart>('GetClassNameW');

  late final _GetWindowThreadProcessIdDart _getWindowThreadProcessId = _user32
      .lookupFunction<_GetWindowThreadProcessIdNative, _GetWindowThreadProcessIdDart>(
    'GetWindowThreadProcessId',
  );

  late final _IsWindowVisibleDart _isWindowVisible = _user32
      .lookupFunction<_IsWindowVisibleNative, _IsWindowVisibleDart>(
    'IsWindowVisible',
  );

  /// 用 `ShowWindowAsync` 而不是 `ShowWindow`：目标是**别的进程**
  /// （msedgewebview2.exe）的窗口，同步版会把消息发给对方线程并**等回执**——
  /// 对方消息循环忙（正在渲染/加载）时宿主这边就卡住，退出/收托盘的
  /// "点了没反应"感很大一部分来自这里。Async 版只投递不等，零阻塞。
  late final _ShowWindowAsyncDart _showWindowAsync = _user32
      .lookupFunction<_ShowWindowAsyncNative, _ShowWindowAsyncDart>(
    'ShowWindowAsync',
  );

  late final _GetCurrentProcessIdDart _getCurrentProcessId = _kernel32
      .lookupFunction<_GetCurrentProcessIdNative, _GetCurrentProcessIdDart>(
    'GetCurrentProcessId',
  );

  late final _CreateToolhelp32SnapshotDart _createToolhelp32Snapshot = _kernel32
      .lookupFunction<_CreateToolhelp32SnapshotNative, _CreateToolhelp32SnapshotDart>(
    'CreateToolhelp32Snapshot',
  );

  late final _Process32WDart _process32First = _kernel32
      .lookupFunction<_Process32WNative, _Process32WDart>('Process32FirstW');

  late final _Process32WDart _process32Next = _kernel32
      .lookupFunction<_Process32WNative, _Process32WDart>('Process32NextW');

  late final _CloseHandleDart _closeHandle = _kernel32
      .lookupFunction<_CloseHandleNative, _CloseHandleDart>('CloseHandle');

  late final _OpenProcessDart _openProcess = _kernel32
      .lookupFunction<_OpenProcessNative, _OpenProcessDart>('OpenProcess');

  late final _TerminateProcessDart _terminateProcess = _kernel32
      .lookupFunction<_TerminateProcessNative, _TerminateProcessDart>(
    'TerminateProcess',
  );

  late final _GetWindowRectDart _getWindowRect = _user32
      .lookupFunction<_GetWindowRectNative, _GetWindowRectDart>(
    'GetWindowRect',
  );

  late final _GetClientRectDart _getClientRect = _user32
      .lookupFunction<_GetClientRectNative, _GetClientRectDart>(
    'GetClientRect',
  );

  late final _ClientToScreenDart _clientToScreen = _user32
      .lookupFunction<_ClientToScreenNative, _ClientToScreenDart>(
    'ClientToScreen',
  );

  late final _GetWindowLongDart _getWindowLongW = _user32
      .lookupFunction<_GetWindowLongNative, _GetWindowLongDart>(
    'GetWindowLongW',
  );

  late final _SetWindowPosDart _setWindowPos = _user32
      .lookupFunction<_SetWindowPosNative, _SetWindowPosDart>('SetWindowPos');

  // --------------------------------------------------------------- 对外接口

  /// 宿主窗口即将/已经不可见（收托盘、最小化、退出）时调用：
  /// 把本进程系下 WebView2 的可视顶层弹窗全部 `SW_HIDE`，并记账。
  void hideOrphaned() {
    if (!Platform.isWindows) return;
    try {
      final List<int> targets = _findVisibleWebviewWindows();
      for (final int hwnd in targets) {
        _showWindowAsync(hwnd, _swHide);
        _sweptHandles.add(hwnd);
      }
    } catch (_) {
      // 清扫失败不影响托盘/窗口主流程 —— 大不了退回原故障形态，不崩。
    }
  }

  /// 宿主窗口重新可见（托盘恢复、任务栏还原、重新获得焦点）时调用：
  /// 把 [hideOrphaned] 藏过的句柄 `SW_SHOW` 回来。
  ///
  /// 恢复前逐句柄校验仍属本进程系下的 WebView2、类名未变，防句柄被复用
  /// 时误放行别的窗口。名单处理完即清空。
  void showSwept() {
    if (!Platform.isWindows) return;
    if (_sweptHandles.isEmpty) return;
    try {
      final Set<int> pids = _webviewProcessPids();
      if (pids.isNotEmpty) {
        final Pointer<Uint32> pidBuf = calloc<Uint32>();
        final Pointer<Uint16> clsBuf = calloc<Uint16>(256);
        try {
          for (final int hwnd in _sweptHandles) {
            _getWindowThreadProcessId(hwnd, pidBuf);
            if (!pids.contains(pidBuf.value)) continue; // 窗口没了 / 句柄被复用
            final int n = _getClassName(hwnd, clsBuf, 256);
            if (n <= 0) continue;
            final String cls = String.fromCharCodes(clsBuf.asTypedList(n));
            if (!cls.startsWith('Chrome_WidgetWin')) continue;
            _showWindowAsync(hwnd, _swShow);
          }
        } finally {
          calloc.free(pidBuf);
          calloc.free(clsBuf);
        }
      }
    } catch (_) {
      // 失败不挡恢复主流程。
    } finally {
      _sweptHandles.clear();
    }
  }

  /// 进程级收尸：把本进程系下所有 `msedgewebview2.exe` 硬杀掉，返回杀掉的
  /// 个数。**只在退出路径上调用**（`tray_controller.dart` 的 `_quit`，在
  /// `windowManager.destroy()` 之后、`exit(0)` 之前）。
  ///
  /// **为什么需要它**：`destroy()` 返回 ≠ WebView2 已退 —— 引擎优雅关闭 +
  /// WebView2 子进程树自己退要 0.5~2s，而 Chromium 的 browser 进程有把自己
  /// detach 出 Job 对象的行为，Windows 按父子链收树时可能漏收；漏收的进程
  /// 父已死、成为孤儿，只能等 WebView2 Runtime 的 IPC 管道断开监控自杀（秒
  /// 级起步，个别 Runtime 版本滞留更久）。退出前由宿主亲手点名收割，不再
  /// "托付给系统"。
  ///
  /// * 名单来自 [_webviewProcessPids]（Toolhelp 快照 + 从本进程 BFS 的后代
  ///   集），与窗口清扫同一套口径——**只杀本进程后代里的
  ///   msedgewebview2.exe**，绝不误伤机器上别的 WebView2 宿主（Outlook、
  ///   小组件等同名进程）。
  /// * 杀完就退，跳过 Chromium 自己的落盘收尾（cookie/localStorage 最后
  ///   几百毫秒的写入可能丢）——退出场景下这是可接受的代价，换来的是
  ///   永不残留；Chromium 本来就按"随时会被杀"设计（crash-safe）。
  /// * `OpenProcess` 失败（进程已退/权限不足）静默跳过：收尸只求尽力，
  ///   任何失败都不挡退出主流程。
  int killDescendants() {
    if (!Platform.isWindows) return 0;
    int killed = 0;
    try {
      final Set<int> pids = _webviewProcessPids();
      for (final int pid in pids) {
        final int h = _openProcess(_processTerminate, 0, pid);
        if (h == 0) continue;
        try {
          if (_terminateProcess(h, 1) != 0) killed++;
        } finally {
          _closeHandle(h);
        }
      }
    } catch (_) {
      // 收尸失败不挡退出 —— 大不了维持原状（孤儿等 Runtime 自杀），不崩。
    }
    return killed;
  }

  /// 宿主窗口 rect 变化（拖动/缩放/最大化/还原）后的**对账**：
  /// 把没**精确对齐**宿主客户区的内容弹窗摆回宿主客户区原位。
  ///
  /// **为什么需要它**：hide/show 清扫只覆盖"宿主不可见→恢复"（收托盘/
  /// 最小化）；而**最大化→还原全程宿主可见**，谁也没动弹窗。插件自己
  /// 的位置同步链在这条路径上会失灵：宿主已缩回小窗，弹窗却停在最大化
  /// 时的旧矩形上 —— 旧矩形与宿主**部分相交**（比如右对齐、左边多出
  /// 一截）时，多出来的那一块照样吞点击（用户实测："还原后左边一条区
  /// 域点不动"）。所以判定不能是"完全无交集"，必须是**精确对齐**：
  ///
  /// * **基准** = 宿主**客户区**的屏幕矩形（GetClientRect + ClientToScreen）。
  ///   内容弹窗就该严丝合缝盖在客户区上 —— 它的窗口矩形与客户区矩形
  ///   任何一边有偏差（≥1px）都判错位，SetWindowPos 摆回去。
  /// * **只碰真正的"内容窗"**，三个指纹同时满足才动手（防误挪）：
  ///   a. 可见；（隐藏态归 hideOrphaned/showSwept 管）
  ///   b. 无 `WS_CAPTION`（DevTools/独立新窗带标题栏，插件合法地让它们
  ///      自由摆放，绝不能被拖走）；
  ///   c. 边长 ≥ 宿主客户区的 80%（右键菜单/下拉/气泡这类小弹窗允许
  ///      临时漂在别处，那是页面的正常 UI）。
  /// * 挪动用 `SWP_ASYNCWINDOWPOS` 投递不等回执，WebView2 正忙也不
  ///   阻塞宿主；`SWP_NOZORDER|SWP_NOACTIVATE` 只挪矩形不动 Z 序/不抢
  ///   焦点。摆位这一下本身也常能惊动 WebView2 重走它自己的同步链。
  ///
  /// 对账幂等：位置本来就对齐的弹窗不满足"有偏差"条件，零动作。
  void resyncToHost() {
    if (!Platform.isWindows) return;
    try {
      final int host = _findHostHwnd();
      if (host == 0) return;
      // 最小化/收托盘态不对账（此时宿主 rect 是 -32000 系的无效值），
      // 那两条路走 hideOrphaned/showSwept。
      if (_isWindowVisible(host) == 0) return;
      final Pointer<_Rect> hostClient = calloc<_Rect>();
      final Pointer<_Rect> wvRect = calloc<_Rect>();
      final Pointer<_Point> pt = calloc<_Point>();
      try {
        if (_getClientRect(host, hostClient) == 0) return;
        final int cw = hostClient.ref.right - hostClient.ref.left;
        final int ch = hostClient.ref.bottom - hostClient.ref.top;
        if (cw <= 0 || ch <= 0) return;
        pt.ref.x = 0;
        pt.ref.y = 0;
        if (_clientToScreen(host, pt) == 0) return;
        final int targetX = pt.ref.x;
        final int targetY = pt.ref.y;

        for (final int hwnd in _findVisibleWebviewWindows()) {
          if (_getWindowRect(hwnd, wvRect) == 0) continue;
          final int wvW = wvRect.ref.right - wvRect.ref.left;
          final int wvH = wvRect.ref.bottom - wvRect.ref.top;
          if (wvW <= 0 || wvH <= 0) continue;
          // 指纹 b：带标题栏的（DevTools 等）不碰；且必须是 WS_POPUP
          // 边框窗（内容窗的标准样式，类注释有实测记录）。
          final int style = _getWindowLongW(hwnd, _gwlStyle);
          if ((style & _wsCaption) != 0) continue;
          if ((style & _wsPopup) == 0) continue;
          // 指纹 c：小弹窗（菜单/下拉/气泡）允许自由摆放。
          if (wvW < cw * 4 ~/ 5 || wvH < ch * 4 ~/ 5) continue;
          // 精确对齐判定：任何一边偏差 ≥1px 就摆回客户区原位。
          final bool aligned = wvRect.ref.left == targetX &&
              wvRect.ref.top == targetY &&
              wvW == cw &&
              wvH == ch;
          if (aligned) continue;
          _setWindowPos(
            hwnd,
            0,
            targetX,
            targetY,
            cw,
            ch,
            _swpAsyncWindowPos | _swpNoActivate | _swpNoZOrder,
          );
        }
      } finally {
        calloc.free(hostClient);
        calloc.free(wvRect);
        calloc.free(pt);
      }
    } catch (_) {
      // 对账失败不影响任何主流程 —— 大不了维持原故障形态，不崩。
    }
  }

  // --------------------------------------------------------------- 内部实现

  /// 桌面链（Z 序）里找**本进程**的 Flutter 宿主窗：类名 + PID 双匹配。
  int _findHostHwnd() {
    final int myPid = _getCurrentProcessId();
    final Pointer<Uint32> pidBuf = calloc<Uint32>();
    final Pointer<Uint16> clsBuf = calloc<Uint16>(256);
    try {
      int hwnd = _getWindow(_getDesktopWindow(), _gwChild);
      int guard = 0;
      while (hwnd != 0 && guard++ < 10000) {
        _getWindowThreadProcessId(hwnd, pidBuf);
        if (pidBuf.value == myPid) {
          final int n = _getClassName(hwnd, clsBuf, 256);
          if (n > 0 &&
              String.fromCharCodes(clsBuf.asTypedList(n)) ==
                  _flutterWindowClass) {
            return hwnd;
          }
        }
        hwnd = _getWindow(hwnd, _gwHwndNext);
      }
    } catch (_) {
      // 找不到就走 resyncToHost 的 host == 0 短路。
    } finally {
      calloc.free(pidBuf);
      calloc.free(clsBuf);
    }
    return 0;
  }

  /// 枚举本进程系下 WebView2 当前**可见**的 `Chrome_WidgetWin*` 顶层窗。
  ///
  /// 走桌面窗口的子链（Z 序），不回调、不分配二次堆；
  /// 上限 10000 个纯属防死循环的保险丝。
  List<int> _findVisibleWebviewWindows() {
    final Set<int> pids = _webviewProcessPids();
    if (pids.isEmpty) return const <int>[];
    final List<int> out = <int>[];
    final Pointer<Uint32> pidBuf = calloc<Uint32>();
    final Pointer<Uint16> clsBuf = calloc<Uint16>(256);
    try {
      int hwnd = _getWindow(_getDesktopWindow(), _gwChild);
      int guard = 0;
      while (hwnd != 0 && guard++ < 10000) {
        _getWindowThreadProcessId(hwnd, pidBuf);
        if (pids.contains(pidBuf.value)) {
          final int n = _getClassName(hwnd, clsBuf, 256);
          if (n > 0) {
            final String cls = String.fromCharCodes(clsBuf.asTypedList(n));
            if (cls.startsWith('Chrome_WidgetWin') &&
                _isWindowVisible(hwnd) != 0) {
              out.add(hwnd);
            }
          }
        }
        hwnd = _getWindow(hwnd, _gwHwndNext);
      }
    } finally {
      calloc.free(pidBuf);
      calloc.free(clsBuf);
    }
    return out;
  }

  /// 本进程（webshell.exe）所有**后代**进程里，映像名为
  /// `msedgewebview2.exe` 的 PID 集合。经 Toolhelp 快照建父子表再 BFS，
  /// 保证绝不误伤别的 WebView2 宿主。
  Set<int> _webviewProcessPids() {
    final int myPid = _getCurrentProcessId();
    final int snap = _createToolhelp32Snapshot(_th32csSnapProcess, 0);
    if (snap == -1) return const <int>{};
    final Pointer<_ProcessEntry32W> entry = calloc<_ProcessEntry32W>();
    final Map<int, int> parents = <int, int>{};
    final Map<int, String> names = <int, String>{};
    try {
      entry.ref.dwSize = sizeOf<_ProcessEntry32W>();
      bool ok = _process32First(snap, entry) != 0;
      while (ok) {
        final int pid = entry.ref.th32ProcessID;
        parents[pid] = entry.ref.th32ParentProcessID;
        names[pid] = _exeName(entry.ref);
        ok = _process32Next(snap, entry) != 0;
      }
    } finally {
      _closeHandle(snap);
      calloc.free(entry);
    }

    final Set<int> reachable = <int>{myPid};
    bool grew = true;
    while (grew) {
      grew = false;
      for (final MapEntry<int, int> e in parents.entries) {
        if (reachable.contains(e.value) && reachable.add(e.key)) grew = true;
      }
    }

    return names.entries
        .where((MapEntry<int, String> e) =>
            reachable.contains(e.key) && e.value == 'msedgewebview2.exe')
        .map((MapEntry<int, String> e) => e.key)
        .toSet();
  }

  static String _exeName(_ProcessEntry32W ref) {
    final List<int> units = <int>[];
    for (int i = 0; i < 260; i++) {
      final int c = ref.szExeFile[i];
      if (c == 0) break;
      units.add(c);
    }
    return String.fromCharCodes(units).toLowerCase();
  }
}