import 'package:test/test.dart';
import 'package:webshell_core/src/models.dart';
import 'package:webshell_core/src/update.dart';

void main() {
  group('isNewer 语义化版本比较', () {
    test('按数字段比较：1.10.0 > 1.9.0（字符串比较会判反）', () {
      expect(UpdateChecker.isNewer('1.10.0', '1.9.0'), isTrue);
    });

    test('主版本优先：2.0.0 > 1.99.99', () {
      expect(UpdateChecker.isNewer('2.0.0', '1.99.99'), isTrue);
      expect(UpdateChecker.isNewer('1.99.99', '2.0.0'), isFalse);
    });

    test('段数不同补零：1.2 与 1.2.0 相等（不算更新）', () {
      expect(UpdateChecker.isNewer('1.2', '1.2.0'), isFalse);
      expect(UpdateChecker.isNewer('1.2.0', '1.2'), isFalse);
      expect(UpdateChecker.isNewer('1.2.0.1', '1.2'), isTrue);
    });

    test('相等不算更新', () {
      expect(UpdateChecker.isNewer('0.1.0', '0.1.0'), isFalse);
    });

    test('预发布低于正式：1.2.0-beta < 1.2.0', () {
      expect(UpdateChecker.isNewer('1.2.0-beta', '1.2.0'), isFalse);
      expect(UpdateChecker.isNewer('1.2.0', '1.2.0-beta'), isTrue);
    });

    test('同段数字后缀：1.2.1-beta > 1.2.0', () {
      expect(UpdateChecker.isNewer('1.2.1-beta', '1.2.0'), isTrue);
    });

    test('+build 元数据不参与比较', () {
      expect(UpdateChecker.isNewer('1.2.0+5', '1.2.0+99'), isFalse);
      expect(UpdateChecker.isNewer('1.3.0+1', '1.2.0+99'), isTrue);
    });

    test('乱输入按段字符串兜底，不抛异常', () {
      expect(() => UpdateChecker.isNewer('x.y.z', '1.2.3'), returnsNormally);
      expect(UpdateChecker.isNewer('1.2.3', ''), isTrue);
    });
  });

  group('fetch 前置条件', () {
    test('没配 updateUrl 直接 null，不发请求', () async {
      final UpdateInfo? r = await UpdateChecker.fetch(Branding.generic);
      expect(r, isNull);
    });

    test('updateUrl 是空白串同样短路', () async {
      const Branding b = Branding(updateUrl: '   ');
      final UpdateInfo? r = await UpdateChecker.fetch(b);
      expect(r, isNull);
    });
  });
}
