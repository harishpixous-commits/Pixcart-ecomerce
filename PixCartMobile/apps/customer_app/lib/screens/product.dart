// The product page (app/(shop)/p/[slug]/page.tsx + buy-box.tsx) as phones show it: breadcrumbs, one white panel
// with the gallery, details, offers, service icons, variants, key specs, "About this item", the seller, then the buy
// box (delivery estimate by PIN, stock, quantity, Add to cart, Buy now), seller details; then the description,
// product information, bought together, reviews, questions, similar and sponsored rails, recently viewed. The buy
// bar stays at the bottom while the buy buttons are out of view.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/frame.dart';
import '../shop/links.dart';
import '../shop/product.dart';
import '../shop/wishlist.dart';
import 'product_blocks.dart';
import 'product_gallery.dart';

final productProvider = FutureProvider.autoDispose.family<ProductPage, String>((ref, slug) async {
  return ProductPage(await ref.read(apiProvider).getMap('/api/catalog/products/${Uri.encodeComponent(slug)}'));
});

class ProductScreen extends ConsumerWidget {
  const ProductScreen({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(productProvider(slug));
    return p.when(
      loading: () => const ShopBody(children: [DetailSkeleton()]),
      error: (e, _) => ShopBody(children: [
        EmptyState(
          title: e is ApiError && e.status == 404 ? "We couldn't find that product" : 'Something went wrong',
          body: e is ApiError && e.status == 404 ? 'The link may be old, or the product is no longer sold.' : ApiError.messageOf(e),
          action: PcButton.text('Go to the home page', onPressed: () => context.go('/')),
        ),
      ]),
      data: (p) => _ProductView(key: ValueKey(p.id), p: p),
    );
  }
}

class _ProductView extends ConsumerStatefulWidget {
  const _ProductView({super.key, required this.p});
  final ProductPage p;

  @override
  ConsumerState<_ProductView> createState() => _ProductViewState();
}

class _ProductViewState extends ConsumerState<_ProductView> {
  final _scroll = ScrollController();
  final _buttonsKey = GlobalKey();
  late Map<String, String> _chosen;
  int _qty = 1;
  String? _busy;
  bool _barVisible = true;

  ProductPage get p => widget.p;

  @override
  void initState() {
    super.initState();
    final first = p.variants.where((v) => v.inStock).firstOrNull ?? p.variants.firstOrNull;
    _chosen = {...?first?.options};
    _scroll.addListener(_checkBar);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkBar();
      final site = ref.read(siteValueProvider);
      rememberViewed(ref, p, site.list('recently_viewed_max'));
      ref.read(apiProvider).post('/api/events', body: {'type': 'view', 'product_id': p.id}).catchError((_) => null);
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// The bar shows while the buy buttons are off screen (IntersectionObserver on the website).
  void _checkBar() {
    final box = _buttonsKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.attached) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final h = MediaQuery.sizeOf(context).height;
    final onScreen = top < h - 60 && top + box.size.height > 200;
    if (onScreen == _barVisible) setState(() => _barVisible = !onScreen);
  }

  PublicVariant? get _variant => p.variants
      .where((v) => _chosen.entries.every((e) => v.options[e.key] == e.value) && v.options.length == _chosen.length)
      .firstOrNull;

  bool _available(String axis, String value) => p.variants
      .any((v) => v.options[axis] == value && v.inStock && _chosen.entries.every((e) => e.key == axis || v.options[e.key] == e.value));

  PublicVariant? _variantFor(String axis, String value) =>
      p.variants.where((v) => v.options[axis] == value && _chosen.entries.every((e) => e.key == axis || v.options[e.key] == e.value)).firstOrNull;

  int _maxQty(Site site, PublicVariant? v) {
    final shown = v ?? p.variants.firstOrNull;
    final dealHere = p.deal != null && shown != null && shown.id == p.deal!.variantId;
    final dealLeft = dealHere && v != null && (p.deal!.unitsLeft ?? 0) > 0 ? p.deal!.unitsLeft! : 1 << 30;
    final m = [site.maxQtyPerItem, v?.stockLeft ?? 10, dealLeft].reduce((a, b) => a < b ? a : b);
    return m < 1 ? 1 : m;
  }

