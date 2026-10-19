import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:webshell_core/webshell_core.dart';

/// 配置、图标缓存等私有数据目录（只有卸载才会清）。
Future<Directory> appDataDir() async {
  final Directory dir = await getApplicationSupportDirectory();
  if (!dir.existsSync()) dir.createSync(recursive: true);
  return dir;
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
  final String home = defaultDownloadDir();
  try {
    final Directory dir = Directory(home);
    if (!dir.existsSync()) dir.createSync(recursive: true);
  } catch (_) {
    // 建不出来就让调用方在写文件时报错，那里有更清楚的错误信息
  }
  return home;
}
