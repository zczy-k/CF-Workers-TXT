import 'dart:io';

import 'package:open_filex/open_filex.dart';
import 'package:url_launcher/url_launcher.dart';

/// 用系统程序打开下载好的文件。返回 null 表示成功，否则是失败原因。
Future<String?> openLocalFile(String path) async {
  if (Platform.isAndroid) {
    try {
      final OpenResult result = await OpenFilex.open(path);
      if (result.type == ResultType.done) return null;
      return result.message.isEmpty ? '没有能打开它的应用' : result.message;
    } catch (e) {
      return e.toString();
    }
  }
  if (Platform.isWindows) {
    try {
      // explorer 打开等价于双击。注意：以管理员身份运行时 Windows 会拒绝这种转发，
      // 那是系统限制，绕不过去。
      await Process.run('explorer.exe', <String>[path]);
      return null;
    } catch (e) {
      return e.toString();
    }
  }
  return '这个平台暂不支持打开文件';
}

/// 在文件管理器里定位这个文件。
Future<bool> revealInFolder(String path) async {
  if (Platform.isWindows) {
    try {
      await Process.run('explorer.exe', <String>['/select,', path]);
      return true;
    } catch (_) {
      return false;
    }
  }
  // Android 没有"定位到文件"这种操作，打开它本身就是最好的反馈
  return (await openLocalFile(path)) == null;
}

/// 打开一个目录（Windows：资源管理器；Android：交给系统文件管理器/打开器）。
///
/// 用途很直接：用户问"下到哪去了"，一个按钮就能看到那个文件夹。
Future<String?> openDirectory(String path) async {
  final Directory dir = Directory(path);
  if (!dir.existsSync()) {
    try {
      dir.createSync(recursive: true);
    } catch (e) {
      return '这个目录打不开：$e';
    }
  }
  if (Platform.isWindows) {
    try {
      // 注意 explorer 对目录路径的退出码不可靠，这里只关心有没有抛异常
      await Process.run('explorer.exe', <String>[path]);
      return null;
    } catch (e) {
      return e.toString();
    }
  }
  return openLocalFile(path);
}

/// 交给系统（浏览器、电话、邮件…）打开。
Future<bool> openExternal(String url) async {
  final Uri? uri = Uri.tryParse(url);
  if (uri == null) return false;
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}
