import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart';

/// 便携式机密存储：站点密码写在 `<数据目录>/secrets.bin`。
///
/// 为什么不用 flutter_secure_storage：它在 Windows 上的落点由插件写死为
/// `%APPDATA%\<CompanyName>\<ProductName>\flutter_secure_storage.json`
/// （没有可配置的路径项），既让密码回不到程序目录、又会在"整个文件夹拷走"
/// 的迁移里被漏掉。这里的落点跟着数据目录走（拷走即迁移）。
///
/// **加密到什么程度（别自欺欺人）**：
///   * Windows：整份内容交给 **DPAPI**（`CryptProtectData`）加密。密钥是当前
///     Windows 用户的主密钥，由系统保管（用户登录凭据派生），本程序不持有、
///     也导不出来。文件被拷到别的机器 / 别的用户下就解不开 —— 这是刻意的：
///     密码宁可让用户在站点页重输一次，也不该跟着文件夹裸奔。
///     用 `CRYPTPROTECT_UI_FORBIDDEN`，不会弹系统对话框；额外加了一段本程序
///     专属的 entropy，别的程序即使用同一个用户身份也解不开。
///   * Android / iOS / 其它平台：没有可用的用户级密钥库通道（不引入插件的话），
///     所以退化成固定掩码异或 —— 它的定位是**混淆**，不是加密：能挡住"随手用
///     记事本翻一眼"，挡不住拿到这个文件的人。这些平台上真正的防线是**App 私有
///     目录**（`/data/data/<包名>/` 只有本 App 的 uid 能读，别的 App 和文件管理器
///     都进不去），以及清单里关掉 `allowBackup` 之后备份也带不走。
///
/// 文件格式：`"WSSEC" 0x01` + 1 字节方案（0 = 掩码，1 = DPAPI） + 载荷。
/// 老版本（纯掩码、没有文件头）照样能读，读到时立刻按新格式重写一遍 ——
/// 老用户升级后不需要重新输密码，文件却在第一次读写时就升级成加密的了。
///
/// 方法名与 FlutterSecureStorage 的常用三件套同形（read / write / delete），
/// 所以调用点无需改动。
class LocalSecureStore {
  LocalSecureStore(this.file);

  /// 落盘文件（`<数据目录>/secrets.bin`）。
  final File file;

  /// 文件头：`WSSEC` + 版本 1。老格式（没有文件头）靠它区分。
  static const List<int> _magic = <int>[0x57, 0x53, 0x53, 0x45, 0x43, 0x01];

  /// 载荷方案。
  static const int _schemeMask = 0; // 固定掩码异或（弱，见类注释）
  static const int _schemeDpapi = 1; // Windows DPAPI

  /// 32 字节固定掩码：只做"看不出明文"的混淆，不是密钥。
  /// 只在没有 DPAPI 的平台上用，读老格式时也用它。
  static const List<int> _mask = <int>[
    0xB7, 0x86, 0x0A, 0x1F, 0xF3, 0x2C, 0x59, 0x6D,
    0x91, 0x4E, 0x3B, 0x08, 0x77, 0xDA, 0x65, 0x12,
    0xC9, 0x24, 0x8F, 0x50, 0xE2, 0x6B, 0x37, 0xA4,
    0x5D, 0x9C, 0x41, 0x0E, 0xB3, 0x78, 0x26, 0xEF,
  ];

  Map<String, String>? _cache;

  /// 当前平台能不能真加密（Windows 上恒为 true；其它平台恒为 false）。
  static bool get _canEncrypt => _Dpapi.available;

  Map<String, String> _load() {
    if (_cache != null) return _cache!;
    final Map<String, String> out = <String, String>{};
    bool legacy = false;
    try {
      if (file.existsSync()) {
        final Uint8List bytes = file.readAsBytesSync();
        Uint8List? plain;
        if (_hasMagic(bytes)) {
          final int scheme = bytes[_magic.length];
          final Uint8List payload = Uint8List.sublistView(bytes, _magic.length + 1);
          plain = scheme == _schemeDpapi ? _Dpapi.unprotect(payload) : _xor(payload);
        } else {
          // 老版本：整份文件就是掩码异或过的 JSON
          legacy = true;
          plain = _xor(bytes);
        }
        if (plain != null) {
          final Object? decoded = jsonDecode(utf8.decode(plain));
          if (decoded is Map) {
            decoded.forEach((Object? k, Object? v) {
              if (k != null && v != null) out['$k'] = '$v';
            });
          }
        }
      }
    } catch (_) {
      // 文件损坏 / 换了用户身份解不开（DPAPI 是用户绑定的）/ 老格式：
      // 一律当成空，不挡启动（用户在站点页重输一次即可）。
    }
    _cache = out;
    // 老格式（或上次落在弱方案上）现在能加密了：立刻升级成密文，不然它就一直裸着。
    if (legacy && _canEncrypt) _save();
    return out;
  }