  Future<void> _add(String then) async {
    final v = _variant;
    if (v == null || !v.inStock) return;
    final site = ref.read(siteValueProvider);
    setState(() => _busy = then);
    try {
      final note = await ref.read(sessionProvider.notifier).addToCart(GuestLine(
            variantId: v.id,
            qty: _qty,
            title: p.title,
            image: p.images.firstOrNull ?? '',
            price: v.price,
            mrp: v.mrp,
            slug: p.slug,
            variantLabel: v.label,
            sellerName: p.seller.str('name'),
            max: _maxQty(site, v),
          ));
      ref.read(apiProvider).post('/api/events', body: {'type': 'add_to_cart', 'product_id': p.id}).ignore();
      if (!mounted) return;
      if (then == 'buy') {
        if (note != null) toast(context, note);
        await context.push(ref.read(sessionProvider).user != null ? '/checkout' : '/login?next=/checkout');
      } else {
        toast(context, note ?? 'Added to your cart');
      }
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not add to cart'), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final variant = _variant;
    final shown = variant ?? p.variants.where((v) => v.inStock).firstOrNull ?? p.variants.firstOrNull;
    final dealHere = p.deal != null && shown != null && shown.id == p.deal!.variantId;
    final pricesDiffer = p.variants.map((v) => v.price).toSet().length > 1;
    final maxQty = _maxQty(site, variant);
    final canBuy = variant?.inStock == true && _busy == null;
    final seller = p.seller;
    final best = p.bestseller;
    final bestTop = best != null && best.integer('rank') <= site.list('bestseller_badge_top');
    final topSeller = p.sellerSnapshot?.flag('top_seller') == true;

    final stock = variant == null
        ? Text('This combination is not available', style: Tw.body(weight: Tw.semibold, color: t.buy))
        : variant.inStock
            ? Text(variant.lowStock ? 'Only ${variant.stockLeft} left in stock' : 'In stock',
                style: Tw.lg(weight: Tw.semibold, color: variant.lowStock ? t.buy : t.success))
            : Text('Currently unavailable', style: Tw.lg(weight: Tw.semibold, color: t.buy));

    final main = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        ProductGallery(
          images: p.images,
          title: p.title,
          zoom: site.gallery.flag('zoom', true),
          zoomLevel: site.gallery.dbl('zoom_level', 2.5),
        ),
        const SizedBox(height: 24),
        if (p.brand.isNotEmpty)
          Align(
            alignment: Alignment.centerLeft,
            child: PcLink('Visit the ${p.brand} store', onTap: () => context.push('/search?brand=${Uri.encodeQueryComponent(p.brand)}')),
          ),
        const SizedBox(height: 12),
        Text(p.title, style: Tw.heading(22, color: t.ink).copyWith(height: 1.375)),
        const SizedBox(height: 12),
        if (p.ratingCount > 0)
          Row(children: [
            Text(p.ratingAvg.toStringAsFixed(1), style: Tw.sm(weight: Tw.semibold, color: t.ink)),
            const SizedBox(width: 6),
            Stars(value: p.ratingAvg),
            const SizedBox(width: 6),
            Text('(${count(p.ratingCount)} ${p.ratingCount == 1 ? 'rating' : 'ratings'})', style: Tw.sm(color: t.primary)),
          ])
        else if (site.feature('reviews'))
          Text('No ratings yet', style: Tw.sm(color: t.inkFaint)),
        if ((p.boughtLastMonth ?? '').isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(p.boughtLastMonth!, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
        ],
        if (bestTop || topSeller) ...[
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (bestTop)
              GestureDetector(
                onTap: () => context.push('/c/${best.str('slug')}?sort=popular'),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(4)),
                  child: Text.rich(TextSpan(style: Tw.xs(weight: Tw.bold, color: t.ink), children: [
                    TextSpan(text: '#${best.integer('rank')} Best seller '),
                    TextSpan(text: 'in ${best.str('category')}', style: const TextStyle(fontWeight: FontWeight.w400)),
                  ])),
                ),
              ),
            if (topSeller)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: t.primary, borderRadius: BorderRadius.circular(4)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(LucideIcons.award, size: 14, color: Colors.white),
                  const SizedBox(width: 4),
                  Text('Top seller', style: Tw.xs(weight: Tw.bold, color: Colors.white)),
                ]),
              ),
          ]),
        ],
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.only(top: 12),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (shown != null) ...[
              Wrap(spacing: 12, crossAxisAlignment: WrapCrossAlignment.end, children: [
                if (shown.discountPct > 0) Text('-${shown.discountPct}%', style: Tw.x2l(weight: FontWeight.w300, color: t.buy, display: false)),
                Text(rupees(shown.price), style: Tw.display(32, 32, color: t.ink)),
                if (site.pdpOn('unit_price')) UnitPriceText(shown.unitPrice),
              ]),
              if (shown.mrp > shown.price)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text.rich(TextSpan(style: Tw.sm(color: t.inkFaint), children: [
                    const TextSpan(text: 'M.R.P.: '),
                    TextSpan(text: rupees(shown.mrp), style: const TextStyle(decoration: TextDecoration.lineThrough)),
                  ])),
                ),
              if (dealHere)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: t.buyLight.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(t.radiusLg)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    DealBadge(deal: p.deal!, discount: shown.discountPct, large: true),
                    const SizedBox(height: 4),
                    Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
                      TextSpan(text: 'Deal price ${rupees(shown.price)}'),
                      if ((p.deal!.regularPrice ?? 0) > shown.price) ...[
                        const TextSpan(text: ' · was '),
                        TextSpan(text: rupees(p.deal!.regularPrice!), style: const TextStyle(decoration: TextDecoration.lineThrough)),
                      ],
                    ])),
                    if (p.deal!.unitsLeft != null && p.deal!.unitsLeft! <= 10)
                      Text('Only ${p.deal!.unitsLeft} left at the deal price', style: Tw.sm(weight: Tw.semibold, color: t.buy)),
                  ]),
                ),
            ],
            Text('Inclusive of all taxes', style: Tw.sm(color: t.inkSoft)),
          ]),
        ),
        if (site.pdpOn('offers') && p.offers.isNotEmpty) ...[const SizedBox(height: 12), OffersBlock(offers: p.offers)],
        if (site.pdpOn('service_icons') && shown != null) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: t.line))),
            child: ServiceIcons(p: p, price: shown.price),
          ),
        ],
        for (final axis in p.optionAxes.entries) ...[
          const SizedBox(height: 12),
          Text.rich(TextSpan(style: Tw.sm(weight: Tw.semibold, color: t.ink), children: [
            TextSpan(text: '${axis.key}: '),
            TextSpan(text: _chosen[axis.key] ?? '', style: TextStyle(fontWeight: FontWeight.w400, color: t.inkSoft)),
          ])),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final val in axis.value) _optionChip(context, site, axis.key, val, pricesDiffer),
          ]),
        ],
        if (site.pdpOn('key_specs')) ...[
          const SizedBox(height: 12),
          KeySpecs(rows: [
            ...p.keySpecs,
            if ((shown?.raw.str('net_quantity') ?? '').isNotEmpty) (label: 'Net quantity', value: shown!.raw.str('net_quantity')),
          ]),
        ],
        if (p.highlights.isNotEmpty) ...[const SizedBox(height: 12), AboutThisItem(items: p.highlights)],
        if (site.pdpOn('seller_snapshot') && p.sellerSnapshot != null) ...[
          const SizedBox(height: 12),
          SellerSnapshotCard(seller: seller, snap: p.sellerSnapshot!),
        ],
        const SizedBox(height: 24),
        _buyBox(context, site, shown, variant, dealHere, maxQty, canBuy, stock),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusXl)),
          child: DefaultTextStyle.merge(
            style: Tw.px(13, line: 21, color: t.inkSoft),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(LucideIcons.badgeCheck, size: 16, color: t.success),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(seller.str('legal_name').isNotEmpty ? seller.str('legal_name') : seller.str('name'),
                      style: Tw.px(13, line: 21, weight: Tw.semibold, color: t.ink)),
                ),
              ]),
              if (seller.str('gstin').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('GSTIN ${seller.str('gstin')}')),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('Grievance officer: ${seller.obj('grievance_officer').str('name')} (${seller.obj('grievance_officer').str('email')})'),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(children: [
                  Icon(LucideIcons.package, size: 14, color: t.inkSoft),
                  const SizedBox(width: 6),
                  Text('Country of origin: ${p.countryOfOrigin}'),
                ]),
              ),
            ]),
          ),
        ),
        if (site.pdpOn('report')) ...[const SizedBox(height: 16), ReportProduct(slug: p.slug)],
      ]),
    );

    final important = p.raw.maps('important');
    return ShopBody(
      controller: _scroll,
      bottom: site.pdpOn('sticky_bar') && shown != null && _barVisible ? _stickyBar(context, shown, canBuy) : null,
      children: [
        if (p.breadcrumbs.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Wrap(children: [
              GestureDetector(onTap: () => context.go('/'), child: Text('Home', style: Tw.sm(color: t.inkFaint))),
              for (final b in p.breadcrumbs) ...[
                Text(' › ', style: Tw.sm(color: t.inkFaint)),
                GestureDetector(onTap: () => context.push('/c/${b.slug}'), child: Text(b.name, style: Tw.sm(color: t.inkFaint))),
              ],
            ]),
          ),
        main,
        if (important.isNotEmpty) ...[
          const SizedBox(height: 16),
          PdpSection(
            title: 'Important information',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final x in important) ...[
                Text(x.str('title'), style: Tw.body(weight: Tw.semibold, color: t.ink)),
                Padding(padding: const EdgeInsets.only(top: 4, bottom: 20), child: Text(x.str('text'), style: Tw.body(color: t.inkSoft))),
              ],
            ]),
          ),
        ],
        if (p.description.isNotEmpty) ...[
          const SizedBox(height: 16),
          PdpSection(title: 'Product description', titleGap: 8, child: Text(p.description, style: Tw.body(color: t.inkSoft))),
        ],
        const SizedBox(height: 16),
        ProductInformation(p: p),
        if (site.feature('bought_together')) BoughtTogether(slug: p.slug),
        if (site.feature('reviews')) ...[const SizedBox(height: 16), ReviewsSummary(slug: p.slug)],
        if (site.feature('qa')) QuestionsSummary(slug: p.slug),
        if (p.similar.isNotEmpty) ...[const SizedBox(height: 16), ProductRail(title: 'Customers also viewed', items: p.similar)],
        SponsoredRail(slug: p.slug),
        if (site.pdpOn('recently_viewed')) RecentlyViewedRail(currentId: p.id),
      ],
    );
  }

  Widget _optionChip(BuildContext context, Site site, String axis, String val, bool pricesDiffer) {
    final t = context.pc;
    final ok = _available(axis, val);
    final selected = _chosen[axis] == val;
    final v = _variantFor(axis, val);
    final chip = Container(
      constraints: const BoxConstraints(minWidth: 56),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: selected ? t.primaryLight : Colors.white,
        borderRadius: BorderRadius.circular(t.radiusLg),
        border: ok ? Border.all(color: selected ? t.primary : t.line, width: 2) : null,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Text(val,
            style: Tw.body(weight: Tw.medium, color: selected ? t.primary : (ok ? t.ink : t.inkFaint))
                .copyWith(decoration: ok ? null : TextDecoration.lineThrough, decorationColor: t.inkFaint)),
        if (pricesDiffer && v != null) Text(rupees(v.price), style: Tw.xs(color: t.ink)),
        if (site.pdpOn('unit_price') && v?.unitPrice != null)
          Text('${rupees(v!.unitPrice!.paise)}/${v.unitPrice!.per}', style: Tw.px(11, line: 16, color: t.inkFaint)),
        if (!ok) Text('Unavailable', style: Tw.px(11, line: 16, color: t.inkFaint)),
      ]),
    );
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        onTap: () => setState(() => _chosen = {..._chosen, axis: val}),
        child: ok ? chip : CustomPaint(foregroundPainter: DashedBorderPainter(color: t.line, radius: t.radiusLg), child: chip),
      ),
    );
  }

  Widget _buyBox(BuildContext context, Site site, PublicVariant? shown, PublicVariant? variant, bool dealHere, int maxQty, bool canBuy, Widget stock) {
    final t = context.pc;
    final seller = p.seller;
    Widget row(String k, Widget v) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 96, child: Text(k, style: Tw.px(13, line: 21, color: t.inkFaint))),
            const SizedBox(width: 12),
            Expanded(child: DefaultTextStyle.merge(style: Tw.px(13, line: 21, color: t.ink), child: v)),
          ]),
        );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusXl), border: Border.all(color: t.line), boxShadow: shadowSm, color: Colors.white),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (shown != null) ...[
          Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.end, children: [
            Text(rupees(shown.price), style: Tw.display(28, 28, color: t.ink)),
            if (site.pdpOn('unit_price')) UnitPriceText(shown.unitPrice),
          ]),
          if (dealHere) Padding(padding: const EdgeInsets.only(top: 6), child: DealBadge(deal: p.deal!, discount: shown.discountPct)),
          const SizedBox(height: 12),
        ],
        DeliveryEstimate(variant: variant),
        const SizedBox(height: 12),
        stock,
        const SizedBox(height: 12),
        Row(children: [
          Text('Quantity', style: Tw.sm(weight: Tw.semibold, color: t.ink)),
          const SizedBox(width: 12),
          SizedBox(
            width: 60,
            child: PcSelect<int>(
              value: _qty > maxQty ? maxQty : _qty,
              title: 'Quantity',
              background: t.page,
              options: [for (var n = 1; n <= maxQty; n++) SelectOption(n, '$n')],
              onChanged: (n) => setState(() => _qty = n),
            ),
          ),
        ]),
        const SizedBox(height: 12),
        Column(key: _buttonsKey, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (variant != null && !variant.inStock && site.feature('stock_alerts'))
            NotifyMe(variantId: variant.id)
          else ...[
            PcButton.text('Add to cart',
                variant: ButtonVariant.cart, size: ButtonSize.lg, expand: true, loading: _busy == 'cart', onPressed: canBuy ? () => _add('cart') : null),
            const SizedBox(height: 8),
            PcButton.text('Buy now',
                variant: ButtonVariant.buy, size: ButtonSize.lg, expand: true, loading: _busy == 'buy', onPressed: canBuy ? () => _add('buy') : null),
          ],
        ]),
        const SizedBox(height: 12),
        row('Ships from', Text('${seller.str('city')}${seller.str('state').isNotEmpty ? ', ${seller.str('state')}' : ''}')),
        row('Sold by', GestureDetector(onTap: () => openLink(context, '/store/${seller.str('slug')}'), child: Text(seller.str('name'), style: TextStyle(color: t.primary)))),
        row('Returns', Text(p.returnWindowDays > 0 ? '${p.returnWindowDays}-day return after delivery' : 'Not returnable')),
        row(
            'Payment',
            Text(!site.onlinePayments
                ? 'Cash on delivery'
                : site.codEnabled
                    ? 'Secure online payment or cash on delivery'
                    : 'Secure online payment')),
        Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.only(top: 12),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
          child: Row(children: [
            if (site.feature('wishlist')) ...[
              WishlistHeart(productId: p.id, size: 40),
              const SizedBox(width: 8),
              Text('Save for later', style: Tw.sm(color: t.inkSoft)),
            ],
            const Spacer(),
            if (site.pdpOn('share'))
              GestureDetector(
                onTap: () => shareProduct(context, p.title, p.slug),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(999), border: Border.all(color: t.line)),
                  child: Row(children: [
                    Icon(LucideIcons.share2, size: 16, color: t.ink),
                    const SizedBox(width: 6),
                    Text('Share', style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                  ]),
                ),
              ),
          ]),
        ),
      ]),
    );
  }

  Widget _stickyBar(BuildContext context, PublicVariant shown, bool canBuy) {
    final t = context.pc;
    return Container(
      decoration: BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: t.line)), boxShadow: shadowLg),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Row(children: [
        Expanded(
          child: Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.end, children: [
            Text(rupees(shown.price), style: Tw.display(18, 28, color: t.ink)),
            if (shown.mrp > shown.price)
              Text(rupees(shown.mrp), style: Tw.sm(color: t.inkFaint).copyWith(decoration: TextDecoration.lineThrough, decorationColor: t.inkFaint)),
          ]),
        ),
        PcButton.text('Add to cart', variant: ButtonVariant.cart, loading: _busy == 'cart', onPressed: canBuy ? () => _add('cart') : null),
        const SizedBox(width: 8),
        PcButton.text('Buy now', variant: ButtonVariant.buy, loading: _busy == 'buy', onPressed: canBuy ? () => _add('buy') : null),
      ]),
    );
  }
}

