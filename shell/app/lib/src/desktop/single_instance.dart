import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// Windows 单实例守卫：同一个包（同一 branding 名）只允许跑一个进程。
///
/// **为什么要单实例**：本 App 的内容窗是 `msedgewebview2.exe` 名下的
/// 独立顶层 LAYERED 弹窗（见 [WebViewWindowGuard] 的故障分析）。多开时
/// 每个宿主都拖一套 WebView2 进程树；旧实例收托盘/最小化后由守卫清掉
/// 自己那套残留窗，但**另一个实例**的 WebView2 弹窗不属于它的进程系，
/// 清扫名单互相看不见 —— 一旦哪个实例的页面停在最大化的残留弹窗上，
/// 整个桌面就被"点不动"（命中测试恒回 HTNOWHERE，点击被静默吞掉）。
/// 单实例把这个问题从根上掐掉。
///
/// **实现**：命名互斥体（kernel32 `CreateMutexW`，`Local\` 会话命名空间，
/// 键 = branding 应用名 —— 也就是"包名/组织名"在本仓库的落地身份）。
/// * 首个实例：持有互斥（bInitialOwner=TRUE）直到进程退出，崩溃也自动释放；
/// * 第二个实例：`GetLastError()==ERROR_ALREADY_EXISTS` → 唤醒旧窗口
///   （还原 + 抢前台），然后自己退出。
///
/// 窗口枚举沿用 WebViewWindowGuard 的桌面子链遍历（不碰 EnumWindows
/// 回调的 FFI 坑），匹配条件：类名 `FLUTTER_RUNNER_WIN32_WINDOW` +
/// 标题 == 本包名 + 属于别的进程。
class SingleInstanceGuard {
  SingleInstanceGuard._();

  /// 单例：main() 里问一次，全局唯一。
  static final SingleInstanceGuard instance = SingleInstanceGuard._();

  static const int _errorAlreadyExists = 183; // ERROR_ALREADY_EXISTS
  static const int _errorAccessDenied = 5; // ERROR_ACCESS_DENIED
  static const int _swRestore = 9; // SW_RESTORE
  static const int _vkMenu = 0x12; // VK_MENU（ALT，前台抢夺技巧用）
  static const int _keyeventfKeyup = 0x2;
  static const int _mbOk = 0x0;
  static const int _mbIconInformation = 0x40;
  static const int _gwChild = 5; // GW_CHILD
  static const int _gwHwndNext = 2; // GW_HWNDNEXT

  /// 窗口类名前缀：Flutter Windows 模板固定值。
  static const String _flutterWindowClass = 'FLUTTER_RUNNER_WIN32_WINDOW';

  // --------------------------------------------------------------- 原生签名

  typedef _CreateMutexWNative = IntPtr Function(
    Pointer<Void> attrs,
    Uint32 initialOwner,
    Pointer<Uint16> name,
  );
  typedef _CreateMutexWDart = int Function(
    Pointer<Void> attrs,
    int initialOwner,
    Pointer<Uint16> name,
  );

  typedef _GetLastErrorNative = Uint32 Function();
  typedef _GetLastErrorDart = int Function();

  typedef _GetWindowNative = IntPtr Function(IntPtr hwnd, Uint32 cmd);
  typedef _GetWindowDart = int Function(int hwnd, int cmd);

  typedef _GetDesktopWindowNative = IntPtr Function();
  typedef _GetDesktopWindowDart = int Function();

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

