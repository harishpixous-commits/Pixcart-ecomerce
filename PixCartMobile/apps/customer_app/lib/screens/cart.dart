// The cart (app/(shop)/cart/page.tsx): signed out, the lines kept on the phone; signed in, the account's cart by
// seller with quantity steppers, delete, save for later, free-delivery progress, the bill, "Proceed to buy" (and the
// bar that keeps it in reach on phones), saved for later.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/bill.dart';
import '../shop/frame.dart';
import '../shop/links.dart';
import 'product_blocks.dart';

/// `rounded-2xl bg-white shadow-sm ring-1 ring-black/5`
BoxDecoration surface(BuildContext context) => BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(context.pc.radius2xl),
      border: Border.all(color: Colors.black.withValues(alpha: 0.05)),
      boxShadow: shadowSm,
    );

class QtyStepper extends StatelessWidget {
  const QtyStepper({super.key, required this.value, required this.max, required this.onChange, this.disabled = false});
  final int value;
  final int max;
  final ValueChanged<int> onChange;
  final bool disabled;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    Widget btn(IconData icon, String label, bool enabled, int to) => Semantics(
          button: true,
          label: label,
          enabled: enabled,
          child: GestureDetector(
            onTap: enabled ? () => onChange(to) : null,
            child: SizedBox(width: 36, height: 34, child: Opacity(opacity: enabled ? 1 : 0.4, child: Icon(icon, size: 16, color: t.inkSoft))),
          ),
        );
    return Container(
      height: 36,
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusLg), border: Border.all(color: t.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        btn(LucideIcons.minus, 'Decrease quantity', !disabled && value > 1, value - 1),
        SizedBox(width: 32, child: Text('$value', textAlign: TextAlign.center, style: Tw.body(weight: Tw.semibold, color: t.ink))),
        btn(LucideIcons.plus, 'Increase quantity', !disabled && value < max, value + 1),
      ]),
    );
  }
}

class _LineAction extends StatelessWidget {
  const _LineAction({required this.icon, required this.label, required this.onTap, required this.color});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final Color color;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Opacity(
          opacity: onTap == null ? 0.5 : 1,
          child: Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 16, color: color),
              const SizedBox(width: 6),
              Text(label, style: Tw.sm(weight: Tw.semibold, color: color)),
            ]),
          ),
        ),
      );
}

Widget _cartHead(BuildContext context, int count, int subtotal) {
  final t = context.pc;
  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 4),
    child: Wrap(spacing: 16, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.end, children: [
      Text('Shopping cart', style: Tw.heading(24, color: t.ink)),
      Text.rich(TextSpan(style: Tw.body(color: t.inkSoft), children: [
        TextSpan(text: 'Subtotal ($count item${count == 1 ? '' : 's'}): '),
        TextSpan(text: rupees(subtotal), style: Tw.display(15, 24, color: t.ink)),
      ])),
    ]),
  );
}

Widget _lineRow(BuildContext context, {required String slug, required String image, required String title, String variantLabel = '', String? seller,
    required int price, required int mrp, String problem = '', required Widget actions}) {
  final t = context.pc;
  return Container(
    color: problem.isNotEmpty ? t.buyLight.withValues(alpha: 0.4) : null,
    padding: const EdgeInsets.all(16),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        GestureDetector(
          onTap: () => context.push('/p/$slug'),
          child: ClipRRect(borderRadius: BorderRadius.circular(t.radiusXl), child: ProductImage(src: image, alt: title, width: 80, height: 80)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            GestureDetector(
              onTap: () => context.push('/p/$slug'),
              child: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: Tw.body(weight: Tw.medium, color: t.ink).copyWith(height: 1.375)),
            ),
            if (variantLabel.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(variantLabel, style: Tw.sm(color: t.inkFaint))),
            if (seller != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Seller: $seller', style: Tw.sm(color: t.inkFaint))),
            const SizedBox(height: 4),
            Price(price: price, mrp: mrp),
            if (problem.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(problem, style: Tw.sm(weight: Tw.semibold, color: t.buy))),
          ]),
        ),
      ]),
      const SizedBox(height: 12),
      actions,
    ]),
  );
}

