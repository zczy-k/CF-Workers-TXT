import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:webshell/src/local_secure_store.dart';

/// 机密存储的落盘格式与迁移。
///
/// 这组测试盯的是**磁盘上到底能不能直接看到密码**，而不是"读回来对不对" ——
/// 只测读写的话，明文落盘也能全绿。
void main() {
  late Directory tmp;
  late File file;
  late LocalSecureStore store;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('webshell_secret_test');
    file = File('${tmp.path}${Platform.pathSeparator}secrets.bin');
    store = LocalSecureStore(file);
  });

  tearDown(() {
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('写进去再读回来，值不变', () async {
    await store.write(key: 'basic:site-1', value: 'hunter2-密码');
    final LocalSecureStore fresh = LocalSecureStore(file);
    expect(await fresh.read(key: 'basic:site-1'), 'hunter2-密码');
    expect(await fresh.read(key: 'basic:nope'), isNull);
  });

  test('磁盘上没有明文密码（Windows 走 DPAPI；其它平台至少不是原样）', () async {
    const String secret = 'PLAINTEXT-CANARY-9f3a';
    await store.write(key: 'basic:site-1', value: secret);

    final Uint8List bytes = file.readAsBytesSync();
    final String asLatin1 = latin1.decode(bytes, allowInvalid: true);
    expect(asLatin1.contains(secret), isFalse,
        reason: '密码原文出现在 secrets.bin 里，等于没加密');
    // 顺带确认 key 名也没裸着（key 里带站点 id，属于配置，不该在密文外层）
    expect(asLatin1.contains('basic:site-1'), isFalse);

    if (LocalSecureStore.encryptedAtRest) {
      // 有真加密的平台：文件头必须是 WSSEC1 + 方案 1（DPAPI）
      expect(bytes.sublist(0, 6), <int>[0x57, 0x53, 0x53, 0x45, 0x43, 0x01]);
      expect(bytes[6], 1);
    }
  });

  test('删除后读不到，重新打开文件也一样', () async {
    await store.write(key: 'basic:site-1', value: 'x');
    await store.delete(key: 'basic:site-1');
    expect(await LocalSecureStore(file).read(key: 'basic:site-1'), isNull);
  });

  test('老格式（无文件头、纯掩码）照样能读，且第一次读取就升级成密文', () async {
    const String legacyJson =
        '{"basic:site-old":"legacy-pass","basic:site-old2":"另一个密码"}';
    file.writeAsBytesSync(LocalSecureStore.legacyBytesForTest(legacyJson));

    final LocalSecureStore fresh = LocalSecureStore(file);
    expect(await fresh.read(key: 'basic:site-old'), 'legacy-pass');
    expect(await fresh.read(key: 'basic:site-old2'), '另一个密码');

    if (!LocalSecureStore.encryptedAtRest) return; // 没有 DPAPI 的平台谈不上升级
    final Uint8List bytes = file.readAsBytesSync();
    expect(bytes.sublist(0, 6), <int>[0x57, 0x53, 0x53, 0x45, 0x43, 0x01]);
    expect(bytes[6], 1, reason: '老文件读完没有立刻重写成密文，会一直裸在磁盘上');
    // 升级后仍然读得出来（等于换了格式、没丢数据）
    expect(await LocalSecureStore(file).read(key: 'basic:site-old'), 'legacy-pass');
  });

  test('密文被截断 / 被改动时当作空，不抛异常', () async {
    await store.write(key: 'basic:site-1', value: 'y');
    final Uint8List bytes = file.readAsBytesSync();
    file.writeAsBytesSync(bytes.sublist(0, bytes.length - 8));
    expect(await LocalSecureStore(file).read(key: 'basic:site-1'), isNull);
  });
}
