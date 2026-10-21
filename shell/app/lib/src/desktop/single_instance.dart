import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// Windows 单实例守卫：同一个包（同一 app_id）只允许跑一个进程。
///
/// **为什么要单实例**：本 App 的内容窗是 `msedgewebview2.exe` 名下的
/// 独立顶层 LAYERED 弹窗（见 [WebViewWindowGuard] 的故障分析）。多开时
/// 每个宿主都拖一套 WebView2 进程树；旧实例收托盘/最小化后由守卫清掉
/// 自己那套残留窗，但**另一个实例**的 WebView2 弹窗不属于它的进程系，
/// 清扫名单互相看不见 —— 一旦哪个实例的页面停在最大化的残留弹窗上，
/// 整个桌面就被"点不动"（命中测试恒回 HTNOWHERE，点击被静默吞掉）。
/// 单实例把这个问题从根上掐掉。
///
/// **实现**：命名互斥体（kernel32）+ **所有权判定**：
/// `CreateMutexW(bInitialOwner=FALSE)` 之后立刻 `WaitForSingleObject(h, 0)`：
/// * `WAIT_OBJECT_0` / `WAIT_ABANDONED`（前任崩溃后所有权移交）→ 我是
///   唯一持有者，首实例；持有到进程退出（含崩溃自动释放），不 Close。
/// * `WAIT_TIMEOUT` → 有活进程持着它 → 我是第二实例，唤醒旧窗口后退出。
///
/// 故意不用 `GetLastError()==ERROR_ALREADY_EXISTS` 判定：两次独立 FFI
/// 调用之间 Dart VM 自己的系统调用会把 last-error 清掉，第二实例于是
/// 被当成首实例放行 —— "同 app_id 还能双开"就是这么来的（实测复现）。
///
/// 互斥键有两把，**任何一把被别人持有都判为已有实例**：
/// * `...id.<appId>`：新键，按包身份（CI 的 app_id）—— 同 id 的两个包
///   哪怕显示名（appName）不同也不许双开；
/// * `...<appName>`：旧键（历史版本的唯一键）。留着它，用户机器上
///   "新版 + 旧版"两个目录并存时，互相也能看见对方。
///
/// 窗口枚举沿用 WebViewWindowGuard 的桌面子链遍历（不碰 EnumWindows
/// 回调的 FFI 坑），匹配条件：类名 `FLUTTER_RUNNER_WIN32_WINDOW` +
/// 标题 == 本包名 + 属于别的进程。
/// 窗口类名前缀：Flutter Windows 模板固定值。
const String _flutterWindowClass = 'FLUTTER_RUNNER_WIN32_WINDOW';

// --------------------------------------------------------------- 原生签名
// typedef 必须在顶层：Dart 语言规则不允许在类体内声明 typedef
// （CI 的 flutter analyze 报 typedef_in_class error，连续三个提交
// 因此构建失败 —— 单实例/退出提速/UI 重建三批修复都没进产物）。

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

typedef _OpenMutexWNative = IntPtr Function(
  Uint32 desiredAccess,
  Uint32 inheritHandle,
  Pointer<Uint16> name,
);
typedef _OpenMutexWDart = int Function(
  int desiredAccess,
  int inheritHandle,
  Pointer<Uint16> name,
);

typedef _WaitForSingleObjectNative = Uint32 Function(IntPtr handle, Uint32 ms);
typedef _WaitForSingleObjectDart = int Function(int handle, int ms);

typedef _CloseHandleNative = Int32 Function(IntPtr handle);
typedef _CloseHandleDart = int Function(int handle);

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

class SingleInstanceGuard {
  SingleInstanceGuard._();

  /// 单例：main() 里问一次，全局唯一。
  static final SingleInstanceGuard instance = SingleInstanceGuard._();

  static const int _waitTimeout = 0x102; // WAIT_TIMEOUT
  static const int _synchronize = 0x00100000; // SYNCHRONIZE（OpenMutexW 用）
  static const int _swRestore = 9; // SW_RESTORE
  static const int _vkMenu = 0x12; // VK_MENU（ALT，前台抢夺技巧用）
  static const int _keyeventfKeyup = 0x2;
  static const int _mbOk = 0x0;
  static const int _mbIconInformation = 0x40;
  static const int _gwChild = 5; // GW_CHILD
  static const int _gwHwndNext = 2; // GW_HWNDNEXT

