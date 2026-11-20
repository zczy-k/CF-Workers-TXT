import 'package:flutter/material.dart';

/// 设计系统：一次定义，全部页面吃同一套。
///
/// 风格基线（对齐 2026 年主流产品，参考 Linear / Arc / iOS 26 / 微信新版）：
///
///   * **不用阴影分层，用「底色差 + 1px 半透明描边」。** 阴影在低分屏是
///     一层脏灰、在大屏是一圈糊边，两端都不干净；描边（hairline）在任何
///     分辨率下都是利落的一条线，而且深色模式下换个 alpha 就能继续用。
///   * **中性灰打底，品牌色只当点缀。** 种子色铺满界面是 2014 年那套
///     Material 观感（也是"复古"的来源）；现在只让主色出现在主按钮、
///     选中态、进度条、徽标上，页面本体永远是中性色。
///   * 大圆角：卡片 18 / 弹层 28 / 对话框 24 / 输入框与按钮 14，
///     底栏整条走全圆（胶囊 dock）。
///   * 字号收紧字距（负数），大标题 28~30 w700 —— 中文用 w700 会把字面
///     撑满，必须配负字距才不显胖。
///   * 输入框填充式、聚焦只描 1.5px 主色边，不用四边全框。
///   * 图标统一 outlined / rounded 系，次级信息 onSurfaceVariant。
///   * 桌面端列表居中限宽（微信桌面 / Notion 的做法），不满屏摊大饼。
class AppTheme {
  AppTheme._();

  static const double radiusCard = 18;
  static const double radiusField = 14;
  static const double radiusButton = 14;
  static const double radiusDialog = 24;
  static const double radiusSheet = 28;

  /// 桌面端内容列的最大宽度（列表页居中收窄用）。
  static const double contentMaxWidth = 760;

  // 页面底色 / 卡片底色：光靠 colorScheme 的 surfaceContainer 系列推不出来
  // 想要的「冷一点、干净一点」的灰，于是写死两组常量，深浅各一套。
  static const Color _lightPage = Color(0xFFF4F5F7);
  static const Color _lightCard = Color(0xFFFFFFFF);
  static const Color _darkPage = Color(0xFF0B0C0E);
  static const Color _darkCard = Color(0xFF15161A);

  /// 卡片 / 底栏 / 弹层的描边色。
  ///
  /// 不用 `outlineVariant`：那个值是给"输入框边线"设计的，比这里需要的
  /// 重一档，大圆角卡片描上去会显得像刻出来的框。
  static Color hairline(ColorScheme colors) => colors.brightness == Brightness.dark
      ? Colors.white.withValues(alpha: 0.08)
      : Colors.black.withValues(alpha: 0.07);

  static ThemeData light(Color seed) => _build(_scheme(seed, Brightness.light));

  static ThemeData dark(Color seed) => _build(_scheme(seed, Brightness.dark));

  static ColorScheme _scheme(Color seed, Brightness brightness) {
    final bool isDark = brightness == Brightness.dark;
    // 只借种子色的 primary / secondary / error 这几个语义色，
    // surface 系列全部换成中性灰（见 _build 里的说明）。
    final ColorScheme base = ColorScheme.fromSeed(
      seedColor: seed,
      brightness: brightness,
    );
    return base.copyWith(
      surface: isDark ? _darkCard : _lightCard,
      surfaceContainerLowest: isDark ? const Color(0xFF0F1013) : Colors.white,
      surfaceContainerLow: isDark ? const Color(0xFF15161A) : const Color(0xFFF9FAFB),
      surfaceContainer: isDark ? const Color(0xFF1B1D22) : const Color(0xFFF1F2F5),
      surfaceContainerHigh: isDark ? const Color(0xFF23262C) : const Color(0xFFEAECEF),
      surfaceContainerHighest: isDark ? const Color(0xFF2B2F36) : const Color(0xFFE3E5E9),
      onSurface: isDark ? const Color(0xFFF2F3F5) : const Color(0xFF111114),
      onSurfaceVariant: isDark ? const Color(0xFF9BA0A8) : const Color(0xFF6C7078),
      outline: isDark ? const Color(0xFF6E747C) : const Color(0xFF8E9299),
      outlineVariant: isDark ? const Color(0xFF2C2F35) : const Color(0xFFE3E5E9),
      surfaceTint: Colors.transparent,
    );
  }

