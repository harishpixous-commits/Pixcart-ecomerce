// Display pieces of components/ui.tsx and components/product-parts.tsx: Pill, StatusPill, Rating, TileRating, Price,
// ProductImage, EmptyState, ErrorNote, ShopPanel, Badge, Divider helpers.

import 'package:lucide_icons/lucide_icons.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';

import 'theme.dart';

enum PillTone { green, amber, red, blue, gray }

class Pill extends StatelessWidget {
  const Pill(this.label, {super.key, this.tone = PillTone.gray});
  final String label;
  final PillTone tone;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final (bg, fg) = switch (tone) {
      PillTone.green => (t.successLight, t.success),
      PillTone.amber => (t.accentLight, const Color(0xFF8A5A00)),
      PillTone.red => (t.buyLight, t.buy),
      PillTone.blue => (t.primaryLight, t.primary),
      PillTone.gray => (t.page, t.inkSoft),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: Tw.xs(weight: Tw.semibold, color: fg)),
    );
  }
}

const _statusTone = <String, PillTone>{
  'approved': PillTone.green, 'delivered': PillTone.green, 'paid': PillTone.green, 'processed': PillTone.green, 'active': PillTone.green,
  'pending': PillTone.amber, 'submitted': PillTone.amber, 'placed': PillTone.amber, 'confirmed': PillTone.blue, 'packed': PillTone.blue,
  'shipped': PillTone.blue, 'pending_payment': PillTone.amber, 'cod': PillTone.blue,
  'rejected': PillTone.red, 'cancelled': PillTone.red, 'suspended': PillTone.red, 'failed': PillTone.red, 'refunded': PillTone.gray,
  'partially_refunded': PillTone.gray, 'draft': PillTone.gray, 'archived': PillTone.gray,
};

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.status, this.label});
  final String status;
  final String? label;

  @override
  Widget build(BuildContext context) => Pill(label ?? humanize(status), tone: _statusTone[status] ?? PillTone.gray);
}

/// "4.3 ★ (1,204)" with a green chip (ui.tsx Rating).
class Rating extends StatelessWidget {
  const Rating({super.key, required this.value, this.count, this.size = 'sm'});
  final double value;
  final int? count;
  final String size;

  @override
  Widget build(BuildContext context) {
    if (count == null || count == 0) return const SizedBox.shrink();
    final t = context.pc;
    final sm = size == 'sm';
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        padding: EdgeInsets.symmetric(horizontal: sm ? 6 : 8),
        decoration: BoxDecoration(color: t.success, borderRadius: BorderRadius.circular(4)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(value.toStringAsFixed(1),
              style: sm ? Tw.px(12, line: 20, weight: Tw.semibold, color: Colors.white) : Tw.px(14, line: 24, weight: Tw.semibold, color: Colors.white)),
          const SizedBox(width: 2),
          const Icon(Icons.star_rounded, size: 13, color: Colors.white),
        ]),
      ),
      const SizedBox(width: 6),
      Text('(${fmtCount(count!)})', style: Tw.xs(color: t.inkFaint)),
    ]);
  }
}

String fmtCount(int n) => count(n);

/// The tile rating chip: "4.3 ★" then "(1,204)".
class TileRating extends StatelessWidget {
  const TileRating({super.key, required this.avg, required this.count});
  final double avg;
  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    final t = context.pc;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: t.success, borderRadius: BorderRadius.circular(4)),
        child: Text('${avg.toStringAsFixed(1)} ★', style: Tw.px(12, line: 20, weight: Tw.semibold, color: Colors.white)),
      ),
      const SizedBox(width: 6),
      Text('(${fmtCount(count)})', style: Tw.xs(color: t.inkFaint)),
    ]);
  }
}

/// Price with M.R.P. struck through and the discount (ui.tsx Price).
class Price extends StatelessWidget {
  const Price({super.key, required this.price, this.mrp, this.discount, this.size = 'md'});
  final int price;
  final int? mrp;
  final int? discount;

  /// sm | md | lg
  final String size;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final m = mrp;
    final off = discount ?? (m != null && m > price ? ((m - price) * 100) ~/ m : 0);
    final main = switch (size) {
      'sm' => Tw.display(16, 24, color: t.ink),
      'lg' => Tw.display(30, 36, color: t.ink),
      _ => Tw.display(18, 28, color: t.ink),
    };
    final small = size == 'lg' ? Tw.base : Tw.sm;
    return Wrap(crossAxisAlignment: WrapCrossAlignment.end, spacing: 8, children: [
      Text(rupees(price), style: main),
      if (m != null && m > price)
        Text(rupees(m), style: small(color: t.inkFaint).copyWith(decoration: TextDecoration.lineThrough, decorationColor: t.inkFaint)),
      if (off > 0) Text('$off% off', style: small(weight: Tw.semibold, color: t.success)),
    ]);
  }
}

