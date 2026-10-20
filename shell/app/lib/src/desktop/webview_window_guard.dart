import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// Win32 `PROCESSENTRY32W`（只声明用得到的字段；x64 下按 C ABI 自动对齐，
/// sizeOf == 568）。
class _ProcessEntry32W extends Struct {
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

typedef _EnumProcNative = Int32 Function(IntPtr hwnd, IntPtr lParam);
typedef _EnumProcDart = int Function(int hwnd, int lParam);

typedef _EnumWindowsNative = Int32 Function(
  Pointer<NativeFunction<_EnumProcNative>> lpEnumFunc,
  IntPtr lParam,
);
typedef _EnumWindowsDart = int Function(
  Pointer<NativeFunction<_EnumProcDart>> lpEnumFunc,
  int lParam,
);

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

typedef _ShowWindowNative = Int32 Function(IntPtr hwnd, Int32 cmd);
typedef _ShowWindowDart = int Function(int hwnd, int cmd);

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

  /// 我们亲手藏起来的句柄。恢复时只放行这份名单。
  final List<int> _sweptHandles = <int>[];

  // EnumWindows 回只能绑静态函数，上下文经单例字段传递。
  // EnumWindows 是同步调用、Dart 又是单线程，不存在重入。
  Set<int>? _enumPids;
  List<int>? _enumOut;
  Pointer<Uint32>? _enumPidBuf;
  Pointer<Uint16>? _enumClsBuf;

  DynamicLibrary? _user32Lib;
  DynamicLibrary get _user32 => _user32Lib ??= DynamicLibrary.open('user32.dll');

  DynamicLibrary? _kernel32Lib;
  DynamicLibrary get _kernel32 =>
      _kernel32Lib ??= DynamicLibrary.open('kernel32.dll');

  late final _EnumWindowsDart _enumWindows = _user32
      .lookupFunction<_EnumWindowsNative, _EnumWindowsDart>('EnumWindows');

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

  late final _ShowWindowDart _showWindow = _user32
      .lookupFunction<_ShowWindowNative, _ShowWindowDart>('ShowWindow');

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

  // --------------------------------------------------------------- 对外接口

  /// 宿主窗口即将/已经不可见（收托盘、最小化、退出）时调用：
  /// 把本进程系下 WebView2 的可视顶层弹窗全部 `SW_HIDE`，并记账。
  void hideOrphaned() {
    if (!Platform.isWindows) return;
    try {
      final List<int> targets = _findVisibleWebviewWindows();
      for (final int hwnd in targets) {
        _showWindow(hwnd, _swHide);
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
            _showWindow(hwnd, _swShow);
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

  // --------------------------------------------------------------- 内部实现

  /// 枚举本进程系下 WebView2 当前**可见**的 `Chrome_WidgetWin*` 顶层窗。
  List<int> _findVisibleWebviewWindows() {
    final Set<int> pids = _webviewProcessPids();
    if (pids.isEmpty) return const <int>[];
    final List<int> out = <int>[];
    final Pointer<Uint32> pidBuf = calloc<Uint32>();
    final Pointer<Uint16> clsBuf = calloc<Uint16>(256);
    try {
      _enumPids = pids;
      _enumOut = out;
      _enumPidBuf = pidBuf;
      _enumClsBuf = clsBuf;
      _enumWindows(Pointer.fromFunction<_EnumProcDart>(_enumProc, 0), 0);
    } finally {
      _enumPids = null;
      _enumOut = null;
      _enumPidBuf = null;
      _enumClsBuf = null;
      calloc.free(pidBuf);
      calloc.free(clsBuf);
    }
    return out;
  }

  /// EnumWindows 回调（静态，上下文走单例字段）。
  static int _enumProc(int hwnd, int lParam) {
    final WebViewWindowGuard g = instance;
    final Pointer<Uint32>? pidBuf = g._enumPidBuf;
    final Pointer<Uint16>? clsBuf = g._enumClsBuf;
    final Set<int>? pids = g._enumPids;
    final List<int>? out = g._enumOut;
    if (pidBuf == null || clsBuf == null || pids == null || out == null) {
      return 0; // 上下文丢了：停
    }
    g._getWindowThreadProcessId(hwnd, pidBuf);
    if (!pids.contains(pidBuf.value)) return 1; // 不是我们系的 WebView2
    final int n = g._getClassName(hwnd, clsBuf, 256);
    if (n <= 0) return 1;
    final String cls = String.fromCharCodes(clsBuf.asTypedList(n));
    if (!cls.startsWith('Chrome_WidgetWin')) return 1;
    if (g._isWindowVisible(hwnd) == 0) return 1;
    out.add(hwnd);
    return 1; // 继续枚举
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