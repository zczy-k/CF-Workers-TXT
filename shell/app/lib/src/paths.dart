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
/// - **Android**：`Android/media/<包名>/Download`。它是应用私有目录（**不需要任何
///   存储权限**，也不用 SAF），但和 `Android/data/<包名>` 不同 —— 后者从 Android 11
///   起被系统对文件管理器和 MTP 屏蔽，用户翻不到，体验上就成了"下载的东西没到手机上"。
///   `Android/media/<包名>` 文件管理器看得见（WhatsApp 的媒体就放这儿）。
///   想放进系统「下载」或别的文件夹，用下载列表里的「另存为」走系统选择器（SAF）。
Future<String> defaultDownloadDirectory() async {
  if (Platform.isAndroid) {
    try {
      final Directory? ext = await getExternalStorageDirectory();
      if (ext != null) {
        // 可见的 Android/media/<包名>；实在不行才退回应用私有目录
        final String base = androidMediaDirOf(ext.path) ?? ext.path;
        final Directory dl = Directory(joinPath(base, 'Download'));
        if (!dl.existsSync()) dl.createSync(recursive: true);
        return dl.path;
      }
    } catch (_) {
      // 落到下面的兜底
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
