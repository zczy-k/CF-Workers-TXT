import 'dart:io';

import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

/// 站点图标：本地缓存的 favicon → 抓不到就退化成带颜色的首字母方块。
class SiteAvatar extends StatelessWidget {
  const SiteAvatar({super.key, required this.site, this.size = 40});

  final SiteProfile site;
  final double size;

  @override
  Widget build(BuildContext context) {
    final String? path = site.iconPath;
    final Widget fallback = _letter(context);
    if (path == null || path.isEmpty) return fallback;

    final File file = File(path);
    if (!file.existsSync()) return fallback;

    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.25),
      child: Image.file(
        file,
        width: size,
        height: size,
        fit: BoxFit.cover,
        // 图标格式五花八门（ico/svg/坏文件），解不出来就退回首字母，不要显示红屏
        errorBuilder: (BuildContext context, Object error, StackTrace? stack) => fallback,
      ),
    );
  }

  Widget _letter(BuildContext context) {
    final String name = site.displayName;
    final String letter = name.isEmpty ? '?' : name.substring(0, 1).toUpperCase();
    final int color = site.themeColor != 0
        ? site.themeColor
        : Theme.of(context).colorScheme.primary.toARGB32();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Color(color),
        borderRadius: BorderRadius.circular(size * 0.25),
      ),
      child: Text(
        letter,
        style: TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w600,
          fontSize: size * 0.45,
        ),
      ),
    );
  }
}