  void _save() {
    try {
      final Map<String, String> data = _cache ?? <String, String>{};
      final Uint8List plain = Uint8List.fromList(utf8.encode(jsonEncode(data)));
      final Uint8List? sealed = _canEncrypt ? _Dpapi.protect(plain) : null;
      final Uint8List body = sealed ?? _xor(plain);
      final int scheme = sealed == null ? _schemeMask : _schemeDpapi;
      final BytesBuilder out = BytesBuilder(copy: false)
        ..add(_magic)
        ..addByte(scheme)
        ..add(body);
      file.parent.createSync(recursive: true);
      file.writeAsBytesSync(out.takeBytes(), flush: true);
    } catch (_) {
      // 写不进去（磁盘满 / 只读介质）不该让界面崩掉
    }
  }

  static bool _hasMagic(Uint8List bytes) {
    if (bytes.length < _magic.length + 1) return false;
    for (int i = 0; i < _magic.length; i++) {
      if (bytes[i] != _magic[i]) return false;
    }
    return true;
  }

  static Uint8List _xor(Uint8List input) {
    final Uint8List out = Uint8List(input.length);
    for (int i = 0; i < input.length; i++) {
      out[i] = input[i] ^ _mask[i % _mask.length];
    }
    return out;
  }

  Future<String?> read({required String key}) async => _load()[key];

  Future<void> write({required String key, required String value}) async {
    _load()[key] = value;
    _save();
  }

  Future<void> delete({required String key}) async {
    _load().remove(key);
    _save();
  }

  Future<Map<String, String>> readAll() async => Map<String, String>.of(_load());

  Future<void> deleteAll() async {
    _load().clear();
    _save();
  }

  /// 当前落盘用的是不是真加密（给"关于"页面 / 排查用）。
  static bool get encryptedAtRest => _canEncrypt;

  /// 只给单测用：按老版本格式（纯掩码、没有文件头）编码一段 JSON。
  ///
  /// 存在的唯一理由是验证"老用户升级后不用重输密码，且第一次读取就把文件升级成密文"，
  /// 而老格式的掩码是 private 的 —— 与其在测试里抄一份掩码（抄错就变成假测试），
  /// 不如让实现自己吐一份出来。
  @visibleForTesting
  static Uint8List legacyBytesForTest(String json) =>
      _xor(Uint8List.fromList(utf8.encode(json)));
}

// ---------------------------------------------------------------------------
// Windows DPAPI（crypt32.dll）
//
// 只做两件事：把一段字节加密成"只有当前 Windows 用户 + 同一段 entropy 才能
// 解开"的密文，以及反过来。密钥由系统托管在用户 profile 里，本程序拿不到，
// 也不往磁盘上写任何密钥 —— 这正是它比"自己造一个密钥再和密文放一起"强的地方。
//
// 结构体按 C ABI 对齐：DATA_BLOB { DWORD cbData; BYTE *pbData; }，x64 下
// cbData 后面有 4 字节填充，Dart 的 Struct 会自动补，sizeof == 16。
// ---------------------------------------------------------------------------

final class _DataBlob extends Struct {
  @Uint32()
  external int cbData;

  external Pointer<Uint8> pbData;
}

typedef _ProtectNative = Int32 Function(
  Pointer<_DataBlob>,
  Pointer<Utf16>,
  Pointer<_DataBlob>,
  Pointer<Void>,
  Pointer<Void>,
  Uint32,
  Pointer<_DataBlob>,
);
typedef _ProtectDart = int Function(
  Pointer<_DataBlob>,
  Pointer<Utf16>,
  Pointer<_DataBlob>,
  Pointer<Void>,
  Pointer<Void>,
  int,
  Pointer<_DataBlob>,
);

typedef _UnprotectNative = Int32 Function(
  Pointer<_DataBlob>,
  Pointer<Pointer<Utf16>>,
  Pointer<_DataBlob>,
  Pointer<Void>,
  Pointer<Void>,
  Uint32,
  Pointer<_DataBlob>,
);
typedef _UnprotectDart = int Function(
  Pointer<_DataBlob>,
  Pointer<Pointer<Utf16>>,
  Pointer<_DataBlob>,
  Pointer<Void>,
  Pointer<Void>,
  int,
  Pointer<_DataBlob>,
);

typedef _LocalFreeNative = Pointer<Void> Function(Pointer<Void>);
typedef _LocalFreeDart = Pointer<Void> Function(Pointer<Void>);

class _Dpapi {
  /// `CRYPTPROTECT_UI_FORBIDDEN`：需要用户交互时直接失败，不弹系统框
  /// （这个调用发生在写配置的路径上，弹框等于卡死 UI）。
  static const int _uiForbidden = 0x1;

