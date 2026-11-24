// Product page building blocks (components/pdp.tsx and the server sections of app/(shop)/p/[slug]/page.tsx):
// stars, unit price, offers, service icons, key specs, "About this item", seller snapshot, info tables,
// "Frequently bought together", browsing history, sponsored rail, "Notify me" and "Report an issue".

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/links.dart';
import '../shop/product.dart';
import '../shop/wishlist.dart';

/// Lucide's star (lucide-react 0.447), filled or outlined like `<Star className="fill-marigold text-marigold" />`.
const _starPath =
    'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z';

String _hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

class LucideStar extends StatelessWidget {
  const LucideStar({super.key, required this.size, required this.color, this.filled = true});
  final double size;
  final Color color;
  final bool filled;

  @override
  Widget build(BuildContext context) => SvgPicture.string(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${filled ? _hex(color) : 'none'}" stroke="${_hex(color)}" '
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="$_starPath"/></svg>',
        width: size,
        height: size,
      );
}

/// Five stars: filled marigold up to the rounded rating, outlined in the line colour after it.
class Stars extends StatelessWidget {
  const Stars({super.key, required this.value, this.size = 16});
  final double value;
  final double size;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Semantics(
      label: '$value out of 5 stars',
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var n = 1; n <= 5; n++)
          n <= value.round() ? LucideStar(size: size, color: t.accent) : LucideStar(size: size, color: t.line, filled: false),
      ]),
    );
  }
}

/// "(₹1,497 / 100 ml)"
class UnitPriceText extends StatelessWidget {
  const UnitPriceText(this.up, {super.key, this.style});
  final UnitPrice? up;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    if (up == null) return const SizedBox.shrink();
    return Text('(${rupees(up!.paise)} / ${up!.per})', style: style ?? Tw.sm(color: context.pc.inkSoft));
  }
}

/// A white section on the page (rounded-xl bg-white p-4) with a heading.
class PdpSection extends StatelessWidget {
  const PdpSection({super.key, this.title, required this.child, this.titleSize = 20, this.titleGap = 12});
  final String? title;
  final Widget child;
  final double titleSize;
  final double titleGap;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (title != null) ...[Text(title!, style: Tw.heading(titleSize, color: t.ink)), SizedBox(height: titleGap)],
        child,
      ]),
    );
  }
}

/* ---------------------------------------------------------------- offers */

class OffersBlock extends StatefulWidget {
  const OffersBlock({super.key, required this.offers});
  final List<Json> offers;

  @override
  State<OffersBlock> createState() => _OffersBlockState();
}

class _OffersBlockState extends State<OffersBlock> {
  String _copied = '';

  Future<void> _copy(String code) async {
    try {
      await Clipboard.setData(ClipboardData(text: code));
    } catch (_) {
      /* the code is on screen anyway */
    }
    if (!mounted) return;
    setState(() => _copied = code);
    toast(context, 'Code $code copied. Apply it at checkout.');
    Timer(const Duration(milliseconds: 2500), () {
      if (mounted) setState(() => _copied = '');
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final n = widget.offers.length;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Icon(LucideIcons.tag, size: 16, color: t.buy),
        const SizedBox(width: 6),
        Text('Save extra with $n ${n == 1 ? 'offer' : 'offers'}', style: Tw.base(weight: Tw.semibold, color: t.ink)),
      ]),
      const SizedBox(height: 8),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        clipBehavior: Clip.none,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final o in widget.offers)
              Container(
                width: 210,
                margin: const EdgeInsets.only(right: 8, bottom: 4),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(t.radiusLg),
                  border: Border.all(color: t.line),
                  boxShadow: shadowSm,
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(o.str('source') == 'seller' ? 'SELLER OFFER' : 'STORE OFFER',
                      style: Tw.xs(weight: Tw.semibold, color: t.inkFaint).copyWith(letterSpacing: 0.3)),
                  Text(o.str('title'), style: Tw.px(15, line: 15 * 1.375, weight: Tw.semibold, color: t.ink)),
                  ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 13 * 2.5),
                    child: Text(
                      o.str('description').isNotEmpty ? o.str('description') : (o.str('terms').isNotEmpty ? o.str('terms') : 'On this product'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Tw.px(13, line: 13 * 1.625, color: t.inkSoft),
                    ),
                  ),
                  if (o.strOrNull('ends_at') != null) Text('Ends ${date(o.str('ends_at'))}', style: Tw.xs(color: t.buy)),
                  const Spacer(),
                  const SizedBox(height: 8),
                  Semantics(
                    button: true,
                    label: 'Copy code ${o.str('code')}',
                    child: GestureDetector(
                      onTap: () => _copy(o.str('code')),
                      child: CustomPaint(
                        painter: DashedBorderPainter(color: t.primary, radius: 6),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(color: t.primaryLight, borderRadius: BorderRadius.circular(6)),
                          child: Row(children: [
                            Expanded(
                              child: Text(o.str('code'),
                                  style: TextStyle(
                                    fontFamily: 'monospace',
                                    fontFamilyFallback: const ['Courier New', 'Courier'],
                                    fontSize: 14,
                                    height: 20 / 14,
                                    fontWeight: FontWeight.w600,
                                    color: t.primary,
                                  )),
                            ),
                            Icon(_copied == o.str('code') ? LucideIcons.check : LucideIcons.copy, size: 16, color: t.primary),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ]),
              ),
          ]),
        ),
      ),
    ]);
  }
}