  DynamicLibrary? _user32Lib;
  DynamicLibrary get _user32 => _user32Lib ??= DynamicLibrary.open('user32.dll');

  DynamicLibrary? _kernel32Lib;
  DynamicLibrary get _kernel32 =>
      _kernel32Lib ??= DynamicLibrary.open('kernel32.dll');

  late final _CreateMutexWDart _createMutexW = _kernel32
      .lookupFunction<_CreateMutexWNative, _CreateMutexWDart>('CreateMutexW');

  late final _OpenMutexWDart _openMutexW =
      _kernel32.lookupFunction<_OpenMutexWNative, _OpenMutexWDart>('OpenMutexW');

  late final _WaitForSingleObjectDart _waitForSingleObject = _kernel32
      .lookupFunction<_WaitForSingleObjectNative, _WaitForSingleObjectDart>(
    'WaitForSingleObject',
  );

  late final _CloseHandleDart _closeHandle =
      _kernel32.lookupFunction<_CloseHandleNative, _CloseHandleDart>('CloseHandle');

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
  bool claim({required String windowTitle, String? appId}) {
    if (!Platform.isWindows) return true;
    try {
      final String id = (appId ?? '').trim();
      // 两把键都要占住才算首实例；任何一把被别人持有 → 第二实例。
      // 顺序固定（id 键在前），不会出现两个进程各持一把互相看不见。
      final List<String> keys = <String>[
        if (id.isNotEmpty) 'Local\\WebShell.SingleInstance.id.$id',
        'Local\\WebShell.SingleInstance.$windowTitle',
      ];
      for (final String key in keys) {
        if (!_tryOwnMutex(key)) {
          _activateExisting(windowTitle);
          return false;
        }
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  // --------------------------------------------------------------- 内部实现

  /// 创建命名互斥体并立刻抢一次所有权（零超时等待）。
  ///
  /// * `true`：拿到所有权（或守卫自身故障，放行不挡启动）；
  /// * `false`：已被别的进程持有。
  bool _tryOwnMutex(String name) {
    final Pointer<Uint16> namePtr = name.toNativeUtf16().cast<Uint16>();
    try {
      // toNativeUtf16() 给的是 Pointer<Utf16>（package:ffi 的扩展类型），
      // 本文件签名按裸 FFI 写的是 Pointer<Uint16> —— 布局同为 16 位无符号，
      // .cast 零开销转换。
      //
      // bInitialOwner=FALSE：身份判定不靠"谁创建"（那要读 GetLastError，
      // 见顶部注释），所有权完全交给下面的 WaitForSingleObject。
      final int handle = _createMutexW(nullptr, 0, namePtr);
      if (handle == 0) {
        // 打不开通常是权限不匹配（一个实例管理员、一个普通用户运行）。
        // 再用 OpenMutexW 复核对象是否真的存在：能打开 → 已有实例。
        final int probe = _openMutexW(_synchronize, 0, namePtr);
        if (probe != 0) {
          _closeHandle(probe);
          return false;
        }
        return true; // 真失败：放行，不因守卫挡启动
      }
      final int wait = _waitForSingleObject(handle, 0);
      if (wait == _waitTimeout) {
        // 有活实例持着。手里的句柄没拿到所有权，关掉防泄漏。
        _closeHandle(handle);
        return false;
      }
      // WAIT_OBJECT_0（拿到）/ WAIT_ABANDONED（前任崩溃，所有权移交我）/
      // 其他罕见返回值：按持有处理，持有到进程退出（含崩溃自动释放），
      // 故意不 CloseHandle、不 ReleaseMutex。
      return true;
    } finally {
      calloc.free(namePtr);
    }
  }

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
            .toNativeUtf16()
            .cast<Uint16>();
    final Pointer<Uint16> caption = title.toNativeUtf16().cast<Uint16>();
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