  /// 本程序专属 entropy：同一台机器、同一个用户下，别的程序即使调 DPAPI 也解不开。
  static const List<int> _entropy = <int>[
    0x77, 0x65, 0x62, 0x73, 0x68, 0x65, 0x6C, 0x6C, // "webshell"
    0x2F, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x73, // "/secrets"
    0x2F, 0x76, 0x31, 0x00, // "/v1"
  ];

  static _ProtectDart? _protect;
  static _UnprotectDart? _unprotect;
  static _LocalFreeDart? _localFree;
  static bool _inited = false;

  static bool get available {
    _ensure();
    return _protect != null;
  }

  static void _ensure() {
    if (_inited) return;
    _inited = true;
    if (!Platform.isWindows) return;
    try {
      final DynamicLibrary crypt32 = DynamicLibrary.open('crypt32.dll');
      final DynamicLibrary kernel32 = DynamicLibrary.open('kernel32.dll');
      _protect = crypt32.lookupFunction<_ProtectNative, _ProtectDart>('CryptProtectData');
      _unprotect =
          crypt32.lookupFunction<_UnprotectNative, _UnprotectDart>('CryptUnprotectData');
      _localFree = kernel32.lookupFunction<_LocalFreeNative, _LocalFreeDart>('LocalFree');
    } catch (_) {
      // 极小概率拿不到 crypt32：退化成掩码，保证功能不坏（见类注释）
      _protect = null;
      _unprotect = null;
      _localFree = null;
    }
  }

  static Uint8List? protect(Uint8List data) {
    _ensure();
    final _ProtectDart? fn = _protect;
    final _LocalFreeDart? free = _localFree;
    if (fn == null || free == null || data.isEmpty) return null;

    final Pointer<_DataBlob> inBlob = calloc<_DataBlob>();
    final Pointer<_DataBlob> entBlob = calloc<_DataBlob>();
    final Pointer<_DataBlob> outBlob = calloc<_DataBlob>();
    final Pointer<Uint8> inBuf = calloc<Uint8>(data.length);
    final Pointer<Uint8> entBuf = calloc<Uint8>(_entropy.length);
    try {
      inBuf.asTypedList(data.length).setAll(0, data);
      inBlob.ref
        ..cbData = data.length
        ..pbData = inBuf;
      entBuf.asTypedList(_entropy.length).setAll(0, _entropy);
      entBlob.ref
        ..cbData = _entropy.length
        ..pbData = entBuf;

      final int ok = fn(
        inBlob,
        nullptr,
        entBlob,
        nullptr,
        nullptr,
        _uiForbidden,
        outBlob,
      );
      if (ok == 0) return null;
      final int len = outBlob.ref.cbData;
      final Pointer<Uint8> buf = outBlob.ref.pbData;
      if (len <= 0 || buf == nullptr) return null;
      final Uint8List result = Uint8List.fromList(buf.asTypedList(len));
      free(buf.cast<Void>());
      return result;
    } finally {
      calloc.free(inBlob);
      calloc.free(entBlob);
      calloc.free(outBlob);
      calloc.free(inBuf);
      calloc.free(entBuf);
    }
  }

  static Uint8List? unprotect(Uint8List data) {
    _ensure();
    final _UnprotectDart? fn = _unprotect;
    final _LocalFreeDart? free = _localFree;
    if (fn == null || free == null || data.length < 2) return null;

    final Pointer<_DataBlob> inBlob = calloc<_DataBlob>();
    final Pointer<_DataBlob> entBlob = calloc<_DataBlob>();
    final Pointer<_DataBlob> outBlob = calloc<_DataBlob>();
    final Pointer<Uint8> inBuf = calloc<Uint8>(data.length);
    final Pointer<Uint8> entBuf = calloc<Uint8>(_entropy.length);
    try {
      inBuf.asTypedList(data.length).setAll(0, data);
      inBlob.ref
        ..cbData = data.length
        ..pbData = inBuf;
      entBuf.asTypedList(_entropy.length).setAll(0, _entropy);
      entBlob.ref
        ..cbData = _entropy.length
        ..pbData = entBuf;

      final int ok = fn(
        inBlob,
        nullptr,
        entBlob,
        nullptr,
        nullptr,
        _uiForbidden,
        outBlob,
      );
      if (ok == 0) return null;
      final int len = outBlob.ref.cbData;
      final Pointer<Uint8> buf = outBlob.ref.pbData;
      if (len <= 0 || buf == nullptr) return null;
      final Uint8List result = Uint8List.fromList(buf.asTypedList(len));
      free(buf.cast<Void>());
      return result;
    } finally {
      calloc.free(inBlob);
      calloc.free(entBlob);
      calloc.free(outBlob);
      calloc.free(inBuf);
      calloc.free(entBuf);
    }
  }
}