final _cartProvider = FutureProvider.autoDispose<(CartView, List<Json>)>((ref) async {
  final api = ref.read(apiProvider);
  final r = await Future.wait([api.getMap('/api/cart'), api.getMap('/api/cart/saved')]);
  return (CartView(r[0]), r[1].maps('items'));
});

class CartScreen extends ConsumerWidget {
  const CartScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    if (!s.ready) return const ShopBody(children: [ListSkeleton(title: true)]);
    if (s.user == null) return const _GuestCart();
    final data = ref.watch(_cartProvider);
    return data.when(
      loading: () => const ShopBody(children: [ListSkeleton(title: true)]),
      error: (e, _) => ShopBody(children: [ErrorNote(ApiError.messageOf(e, 'Could not load your cart'))]),
      data: (d) => _AccountCart(cart: d.$1, saved: d.$2),
    );
  }
}

class _GuestCart extends ConsumerWidget {
  const _GuestCart();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final lines = ref.watch(sessionProvider.select((s) => s.guestLines));
    if (lines.isEmpty) {
      return ShopBody(children: [
        EmptyState(
          title: 'Your cart is empty',
          body: 'Find something you like and add it here.',
          action: PcButton.text('Start shopping', onPressed: () => context.go('/')),
        ),
        const SizedBox(height: 16),
        const RecentlyViewedRail(currentId: ''),
      ]);
    }
    final mrp = lines.fold<int>(0, (n, l) => n + l.mrp * l.qty);
    final total = lines.fold<int>(0, (n, l) => n + l.price * l.qty);
    final count = lines.fold<int>(0, (n, l) => n + l.qty);
    final notifier = ref.read(sessionProvider.notifier);
    return ShopBody(gap: 12, children: [
      _cartHead(context, count, total),
      Container(
        decoration: surface(context),
        clipBehavior: Clip.antiAlias,
        child: Column(children: [
          for (var i = 0; i < lines.length; i++) ...[
            if (i > 0) Divider(height: 1, color: t.line),
            _lineRow(
              context,
              slug: lines[i].slug,
              image: lines[i].image,
              title: lines[i].title,
              variantLabel: lines[i].variantLabel,
              seller: lines[i].sellerName,
              price: lines[i].price,
              mrp: lines[i].mrp,
              actions: Wrap(spacing: 4, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                QtyStepper(value: lines[i].qty, max: lines[i].max ?? 10, onChange: (n) => notifier.setGuestQty(lines[i].variantId, n)),
                _LineAction(icon: LucideIcons.trash2, label: 'Remove', color: t.inkSoft, onTap: () => notifier.setGuestQty(lines[i].variantId, 0)),
              ]),
            ),
          ],
        ]),
      ),
      Container(
        padding: const EdgeInsets.all(16),
        decoration: surface(context),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('PRICE DETAILS', style: Tw.xs(weight: Tw.bold, color: t.inkSoft).copyWith(letterSpacing: 1.4)),
          const SizedBox(height: 12),
          BillDetailsGuest(mrp: mrp, total: total, count: count),
          const SizedBox(height: 16),
          Text('Delivery charges are worked out at checkout.', style: Tw.sm(color: t.inkFaint)),
          const SizedBox(height: 16),
          PcButton.text('Sign in to place order', variant: ButtonVariant.buy, size: ButtonSize.lg, expand: true, onPressed: () => context.push('/login?next=/checkout')),
        ]),
      ),
      const RecentlyViewedRail(currentId: ''),
    ]);
  }
}