/* ---------------------------------------------------------------- service icons */

class ServiceIcons extends ConsumerWidget {
  const ServiceIcons({super.key, required this.p, required this.price});
  final ProductPage p;
  final int price;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final free = price >= site.freeShippingThresholdPaise;
    final ship = site.shippingFeePaise == 0 ? 4000 : site.shippingFeePaise;
    final items = <(IconData, String, String, bool)>[
      free
          ? (LucideIcons.truck, 'Free delivery', 'No delivery charge on this item', false)
          : (LucideIcons.truck, 'Delivery ${rupees(ship)}', 'Free when you buy ${rupees(site.freeShippingThresholdPaise)} or more from this seller', false),
      if (site.codEnabled) (LucideIcons.banknote, 'Pay on delivery', 'Cash, UPI or card when the parcel arrives', false),
      p.returnWindowDays > 0
          ? (LucideIcons.rotateCcw, '${p.returnWindowDays}-day returns', 'Return within ${p.returnWindowDays} days of delivery if something is wrong', false)
          : (LucideIcons.ban, 'Not returnable', 'This item cannot be returned once delivered', true),
      if (p.sellerSnapshot?.flag('top_seller') ?? false) (LucideIcons.award, 'Top seller', 'Highly rated seller with many recent orders', false),
      (LucideIcons.badgeCheck, 'Verified seller', 'Identity, GST and bank details checked', false),
      (LucideIcons.fileText, 'GST invoice', 'Download a GST invoice for every order', false),
      if (site.onlinePayments) (LucideIcons.shieldCheck, 'Secure payment', 'UPI, cards and net banking through a certified gateway', false),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final (icon, label, detail, faint) in items)
          Tooltip(
            message: detail,
            child: Container(
              width: 84,
              margin: const EdgeInsets.only(right: 4),
              child: Column(children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: t.primaryLight, shape: BoxShape.circle),
                  child: Icon(icon, size: 20, color: faint ? t.inkFaint : t.primary),
                ),
                const SizedBox(height: 4),
                Text(label, textAlign: TextAlign.center, style: Tw.px(12, line: 15, weight: Tw.medium, color: t.primary)),
              ]),
            ),
          ),
      ]),
    );
  }
}

/* ---------------------------------------------------------------- key specs and about */

class KeySpecs extends StatelessWidget {
  const KeySpecs({super.key, required this.rows});
  final List<({String label, String value})> rows;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    return Column(children: [
      for (final r in rows)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
              width: 160,
              child: Padding(
                padding: const EdgeInsets.only(right: 16),
                child: Text(r.label, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
              ),
            ),
            Expanded(child: Text(r.value, style: Tw.sm(color: t.inkSoft))),
          ]),
        ),
    ]);
  }
}

class AboutThisItem extends ConsumerStatefulWidget {
  const AboutThisItem({super.key, required this.items});
  final List<String> items;

  @override
  ConsumerState<AboutThisItem> createState() => _AboutThisItemState();
}

