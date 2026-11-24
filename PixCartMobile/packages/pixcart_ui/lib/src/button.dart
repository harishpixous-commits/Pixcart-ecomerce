// Button (components/ui.tsx): variants primary, cart, buy, secondary, ghost, danger, outlineLight; sizes sm, md, lg;
// while loading it keeps its size and shows a centred spinner over the hidden label. Pressing scales it to 0.97
// (`pc-press`).

import 'package:lucide_icons/lucide_icons.dart';
import 'package:material_ui/material_ui.dart';

import 'theme.dart';

enum ButtonVariant { primary, cart, buy, secondary, ghost, danger, outlineLight }

enum ButtonSize { sm, md, lg }

class PcButton extends StatefulWidget {
  const PcButton({
    super.key,
    required this.child,
    this.onPressed,
    this.variant = ButtonVariant.primary,
    this.size = ButtonSize.md,
    this.loading = false,
    this.expand = false,
    this.icon,
    this.radius,
    this.height,
    this.padding,
    this.textStyle,
  });

  /// A text label button.
  factory PcButton.text(
    String label, {
    Key? key,
    VoidCallback? onPressed,
    ButtonVariant variant = ButtonVariant.primary,
    ButtonSize size = ButtonSize.md,
    bool loading = false,
    bool expand = false,
    IconData? icon,
    double? radius,
    double? height,
    EdgeInsets? padding,
  }) =>
      PcButton(
        key: key,
        onPressed: onPressed,
        variant: variant,
        size: size,
        loading: loading,
        expand: expand,
        icon: icon,
        radius: radius,
        height: height,
        padding: padding,
        child: Text(label),
      );

  final Widget child;
  final VoidCallback? onPressed;
  final ButtonVariant variant;
  final ButtonSize size;
  final bool loading;

  /// w-full
  final bool expand;
  final IconData? icon;
  final double? radius;
  final double? height;
  final EdgeInsets? padding;
  final TextStyle? textStyle;

  @override
  State<PcButton> createState() => _PcButtonState();
}

class _PcButtonState extends State<PcButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final enabled = widget.onPressed != null && !widget.loading;
    final (Color bg, Color fg, Color? ring) = switch (widget.variant) {
      ButtonVariant.primary => (t.primary, Colors.white, null),
      ButtonVariant.cart => (t.accent, t.ink, null),
      ButtonVariant.buy => (t.buy, Colors.white, null),
      ButtonVariant.secondary => (Colors.white, t.primary, t.primary.withValues(alpha: 0.4)),
      ButtonVariant.ghost => (Colors.transparent, t.primary, null),
      ButtonVariant.danger => (Colors.white, t.buy, t.buy.withValues(alpha: 0.4)),
      ButtonVariant.outlineLight => (Colors.transparent, Colors.white, Colors.white.withValues(alpha: 0.6)),
    };
    final (double h, double px, double fs, double lh) = switch (widget.size) {
      ButtonSize.sm => (32.0, 12.0, 14.0, 20.0),
      ButtonSize.md => (40.0, 16.0, 15.0, 15 * 1.625),
      ButtonSize.lg => (48.0, 24.0, 16.0, 24.0),
    };
    final style = (widget.textStyle ?? TextStyle(fontFamily: sansFamily, fontSize: fs, height: lh / fs, fontWeight: FontWeight.w600))
        .copyWith(color: fg, leadingDistribution: TextLeadingDistribution.even);
    Widget label = DefaultTextStyle.merge(
      style: style,
      child: IconTheme.merge(
        data: IconThemeData(color: fg, size: 16),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (widget.icon != null) ...[Icon(widget.icon, size: 16, color: fg), const SizedBox(width: 8)],
            Flexible(child: widget.child),
          ],
        ),
      ),
    );
    if (widget.loading) {
      label = Stack(alignment: Alignment.center, children: [
        Opacity(opacity: 0, child: label),
        SizedBox(width: 16, height: 16, child: SpinningLoader(color: fg, size: 16)),
      ]);
    }
    final r = BorderRadius.circular(widget.radius ?? t.radiusLg);
    Widget box = Container(
      height: widget.height ?? h,
      padding: widget.padding ?? EdgeInsets.symmetric(horizontal: px),
      decoration: BoxDecoration(
        color: _down && enabled ? _hover(bg, t) : bg,
        borderRadius: r,
        border: ring == null ? null : Border.all(color: ring),
      ),
      alignment: Alignment.center,
      child: label,
    );
    if (widget.expand) box = SizedBox(width: double.infinity, child: box);
    return Semantics(
      button: true,
      enabled: enabled,
      child: Opacity(
        opacity: widget.onPressed == null || widget.loading ? (widget.loading ? 0.55 : 0.55) : 1,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapCancel: () => setState(() => _down = false),
          onTapUp: (_) => setState(() => _down = false),
          onTap: enabled ? widget.onPressed : null,
          child: AnimatedScale(scale: _down && enabled ? 0.97 : 1, duration: const Duration(milliseconds: 120), child: box),
        ),
      ),
    );
  }

  Color _hover(Color bg, dynamic t) {
    final tk = context.pc;
    if (bg == tk.primary) return tk.primaryDark;
    if (bg == tk.accent) return tk.accentDark;
    if (bg == tk.buy) return tk.buyDark;
    if (bg == Colors.transparent) return widget.variant == ButtonVariant.outlineLight ? Colors.white24 : tk.primaryLight;
    return widget.variant == ButtonVariant.danger ? tk.buyLight : tk.primaryLight;
  }
}

/// The Loader2 icon spinning (Tailwind animate-spin: one turn per second).
class SpinningLoader extends StatefulWidget {
  const SpinningLoader({super.key, this.color, this.size = 24});
  final Color? color;
  final double size;

  @override
  State<SpinningLoader> createState() => _SpinningLoaderState();
}

class _SpinningLoaderState extends State<SpinningLoader> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Loading',
        child: RotationTransition(
          turns: _c,
          child: Icon(LucideIcons.loader2, size: widget.size, color: widget.color ?? context.pc.primary),
        ),
      );
}

/// A text link styled like the website's peacock links ("See all", "Back").
class PcLink extends StatelessWidget {
  const PcLink(this.label, {super.key, required this.onTap, this.style, this.icon, this.iconAfter = false});
  final String label;
  final VoidCallback? onTap;
  final TextStyle? style;
  final IconData? icon;
  final bool iconAfter;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final s = style ?? Tw.sm(weight: Tw.semibold, color: t.primary);
    final ic = icon == null ? null : Icon(icon, size: (s.fontSize ?? 14) + 2, color: s.color);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (ic != null && !iconAfter) ...[ic, const SizedBox(width: 2)],
        Text(label, style: s),
        if (ic != null && iconAfter) ...[const SizedBox(width: 2), ic],
      ]),
    );
  }
}
