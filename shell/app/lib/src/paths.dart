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
/// - **Android**：应用自己的外部目录（`Android/data/<包名>/files/Download`）。
///   它就在手机本机存储里，**不需要任何存储权限**，也不用担心被系统限制；
///   想放进系统「下载」或别的文件夹，用下载列表里的「另存为」走系统选择器（SAF）。
Future<String> defaultDownloadDirectory() async {
  if (Platform.isAndroid) {
    try {
      final Directory? ext = await getExternalStorageDirectory();
      if (ext != null) {
        final Directory dl = Directory(joinPath(ext.path, 'Download'));
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