class _AboutThisItemState extends ConsumerState<AboutThisItem> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    if (widget.items.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    final first = ref.watch(siteValueProvider).list('highlights_shown').clamp(1, 1000);
    final shown = _all ? widget.items : widget.items.take(first).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('About this item', style: Tw.heading(18, color: t.ink)),
      const SizedBox(height: 6),
      for (var i = 0; i < shown.length; i++)
        Padding(
          padding: EdgeInsets.only(top: i == 0 ? 0 : 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(
              width: 20,
              height: 15 * 1.625,
              child: Align(
                alignment: const Alignment(0.2, 0),
                child: Container(width: 5, height: 5, decoration: BoxDecoration(color: t.inkSoft, shape: BoxShape.circle)),
              ),
            ),
            Expanded(child: Text(shown[i], style: Tw.body(color: t.inkSoft))),
          ]),
        ),
      if (widget.items.length > 5)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: PcLink(_all ? 'Show less' : 'Show ${widget.items.length - 5} more',
              icon: _all ? LucideIcons.chevronUp : LucideIcons.chevronDown, iconAfter: true, onTap: () => setState(() => _all = !_all)),
        ),
    ]);
  }
}

/* ---------------------------------------------------------------- seller snapshot */

class SellerSnapshotCard extends ConsumerWidget {
  const SellerSnapshotCard({super.key, required this.seller, required this.snap});
  final Json seller;
  final Json snap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final years = snap.integer('years');
    final months = snap.integer('months');
    final tenure = years >= 1
        ? '$years+ ${years == 1 ? 'year' : 'years'}'
        : months >= 1
            ? '$months ${months == 1 ? 'month' : 'months'}'
            : 'New';
    final stats = <(IconData, String)>[];
    final ratingCount = snap.integer('rating_count');
    if (snap.intOrNull('positive_pct') != null) {
      stats.add((LucideIcons.thumbsUp, '${snap.integer('positive_pct')}% positive ratings from ${count(ratingCount)} customers'));
    } else if (ratingCount > 0) {
      stats.add((LucideIcons.star, '${snap.dbl('rating_avg').toStringAsFixed(1)} out of 5 from $ratingCount ratings'));
    }
    if ((snap.strOrNull('orders_90d') ?? '').isNotEmpty) stats.add((LucideIcons.truck, '${snap.str('orders_90d')} orders in the last 3 months'));
    if (snap.intOrNull('on_time_pct') != null) stats.add((LucideIcons.clock, '${snap.integer('on_time_pct')}% of orders dispatched on time'));
    stats.add((LucideIcons.badgeCheck, '$tenure on ${site.brandName.isEmpty ? 'this store' : site.brandName}'));
    void store() => openLink(context, '/store/${seller.str('slug')}');
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusXl), border: Border.all(color: t.line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: GestureDetector(onTap: store, child: Text(seller.str('name'), style: Tw.heading(16, color: t.ink)))),
          if (snap.flag('top_seller'))
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(color: t.accentLight, borderRadius: BorderRadius.circular(999)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.award, size: 14, color: t.ink),
                const SizedBox(width: 4),
                Text('Top seller', style: Tw.xs(weight: Tw.semibold, color: t.ink)),
              ]),
            ),
        ]),
        const SizedBox(height: 8),
        for (var i = 0; i < stats.length; i++)
          Padding(
            padding: EdgeInsets.only(top: i == 0 ? 0 : 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(padding: const EdgeInsets.only(top: 2), child: Icon(stats[i].$1, size: 16, color: t.primary)),
              const SizedBox(width: 8),
              Expanded(child: Text(stats[i].$2, style: Tw.sm(color: t.inkSoft))),
            ]),
          ),
        const SizedBox(height: 12),
        PcLink('Visit the store', onTap: store),
      ]),
    );
  }
}

/* ---------------------------------------------------------------- information tables */

