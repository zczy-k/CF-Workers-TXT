import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:webshell_core/webshell_core.dart';

/// 便携模式：Windows 上把全部运行数据放进**程序所在目录**，不往 C 盘写。
///
/// 原先是 path_provider 的默认落点 `%APPDATA%\<企业名>\<产品名>`：
/// 拷程序时容易漏、换机后站点列表就空了。改到程序目录后，
/// "整个文件夹拷走 = 完整迁移"，且 C 盘不留任何本程序的数据。
bool get portableMode => Platform.isWindows;

/// 程序（exe）所在目录。
String executableDir() => File(Platform.resolvedExecutable).parent.path;

/// 便携数据根目录（只有 Windows 走这里）。名字用 `data-user`，
/// 刻意避开 Flutter 自己占用的 `data\`（那是 flutter_assets 等资源）。
String portableRootPath() => joinPath(executableDir(), 'data-user');

/// 该路径是否已在便携数据目录内（用于把老配置从 C 盘迁过来）。
bool isInPortableRoot(String path) {
  if (!portableMode || path.isEmpty) return false;
  final String root = portableRootPath();
  return path == root || path.startsWith('$root${Platform.pathSeparator}');
}

/// 配置、图标缓存等私有数据目录（只有卸载才会清）。
///
/// - **Windows**：程序目录下的 `data-user\`。首次创建时自动把老版本落在
///   C 盘 `%APPDATA%\企业名\产品名` 里的站点配置、下载记录、图标缓存搬过来，
///   老用户升级不会"站点全没了"。
/// - **其它平台**：维持系统默认（Android 的私有目录不可自选）。
Future<Directory> appDataDir() async {
  if (portableMode) {
    final Directory dir = Directory(portableRootPath());
    if (!dir.existsSync()) {
      dir.createSync(recursive: true);
      await _migrateFromAppData(dir);
    }
    return dir;
  }
  final Directory dir = await getApplicationSupportDirectory();
  if (!dir.existsSync()) dir.createSync(recursive: true);
  return dir;
}

/// 首次在程序目录里建数据目录时，把老位置（`%APPDATA%\企业名\产品名`）
/// 的站点配置 / 下载记录 / 密码 / 图标缓存搬一次。
Future<void> _migrateFromAppData(Directory portable) async {
  Directory old;
  try {
    old = await getApplicationSupportDirectory();
  } catch (_) {
    return; // 拿不到老位置就当没有老数据
  }
  if (old.path == portable.path || !old.existsSync()) return;

  void moveFile(String name) {
    try {
      final File src = File(joinPath(old.path, name));
      final File dst = File(joinPath(portable.path, name));
      if (src.existsSync() && !dst.existsSync()) src.copySync(dst.path);
    } catch (_) {
      // 单个文件搬不动（占用 / 权限）不影响其它数据，启动不该因此失败
    }
  }

  moveFile(ConfigFile.defaultFileName); // webshell.json：站点列表与设置
  moveFile('downloads.json');           // 下载记录
  moveFile('secrets.bin');              // 站点密码（便携版落点，见 local_secure_store.dart）

  try {
    final Directory src = Directory(joinPath(old.path, 'icons'));
    final Directory dst = Directory(joinPath(portable.path, 'icons'));
    if (src.existsSync() && !dst.existsSync()) _copyDirSync(src, dst);
  } catch (_) {}
}

/// 递归复制目录。
///
/// Dart 的 `Directory` 没有现成的 `copySync`（只有 `File.copySync`），
/// 所以这里自己走一遍：先建目标目录，再把源目录里的每个子目录 / 文件
/// 按相对路径补到目标下。图标缓存里不该出现符号链接，遇到就跳过，
/// 避免把链接指向的原始路径也搬过去。
void _copyDirSync(Directory from, Directory to) {
  to.createSync(recursive: true);
  for (final FileSystemEntity e
      in from.listSync(recursive: true, followLinks: false)) {
    final String rel = e.path
        .substring(from.path.length)
        .replaceFirst(RegExp(r'^[\\/]+'), '');
    if (rel.isEmpty) continue;
    final String dest = joinPath(to.path, rel);
    if (e is Directory) {
      Directory(dest).createSync(recursive: true);
    } else if (e is File) {
      e.copySync(dest);
    }
  }
}

/// 图标缓存目录。
Future<Directory> iconCacheDir() async {
  final Directory dir = Directory(joinPath((await appDataDir()).path, 'icons'));
  if (!dir.existsSync()) dir.createSync(recursive: true);
  return dir;
}

/// 默认下载目录。
///
/// - **Windows**：用户的「下载」文件夹。资源管理器里直接就能看见，符合直觉。
/// - **Android**：优先系统公共 `Download/<App 名文件夹>`（App 名是中文就取拼音
///   首字母，如「成都」→ `Download/cd`；英文名直接用原名）。Android 11+ 可以
///   免权限直接写，文件管理器和系统「下载」里一眼可见。
///   建不出来（Android 10 的 scoped storage、个别厂商 ROM）就回退
///   `Android/media/<包名>/Download`——它同样免权限、文件管理器可见，并且
///   **卸载时系统自动删掉**。注意：公共 `Download` 里的文件卸载时系统**不会**
///   删（Android 没有任何卸载钩子，这是平台行为）。
///
///   目录探测在首次启动（配置为空）和升级迁移时各做一次，结果写进配置，
///   下载时不再反复探测。
Future<String> defaultDownloadDirectory(String appName) async {
  if (Platform.isAndroid) {
    Directory? ext;
    try {
      ext = await getExternalStorageDirectory();
    } catch (_) {
      ext = null; // 拿不到应用外部目录就落到桌面式兜底
    }
    if (ext != null) {
      // 1) 公共 Download/<App 名>：建得出来 = 可直写（Android 11+），用它
      final String? volumeRoot = androidVolumeRootOf(ext.path);
      if (volumeRoot != null) {
        try {
          final Directory dl = Directory(
            joinPath(joinPath(volumeRoot, 'Download'), appFolderName(appName)),
          );
          if (!dl.existsSync()) dl.createSync(recursive: true);
          return dl.path;
        } catch (_) {
          // Android 10 / 厂商限制写不了公共目录：走下面的回退
        }
      }
      // 2) 回退：可见的 Android/media/<包名>/Download（卸载自动清）
      try {
        final String base = androidMediaDirOf(ext.path) ?? ext.path;
        final Directory dl = Directory(joinPath(base, 'Download'));
        if (!dl.existsSync()) dl.createSync(recursive: true);
        return dl.path;
      } catch (_) {
        // 再落兜底
      }
    }
  }
  // Windows 便携：默认下载目录也放在程序目录里，跟其它数据一起搬走。
  if (portableMode) {
    final Directory dir = Directory(joinPath(portableRootPath(), 'Download'));
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir.path;
  }
  final String home = defaultDownloadDir();
  try {
    final Directory dir = Directory(home);
    if (!dir.existsSync()) dir.createSync(recursive: true);
  } catch (_) {
    // 建不出来就让调用方在写文件时报错，那里有更清楚的错误信息
  }
  return home;
}
