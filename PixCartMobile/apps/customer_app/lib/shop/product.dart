// Product tiles, grids and rails (components/product.tsx, components/product-parts.tsx, themes/classic/product-tile.tsx).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import 'links.dart';
import 'wishlist.dart';

/// "Ends in 02:13:44", ticking every second.
class DealCountdown extends StatefulWidget {
  const DealCountdown({super.key, required this.endsAt, this.prefix = 'Ends in', this.doneText = 'Deal ended', this.style});
  final String endsAt;
  final String prefix;
  final String doneText;
  final TextStyle? style;

  @override
  State<DealCountdown> createState() => _DealCountdownState();
}

class _DealCountdownState extends State<DealCountdown> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final end = DateTime.tryParse(widget.endsAt);
    final left = end == null ? Duration.zero : end.difference(DateTime.now());
    return Text(left > Duration.zero ? '${widget.prefix} ${timeLeft(left)}' : widget.doneText, style: widget.style);
  }
}

class DealBadge extends StatelessWidget {
  const DealBadge({super.key, required this.deal, required this.discount, this.large = false});
  final DealInfo deal;
  final int discount;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final text = large ? Tw.sm(weight: Tw.semibold, color: t.buy) : Tw.xs(weight: Tw.semibold, color: t.buy);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        if (discount > 0) OffChip(discount, large: large),
        Text(deal.label, style: text),
      ]),
      if (deal.kind != 'limited')
        Padding(
          padding: EdgeInsets.only(top: large ? 6 : 4),
          child: DealCountdown(endsAt: deal.endsAt, style: text.copyWith(fontWeight: Tw.medium)),
        ),
      if (deal.claimedPct != null)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(
                  value: (deal.claimedPct!.clamp(4, 100)) / 100,
                  minHeight: 6,
                  color: t.buy,
                  backgroundColor: t.buyLight,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text('${deal.claimedPct}% claimed', style: Tw.px(11, line: 16, color: t.inkFaint)),
          ]),
        ),
    ]);
  }
}

/// Adds one unit of a single-version product with the cart's notice as a toast.
Future<void> quickAdd(BuildContext context, WidgetRef ref, ProductCard p) async {
  try {
    final note = await ref.read(sessionProvider.notifier).addToCart(GuestLine(
          variantId: p.variantId!,
          qty: 1,
          title: p.title,
          image: p.image,
          price: p.price,
          mrp: p.mrp,
          slug: p.slug,
          sellerName: p.sellerName,
        ));
    if (context.mounted) toast(context, note ?? 'Added to your cart');
  } catch (e) {
    if (context.mounted) toast(context, ApiError.messageOf(e, 'Could not add to cart'), error: true);
  }
}

void openProduct(BuildContext context, ProductCard p) {
  if (p.sponsored && (p.href ?? '').isNotEmpty) {
    // ads go through the click counter, which redirects to the product page
    unawaited(openLink(context, p.href!));
    return;
  }
  unawaited(context.push('/p/${p.slug}'));
}

class TilePrice extends StatelessWidget {
  const TilePrice({super.key, required this.p});
  final ProductCard p;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.end, children: [
      Text(rupees(p.price), style: Tw.display(18, 28, color: t.ink)),
      if (p.unitPrice != null) Text('(${rupees(p.unitPrice!.paise)}/${p.unitPrice!.per})', style: Tw.xs(color: t.inkSoft)),
      if (p.mrp > p.price) Text(rupees(p.mrp), style: Tw.sm(color: t.inkFaint).copyWith(decoration: TextDecoration.lineThrough, decorationColor: t.inkFaint)),
      if (p.discountPct > 0 && p.deal == null) Text('${p.discountPct}% off', style: Tw.sm(weight: Tw.semibold, color: t.success)),
    ]);
  }
}