/// A two-column table in a rounded frame with grey labels (Specifications, Item details).
class InfoTable extends StatelessWidget {
  const InfoTable({super.key, required this.rows});
  final List<({String label, String value})> rows;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusLg), border: Border.all(color: t.line)),
      clipBehavior: Clip.antiAlias,
      child: LayoutBuilder(builder: (_, c) {
        return Column(children: [
          for (var i = 0; i < rows.length; i++)
            Container(
              decoration: BoxDecoration(border: i < rows.length - 1 ? Border(bottom: BorderSide(color: t.line)) : null),
              child: IntrinsicHeight(
                child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Container(
                    width: c.maxWidth * 0.4,
                    color: t.page,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: Text(rows[i].label, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: Text(rows[i].value, style: Tw.sm(color: t.inkSoft)),
                    ),
                  ),
                ]),
              ),
            ),
        ]);
      }),
    );
  }
}

class ProductInformation extends StatelessWidget {
  const ProductInformation({super.key, required this.p});
  final ProductPage p;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final info = [...p.info];
    final best = p.bestseller;
    if (best != null) info.add((label: 'Best sellers rank', value: '#${best.integer('rank')} in ${best.str('category')}'));
    final first = p.raw.strOrNull('first_available');
    if (first != null && first.isNotEmpty) info.add((label: 'On sale since', value: date(first)));
    final specs = [for (final e in p.specs.entries) (label: e.key, value: e.value)];
    if (specs.isEmpty && info.isEmpty) return const SizedBox.shrink();
    Widget h3(String s) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(s, style: Tw.heading(15, color: t.ink)));
    return PdpSection(
      title: 'Product information',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (specs.isNotEmpty) ...[h3('Specifications'), InfoTable(rows: specs)],
        if (specs.isNotEmpty && info.isNotEmpty) const SizedBox(height: 24),
        if (info.isNotEmpty) ...[h3('Item details'), InfoTable(rows: info)],
      ]),
    );
  }
}

/* ---------------------------------------------------------------- bought together */

class BoughtTogether extends ConsumerStatefulWidget {
  const BoughtTogether({super.key, required this.slug});
  final String slug;

  @override
  ConsumerState<BoughtTogether> createState() => _BoughtTogetherState();
}

class _BoughtTogetherState extends ConsumerState<BoughtTogether> {
  List<ProductCard>? _items;
  final _off = <String>{};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    ref.read(apiProvider).getMap('/api/catalog/products/${widget.slug}/bought-together').then((r) {
      if (mounted) setState(() => _items = r.list('items', ProductCard.new));
    }).catchError((Object _) {
      if (mounted) setState(() => _items = []);
    });
  }

  Future<void> _addAll(List<ProductCard> addable, int needsChoice) async {
    setState(() => _busy = true);
    try {
      for (final p in addable) {
        await ref.read(sessionProvider.notifier).addToCart(GuestLine(
            variantId: p.variantId!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, sellerName: p.sellerName));
      }
      if (mounted) {
        toast(context,
            '${addable.length} item${addable.length == 1 ? '' : 's'} added to your cart${needsChoice > 0 ? '. Choose options for the rest.' : ''}');
      }
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not add to cart'), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final site = ref.watch(siteValueProvider);
    final items = _items;
    if (site.features['bought_together'] == false || items == null || items.length < 2) return const SizedBox.shrink();
    final t = context.pc;
    final picked = items.where((p) => !_off.contains(p.id)).toList();
    final total = picked.fold<int>(0, (n, p) => n + p.price);
    final addable = picked.where((p) => p.variantId != null && p.inStock).toList();
    final needsChoice = picked.where((p) => p.variantId == null).length;
    return PdpSection(
      title: 'Frequently bought together',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          for (var i = 0; i < items.length; i++) ...[
            if (i > 0) Icon(LucideIcons.plus, size: 20, color: t.inkFaint),
            GestureDetector(
              onTap: () => context.push('/p/${items[i].slug}'),
              child: Opacity(
                opacity: _off.contains(items[i].id) ? 0.4 : 1,
                child: Container(
                  width: 96,
                  height: 96,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusLg)),
                  child: ProductImage(src: items[i].image, alt: items[i].title, placeholderText: null),
                ),
              ),
            ),
          ],
        ]),
        const SizedBox(height: 20),
        Text.rich(TextSpan(style: Tw.lg(color: t.ink), children: [
          const TextSpan(text: 'Total price: '),
          TextSpan(text: rupees(total), style: Tw.display(18, 28, color: t.ink)),
        ])),
        const SizedBox(height: 8),
        PcButton.text(
          picked.length == items.length ? 'Add all ${addable.length} to cart' : 'Add ${addable.length} to cart',
          variant: ButtonVariant.cart,
          loading: _busy,
          onPressed: addable.isEmpty ? null : () => _addAll(addable, needsChoice),
        ),
        if (needsChoice > 0)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Some items have sizes or colours: choose them on their pages.', style: Tw.xs(color: t.inkFaint)),
          ),
        const SizedBox(height: 16),
        for (var i = 0; i < items.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: PcCheckbox(
              value: !_off.contains(items[i].id),
              onChanged: (v) => setState(() => v ? _off.remove(items[i].id) : _off.add(items[i].id)),
              label: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: [
                if (i == 0) const TextSpan(text: 'This item: ', style: TextStyle(fontWeight: FontWeight.w600)),
                TextSpan(text: '${items[i].title} '),
                TextSpan(text: rupees(items[i].price), style: const TextStyle(fontWeight: FontWeight.w600)),
                if (items[i].variantId == null) TextSpan(text: ' · choose options on its page', style: TextStyle(color: t.inkFaint)),
              ])),
            ),
          ),
      ]),
    );
  }
}