String _within(int min) {
  final h = min ~/ 60, m = min % 60;
  return h > 0 ? '$h hr${h > 1 ? 's' : ''} $m min${m == 1 ? '' : 's'}' : '$m min${m == 1 ? '' : 's'}';
}

/// Delivery date, charge, cut-off and cash on delivery for the shopper's PIN code.
class DeliveryEstimate extends ConsumerStatefulWidget {
  const DeliveryEstimate({super.key, required this.variant});
  final PublicVariant? variant;

  @override
  ConsumerState<DeliveryEstimate> createState() => _DeliveryEstimateState();
}

class _DeliveryEstimateState extends ConsumerState<DeliveryEstimate> {
  final _pin = TextEditingController();
  bool _editing = false;
  String? _err;
  String _key = '';
  Json? _res;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _load(String pin) async {
    final v = widget.variant;
    if (v == null || !isPincode(pin)) return;
    final key = '${v.id}:$pin';
    if (key == _key) return;
    _key = key;
    try {
      final r = await ref.read(apiProvider).getMap('/api/catalog/delivery-estimate', query: {'variant_id': v.id, 'pincode': pin});
      if (mounted && _key == key) setState(() => (_res = r, _err = null));
    } catch (e) {
      if (mounted) setState(() => _err = ApiError.messageOf(e, 'Could not check delivery'));
    }
  }

