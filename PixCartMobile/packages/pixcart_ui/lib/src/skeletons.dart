// Loading placeholders (components/skeletons.tsx): a soft shimmer in the theme's line and page colours, invisible
// for the first 180 ms so quick loads never flash, then fading in. Shapes for the main screens.

import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'theme.dart';

const loaderDelay = Duration(milliseconds: 180);

/// Invisible for [delay], then fades in (`pc-delayed`).
class DelayedFallback extends StatefulWidget {
  const DelayedFallback({super.key, required this.child, this.delay = loaderDelay});
  final Widget child;
  final Duration delay;

  @override
  State<DelayedFallback> createState() => _DelayedFallbackState();
}

class _DelayedFallbackState extends State<DelayedFallback> {
  bool _show = false;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer(widget.delay, () => mounted ? setState(() => _show = true) : null);
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Loading',
        child: AnimatedOpacity(opacity: _show ? 1 : 0, duration: const Duration(milliseconds: 220), child: widget.child),
      );
}

/// One shimmering block (`.skeleton`).
class SkeletonBlock extends StatefulWidget {
  const SkeletonBlock({super.key, this.width, this.height = 14, this.radius, this.circle = false});
  final double? width;
  final double height;
  final double? radius;
  final bool circle;

  @override
  State<SkeletonBlock> createState() => _SkeletonBlockState();
}

class _SkeletonBlockState extends State<SkeletonBlock> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1300))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final a = t.line.withValues(alpha: 0.75);
    final b = t.page.withValues(alpha: 0.9);
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) {
        final x = reduce ? 0.0 : (1 - 2 * _c.value) * 2;
        return Container(
          width: widget.width,
          height: widget.height,
          decoration: BoxDecoration(
            shape: widget.circle ? BoxShape.circle : BoxShape.rectangle,
            borderRadius: widget.circle ? null : BorderRadius.circular(widget.radius ?? t.radiusLg),
            gradient: reduce
                ? null
                : LinearGradient(begin: Alignment(-1 + x, 0), end: Alignment(1 + x, 0), colors: [a, b, a], tileMode: TileMode.mirror),
            color: reduce ? a : null,
          ),
        );
      },
    );
  }
}

class SkeletonText extends StatelessWidget {
  const SkeletonText({super.key, this.lines = 3, this.lineHeight = 14, this.lastFraction = 0.66});
  final int lines;
  final double lineHeight;
  final double lastFraction;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (_, c) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < lines; i++)
            Padding(
              padding: EdgeInsets.only(top: i == 0 ? 0 : 8),
              child: SkeletonBlock(width: i == lines - 1 ? c.maxWidth * lastFraction : c.maxWidth, height: lineHeight, radius: 4),
            ),
        ]),
      );
}

/// A two-column product grid placeholder (phones).
class ProductGridSkeleton extends StatelessWidget {
  const ProductGridSkeleton({super.key, this.count = 6});
  final int count;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return DelayedFallback(
      child: LayoutBuilder(builder: (_, c) {
        final w = (c.maxWidth - 1) / 2;
        return Container(
          decoration: BoxDecoration(color: t.line, borderRadius: BorderRadius.circular(t.radiusXl)),
          clipBehavior: Clip.antiAlias,
          child: Wrap(spacing: 1, runSpacing: 1, children: [
            for (var i = 0; i < count; i++)
              Container(
                width: w,
                color: Colors.white,
                padding: const EdgeInsets.all(12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  AspectRatio(aspectRatio: 1, child: SkeletonBlock(height: double.infinity, radius: t.radiusLg)),
                  const SizedBox(height: 10),
                  const SkeletonText(lines: 2, lineHeight: 12),
                  const SizedBox(height: 10),
                  const SkeletonBlock(width: 64, height: 18),
                ]),
              ),
          ]),
        );
      }),
    );
  }
}

/// A list of rows (orders, notifications, addresses).
class ListSkeleton extends StatelessWidget {
  const ListSkeleton({super.key, this.rows = 4, this.title = true, this.rowHeight = 72});
  final int rows;
  final bool title;
  final double rowHeight;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return DelayedFallback(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (title) ...[const SkeletonBlock(width: 180, height: 28), const SizedBox(height: 16)],
        for (var i = 0; i < rows; i++)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl), boxShadow: cardShadow(t)),
            child: Row(children: [
              SkeletonBlock(width: rowHeight - 16, height: rowHeight - 16),
              const SizedBox(width: 12),
              const Expanded(child: SkeletonText(lines: 3, lineHeight: 12)),
            ]),
          ),
      ]),
    );
  }
}

/// A generic page: title, a panel of text, two panels.
class PageSkeleton extends StatelessWidget {
  const PageSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    Widget panel(double h) => Container(
          height: h,
          margin: const EdgeInsets.only(bottom: 16),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
          child: const SkeletonText(lines: 4),
        );
    return DelayedFallback(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SkeletonBlock(width: 200, height: 28),
        const SizedBox(height: 16),
        panel(160),
        panel(120),
      ]),
    );
  }
}

/// Detail pages (an order, a product).
class DetailSkeleton extends StatelessWidget {
  const DetailSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return DelayedFallback(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SkeletonBlock(width: 220, height: 28),
        const SizedBox(height: 8),
        const SkeletonBlock(width: 140, height: 14),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
          child: Column(children: [
            for (var i = 0; i < 3; i++)
              const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: Row(children: [
                  SkeletonBlock(width: 64, height: 64),
                  SizedBox(width: 12),
                  Expanded(child: SkeletonText(lines: 3, lineHeight: 12)),
                ]),
              ),
          ]),
        ),
      ]),
    );
  }
}

/// A narrow form (sign in, add address).
class FormSkeleton extends StatelessWidget {
  const FormSkeleton({super.key, this.fields = 4});
  final int fields;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return DelayedFallback(
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radius2xl)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const SkeletonBlock(width: 160, height: 28),
          const SizedBox(height: 20),
          for (var i = 0; i < fields; i++) ...[
            const SkeletonBlock(width: 90, height: 12),
            const SizedBox(height: 6),
            const SkeletonBlock(height: 40),
            const SizedBox(height: 16),
          ],
          const SkeletonBlock(height: 44),
        ]),
      ),
    );
  }
}