/* ---------------------------------------------------------------- browsing history and sponsored */

class RecentlyViewedRail extends ConsumerWidget {
  const RecentlyViewedRail({super.key, required this.currentId});
  final String currentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = (ref.watch(viewedProvider).value ?? const <Json>[]).where((x) => x.str('id') != currentId).toList();
    if (items.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    return PdpSection(
      title: 'Your browsing history',
      child: SizedBox(
        height: 128 + 4 + 40 + 24,
        child: ListView(scrollDirection: Axis.horizontal, children: [
          for (final x in items)
            GestureDetector(
              onTap: () => context.push('/p/${x.str('slug')}'),
              child: Container(
                width: 128,
                margin: const EdgeInsets.only(right: 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(t.radiusLg),
                    child: Container(
                      color: t.page,
                      width: 128,
                      height: 128,
                      child: ProductImage(src: x.str('image'), alt: x.str('title'), placeholderText: null),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(x.str('title'), maxLines: 2, overflow: TextOverflow.ellipsis, style: Tw.sm(color: t.ink)),
                  Text(rupees(x.integer('price')), style: Tw.display(15, 24, color: t.ink)),
                ]),
              ),
            ),
        ]),
      ),
    );
  }
}

class SponsoredRail extends ConsumerStatefulWidget {
  const SponsoredRail({super.key, required this.slug});
  final String slug;

  @override
  ConsumerState<SponsoredRail> createState() => _SponsoredRailState();
}

class _SponsoredRailState extends ConsumerState<SponsoredRail> {
  List<ProductCard> _items = const [];

  @override
  void initState() {
    super.initState();
    final limit = ref.read(siteValueProvider).list('sponsored_on_product');
    if (limit <= 0) return;
    ref
        .read(apiProvider)
        .getMap('/api/ads/serve', query: {'placement': 'product', 'product': widget.slug, 'limit': limit})
        .then((r) => mounted ? setState(() => _items = r.list('items', ProductCard.new)) : null)
        .catchError((Object _) => null);
  }

  @override
  Widget build(BuildContext context) =>
      _items.isEmpty ? const SizedBox.shrink() : ProductRail(title: 'Sponsored products related to this item', items: _items, note: 'Sponsored');
}

/* ---------------------------------------------------------------- notify me */

class NotifyMe extends ConsumerStatefulWidget {
  const NotifyMe({super.key, required this.variantId});
  final String variantId;

  @override
  ConsumerState<NotifyMe> createState() => _NotifyMeState();
}

class _NotifyMeState extends ConsumerState<NotifyMe> {
  String? _for;
  bool _on = false;
  bool _busy = false;

  void _load() {
    if (ref.read(sessionProvider).user == null || _for == widget.variantId) return;
    _for = widget.variantId;
    ref.read(apiProvider).getMap('/api/alerts', query: {'variant_id': widget.variantId}).then((r) {
      if (mounted && _for == widget.variantId) setState(() => _on = r.maps('stock').isNotEmpty);
    }).catchError((Object _) {});
  }