  typedef _GetWindowTextWNative = Int32 Function(
    IntPtr hwnd,
    Pointer<Uint16> buf,
    Int32 maxCount,
  );
  typedef _GetWindowTextWDart = int Function(
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

  typedef _GetCurrentProcessIdNative = Uint32 Function();
  typedef _GetCurrentProcessIdDart = int Function();

  typedef _ShowWindowAsyncNative = Int32 Function(IntPtr hwnd, Int32 cmd);
  typedef _ShowWindowAsyncDart = int Function(int hwnd, int cmd);

  typedef _SetForegroundWindowNative = Int32 Function(IntPtr hwnd);
  typedef _SetForegroundWindowDart = int Function(int hwnd);

  typedef _KeybdEventNative = Void Function(
    Uint8 vk,
    Uint8 scan,
    Uint32 flags,
    IntPtr extraInfo,
  );
  typedef _KeybdEventDart = void Function(
    int vk,
    int scan,
    int flags,
    int extraInfo,
  );

  typedef _MessageBoxWNative = Int32 Function(
    IntPtr hwnd,
    Pointer<Uint16> text,
    Pointer<Uint16> caption,
    Uint32 type,
  );
  typedef _MessageBoxWDart = int Function(
    int hwnd,
    Pointer<Uint16> text,
    Pointer<Uint16> caption,
    int type,
  );

  DynamicLibrary? _user32Lib;
  DynamicLibrary get _user32 => _user32Lib ??= DynamicLibrary.open('user32.dll');

  DynamicLibrary? _kernel32Lib;
  DynamicLibrary get _kernel32 =>
      _kernel32Lib ??= DynamicLibrary.open('kernel32.dll');

  late final _CreateMutexWDart _createMutexW = _kernel32
      .lookupFunction<_CreateMutexWNative, _CreateMutexWDart>('CreateMutexW');

  late final _GetLastErrorDart _getLastError = _kernel32
      .lookupFunction<_GetLastErrorNative, _GetLastErrorDart>('GetLastError');

  late final _GetCurrentProcessIdDart _getCurrentProcessId = _kernel32
      .lookupFunction<_GetCurrentProcessIdNative, _GetCurrentProcessIdDart>(
    'GetCurrentProcessId',
  );

  late final _GetDesktopWindowDart _getDesktopWindow = _user32
      .lookupFunction<_GetDesktopWindowNative, _GetDesktopWindowDart>(
    'GetDesktopWindow',
  );

  late final _GetWindowDart _getWindow = _user32
      .lookupFunction<_GetWindowNative, _GetWindowDart>('GetWindow');

  late final _GetClassNameWDart _getClassName = _user32
      .lookupFunction<_GetClassNameWNative, _GetClassNameWDart>('GetClassNameW');

  late final _GetWindowTextWDart _getWindowText = _user32
      .lookupFunction<_GetWindowTextWNative, _GetWindowTextWDart>(
    'GetWindowTextW',
  );

  late final _GetWindowThreadProcessIdDart _getWindowThreadProcessId = _user32
      .lookupFunction<
        _GetWindowThreadProcessIdNative,
        _GetWindowThreadProcessIdDart
      >('GetWindowThreadProcessId');

  late final _ShowWindowAsyncDart _showWindowAsync = _user32
      .lookupFunction<_ShowWindowAsyncNative, _ShowWindowAsyncDart>(
    'ShowWindowAsync',
  );

  late final _SetForegroundWindowDart _setForegroundWindow = _user32
      .lookupFunction<_SetForegroundWindowNative, _SetForegroundWindowDart>(
    'SetForegroundWindow',
  );

  late final _KeybdEventDart _keybdEvent = _user32
      .lookupFunction<_KeybdEventNative, _KeybdEventDart>('keybd_event');

  late final _MessageBoxWDart _messageBoxW = _user32
      .lookupFunction<_MessageBoxWNative, _MessageBoxWDart>('MessageBoxW');

  // --------------------------------------------------------------- 对外接口

  /// 尝试占住"本包唯一实例"的名额。
  ///
  /// * 返回 `true`：我是首个实例（或非 Windows 平台 / 守卫自身故障），
  ///   调用方继续正常启动。守卫失败不挡启动 —— 与全仓"兜底优先"口径一致。
  /// * 返回 `false`：已有一个实例在跑（已尽力唤醒它的窗口；实在找不到
  ///   窗口时已弹提示框），调用方应立即 `exit(0)`。
  bool claim({required String windowTitle}) {
    if (!Platform.isWindows) return true;
    try {
      // 互斥键 = 包名（branding 应用名）。白标 CI 会改 preset.json 与
      // runner 标题，同一个包无论拷到哪个目录、exe 叫什么，键都一致。
      final String name = 'Local\\WebShell.SingleInstance.$windowTitle';
      final Pointer<Uint16> namePtr = name.toNativeUtf16();
      try {
        final int handle = _createMutexW(nullptr, 1, namePtr);
        final int err = _getLastError();
        if (handle == 0) return true; // 创建失败：放行，不因守卫挡启动
        if (err != _errorAlreadyExists && err != _errorAccessDenied) {
          // 首实例：持有互斥直到进程退出（含崩溃自动释放），不 CloseHandle。
          return true;
        }
      } finally {
        calloc.free(namePtr);
      }
      _activateExisting(windowTitle);
      return false;
    } catch (_) {
      return true;
    }
  }

  // --------------------------------------------------------------- 内部实现

  /// 唤醒已存在实例的窗口：还原（SW_HIDE 收托盘的也能被带回来）+ 抢前台。
  ///
  /// `ShowWindowAsync` 投递不阻塞、跨进程安全；`SetForegroundWindow`
  /// 常被前台锁拦（对方进程没给授权），用经典 ALT 技巧垫一下：按下 ALT
  /// 再调 SetForegroundWindow、随后抬起 —— 系统会当作"用户输入切前台"
  /// 放行。旧实例窗口被外部还原时会走 window_manager 的 restore/focus
  /// 回调 → `showSwept()`，它的 WebView2 残留窗一并复活，闭环。
  void _activateExisting(String title) {
    final int hwnd = _findFlutterWindow(title);
    if (hwnd == 0) {
      _notifyAlreadyRunning(title);
      return;
    }
    _showWindowAsync(hwnd, _swRestore);
    _keybdEvent(_vkMenu, 0, 0, 0);
    _setForegroundWindow(hwnd);
    _keybdEvent(_vkMenu, 0, _keyeventfKeyup, 0);
  }

  /// 桌面子链（Z 序）里找别的进程的 Flutter 宿主窗：类名匹配 + 标题匹配。
  /// 找不到返回 0（对方可能还在启动早期，或窗口已被销毁）。
  int _findFlutterWindow(String title) {
    final int myPid = _getCurrentProcessId();
    final Pointer<Uint32> pidBuf = calloc<Uint32>();
    final Pointer<Uint16> clsBuf = calloc<Uint16>(256);
    final Pointer<Uint16> txtBuf = calloc<Uint16>(512);
    try {
      int hwnd = _getWindow(_getDesktopWindow(), _gwChild);
      int guard = 0;
      while (hwnd != 0 && guard++ < 10000) {
        _getWindowThreadProcessId(hwnd, pidBuf);
        if (pidBuf.value != myPid) {
          final int n = _getClassName(hwnd, clsBuf, 256);
          if (n > 0 &&
              String.fromCharCodes(clsBuf.asTypedList(n)) ==
                  _flutterWindowClass) {
            final int m = _getWindowText(hwnd, txtBuf, 512);
            if (m > 0 &&
                String.fromCharCodes(txtBuf.asTypedList(m)) == title) {
              return hwnd;
            }
          }
        }
        hwnd = _getWindow(hwnd, _gwHwndNext);
      }
    } catch (_) {
      // 枚举失败视同找不到：走提示框分支。
    } finally {
      calloc.free(pidBuf);
      calloc.free(clsBuf);
      calloc.free(txtBuf);
    }
    return 0;
  }

  /// 实在找不到旧窗口（对方在启动早期/已被销毁）时的兜底提示。
  void _notifyAlreadyRunning(String title) {
    final Pointer<Uint16> text =
        '$title 已经在运行了，请从任务栏或系统托盘找回窗口。'
            .toNativeUtf16();
    final Pointer<Uint16> caption = title.toNativeUtf16();
    try {
      _messageBoxW(0, text, caption, _mbOk | _mbIconInformation);
    } catch (_) {
      // 提示失败就算了：调用方照旧退出。
    } finally {
      calloc.free(text);
      calloc.free(caption);
    }
  }
}
