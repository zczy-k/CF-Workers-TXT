/// App 名 → 下载子文件夹名（Android 公共 Download 下按 App 分文件夹用）。
///
/// 拼音转换用的是内嵌的纯 Dart 实现（src/pinyin/，抄自 lpinyin 2.0.3，
/// Apache-2.0）——它 pub 上的 sdk 约束停在 `<3.0.0`，Dart 3 下 pub 解不开，
/// 所以内嵌源码而不是加依赖。
library;

import 'pinyin/pinyin_exception.dart';
import 'pinyin/pinyin_helper.dart';
import 'url_utils.dart';

/// App 名 → 公共下载目录下的子文件夹名。
///
/// - **中文名**取拼音首字母：成都 → cd；多音字按词组字典走：重庆 → cq；
/// - **英文 / 字母 / 数字名**直接用原名（保留大小写）：WebShell → WebShell；
/// - **中英混合**按段处理：成都TV → cdTV；
/// - 目录分隔符等非法字符过一遍文件名清理；清理后为空兜底 `App`。
///
/// 同一 App 名结果稳定（纯函数），因此可以在"首次启动建目录"和"每次下载"两处
/// 独立调用而不怕不一致。
String appFolderName(String appName) {
  final String raw = appName.trim();
  if (raw.isEmpty) return 'App';
  final String cleaned = sanitizeFileName(raw);
  // sanitizeFileName 对"清理后为空"的输入返回兜底值 'download'——纯非法字符
  // （比如 "///"）会走到这，那种情况用 App 而不是建一个叫 download 的文件夹。
  if (cleaned == 'download' && raw.toLowerCase() != 'download') return 'App';

  final String s = _shortPinyinSafe(cleaned);
  final String result = sanitizeFileName(s).trim();
  return result.isEmpty ? 'App' : result;
}

/// 生僻字不在字典里时 [PinyinHelper.getShortPinyin] 会抛异常：
/// 逐字降级——转得了的转，转不了的原样保留（文件系统收 UTF-8 没问题）。
String _shortPinyinSafe(String s) {
  try {
    return PinyinHelper.getShortPinyin(s);
  } on PinyinException {
    final StringBuffer buf = StringBuffer();
    for (int i = 0; i < s.length; i++) {
      try {
        buf.write(PinyinHelper.getShortPinyin(s[i]));
      } on PinyinException {
        buf.write(s[i]);
      }
    }
    return buf.toString();
  }
}
