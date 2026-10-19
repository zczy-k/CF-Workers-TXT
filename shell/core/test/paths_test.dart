import 'package:test/test.dart';
import 'package:webshell_core/webshell_core.dart';

void main() {
  group('appFolderName：App 名 → 公共下载子文件夹名', () {
    test('中文名取拼音首字母', () {
      expect(appFolderName('成都'), 'cd');
      expect(appFolderName('记事本'), 'jsb');
    });

    test('多音字按词组字典走', () {
      expect(appFolderName('重庆'), 'cq'); // 词组字典：重庆=chong qing
    });

    test('英文 / 字母 / 数字名直接用原名（保留大小写）', () {
      expect(appFolderName('WebShell'), 'WebShell');
      expect(appFolderName('TXT2APP'), 'TXT2APP');
      expect(appFolderName('abc 123'), 'abc 123');
    });

    test('中英混合按段处理', () {
      expect(appFolderName('成都TV'), 'cdTV');
    });

    test('繁体先转简体再取首字母', () {
      expect(appFolderName('記憶'), 'jy');
    });

    test('非法字符清理', () {
      expect(appFolderName('a/b'), 'a_b');
      expect(appFolderName('con'), '_con'); // Windows 保留名加前缀
    });

    test('空名 / 纯符号名兜底 App', () {
      expect(appFolderName(''), 'App');
      expect(appFolderName('   '), 'App');
      expect(appFolderName('///'), 'App');
    });

    test('纯非法字符清理后为空不产生 download 文件夹', () {
      // sanitizeFileName 的空兜底值是 'download'，appFolderName 必须拦住它
      expect(appFolderName('???'), isNot('download'));
    });

    test('纯生僻字不崩（字典缺字逐字降级）', () {
      // '𠀀' 是扩展 B 区汉字，不在字典里：原样保留，不能抛异常
      final String result = appFolderName('𠀀');
      expect(result, isNotEmpty);
    });
  });

  group('androidVolumeRootOf：应用私有目录 → 卷根', () {
    test('提取卷根', () {
      expect(
        androidVolumeRootOf(
            '/storage/emulated/0/Android/data/com.example.app/files'),
        '/storage/emulated/0',
      );
    });

    test('尾部路径也认', () {
      expect(
        androidVolumeRootOf('/sdcard/Android/data/com.example.app/files/x'),
        '/sdcard',
      );
    });

    test('非 Android 应用私有目录形状返回 null', () {
      expect(androidVolumeRootOf('/home/user/docs'), isNull);
      expect(androidVolumeRootOf(''), isNull);
    });
  });
}