/// The Classic tile: white, photo on top, rating chip, deal badge, price, delivery date.
class ProductTile extends ConsumerStatefulWidget {
  const ProductTile({super.key, required this.p, this.showAdd = false, this.rank, this.quickPlus = false});
  final ProductCard p;
  final bool showAdd;
  final int? rank;
  final bool quickPlus;

  @override
  ConsumerState<ProductTile> createState() => _ProductTileState();
}

class _ProductTileState extends ConsumerState<ProductTile> {
  bool _busy = false;

  Future<void> _add() async {
    if (_busy) return;
    setState(() => _busy = true);
    await quickAdd(context, ref, widget.p);
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final p = widget.p;
    final canAdd = p.inStock && p.variantId != null;
    final needsOptions = p.inStock && p.variantId == null;
    final top = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Stack(children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(t.radiusLg),
              child: Stack(fit: StackFit.expand, children: [
                if (p.image.isEmpty) Container(color: t.page) else ProductImage(src: p.image, alt: p.title, placeholderText: null),
                if (!p.inStock)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: Container(
                      color: t.ink.withValues(alpha: 0.75),
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text('Out of stock', textAlign: TextAlign.center, style: Tw.xs(weight: Tw.semibold, color: Colors.white)),
                    ),
                  ),
              ]),
            ),
          ),
          if (widget.rank != null)
            Positioned(
              left: 0,
              top: 0,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.only(bottomRight: Radius.circular(t.radiusLg))),
                child: Text('#${widget.rank}', style: Tw.sm(weight: Tw.bold, color: t.ink)),
              ),
            ),
        ]),
      ),
      if (p.sponsored) Text('SPONSORED', style: Tw.px(11, line: 16, weight: Tw.medium, color: t.inkFaint).copyWith(letterSpacing: 0.3)),
      if (p.brand.isNotEmpty) Text(p.brand, style: Tw.xs(weight: Tw.semibold, color: t.inkFaint)),
      Text(p.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: Tw.px(15, line: 15 * 1.375, color: t.ink)),
      if (p.ratingCount > 0) Padding(padding: const EdgeInsets.only(top: 4), child: TileRating(avg: p.ratingAvg, count: p.ratingCount)),
      if (p.bought != null && p.bought!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text(p.bought!, style: Tw.xs(color: t.inkSoft))),
      if (p.deal != null) Padding(padding: const EdgeInsets.only(top: 6), child: DealBadge(deal: p.deal!, discount: p.discountPct)),
    ]);
    final bottom = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.only(top: 6), child: TilePrice(p: p)),
      if (p.deliveryBy != null)
        Text.rich(TextSpan(style: Tw.xs(color: t.inkSoft), children: [
          const TextSpan(text: 'Get it by '),
          TextSpan(text: date(p.deliveryBy), style: TextStyle(fontWeight: Tw.semibold, color: t.ink)),
        ])),
      if (p.startsAt != null) Text('Starts ${weekdayTime(p.startsAt)}', style: Tw.xs(weight: Tw.semibold, color: t.primary)),
    ]);
    Widget? addButton;
    if (widget.showAdd && (canAdd || needsOptions)) {
      addButton = Padding(
        padding: const EdgeInsets.only(top: 8),
        child: needsOptions
            ? GestureDetector(
                onTap: () => context.push('/p/${p.slug}'),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(999), border: Border.all(color: t.line)),
                  alignment: Alignment.center,
                  child: Text('See options', style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                ),
              )
            : GestureDetector(
                onTap: _busy ? null : _add,
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999)),
                  child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Icon(LucideIcons.shoppingCart, size: 16, color: t.ink),
                    const SizedBox(width: 6),
                    Text(_busy ? 'Adding…' : 'Add to cart', style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                  ]),
                ),
              ),
      );
    }
    return Container(
      color: Colors.white,
      child: Stack(children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => openProduct(context, p),
          child: Padding(
            padding: const EdgeInsets.all(12),
            // mt-auto on the price: in a stretched row the price sits at the bottom
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [top, Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [bottom, ?addButton])],
            ),
          ),
        ),
        Positioned(right: 8, top: 8, child: WishlistHeart(productId: p.id)),
        if (widget.quickPlus && canAdd)
          Positioned(
            right: 8,
            bottom: 8,
            child: GestureDetector(
              onTap: _busy ? null : _add,
              child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: t.accent, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 2), boxShadow: shadowMd),
                child: Icon(LucideIcons.plus, size: 20, color: t.ink),
              ),
            ),
          ),
      ]),
    );
  }
}