/// A product photo (object-contain) or the "No image" placeholder.
class ProductImage extends StatelessWidget {
  const ProductImage({super.key, required this.src, this.fit = BoxFit.contain, this.width, this.height, this.alt = '', this.placeholderText = 'No image'});
  final String src;
  final BoxFit fit;
  final double? width;
  final double? height;
  final String alt;
  final String? placeholderText;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    Widget placeholder() => Container(
          width: width,
          height: height,
          color: t.page,
          alignment: Alignment.center,
          child: placeholderText == null ? null : Text(placeholderText!, style: Tw.sm(color: t.inkFaint)),
        );
    if (src.isEmpty) return placeholder();
    return Semantics(
      image: true,
      label: alt,
      child: Image.network(
        mediaUrl(src),
        width: width,
        height: height,
        fit: fit,
        filterQuality: FilterQuality.medium,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => placeholder(),
        frameBuilder: (_, child, frame, sync) =>
            sync || frame != null ? child : SizedBox(width: width, height: height),
      ),
    );
  }
}

/// A rounded box with a dashed line border, title, body and an action (ui.tsx EmptyState).
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.body, this.action});
  final String title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return CustomPaint(
      painter: DashedBorderPainter(color: t.line, radius: t.radiusXl),
      child: Container(
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
        width: double.infinity,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(title, textAlign: TextAlign.center, style: Tw.display(20, 28, weight: Tw.semibold, color: t.ink)),
          if (body != null) ...[
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 448),
              child: Text(body!, textAlign: TextAlign.center, style: Tw.body(color: t.inkSoft)),
            ),
          ],
          if (action != null) ...[const SizedBox(height: 20), action!],
        ]),
      ),
    );
  }
}

class DashedBorderPainter extends CustomPainter {
  DashedBorderPainter({required this.color, required this.radius});
  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final path = Path()..addRRect(RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)).deflate(0.5));
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, d + 3), paint);
        d += 6;
      }
    }
  }

  @override
  bool shouldRepaint(DashedBorderPainter old) => old.color != color || old.radius != radius;
}

/// A red note under a form (ui.tsx ErrorNote).
class ErrorNote extends StatelessWidget {
  const ErrorNote(this.message, {super.key});
  final String? message;

  @override
  Widget build(BuildContext context) {
    if (message == null || message!.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: t.buyLight, borderRadius: BorderRadius.circular(t.radiusLg)),
        child: Text(message!, style: Tw.sm(color: t.buy)),
      ),
    );
  }
}

/// `.shop-panel`: a white panel with the theme's xl radius (or straight on the page for "plain" sections).
class ShopPanel extends StatelessWidget {
  const ShopPanel({super.key, required this.child, this.padding = EdgeInsets.zero, this.plain});
  final Widget child;
  final EdgeInsets padding;
  final bool? plain;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final isPlain = plain ?? t.option('sections') == 'plain';
    if (isPlain) return Padding(padding: EdgeInsets.symmetric(vertical: padding.vertical / 2), child: child);
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl), boxShadow: panelShadow(t)),
      child: child,
    );
  }
}

/// A white card with the line border (rounded-xl bg-white ring-1 ring-line / shadow-card).
class PcCard extends StatelessWidget {
  const PcCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.radius, this.color});
  final Widget child;
  final EdgeInsets padding;
  final double? radius;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? Colors.white,
        borderRadius: BorderRadius.circular(radius ?? t.radiusXl),
        boxShadow: cardShadow(t),
      ),
      child: child,
    );
  }
}

/// The deal's "68% off" red chip.
class OffChip extends StatelessWidget {
  const OffChip(this.discount, {super.key, this.large = false});
  final int discount;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: large ? 8 : 6, vertical: large ? 2 : 0),
      decoration: BoxDecoration(color: t.buy, borderRadius: BorderRadius.circular(4)),
      child: Text('$discount% off',
          style: large ? Tw.sm(weight: Tw.semibold, color: Colors.white) : Tw.px(12, line: 20, weight: Tw.semibold, color: Colors.white)),
    );
  }
}

/// The ★ icon filled (Lucide Star with fill-current).
class StarIcon extends StatelessWidget {
  const StarIcon({super.key, this.size = 16, this.color, this.filled = true});
  final double size;
  final Color? color;
  final bool filled;

  @override
  Widget build(BuildContext context) => filled
      ? Icon(Icons.star_rounded, size: size * 1.15, color: color ?? context.pc.accent)
      : Icon(LucideIcons.star, size: size, color: color ?? context.pc.line);
}