  void _apply() {
    if (!isPincode(_pin.text)) {
      setState(() => _err = 'Enter a valid 6-digit PIN code');
      return;
    }
    ref.read(pincodeProvider.notifier).set(_pin.text);
    setState(() => _editing = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final pin = ref.watch(pincodeProvider);
    if (pin.isNotEmpty) _load(pin);
    final res = widget.variant != null && _key == '${widget.variant!.id}:$pin' ? _res : null;
    final showForm = _editing || pin.isEmpty;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (res != null && res.flag('serviceable')) ...[
        Text.rich(TextSpan(style: Tw.body(color: t.ink), children: [
          res.integer('delivery_fee_paise') == 0
              ? TextSpan(text: 'FREE delivery', style: TextStyle(fontWeight: Tw.semibold, color: t.success))
              : TextSpan(text: '${rupees(res.integer('delivery_fee_paise'))} delivery'),
          const TextSpan(text: ' '),
          TextSpan(text: date(res.str('min_date')), style: const TextStyle(fontWeight: FontWeight.w600)),
          if (res.str('max_date') != res.str('min_date')) ...[
            const TextSpan(text: ' – '),
            TextSpan(text: date(res.str('max_date')), style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
          const TextSpan(text: '.'),
        ])),
        if (res.integer('delivery_fee_paise') != 0 && res.integer('free_delivery_from_paise') > 0)
          Text('Free delivery when you buy ${rupees(res.integer('free_delivery_from_paise'))} or more from this seller.', style: Tw.sm(color: t.inkSoft)),
        if (res.intOrNull('order_within_min') != null && site.pdpOn('delivery_countdown'))
          Row(children: [
            Icon(LucideIcons.clock, size: 16, color: t.success),
            const SizedBox(width: 6),
            Flexible(
              child: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: [
                const TextSpan(text: 'Order within '),
                TextSpan(text: _within(res.integer('order_within_min')), style: TextStyle(fontWeight: Tw.semibold, color: t.success)),
                const TextSpan(text: ' to get it by this date.'),
              ])),
            ),
          ]),
        if (res.flag('cod_available'))
          Row(children: [
            Icon(LucideIcons.banknote, size: 16, color: t.inkSoft),
            const SizedBox(width: 6),
            Text('Cash on delivery available', style: Tw.sm(color: t.inkSoft)),
          ]),
      ],
      if (res != null && !res.flag('serviceable')) Text('This seller does not deliver to $pin yet.', style: Tw.sm(color: t.buy)),
      if (pin.isNotEmpty && !showForm)
        GestureDetector(
          onTap: () => setState(() {
            _pin.text = pin;
            _editing = true;
          }),
          child: Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(children: [
              Icon(LucideIcons.mapPin, size: 16, color: t.primary),
              const SizedBox(width: 4),
              Flexible(
                child: Text('Delivering to $pin${res != null && res.str('state').isNotEmpty ? ', ${res.str('state')}' : ''} – Change',
                    style: Tw.sm(color: t.primary)),
              ),
            ]),
          ),
        ),
      if (showForm)
        Row(children: [
          Icon(LucideIcons.mapPin, size: 16, color: t.primary),
          const SizedBox(width: 8),
          Expanded(
            child: PcInput(
              controller: _pin,
              height: 36,
              placeholder: 'Enter PIN for delivery date',
              keyboardType: TextInputType.number,
              maxLength: 6,
              style: Tw.sm(color: t.ink),
              onSubmitted: (_) => _apply(),
              onChanged: (_) => setState(() => _err = null),
              semanticLabel: 'PIN code',
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(onTap: _apply, child: Text('Check', style: Tw.sm(weight: Tw.semibold, color: t.primary))),
        ]),
      if (_err != null) Text(_err!, style: Tw.sm(color: t.buy)),
    ]);
  }
}