/// The height a Classic tile needs at [width] (rails need a fixed height).
double tileHeight(ProductCard p, double width, {bool showAdd = false}) {
  var h = 24 + (width - 24) + 8 + 42 + 34; // padding, photo, title, price
  if (p.ratingCount > 0) h += 24;
  if (p.brand.isNotEmpty) h += 16;
  if (p.sponsored) h += 16;
  if ((p.bought ?? '').isNotEmpty) h += 18;
  if (p.deal != null) h += 28 + (p.deal!.kind != 'limited' ? 20 : 0) + (p.deal!.claimedPct != null ? 16 : 0);
  if (p.deliveryBy != null) h += 16;
  if (p.startsAt != null) h += 16;
  if (showAdd) h += 40;
  return h;
}

/// A hairline product grid: two columns on phones, white cells separated by lines, in a rounded frame.
class ProductGrid extends StatelessWidget {
  const ProductGrid({super.key, required this.items, this.showAdd = false, this.ranked = false, this.columns = 2});
  final List<ProductCard> items;
  final bool showAdd;
  final bool ranked;
  final int columns;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return LayoutBuilder(builder: (_, c) {
      final w = c.maxWidth / columns;
      final rows = <Widget>[];
      for (var i = 0; i < items.length; i += columns) {
        final rowItems = items.sublist(i, (i + columns).clamp(0, items.length));
        rows.add(IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var j = 0; j < columns; j++)
              Container(
                width: w,
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border(
                    right: j < columns - 1 ? BorderSide(color: t.line) : BorderSide.none,
                    bottom: i + columns < items.length ? BorderSide(color: t.line) : BorderSide.none,
                  ),
                ),
                child: j < rowItems.length
                    ? ProductTile(p: rowItems[j], showAdd: showAdd, rank: ranked ? i + j + 1 : null)
                    : const SizedBox.shrink(),
              ),
          ]),
        ));
      }
      return Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(t.radiusXl),
          border: Border.all(color: t.line),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(children: rows),
      );
    });
  }
}

/// A horizontal row of tiles that swipes (hairline: 46% wide cells with a line between).
class ProductRail extends StatelessWidget {
  const ProductRail({super.key, required this.title, required this.items, this.href, this.linkText = 'See all', this.showAdd = false, this.ranked = false, this.note, this.extra});
  final String title;

  /// shown after the title (the deals rail's countdown chip)
  final Widget? extra;
  final List<ProductCard> items;
  final String? href;
  final String linkText;
  final bool showAdd;
  final bool ranked;
  final String? note;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    return ShopPanel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: Wrap(spacing: 12, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text(title, style: Tw.heading(20, color: t.ink)),
                if (note != null) Text(note!, style: Tw.xs(color: t.inkFaint)),
                ?extra,
              ]),
            ),
            if (href != null) PcLink(linkText, onTap: () => openLink(context, href!)),
          ]),
        ),
        LayoutBuilder(builder: (_, c) {
          final w = c.maxWidth * 0.46;
          return SizedBox(
            height: items.map((p) => tileHeight(p, w, showAdd: showAdd)).reduce((a, b) => a > b ? a : b),
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: items.length,
              itemBuilder: (_, i) => Container(
                width: w,
                decoration: BoxDecoration(border: i < items.length - 1 ? Border(right: BorderSide(color: t.line)) : null),
                child: ProductTile(p: items[i], showAdd: showAdd, rank: ranked ? i + 1 : null),
              ),
            ),
          );
        }),
      ]),
    );
  }
}
