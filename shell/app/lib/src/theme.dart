import 'package:flutter/material.dart';

/// 设计系统：一次定义，全部页面吃同一套。
///
/// 风格基线（对齐当前大厂通行做法）：
///   * 页面浅灰、卡片纯白（深色模式反过来）—— 层次靠底色，不靠阴影；
///   * 大圆角：卡片 16 / 对话框 20 / 底部弹层顶部 24 / 输入框与按钮 14；
///   * 输入框填充式（filled、无边框，聚焦才描主色边）；
///   * 主按钮 48 高、字重 w600；
///   * 图标统一 outlined 系、次级信息 onSurfaceVariant；
///   * 桌面端列表居中限宽（微信桌面 / Notion 的做法），不满屏摊大饼。
class AppTheme {
  AppTheme._();

  static const double radiusCard = 16;
  static const double radiusField = 14;
  static const double radiusButton = 14;
  static const double radiusDialog = 20;

  /// 桌面端内容列的最大宽度（列表页居中收窄用）。
  static const double contentMaxWidth = 760;

  static ThemeData light(Color seed) => _build(
        ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.light),
      );

  static ThemeData dark(Color seed) => _build(
        ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark),
      );

  static ThemeData _build(ColorScheme colors) {
    final bool isDark = colors.brightness == Brightness.dark;
    // 页面底色比卡片深/浅一档，层次感就出来了
    final Color pageBg =
        isDark ? colors.surfaceContainerLow : const Color(0xFFF6F7FA);
    final Color cardBg =
        isDark ? colors.surfaceContainerLowest : colors.surface;
    final Color fieldBg =
        isDark ? colors.surfaceContainerHigh : const Color(0xFFEFF1F5);

    return ThemeData(
      useMaterial3: true,
      colorScheme: colors,
      scaffoldBackgroundColor: pageBg,
      visualDensity: VisualDensity.adaptivePlatformDensity,
      appBarTheme: AppBarTheme(
        backgroundColor: pageBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 17,
          fontWeight: FontWeight.w700,
          color: colors.onSurface,
        ),
        iconTheme: IconThemeData(color: colors.onSurfaceVariant),
      ),
      cardTheme: CardThemeData(
        color: cardBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
        ),
      ),
      listTileTheme: ListTileThemeData(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        iconColor: colors.onSurfaceVariant,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: fieldBg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: colors.primary, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: colors.error, width: 1),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: colors.error, width: 2),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 48),
          padding: const EdgeInsets.symmetric(horizontal: 24),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusButton),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 46),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusButton),
          ),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusButton),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: cardBg,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusDialog),
        ),
        titleTextStyle: TextStyle(
          fontSize: 17,
          fontWeight: FontWeight.w700,
          color: colors.onSurface,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: cardBg,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      dividerTheme: DividerThemeData(
        color: colors.outlineVariant.withValues(alpha: 0.5),
        thickness: 1,
        space: 1,
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: cardBg,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: colors.primary,
        linearTrackColor: colors.surfaceContainerHighest,
      ),
      scrollbarTheme: ScrollbarThemeData(
        radius: const Radius.circular(8),
        thickness: const WidgetStatePropertyAll<double>(6),
        thumbColor: WidgetStateProperty.resolveWith((Set<WidgetState> states) {
          return colors.outlineVariant.withValues(
            alpha: states.contains(WidgetState.hovered) ? 0.9 : 0.5,
          );
        }),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: const WidgetStatePropertyAll<Color?>(Colors.white),
        trackColor: WidgetStateProperty.resolveWith((Set<WidgetState> states) {
          return states.contains(WidgetState.selected)
              ? colors.primary
              : colors.surfaceContainerHighest;
        }),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: colors.primary,
        inactiveTrackColor: colors.surfaceContainerHighest,
        thumbColor: colors.primary,
        overlayColor: colors.primary.withValues(alpha: 0.08),
      ),
    );
  }
}
