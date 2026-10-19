import 'package:flutter/material.dart';

import '../util.dart';

/// `IconDataLite` → 真正的 `IconData`。
///
/// 单独一个文件，是因为这套映射有三个使用方（列表行、搜索页、编辑器），
/// 而 util.dart 刻意不 import material（它要能被纯逻辑复用）。
IconData iconOf(IconDataLite i) {
  switch (i) {
    case IconDataLite.folder:
      return Icons.folder_rounded;
    case IconDataLite.text:
      return Icons.article_outlined;
    case IconDataLite.config:
      return Icons.settings_suggest_outlined;
    case IconDataLite.table:
      return Icons.table_chart_outlined;
    case IconDataLite.web:
      return Icons.language_outlined;
    case IconDataLite.image:
      return Icons.image_outlined;
    case IconDataLite.media:
      return Icons.play_circle_outline;
    case IconDataLite.pdf:
      return Icons.picture_as_pdf_outlined;
    case IconDataLite.zip:
      return Icons.archive_outlined;
    case IconDataLite.code:
      return Icons.code;
    case IconDataLite.file:
      return Icons.insert_drive_file_outlined;
  }
}