  /// 字号阶梯。默认的 Roboto 阶梯给中文用会偏松散（字距默认 0、行高 1.5+），
  /// 大标题尤其明显 —— 这里统一收紧一档。
  static TextTheme _text(ColorScheme colors, bool isDark) {
    final TextTheme base =
        isDark ? Typography.material2021().white : Typography.material2021().black;
    final TextTheme t = base.apply(
      bodyColor: colors.onSurface,
      displayColor: colors.onSurface,
    );
    return t.copyWith(
      headlineMedium: t.headlineMedium?.copyWith(
        fontSize: 30,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.9,
        height: 1.16,
      ),
      headlineSmall: t.headlineSmall?.copyWith(
        fontSize: 24,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.6,
        height: 1.2,
      ),
      titleLarge: t.titleLarge?.copyWith(
        fontSize: 21,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.4,
        height: 1.25,
      ),
      titleMedium: t.titleMedium?.copyWith(
        fontSize: 15.5,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.1,
        height: 1.35,
      ),
      titleSmall: t.titleSmall?.copyWith(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.1,
      ),
      bodyLarge: t.bodyLarge?.copyWith(fontSize: 15, height: 1.45),
      bodyMedium: t.bodyMedium?.copyWith(fontSize: 14, height: 1.5),
      bodySmall: t.bodySmall?.copyWith(fontSize: 12.5, height: 1.45),
      labelLarge: t.labelLarge?.copyWith(
        fontSize: 14.5,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      labelMedium: t.labelMedium?.copyWith(
        fontSize: 12,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.2,
      ),
    );
  }

  static ThemeData _build(ColorScheme colors) {
    final bool isDark = colors.brightness == Brightness.dark;
    final Color pageBg = isDark ? _darkPage : _lightPage;
    final Color cardBg = colors.surface;
    final Color fieldBg = isDark ? colors.surfaceContainerHigh : const Color(0xFFF0F1F4);
    final Color line = hairline(colors);
    final TextTheme text = _text(colors, isDark);

    return ThemeData(
      useMaterial3: true,
      colorScheme: colors,
      scaffoldBackgroundColor: pageBg,
      canvasColor: pageBg,
      textTheme: text,
      primaryTextTheme: text,
      visualDensity: VisualDensity.adaptivePlatformDensity,
      // 页面转场：Android / 桌面用 M3 的 FadeForwards（淡入 + 轻微上移，
      // 比老 Zoom 转场安静得多）。iOS / macOS 不在这里写死 —— 那两个平台
      // 由 Flutter 自己套系统横滑（Cupertino），覆盖反而会退化成 Material 动画。
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: <TargetPlatform, PageTransitionsBuilder>{
          TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
          TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
          TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
        },
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: pageBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        // 默认 56dp（kToolbarHeight）偏胖：标题一行 + 48 高的按钮，
        // 上下各留 4dp 就够。压到 54 之后，设置 / 下载 / 站点编辑这些页
        // 也跟着一起瘦，浏览页则干脆不用 AppBar 了（见 browser_page 的 dock）。
        toolbarHeight: 54,
        titleTextStyle: text.titleMedium?.copyWith(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
          color: colors.onSurface,
        ),
        iconTheme: IconThemeData(color: colors.onSurface, size: 22),
        actionsIconTheme: IconThemeData(color: colors.onSurfaceVariant, size: 22),
      ),
      cardTheme: CardThemeData(
        color: cardBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
          side: BorderSide(color: line),
        ),
      ),
      listTileTheme: ListTileThemeData(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        minVerticalPadding: 10,
        iconColor: colors.onSurfaceVariant,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        titleTextStyle: text.titleMedium?.copyWith(
          fontSize: 15,
          fontWeight: FontWeight.w500,
        ),
        subtitleTextStyle: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: fieldBg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        hintStyle: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        labelStyle: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
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
          borderSide: BorderSide(color: colors.primary, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: colors.error, width: 1),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusField),
          borderSide: BorderSide(color: colors.error, width: 1.5),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 48),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          elevation: 0,
          shadowColor: Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusButton),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 46),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          foregroundColor: colors.onSurface,
          side: BorderSide(color: colors.outlineVariant),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusButton),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colors.primary,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: colors.primary,
        foregroundColor: colors.onPrimary,
        elevation: 2,
        focusElevation: 2,
        hoverElevation: 3,
        highlightElevation: 1,
        shape: const StadiumBorder(),
        extendedTextStyle: const TextStyle(
          fontSize: 14.5,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: cardBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusDialog),
          side: BorderSide(color: line),
        ),
        titleTextStyle: text.titleLarge?.copyWith(
          fontSize: 19,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
          color: colors.onSurface,
        ),
        contentTextStyle: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: cardBg,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: cardBg,
        modalElevation: 0,
        elevation: 0,
        showDragHandle: true,
        dragHandleColor: colors.outlineVariant,
        dragHandleSize: const Size(36, 4),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(radiusSheet)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        // 深色浮条：浅灰页面上比"主色条"克制得多，也是现在通行做法
        backgroundColor: isDark ? const Color(0xFF2B2F36) : const Color(0xFF1F2126),
        contentTextStyle: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.4),
        elevation: 0,
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      dividerTheme: DividerThemeData(color: line, thickness: 1, space: 1),
      popupMenuTheme: PopupMenuThemeData(
        color: cardBg,
        surfaceTintColor: Colors.transparent,
        elevation: 3,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: line),
        ),
        textStyle: text.bodyMedium?.copyWith(fontSize: 14.5),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: colors.primary,
        linearTrackColor: colors.surfaceContainerHighest,
        circularTrackColor: colors.surfaceContainerHighest,
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
        trackOutlineColor: const WidgetStatePropertyAll<Color?>(Colors.transparent),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: colors.primary,
        inactiveTrackColor: colors.surfaceContainerHighest,
        thumbColor: colors.primary,
        trackHeight: 4,
        overlayColor: colors.primary.withValues(alpha: 0.08),
      ),
      badgeTheme: BadgeThemeData(
        backgroundColor: colors.primary,
        textColor: colors.onPrimary,
        smallSize: 7,
        textStyle: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700, height: 1.1),
      ),
      tooltipTheme: const TooltipThemeData(
        waitDuration: Duration(milliseconds: 500),
        preferBelow: false,
      ),
    );
  }
}