/// The signed-out bill: delivery and fees are worked out at checkout.
class BillDetailsGuest extends StatelessWidget {
  const BillDetailsGuest({super.key, required this.mrp, required this.total, required this.count});
  final int mrp;
  final int total;
  final int count;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final big = Tw.display(18, 28, color: t.ink);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(
          child: Text.rich(TextSpan(style: Tw.body(color: t.ink), children: [
            const TextSpan(text: 'Item total'),
            TextSpan(text: ' ($count item${count == 1 ? '' : 's'})', style: TextStyle(color: t.inkFaint)),
          ])),
        ),
        if (mrp > total) ...[
          Text(rupees(mrp), style: Tw.sm(color: t.inkFaint).copyWith(decoration: TextDecoration.lineThrough, decorationColor: t.inkFaint)),
          const SizedBox(width: 6),
        ],
        Text(rupees(total), style: Tw.body(color: t.ink)),
      ]),
      const SizedBox(height: 10),
      Row(children: [Expanded(child: Text('Delivery', style: Tw.body(color: t.ink))), Text('At checkout', style: Tw.sm(color: t.inkFaint))]),
      const SizedBox(height: 12),
      Divider(height: 1, color: t.line),
      const SizedBox(height: 12),
      Row(children: [Expanded(child: Text('Subtotal', style: big)), Text(rupees(total), style: big)]),
      if (mrp > total) ...[
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: t.successLight, borderRadius: BorderRadius.circular(t.radiusXl)),
          child: Row(children: [
            Icon(LucideIcons.badgePercent, size: 16, color: t.success),
            const SizedBox(width: 8),
            Text('You save ${rupees(mrp - total)} on this order', style: Tw.sm(weight: Tw.semibold, color: t.success)),
          ]),
        ),
      ],
    ]);
  }
}

class _AccountCart extends ConsumerStatefulWidget {
  const _AccountCart({required this.cart, required this.saved});
  final CartView cart;
  final List<Json> saved;

  @override
  ConsumerState<_AccountCart> createState() => _AccountCartState();
}

