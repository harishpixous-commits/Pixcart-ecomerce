// ThemeData from the site's theme tokens, exactly like the website's CSS variables, plus Tailwind's type scale.
//
// Screens read colours with `context.pc` (PcTokens: peacock = primary, marigold = accent, vermilion = buy,
// leaf = success, ink, mist = page, line) and text styles with `Tw` (text-xs ... text-3xl with Tailwind's line heights).

import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';

const _pkg = 'pixcart_ui';

/// The bundled families (packages/pixcart_ui/fonts). Other themes' fonts fall back to these.
const sansFamily = 'packages/$_pkg/Mukta';
const displayFamily = 'packages/$_pkg/Baloo2';

class PcThemeExt extends ThemeExtension<PcThemeExt> {
  const PcThemeExt(this.tokens);
  final PcTokens tokens;

  @override
  PcThemeExt copyWith({PcTokens? tokens}) => PcThemeExt(tokens ?? this.tokens);

  @override
  PcThemeExt lerp(covariant PcThemeExt? other, double t) => other == null || t < 0.5 ? this : other;
}

extension PcContext on BuildContext {
  /// The storefront's colours, radii and fonts.
  PcTokens get pc => Theme.of(this).extension<PcThemeExt>()?.tokens ?? PcTokens.fallback;
}

/// Tailwind's text sizes with their line heights (font-size / line-height in px).
class Tw {
  Tw._();

  static TextStyle _s(double size, double line, {FontWeight weight = FontWeight.w400, Color? color, bool display = false}) => TextStyle(
        fontFamily: display ? displayFamily : sansFamily,
        fontSize: size,
        height: line / size,
        fontWeight: weight,
        color: color,
        leadingDistribution: TextLeadingDistribution.even,
      );

  /// text-[11px] (line height 16.5 from leading-normal of the body is not inherited by Tailwind arbitrary sizes)
  static TextStyle px(double size, {double? line, FontWeight weight = FontWeight.w400, Color? color, bool display = false}) =>
      _s(size, line ?? size * 1.625, weight: weight, color: color, display: display);

  static TextStyle xs({FontWeight weight = FontWeight.w400, Color? color}) => _s(12, 16, weight: weight, color: color);
  static TextStyle sm({FontWeight weight = FontWeight.w400, Color? color}) => _s(14, 20, weight: weight, color: color);

  /// The body text: 15 px, leading-relaxed.
  static TextStyle body({FontWeight weight = FontWeight.w400, Color? color}) => _s(15, 15 * 1.625, weight: weight, color: color);
  static TextStyle base({FontWeight weight = FontWeight.w400, Color? color}) => _s(16, 24, weight: weight, color: color);
  static TextStyle lg({FontWeight weight = FontWeight.w400, Color? color, bool display = false}) =>
      _s(18, 28, weight: weight, color: color, display: display);
  static TextStyle xl({FontWeight weight = FontWeight.w600, Color? color, bool display = true}) =>
      _s(20, 28, weight: weight, color: color, display: display);
  static TextStyle x2l({FontWeight weight = FontWeight.w600, Color? color, bool display = true}) =>
      _s(24, 32, weight: weight, color: color, display: display);
  static TextStyle x3l({FontWeight weight = FontWeight.w700, Color? color, bool display = true}) =>
      _s(30, 36, weight: weight, color: color, display: display);

  /// h1/h2/h3 use the display font with leading-tight (1.25).
  static TextStyle heading(double size, {FontWeight weight = FontWeight.w600, Color? color}) =>
      _s(size, size * 1.25, weight: weight, color: color, display: true);

  /// font-display on a non-heading element (prices): line height from the size class.
  static TextStyle display(double size, double line, {FontWeight weight = FontWeight.w700, Color? color}) =>
      _s(size, line, weight: weight, color: color, display: true);

  static const medium = FontWeight.w500;
  static const semibold = FontWeight.w600;
  static const bold = FontWeight.w700;
}

ThemeData buildTheme(PcTokens t) {
  final scheme = ColorScheme.light(
    primary: t.primary,
    onPrimary: Colors.white,
    secondary: t.accent,
    onSecondary: t.ink,
    error: t.buy,
    surface: Colors.white,
    onSurface: t.ink,
    outline: t.line,
  );
  final body = Tw.body(color: t.ink);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: t.page,
    canvasColor: t.page,
    fontFamily: sansFamily,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    hoverColor: t.page,
    dividerColor: t.line,
    textTheme: TextTheme(
      bodyMedium: body,
      bodyLarge: Tw.base(color: t.ink),
      bodySmall: Tw.sm(color: t.ink),
      titleLarge: Tw.heading(24, color: t.ink),
      titleMedium: Tw.heading(20, color: t.ink),
      labelLarge: Tw.body(weight: Tw.semibold, color: t.ink),
    ),
    textSelectionTheme: TextSelectionThemeData(cursorColor: t.ink, selectionColor: t.primary.withValues(alpha: 0.25)),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: t.primary),
    extensions: [PcThemeExt(t)],
  );
}

/// Card shadows per theme (`--shadow-card`, `--shadow-panel`).
List<BoxShadow> cardShadow(PcTokens t) => switch (t.shadow) {
      'soft' => const [
          BoxShadow(color: Color(0x0D101828), blurRadius: 2, offset: Offset(0, 1)),
          BoxShadow(color: Color(0x12101828), blurRadius: 3, offset: Offset(0, 1)),
        ],
      'lifted' => const [
          BoxShadow(color: Color(0x12101828), blurRadius: 3, offset: Offset(0, 1)),
          BoxShadow(color: Color(0x1A101828), blurRadius: 12, spreadRadius: -4, offset: Offset(0, 4)),
        ],
      _ => [BoxShadow(color: t.line, spreadRadius: 1)],
    };

List<BoxShadow> panelShadow(PcTokens t) => switch (t.shadow) {
      'soft' => const [BoxShadow(color: Color(0x0A101828), blurRadius: 2, offset: Offset(0, 1))],
      'lifted' => const [BoxShadow(color: Color(0x0F101828), blurRadius: 3, offset: Offset(0, 1))],
      _ => const [],
    };

/// Tailwind's shadow-sm / shadow-md / shadow-lg / shadow-xl.
const shadowSm = [BoxShadow(color: Color(0x0D000000), blurRadius: 2, offset: Offset(0, 1))];
const shadowMd = [
  BoxShadow(color: Color(0x1A000000), blurRadius: 6, spreadRadius: -1, offset: Offset(0, 4)),
  BoxShadow(color: Color(0x1A000000), blurRadius: 4, spreadRadius: -2, offset: Offset(0, 2)),
];
const shadowLg = [
  BoxShadow(color: Color(0x1A000000), blurRadius: 15, spreadRadius: -3, offset: Offset(0, 10)),
  BoxShadow(color: Color(0x1A000000), blurRadius: 6, spreadRadius: -4, offset: Offset(0, 4)),
];
const shadowXl = [
  BoxShadow(color: Color(0x1A000000), blurRadius: 25, spreadRadius: -5, offset: Offset(0, 20)),
  BoxShadow(color: Color(0x1A000000), blurRadius: 10, spreadRadius: -6, offset: Offset(0, 8)),
];
