import 'dart:convert';
import 'dart:io';

/// 便携式机密存储：站点密码写在 `<数据目录>/secrets.bin`。
///
/// 为什么不用 flutter_secure_storage：它在 Windows 上的落点由插件写死为
/// `%APPDATA%\<CompanyName>\<ProductName>\flutter_secure_storage.json`
/// （没有可配置的路径项），既让密码回不到程序目录、又会在"整个文件夹拷走"
/// 的迁移里被漏掉。这里用纯 dart:io 的本地混淆文件顶上：目标是让密码跟
/// 数据目录绑在一起（拷走即迁移），不是对抗已拿到磁盘读权限的攻击者。
///
/// 方法名与 FlutterSecureStorage 的常用三件套同形（read / write / delete），
/// 所以调用点无需改动。
class LocalSecureStore {
  LocalSecureStore(this.file);

  /// 落盘文件（`<数据目录>/secrets.bin`）。
  final File file;

  /// 32 字节固定掩码：只做"看不出明文"的混淆，不是密钥。
  static const List<int> _mask = <int>[
    0xB7, 0x86, 0x0A, 0x1F, 0xF3, 0x2C, 0x59, 0x6D,
    0x91, 0x4E, 0x3B, 0x08, 0x77, 0xDA, 0x65, 0x12,
    0xC9, 0x24, 0x8F, 0x50, 0xE2, 0x6B, 0x37, 0xA4,
    0x5D, 0x9C, 0x41, 0x0E, 0xB3, 0x78, 0x26, 0xEF,
  ];

  Map<String, String>? _cache;

  Map<String, String> _load() {
    if (_cache != null) return _cache!;
    final Map<String, String> out = <String, String>{};
    try {
      if (file.existsSync()) {
        final String text = utf8.decode(_xor(file.readAsBytesSync()));
        (jsonDecode(text) as Map).forEach((Object? k, Object? v) {
          if (k != null && v != null) out['$k'] = '$v';
        });
      }
    } catch (_) {
      // 文件损坏 / 老格式：当作空，不挡启动（用户在站点页重输一次即可）
    }
    return _cache = out;
  }

  void _save() {
    try {
      final Map<String, String> data = _cache ?? <String, String>{};
      file.parent.createSync(recursive: true);
      file.writeAsBytesSync(_xor(utf8.encode(jsonEncode(data))), flush: true);
    } catch (_) {
      // 写不进去（磁盘满 / 只读介质）不该让界面崩掉
    }
  }

  static List<int> _xor(List<int> input) {
    final List<int> out = List<int>.filled(input.length, 0);
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
}