final _reviewsProvider = FutureProvider.autoDispose.family<Json, String>((ref, slug) async {
  return ref.read(apiProvider).getMap('/api/catalog/products/$slug/reviews', query: {'page': 1});
});

/// Customer reviews: the score, the star bars, "Review this product", what customers say and the first reviews.
class ReviewsSummary extends ConsumerWidget {
  const ReviewsSummary({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final data = ref.watch(_reviewsProvider(slug)).value;
    if (data == null) return const SizedBox.shrink();
    final total = data.integer('rating_count');
    final dist = data.obj('distribution');
    final maxN = [for (final v in dist.values) v is num ? v.toInt() : 0].fold<int>(1, (a, b) => b > a ? b : a);
    final items = data.maps('items');
    final why = data.str('cannot_review_reason');
    return PdpSection(
      title: 'Customer reviews',
      titleSize: 24,
      titleGap: 16,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (total > 0) ...[
          Row(children: [
            Stars(value: data.dbl('rating_avg'), size: 20),
            const SizedBox(width: 8),
            Text('${data.dbl('rating_avg').toStringAsFixed(1)} out of 5', style: Tw.lg(weight: Tw.semibold, color: t.ink)),
          ]),
          const SizedBox(height: 4),
          Text('${count(total)} ${total == 1 ? 'rating' : 'ratings'}', style: Tw.sm(color: t.inkFaint)),
          const SizedBox(height: 12),
          for (final s in ['5', '4', '3', '2', '1'])
            Opacity(
              opacity: dist.integer(s) > 0 ? 1 : 0.6,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(children: [
                  SizedBox(width: 52, child: Text('$s star', style: Tw.sm(color: t.primary))),
                  Expanded(
                    child: Container(
                      height: 16,
                      decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(4), border: Border.all(color: t.line)),
                      alignment: Alignment.centerLeft,
                      child: FractionallySizedBox(
                        widthFactor: dist.integer(s) / maxN,
                        child: Container(decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(3))),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 40,
                    child: Text('${total > 0 ? (dist.integer(s) * 100 / total).round() : 0}%',
                        textAlign: TextAlign.right, style: Tw.sm(color: t.inkFaint)),
                  ),
                ]),
              ),
            ),
        ] else
          Text(
              'No reviews yet. ${data.obj('settings').flag('buyers_only', true) ? 'Customers who buy this can review it after delivery.' : 'Be the first to review it.'}',
              style: Tw.body(color: t.inkSoft)),
        Container(
          margin: const EdgeInsets.only(top: 16),
          padding: const EdgeInsets.only(top: 16),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Review this product', style: Tw.body(weight: Tw.semibold, color: t.ink)),
            Padding(padding: const EdgeInsets.only(bottom: 12), child: Text('Share your thoughts with other customers', style: Tw.sm(color: t.inkSoft))),
            if (why == 'sign_in')
              GestureDetector(
                onTap: () => context.push('/login?next=${Uri.encodeComponent('/p/$slug')}'),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusLg), border: Border.all(color: t.line)),
                  alignment: Alignment.center,
                  child: Text('Sign in to write a review', style: Tw.body(weight: Tw.semibold, color: t.primary)),
                ),
              )
            else if (data.flag('can_review'))
              PcButton.text('Write a review', variant: ButtonVariant.secondary, expand: true, onPressed: () => openLink(context, '/p/$slug#reviews'))
            else if (why == 'not_purchased')
              Text(
                  data.obj('settings').flag('buyers_only', true)
                      ? 'Only customers who bought this product can review it, after it is delivered.'
                      : 'You can review this product after you buy it.',
                  style: Tw.sm(color: t.inkFaint)),
          ]),
        ),
        if (data.str('summary').isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Customers say', style: Tw.heading(18, color: t.ink)),
          const SizedBox(height: 4),
          Text(data.str('summary'), style: Tw.body(color: t.inkSoft)),
          Text('Written by AI from the text of customer reviews', style: Tw.xs(color: t.inkFaint)),
        ],
        for (final r in items.take(5)) ...[
          const SizedBox(height: 16),
          Row(children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(color: t.primaryLight, shape: BoxShape.circle),
              alignment: Alignment.center,
              child: Text(r.str('author').isEmpty ? '?' : r.str('author')[0].toUpperCase(), style: Tw.sm(weight: Tw.semibold, color: t.primary)),
            ),
            const SizedBox(width: 8),
            Text(r.str('author'), style: Tw.sm(weight: Tw.medium, color: t.ink)),
          ]),
          const SizedBox(height: 4),
          Row(children: [
            Stars(value: r.dbl('rating'), size: 14),
            const SizedBox(width: 8),
            Flexible(child: Text(r.str('title'), style: Tw.sm(weight: Tw.semibold, color: t.ink))),
          ]),
          Text(
              'Reviewed on ${date(r.str('created_at'))}${r.flag('verified') ? ' · Verified purchase' : ''}',
              style: Tw.xs(color: t.inkFaint)),
          const SizedBox(height: 4),
          Text(r.str('body'), style: Tw.body(color: t.ink)),
        ],
      ]),
    );
  }
}