  Future<void> _toggle() async {
    setState(() => _busy = true);
    try {
      final api = ref.read(apiProvider);
      if (_on) {
        await api.delete('/api/alerts/stock/${widget.variantId}');
      } else {
        await api.post('/api/alerts/stock', body: {'variant_id': widget.variantId});
      }
      if (!mounted) return;
      toast(context, _on ? 'Alert removed' : 'We will tell you as soon as it is back');
      setState(() => _on = !_on);
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not update the alert'), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final user = ref.watch(sessionProvider.select((s) => s.user));
    if (user == null) {
      return GestureDetector(
        onTap: () => context.push('/login?next=${Uri.encodeComponent(GoRouterState.of(context).uri.toString())}'),
        child: Container(
          height: 48,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(999), border: Border.all(color: t.primary, width: 2)),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(LucideIcons.bell, size: 20, color: t.primary),
            const SizedBox(width: 8),
            Text('Sign in to get notified', style: Tw.body(weight: Tw.semibold, color: t.primary)),
          ]),
        ),
      );
    }
    _load();
    if (_on) {
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: t.successLight, borderRadius: BorderRadius.circular(t.radiusXl)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(LucideIcons.bellRing, size: 16, color: t.success),
            const SizedBox(width: 6),
            Text('We will notify you when it is back', style: Tw.sm(weight: Tw.semibold, color: t.success)),
          ]),
          GestureDetector(onTap: _busy ? null : _toggle, child: Text('Stop this alert', style: Tw.sm(color: t.inkSoft))),
        ]),
      );
    }
    return PcButton(
      variant: ButtonVariant.secondary,
      size: ButtonSize.lg,
      expand: true,
      loading: _busy,
      icon: LucideIcons.bell,
      onPressed: _toggle,
      child: const Text('Notify me when available'),
    );
  }
}

/* ---------------------------------------------------------------- report an issue */

const _reportReasons = <(String, String)>[
  ('wrong_info', 'Wrong or missing product information'),
  ('counterfeit', 'Fake or counterfeit product'),
  ('unsafe', 'Unsafe, expired or harmful'),
  ('prohibited', 'Not allowed to be sold'),
  ('offensive', 'Offensive images or text'),
  ('price', 'Lower price elsewhere / misleading price'),
  ('other', 'Something else'),
];

class ReportProduct extends ConsumerWidget {
  const ReportProduct({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final user = ref.watch(sessionProvider.select((s) => s.user));
    final label = user == null ? 'Sign in to report an issue with this product' : 'Report an issue with this product';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => user == null
          ? context.push('/login?next=${Uri.encodeComponent(GoRouterState.of(context).uri.toString())}')
          : _open(context, ref),
      child: Row(children: [
        Icon(LucideIcons.flag, size: 16, color: t.inkFaint),
        const SizedBox(width: 6),
        Flexible(child: Text(label, style: Tw.sm(color: t.inkFaint))),
      ]),
    );
  }

