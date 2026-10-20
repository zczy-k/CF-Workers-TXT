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

typedef _GetWindowRectNative = Int32 Function(
  IntPtr hwnd,
  Pointer<_Rect> rect,
);
typedef _GetWindowRectDart = int Function(int hwnd, Pointer<_Rect> rect);

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
  static const int _gwChild = 5; // GW_CHILD
  static const int _gwHwndNext = 2; // GW_HWNDNEXT
  static const int _swpAsyncWindowPos = 0x4000; // SWP_ASYNCWINDOWPOS
  static const int _swpNoActivate = 0x0010; // SWP_NOACTIVATE
  static const int _swpNoZOrder = 0x0004; // SWP_NOZORDER

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

  late final _GetWindowRectDart _getWindowRect = _user32
      .lookupFunction<_GetWindowRectNative, _GetWindowRectDart>(
    'GetWindowRect',
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

  /// 宿主窗口 rect 变化（拖动/缩放/最大化/还原）后的**对账**：
  /// 把完全落在宿主窗口矩形之外的可见 WebView2 弹窗挪回宿主当前矩形。
  ///
  /// **为什么需要它**：hide/show 清扫只覆盖"宿主不可见→恢复"（收托盘/
  /// 最小化）；而**最大化→还原全程宿主可见**，谁也没动弹窗。插件自己
  /// 的位置同步链在这条路径上会失灵：宿主已缩回小窗，弹窗却留在最大化
  /// 时的旧矩形上 —— 旧矩形内（宿主窗口之外的部分）点击被它静默吞掉，
  /// 用户看到的就是"窗口缩小了，但旁边一大块红框区域点不动"。
  ///
  /// 判定保守：**完全无交集**才算错位（正常同步的弹窗必然与宿主相交，
  /// 因为 InAppWebView 布局在窗口内），误伤为零。挪动用
  /// `SWP_ASYNCWINDOWPOS` 投递不等回执，WebView2 正忙也不阻塞宿主；
  /// `SWP_NOZORDER|SWP_NOACTIVATE` 保证只挪矩形不动 Z 序/不抢焦点。
  /// 挪动这一下本身也常能惊动 WebView2 重新走它自己的同步。
  void resyncToHost() {
    if (!Platform.isWindows) return;
    try {
      final int host = _findHostHwnd();
      if (host == 0) return;
      // 最小化/收托盘态不对账（此时宿主 rect 是 -32000 系的无效值），
      // 那两条路走 hideOrphaned/showSwept。
      if (_isWindowVisible(host) == 0) return;
      final Pointer<_Rect> hostRect = calloc<_Rect>();
      final Pointer<_Rect> wvRect = calloc<_Rect>();
      try {
        if (_getWindowRect(host, hostRect) == 0) return;
        final int hw = hostRect.ref.right - hostRect.ref.left;
        final int hh = hostRect.ref.bottom - hostRect.ref.top;
        if (hw <= 0 || hh <= 0) return;
        for (final int hwnd in _findVisibleWebviewWindows()) {
          if (_getWindowRect(hwnd, wvRect) == 0) continue;
          final bool disjoint =
              wvRect.ref.right <= hostRect.ref.left ||
              wvRect.ref.left >= hostRect.ref.right ||
              wvRect.ref.bottom <= hostRect.ref.top ||
              wvRect.ref.top >= hostRect.ref.bottom;
          if (!disjoint) continue;
          _setWindowPos(
            hwnd,
            0,
            hostRect.ref.left,
            hostRect.ref.top,
            hw,
            hh,
            _swpAsyncWindowPos | _swpNoActivate | _swpNoZOrder,
          );
        }
      } finally {
        calloc.free(hostRect);
        calloc.free(wvRect);
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