final _questionsProvider = FutureProvider.autoDispose.family<Json, String>((ref, slug) async {
  return ref.read(apiProvider).getMap('/api/catalog/products/$slug/questions', query: {'sort': 'helpful', 'page': 1});
});

/// Questions and answers: the count and the first answered questions.
class QuestionsSummary extends ConsumerWidget {
  const QuestionsSummary({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final data = ref.watch(_questionsProvider(slug)).value;
    if (data == null || !data.flag('enabled', true)) return const SizedBox.shrink();
    final total = data.integer('total');
    final user = ref.watch(sessionProvider).user;
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: PdpSection(
        title: 'Questions and answers',
        titleSize: 24,
        titleGap: 0,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(total > 0 ? '$total question${total == 1 ? '' : 's'} about this product' : 'Have a question? Ask the seller and buyers.',
              style: Tw.sm(color: t.inkSoft)),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusLg)),
            child: user == null
                ? GestureDetector(
                    onTap: () => context.push('/login?next=${Uri.encodeComponent('/p/$slug')}'),
                    child: Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
                      TextSpan(text: 'Sign in', style: TextStyle(fontWeight: Tw.semibold, color: t.primary)),
                      const TextSpan(text: ' to ask a question.'),
                    ])),
                  )
                : GestureDetector(
                    onTap: () => openLink(context, '/p/$slug#questions'),
                    child: Row(children: [
                      Icon(LucideIcons.messageCircleQuestion, size: 16, color: t.primary),
                      const SizedBox(width: 6),
                      Text('Ask a question about this product', style: Tw.body(weight: Tw.semibold, color: t.ink)),
                    ]),
                  ),
          ),
          for (final q in data.maps('items').take(3)) ...[
            const SizedBox(height: 12),
            Text.rich(TextSpan(style: Tw.body(color: t.ink), children: [
              const TextSpan(text: 'Q: ', style: TextStyle(fontWeight: FontWeight.w600)),
              TextSpan(text: q.str('text')),
            ])),
            for (final a in q.maps('answers').take(1))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text.rich(TextSpan(style: Tw.body(color: t.inkSoft), children: [
                  const TextSpan(text: 'A: ', style: TextStyle(fontWeight: FontWeight.w600)),
                  TextSpan(text: a.str('text')),
                ])),
              ),
          ],
        ]),
      ),
    );
  }
}