class _AccountCartState extends ConsumerState<_AccountCart> {
  late CartView _cart = widget.cart;
  late List<Json> _saved = widget.saved;
  String? _busy;
  int _seq = 0;
  final _scroll = ScrollController();
  final _buyKey = GlobalKey();
  bool _showBar = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_check);
    WidgetsBinding.instance.addPostFrameCallback((_) => _check());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _check() {
    final box = _buyKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.attached) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final h = MediaQuery.sizeOf(context).height;
    final visible = top < h - 60 && top + box.size.height > 0;
    if (visible == _showBar) setState(() => _showBar = !visible);
  }

  Future<void> _setQty(String variantId, int qty) async {
    setState(() => _busy = variantId);
    final id = ++_seq;
    try {
      final c = CartView(asMap(await ref.read(apiProvider).put('/api/cart/items', body: {'variant_id': variantId, 'qty': qty})));
      if (id == _seq && mounted) {
        setState(() => _cart = c);
        if ((c.notice ?? '').isNotEmpty) toast(context, c.notice!);
      }
      await ref.read(sessionProvider.notifier).refreshCart();
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not update the cart'), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _move(String path, String variantId, String done) async {
    setState(() => _busy = variantId);
    try {
      final r = asMap(await ref.read(apiProvider).post(path));
      if (mounted) {
        setState(() {
          _cart = CartView(r.obj('cart'));
          _saved = r.obj('saved').maps('items');
        });
      }
      await ref.read(sessionProvider.notifier).refreshCart();
      if (mounted) toast(context, done);
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not update the cart'), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _removeSaved(String variantId) async {
    try {
      final r = asMap(await ref.read(apiProvider).delete('/api/cart/saved/$variantId'));
      if (mounted) setState(() => _saved = r.maps('items'));
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not delete'), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final s = _cart.summary;
    final saved = _savedBlock(context);
    if (_cart.groups.isEmpty) {
      return ShopBody(gap: 16, children: [
        EmptyState(
          title: 'Your cart is empty',
          body: _saved.isNotEmpty ? 'Your saved items are below.' : 'Find something you like and add it here.',
          action: PcButton.text('Start shopping', onPressed: () => context.go('/')),
        ),
        ?saved,
        const RecentlyViewedRail(currentId: ''),
      ]);
    }
    final cannotBuy = s.hasProblems || s.itemCount == 0;
    void checkout() => context.push('/checkout');
    return ShopBody(
      controller: _scroll,
      gap: 12,
      bottom: _showBar
          ? Container(
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.95),
                border: Border(top: BorderSide(color: t.line)),
                boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 16, offset: Offset(0, -4))],
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(rupees(s.grandTotal), style: Tw.display(18, 22.5, color: t.ink)),
                    GestureDetector(
                      onTap: () => _scroll.animateTo(0, duration: const Duration(milliseconds: 300), curve: Curves.easeOut),
                      child: Text('View bill', style: Tw.xs(weight: Tw.semibold, color: t.primary)),
                    ),
                  ]),
                ),
                PcButton.text('Proceed to buy', variant: ButtonVariant.buy, onPressed: cannotBuy ? null : checkout),
              ]),
            )
          : null,
      children: [
        _cartHead(context, s.itemCount, s.itemsTotal),
        for (final g in _cart.groups) _group(context, g),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: surface(context),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            BillDetails(
              bill: BillData.fromSummary(s),
              deliveryLabel: _cart.checkout?.str('delivery_label', 'Delivery fee') ?? 'Delivery fee',
              deliveryInfo: _cart.checkout?.str('delivery_info') ?? '',
              hints: _cart.hints,
              totalLabel: 'Total',
            ),
            if (s.hasProblems) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(color: t.buyLight, borderRadius: BorderRadius.circular(t.radiusXl)),
                child: Text('Remove or update the items marked in red to continue.', style: Tw.sm(color: t.buy)),
              ),
            ],
            const SizedBox(height: 16),
            PcButton.text('Proceed to buy', key: _buyKey, variant: ButtonVariant.buy, size: ButtonSize.lg, expand: true, onPressed: cannotBuy ? null : checkout),
            const SizedBox(height: 16),
            Text(
              'Prices include GST. ${site.feature('coupons') ? 'Apply coupons and choose how to pay at checkout.' : 'Choose how to pay at checkout.'}',
              textAlign: TextAlign.center,
              style: Tw.xs(color: t.inkFaint),
            ),
          ]),
        ),
        ?saved,
        const RecentlyViewedRail(currentId: ''),
      ],
    );
  }

  Widget _group(BuildContext context, CartGroup g) {
    final t = context.pc;
    final free = g.shippingFee == 0 && g.itemsTotal > 0;
    final goal = g.itemsTotal + g.freeShippingGap;
    final pct = goal > 0 ? (g.itemsTotal * 100 / goal).round().clamp(4, 100) : 0;
    final seller = g.seller;
    return Container(
      decoration: surface(context),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.line))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, spacing: 12, runSpacing: 6, children: [
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.store, size: 16, color: t.primary),
                const SizedBox(width: 8),
                Text('Sold by ', style: Tw.body(weight: Tw.semibold, color: t.ink)),
                GestureDetector(
                  onTap: () => openLink(context, '/store/${seller.str('slug')}'),
                  child: Text(seller.str('name'), style: Tw.body(weight: Tw.semibold, color: t.primary)),
                ),
              ]),
              if (free)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  decoration: BoxDecoration(color: t.successLight, borderRadius: BorderRadius.circular(999)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(LucideIcons.truck, size: 14, color: t.success),
                    const SizedBox(width: 4),
                    Text('Free delivery', style: Tw.xs(weight: Tw.semibold, color: t.success)),
                  ]),
                )
              else if (g.shippingFee > 0)
                Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
                  const TextSpan(text: 'Delivery '),
                  TextSpan(text: rupees(g.shippingFee), style: TextStyle(fontWeight: Tw.semibold, color: t.ink)),
                ])),
            ]),
            if (g.shippingFee > 0 && g.freeShippingGap > 0) ...[
              const SizedBox(height: 12),
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.truck, size: 16, color: t.accentDark)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
                    const TextSpan(text: 'Add items worth '),
                    TextSpan(text: rupees(g.freeShippingGap), style: TextStyle(fontWeight: Tw.semibold, color: t.ink)),
                    TextSpan(text: ' more for free delivery from ${seller.str('name')}'),
                  ])),
                ),
              ]),
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(value: pct / 100, minHeight: 6, color: t.accent, backgroundColor: t.page),
              ),
            ],
          ]),
        ),
        for (var i = 0; i < g.lines.length; i++) ...[
          if (i > 0) Divider(height: 1, color: t.line),
          _lineRow(
            context,
            slug: g.lines[i].productSlug,
            image: g.lines[i].image,
            title: g.lines[i].title,
            variantLabel: g.lines[i].variantLabel,
            price: g.lines[i].price,
            mrp: g.lines[i].mrp,
            problem: g.lines[i].problem,
            actions: Wrap(spacing: 4, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              QtyStepper(
                value: g.lines[i].qty,
                max: g.lines[i].maxQty ?? (g.lines[i].stockLeft < 10 ? g.lines[i].stockLeft : 10).clamp(1, 1 << 30),
                disabled: _busy == g.lines[i].variantId,
                onChange: (n) => _setQty(g.lines[i].variantId, n),
              ),
              _LineAction(
                icon: LucideIcons.trash2,
                label: 'Delete',
                color: t.inkSoft,
                onTap: _busy == g.lines[i].variantId ? null : () => _setQty(g.lines[i].variantId, 0),
              ),
              _LineAction(
                icon: LucideIcons.bookmark,
                label: 'Save for later',
                color: t.primary,
                onTap: _busy == g.lines[i].variantId
                    ? null
                    : () => _move('/api/cart/items/${g.lines[i].variantId}/save-for-later', g.lines[i].variantId, 'Saved for later'),
              ),
            ]),
          ),
        ],
      ]),
    );
  }

  Widget? _savedBlock(BuildContext context) {
    if (_saved.isEmpty) return null;
    final t = context.pc;
    return Container(
      decoration: surface(context),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.line))),
          child: Text.rich(TextSpan(style: Tw.heading(18, color: t.ink), children: [
            const TextSpan(text: 'Saved for later '),
            TextSpan(text: '(${_saved.length} item${_saved.length == 1 ? '' : 's'})', style: Tw.base(color: t.inkFaint)),
          ])),
        ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Column(children: [
            for (final it in _saved)
              Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusXl), border: Border.all(color: t.line)),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  ClipRRect(borderRadius: BorderRadius.circular(t.radiusLg), child: ProductImage(src: it.str('image'), width: 80, height: 80)),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(it.str('title'), maxLines: 2, overflow: TextOverflow.ellipsis, style: Tw.sm(weight: Tw.medium, color: t.ink)),
                      if (it.str('variant_label').isNotEmpty) Text(it.str('variant_label'), style: Tw.xs(color: t.inkFaint)),
                      Price(price: it.integer('price'), mrp: it.integer('mrp'), size: 'sm'),
                      if (!it.flag('in_stock'))
                        Text(it.flag('available') ? 'Out of stock' : 'No longer available', style: Tw.xs(weight: Tw.semibold, color: t.buy)),
                      const SizedBox(height: 4),
                      Row(children: [
                        PcButton.text('Move to cart',
                            size: ButtonSize.sm,
                            variant: ButtonVariant.secondary,
                            onPressed: !it.flag('in_stock') || _busy == it.str('variant_id')
                                ? null
                                : () => _move('/api/cart/saved/${it.str('variant_id')}/move-to-cart', it.str('variant_id'), 'Moved to your cart')),
                        const SizedBox(width: 8),
                        GestureDetector(
                          onTap: () => _removeSaved(it.str('variant_id')),
                          child: Text('Delete', style: Tw.sm(weight: Tw.semibold, color: t.inkSoft)),
                        ),
                      ]),
                    ]),
                  ),
                ]),
              ),
          ]),
        ),
      ]),
    );
  }
}
