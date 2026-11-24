// The storefront theme's design tokens, worked out exactly like the website's CSS variables
// (`lib/theme.ts` colorVars/radiusVars, `themes/css.ts` themeVars, `themes/manifest.ts` resolveTheme).
// Brand colours come from GET /api/site at runtime, so a colour change in the admin panel needs no app release.

import 'dart:ui';

import '../models/json.dart';

typedef Rgb = (int, int, int);

Rgb parseHex(String? hex, [Rgb fallback = (11, 85, 99)]) {
  final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch((hex ?? '').trim());
  if (m == null) return fallback;
  final n = int.parse(m.group(1)!, radix: 16);
  return ((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/// `mix` from lib/theme.ts: moves each channel towards [target] by [t] and rounds like Math.round.
Rgb mix(Rgb c, int target, double t) {
  int m(int x) => (x + (target - x) * t + 0.5).floor();
  return (m(c.$1), m(c.$2), m(c.$3));
}

Color rgbColor(Rgb c, [double opacity = 1]) => Color.fromRGBO(c.$1, c.$2, c.$3, opacity);

/// The six colours admins pick.
class ThemeColors {
  const ThemeColors({
    required this.primary,
    required this.primaryDark,
    required this.accent,
    required this.buy,
    required this.success,
    required this.page,
  });

  factory ThemeColors.fromJson(Json j, [ThemeColors fallback = ThemeColors.defaults]) => ThemeColors(
        primary: _hexOr(j['primary'], fallback.primary),
        primaryDark: _hexOr(j['primary_dark'], fallback.primaryDark),
        accent: _hexOr(j['accent'], fallback.accent),
        buy: _hexOr(j['buy'], fallback.buy),
        success: _hexOr(j['success'], fallback.success),
        page: _hexOr(j['page'], fallback.page),
      );

  static const defaults = ThemeColors(
      primary: '#0B5563', primaryDark: '#073B45', accent: '#F5A524', buy: '#D7263D', success: '#1E8E3E', page: '#EEF2F4');

  final String primary;
  final String primaryDark;
  final String accent;
  final String buy;
  final String success;
  final String page;

  ThemeColors merge(Json? own) => own == null ? this : ThemeColors.fromJson(own, this);
}

String _hexOr(Object? v, String fallback) =>
    v is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(v) ? v.toUpperCase() : fallback;

class InkColors {
  const InkColors({required this.ink, required this.inkSoft, required this.inkFaint, required this.line});
  final String ink;
  final String inkSoft;
  final String inkFaint;
  final String line;
}

class ColorPreset {
  const ColorPreset(this.id, this.name, this.colors, [this.ink]);
  final String id;
  final String name;
  final ThemeColors colors;
  final InkColors? ink;
}

/// A storefront theme's data (`src/themes/<id>/theme.ts`). The app draws the Classic slots for every theme; the
/// tokens (colours, radius, shadows, header tone) follow the active theme.
class ThemeDef {
  const ThemeDef({
    required this.id,
    required this.name,
    required this.chrome,
    required this.ink,
    required this.displayFont,
    required this.sansFont,
    required this.headingTracking,
    required this.radius,
    required this.shadow,
    required this.layout,
    required this.presets,
  });
  final String id;
  final String name;

  /// "brand": the header is on the brand colour; "light": a white header.
  final String chrome;
  final InkColors ink;

  /// The website's font families (the app bundles Baloo 2 and Mukta; see docs/FLUTTER_GUIDELINES.md).
  final String displayFont;
  final String sansFont;

  /// letter-spacing in em
  final double headingTracking;

  /// square | rounded | soft
  final String radius;

  /// none | soft | lifted
  final String shadow;
  final Map<String, String> layout;
  final List<ColorPreset> presets;
}

ThemeColors _c(String p, String pd, String a, String b, String s, String pg) =>
    ThemeColors(primary: p, primaryDark: pd, accent: a, buy: b, success: s, page: pg);

final Map<String, ThemeDef> themes = {
  'classic': ThemeDef(
    id: 'classic',
    name: 'Classic',
    chrome: 'brand',
    ink: const InkColors(ink: '#1B2430', inkSoft: '#4A5565', inkFaint: '#7A8594', line: '#DCE3E8'),
    displayFont: 'Baloo 2',
    sansFont: 'Mukta',
    headingTracking: 0,
    radius: 'rounded',
    shadow: 'none',
    layout: const {'productGrid': 'hairline', 'categories': 'circles', 'sections': 'panel', 'filters': 'sidebar', 'pdp': 'three', 'cart': 'side', 'auth': 'card'},
    presets: [
      ColorPreset('peacock', 'Peacock', _c('#0B5563', '#073B45', '#F5A524', '#D7263D', '#1A7F37', '#EEF2F4')),
      ColorPreset('midnight', 'Midnight', _c('#1E2A44', '#131C30', '#F2B33D', '#C8323C', '#1F7A4D', '#EEF0F4')),
      ColorPreset('mulberry', 'Mulberry', _c('#6B1F4E', '#4B1537', '#F6B93B', '#C0392B', '#2E7D4F', '#F4EFF2')),
      ColorPreset('forest', 'Forest', _c('#1F5130', '#143820', '#E9B949', '#B83227', '#2E7D32', '#EEF2EE')),
      ColorPreset('ocean', 'Ocean', _c('#0D4E8B', '#093762', '#FFB547', '#C62F2F', '#1D7A46', '#EDF2F7')),
    ],
  ),
  'bazaar': ThemeDef(
    id: 'bazaar',
    name: 'Bazaar',
    chrome: 'brand',
    ink: const InkColors(ink: '#151B2E', inkSoft: '#4A5270', inkFaint: '#7C84A0', line: '#E1E5EE'),
    displayFont: 'Poppins',
    sansFont: 'Inter',
    headingTracking: -0.01,
    radius: 'rounded',
    shadow: 'lifted',
    layout: const {'productGrid': 'cards', 'categories': 'cards', 'sections': 'panel', 'filters': 'sidebar', 'pdp': 'two', 'cart': 'side', 'auth': 'split'},
    presets: [
      ColorPreset('indigo', 'Indigo sun', _c('#2B3A8C', '#1C2766', '#FFC93C', '#D03E21', '#13855C', '#F1F3F8')),
      ColorPreset('crimson', 'Crimson', _c('#9B1B30', '#6E1322', '#FFD166', '#C2410C', '#1E7F4F', '#F7F1F2')),
      ColorPreset('teal', 'Teal and coral', _c('#0F5E68', '#0A4249', '#FFB703', '#D62839', '#2A7F4F', '#EEF4F5')),
      ColorPreset('royal', 'Royal purple', _c('#4A2C8F', '#331E66', '#FFC857', '#D7263D', '#1E7F4F', '#F3F1F8')),
      ColorPreset('graphite', 'Graphite', _c('#23262F', '#15171C', '#FFB020', '#D6336C', '#127A4B', '#F2F3F5')),
    ],
  ),
  'fresh': ThemeDef(
    id: 'fresh',
    name: 'Fresh',
    chrome: 'light',
    ink: const InkColors(ink: '#1C2321', inkSoft: '#4B5652', inkFaint: '#7A8480', line: '#E3E8E4'),
    displayFont: 'Plus Jakarta Sans',
    sansFont: 'Plus Jakarta Sans',
    headingTracking: -0.015,
    radius: 'soft',
    shadow: 'soft',
    layout: const {'productGrid': 'cards', 'categories': 'squares', 'sections': 'plain', 'filters': 'topbar', 'pdp': 'two', 'cart': 'sticky', 'auth': 'card'},
    presets: [
      ColorPreset('leaf', 'Leaf', _c('#0C831F', '#08621A', '#FCD34D', '#D6336C', '#0C831F', '#F4F6F3')),
      ColorPreset('berry', 'Berry', _c('#B3135A', '#8A0E45', '#FFD23F', '#0B7A75', '#15803D', '#FBF3F6')),
      ColorPreset('citrus', 'Citrus', _c('#C2410C', '#9A3412', '#FDE047', '#1D4ED8', '#15803D', '#FFF7ED')),
      ColorPreset('ocean', 'Ocean', _c('#0369A1', '#075985', '#FCD34D', '#BE185D', '#15803D', '#F0F7FB')),
      ColorPreset('mint', 'Mint', _c('#047857', '#065F46', '#FDE68A', '#C2410C', '#047857', '#F0FAF6')),
    ],
  ),
  'luxe': ThemeDef(
    id: 'luxe',
    name: 'Luxe',
    chrome: 'light',
    ink: const InkColors(ink: '#171717', inkSoft: '#4D4A45', inkFaint: '#7F7A71', line: '#E7E1D6'),
    displayFont: 'Playfair Display',
    sansFont: 'Inter',
    headingTracking: 0.005,
    radius: 'square',
    shadow: 'none',
    layout: const {'productGrid': 'airy', 'categories': 'chips', 'sections': 'plain', 'filters': 'topbar', 'pdp': 'gallery', 'cart': 'side', 'auth': 'split'},
    presets: [
      ColorPreset('noir', 'Noir and gold', _c('#111111', '#000000', '#B8955A', '#8C2F39', '#2F6B4F', '#F7F4EE')),
      ColorPreset('rose', 'Ivory rose', _c('#3D2B2E', '#24191B', '#C9A27E', '#9E3B4E', '#3E6B54', '#FBF6F3')),
      ColorPreset('emerald', 'Emerald', _c('#0F3D33', '#082820', '#C5A46D', '#8E2C48', '#2F6B4F', '#F5F3EE')),
      ColorPreset('slate', 'Slate', _c('#1F2937', '#111827', '#A8A29E', '#7C2D3A', '#2F6B4F', '#F4F4F2')),
      ColorPreset('sand', 'Sand', _c('#3F3A33', '#27231E', '#D4B483', '#8B3A2F', '#3A6B50', '#F6F1E8')),
    ],
  ),
};

/// Every colour the shop screens use, with the light and dark steps (the `--c-*` CSS variables).
class PcTokens {
  PcTokens._({
    required this.themeId,
    required this.chrome,
    required this.primary,
    required this.primaryDark,
    required this.primaryLight,
    required this.accent,
    required this.accentDark,
    required this.accentLight,
    required this.buy,
    required this.buyDark,
    required this.buyLight,
    required this.success,
    required this.successLight,
    required this.page,
    required this.ink,
    required this.inkSoft,
    required this.inkFaint,
    required this.line,
    required this.radiusLg,
    required this.radiusXl,
    required this.radius2xl,
    required this.shadow,
    required this.displayFont,
    required this.sansFont,
    required this.headingTracking,
    required this.layout,
  });

  /// colorVars + radiusVars + themeVars from the website.
  factory PcTokens.from({required ThemeColors colors, required ThemeDef theme, required InkColors ink, String? radius}) {
    final p = parseHex(colors.primary);
    final a = parseHex(colors.accent, (245, 165, 36));
    final b = parseHex(colors.buy, (215, 38, 61));
    final s = parseHex(colors.success, (30, 142, 62));
    final r = radius ?? theme.radius;
    final radii = r == 'square' ? [2.0, 4.0, 6.0] : r == 'soft' ? [12.0, 18.0, 24.0] : [8.0, 12.0, 16.0];
    return PcTokens._(
      themeId: theme.id,
      chrome: theme.chrome,
      primary: rgbColor(p),
      primaryDark: rgbColor(parseHex(colors.primaryDark, (7, 59, 69))),
      primaryLight: rgbColor(mix(p, 255, 0.88)),
      accent: rgbColor(a),
      accentDark: rgbColor(mix(a, 0, 0.12)),
      accentLight: rgbColor(mix(a, 255, 0.85)),
      buy: rgbColor(b),
      buyDark: rgbColor(mix(b, 0, 0.18)),
      buyLight: rgbColor(mix(b, 255, 0.9)),
      success: rgbColor(s),
      successLight: rgbColor(mix(s, 255, 0.88)),
      page: rgbColor(parseHex(colors.page, (238, 242, 244))),
      ink: rgbColor(parseHex(ink.ink, (27, 36, 48))),
      inkSoft: rgbColor(parseHex(ink.inkSoft, (74, 85, 101))),
      inkFaint: rgbColor(parseHex(ink.inkFaint, (122, 133, 148))),
      line: rgbColor(parseHex(ink.line, (220, 227, 232))),
      radiusLg: radii[0],
      radiusXl: radii[1],
      radius2xl: radii[2],
      shadow: theme.shadow,
      displayFont: theme.displayFont,
      sansFont: theme.sansFont,
      headingTracking: theme.headingTracking,
      layout: theme.layout,
    );
  }

  static final PcTokens fallback = PcTokens.from(
      colors: ThemeColors.defaults, theme: themes['classic']!, ink: themes['classic']!.ink);

  final String themeId;
  final String chrome;
  final Color primary, primaryDark, primaryLight;
  final Color accent, accentDark, accentLight;
  final Color buy, buyDark, buyLight;
  final Color success, successLight;
  final Color page;
  final Color ink, inkSoft, inkFaint, line;

  /// rounded-lg, rounded-xl, rounded-2xl in logical pixels
  final double radiusLg, radiusXl, radius2xl;
  final String shadow;
  final String displayFont;
  final String sansFont;
  final double headingTracking;
  final Map<String, String> layout;

  /// The header on the brand colour (white text) or white (ink text).
  bool get brandChrome => chrome == 'brand';

  /// The theme's layout option (`productGrid`, `categories`, `sections`, `filters`, `pdp`, `cart`, `auth`).
  String option(String key) => layout[key] ?? themes['classic']!.layout[key]!;
}

const brandPreset = 'brand';

/// resolveTheme (themes/manifest.ts) for the live theme: its preset, the owner's colour and layout changes.
PcTokens resolveTokens(Json site) {
  final id = themes.containsKey(site['theme']) ? site['theme'] as String : 'classic';
  final base = themes[id]!;
  final saved = site.obj('theme_settings').obj(id);
  var presetId = saved.str('preset', id == 'classic' ? brandPreset : base.presets.first.id);
  if (presetId != brandPreset && !base.presets.any((p) => p.id == presetId)) {
    presetId = id == 'classic' ? brandPreset : base.presets.first.id;
  }
  final brand = ThemeColors.fromJson(site.obj('colors'));
  final preset = base.presets.where((p) => p.id == presetId).firstOrNull;
  final colors = (presetId == brandPreset ? brand : (preset ?? base.presets.first).colors).merge(saved.objOrNull('colors'));
  final ink = preset?.ink ?? base.ink;
  final layoutOwn = saved.obj('layout');
  final layout = {...base.layout};
  for (final k in ['productGrid', 'categories', 'sections', 'filters', 'pdp', 'cart', 'auth']) {
    final v = layoutOwn[k];
    if (v is String) layout[k] = v;
  }
  final def = ThemeDef(
    id: base.id,
    name: base.name,
    chrome: base.chrome,
    ink: base.ink,
    displayFont: base.displayFont,
    sansFont: base.sansFont,
    headingTracking: base.headingTracking,
    radius: base.radius,
    shadow: base.shadow,
    layout: layout,
    presets: base.presets,
  );
  // Classic keeps the corner style chosen in Admin → Storefront → Brand.
  final radius = id == 'classic' ? site.str('radius', 'rounded') : null;
  return PcTokens.from(colors: colors, theme: def, ink: ink, radius: radius);
}