  Future<void> _open(BuildContext context, WidgetRef ref) {
    var reason = '';
    final note = TextEditingController();
    final url = TextEditingController();
    String? error;
    var busy = false;
    return showPcSheet<void>(context, title: 'Report an issue with this product', builder: (ctx) {
      return StatefulBuilder(builder: (ctx, setState) {
        final t = ctx.pc;
        final needsNote = ['wrong_info', 'other', 'counterfeit', 'unsafe'].contains(reason);
        Future<void> send() async {
          if (reason.isEmpty) return setState(() => error = 'Choose what is wrong');
          if (needsNote && note.text.trim().length < 10) return setState(() => error = 'Tell us a little more (at least 10 characters)');
          setState(() {
            busy = true;
            error = null;
          });
          try {
            await ref.read(apiProvider).post('/api/catalog/products/$slug/report', body: {'reason': reason, 'note': note.text, 'url': url.text});
            if (ctx.mounted) Navigator.of(ctx).pop();
            if (context.mounted) toast(context, 'Thank you. Our team will look into it.');
          } catch (e) {
            setState(() => error = ApiError.messageOf(e, 'Could not send the report'));
          } finally {
            if (ctx.mounted) setState(() => busy = false);
          }
        }

        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('What is wrong?', style: Tw.sm(weight: Tw.semibold, color: t.ink)),
          const SizedBox(height: 4),
          for (final (k, label) in _reportReasons)
            GestureDetector(
              onTap: () => setState(() {
                reason = k;
                error = null;
              }),
              child: Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: reason == k ? t.primaryLight : Colors.white,
                  borderRadius: BorderRadius.circular(t.radiusLg),
                  border: Border.all(color: reason == k ? t.primary : t.line),
                ),
                child: Row(children: [
                  Icon(reason == k ? LucideIcons.circleDot : LucideIcons.circle, size: 16, color: reason == k ? t.primary : t.inkFaint),
                  const SizedBox(width: 8),
                  Expanded(child: Text(label, style: Tw.sm(color: t.ink))),
                ]),
              ),
            ),
          if (reason == 'price') ...[
            const SizedBox(height: 12),
            PcField(label: 'Where did you see it? (optional)', child: PcInput(controller: url, placeholder: 'https://')),
          ],
          const SizedBox(height: 12),
          PcField(
            label: 'Details ${needsNote ? '' : '(optional)'}',
            child: PcTextarea(controller: note, maxLength: 2000, placeholder: 'What did you notice?', minLines: 3),
          ),
          if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: Tw.sm(color: t.buy))),
          const SizedBox(height: 8),
          Text('Our team checks every report. The seller sees what was reported, not who reported it.', style: Tw.xs(color: t.inkFaint)),
          const SizedBox(height: 12),
          PcButton.text('Send report', loading: busy, onPressed: send),
        ]);
      });
    });
  }
}

/// Share: the system share sheet is not wired in this module; the link opens the WhatsApp/X/Facebook share pages.
Future<void> shareProduct(BuildContext context, String title, String slug) {
  final base = siteUrl.isNotEmpty ? siteUrl : AppConfig.apiBase;
  final link = '$base/p/$slug';
  final text = Uri.encodeComponent('$title $link');
  return showPcSheet<void>(context, title: 'Share', builder: (ctx) {
    final t = ctx.pc;
    Widget row(IconData icon, String label, VoidCallback onTap) => InkWell(
          onTap: () {
            Navigator.of(ctx).pop();
            onTap();
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(children: [Icon(icon, size: 18, color: t.inkSoft), const SizedBox(width: 10), Text(label, style: Tw.body(color: t.ink))]),
          ),
        );
    return Column(mainAxisSize: MainAxisSize.min, children: [
      row(LucideIcons.messageCircle, 'WhatsApp', () => openLink(context, 'https://wa.me/?text=$text')),
      row(LucideIcons.share2, 'Facebook', () => openLink(context, 'https://www.facebook.com/sharer/sharer.php?u=${Uri.encodeComponent(link)}')),
      row(LucideIcons.share2, 'X (Twitter)', () => openLink(context, 'https://twitter.com/intent/tweet?text=$text')),
      row(LucideIcons.link2, 'Copy link', () async {
        await Clipboard.setData(ClipboardData(text: link));
        if (context.mounted) toast(context, 'Link copied');
      }),
    ]);
  });
}

/// Keeps the wishlist heart in a plain ring (the buy box's "Save for later").
class SaveForLater extends ConsumerWidget {
  const SaveForLater({super.key, required this.productId});
  final String productId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(siteValueProvider).feature('wishlist')) return const SizedBox.shrink();
    final t = context.pc;
    final on = ref.watch(wishlistProvider).contains(productId);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Semantics(
        button: true,
        toggled: on,
        label: on ? 'Remove from wishlist' : 'Save to wishlist',
        child: GestureDetector(
          onTap: () async {
            final ok = await ref.read(wishlistProvider.notifier).toggle(productId);
            if (!ok && context.mounted) {
              await context.push('/login?next=${Uri.encodeComponent(GoRouterState.of(context).uri.toString())}');
            }
          },
          child: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: t.line)),
            child: on ? Icon(Icons.favorite_rounded, size: 21, color: t.buy) : Icon(LucideIcons.heart, size: 20, color: t.inkFaint),
          ),
        ),
      ),
      const SizedBox(width: 8),
      Text('Save for later', style: Tw.sm(color: t.inkSoft)),
    ]);
  }
}
