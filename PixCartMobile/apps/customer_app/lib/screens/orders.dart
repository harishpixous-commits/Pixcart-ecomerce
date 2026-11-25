// Your orders (app/(shop)/orders/page.tsx), the wishlist (wishlist/page.tsx) and notifications
// (notifications/page.tsx).

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/frame.dart';
import '../shop/header.dart' show unreadProvider;
import '../shop/links.dart';
import '../shop/product.dart';
import '../shop/wishlist.dart';

/// The status shown for a whole order (its packages can differ).
(String, String) overallStatus(OrderSummary o) {
  if (o.status == 'pending_payment') return ('pending_payment', 'Awaiting payment');
  if (o.status == 'cancelled') return ('cancelled', 'Cancelled');
  final live = o.subStatuses.where((s) => s != 'cancelled').toList();
  if (live.isNotEmpty && live.every((s) => s == 'delivered')) return ('delivered', 'Delivered');
  if (live.any((s) => s == 'shipped')) return ('shipped', 'On the way');
  final first = live.firstOrNull ?? 'placed';
  return (first, subStatusLabel[first] ?? humanize(first));
}

final _ordersProvider = FutureProvider.autoDispose.family<Paged<OrderSummary>, int>((ref, page) async {
  try {
    return Paged(await ref.read(apiProvider).getMap('/api/orders', query: {'page': page}), OrderSummary.new);
  } catch (_) {
    return Paged(const {'items': [], 'total': 0, 'page': 1, 'page_size': 10}, OrderSummary.new);
  }
});

class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key});

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  int _page = 1;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final data = ref.watch(_ordersProvider(_page)).value;
    if (data == null) return const ShopBody(children: [ListSkeleton()]);
    if (data.items.isEmpty) {
      return ShopBody(
        children: [
          EmptyState(
            title: 'No orders yet',
            body: 'When you place an order it will appear here.',
            action: PcButton.text('Start shopping', onPressed: () => context.go('/')),
          ),
        ],
      );
    }
    final pages = (data.total / (data.pageSize == 0 ? 10 : data.pageSize)).ceil();
    return ShopBody(
      gap: 12,
      onRefresh: () async => ref.invalidate(_ordersProvider(_page)),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text('Your orders', style: Tw.heading(24, color: t.ink)),
        ),
        for (final o in data.items) _OrderCard(o: o),
        if (pages > 1)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                PcButton.text(
                  'Previous',
                  variant: ButtonVariant.secondary,
                  size: ButtonSize.sm,
                  onPressed: _page <= 1 ? null : () => setState(() => _page--),
                ),
                const SizedBox(width: 8),
                Text('Page $_page of $pages', style: Tw.sm(color: t.inkSoft)),
                const SizedBox(width: 8),
                PcButton.text(
                  'Next',
                  variant: ButtonVariant.secondary,
                  size: ButtonSize.sm,
                  onPressed: _page >= pages ? null : () => setState(() => _page++),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({required this.o});
  final OrderSummary o;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final (status, label) = overallStatus(o);
    final first = o.items.firstOrNull;
    return GestureDetector(
      onTap: () => context.push('/orders/${o.id}'),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              height: 64,
              child: Stack(
                children: [
                  for (var i = 0; i < o.items.length && i < 3; i++)
                    Positioned(
                      left: i * 52.0,
                      child: Container(
                        width: 64,
                        height: 64,
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(t.radiusLg),
                          border: Border.all(color: Colors.white, width: 2),
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: ProductImage(src: o.items[i].str('image'), alt: o.items[i].str('title')),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              '${first?.str('title') ?? ''}${o.itemCount > 1 ? ' and ${o.itemCount - 1} more' : ''}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Tw.body(weight: Tw.medium, color: t.ink),
            ),
            Text('Order ${o.number}, placed ${date(o.createdAt)}', style: Tw.sm(color: t.inkFaint)),
            const SizedBox(height: 12),
            Row(
              children: [
                Text(rupees(o.grandTotal), style: Tw.display(18, 28, color: t.ink)),
                const SizedBox(width: 16),
                StatusPill(status: status, label: label),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

final _wishlistItemsProvider = FutureProvider.autoDispose<List<ProductCard>>((ref) async {
  final r = await ref.read(apiProvider).getMap('/api/wishlist');
  return r.list('items', ProductCard.new);
});

class WishlistScreen extends ConsumerWidget {
  const WishlistScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final items = ref.watch(_wishlistItemsProvider).value;
    final ids = ref.watch(wishlistProvider);
    if (items == null) return const ShopBody(children: [ProductGridSkeleton(count: 4)]);
    final shown = items.where((p) => ids.contains(p.id)).toList();
    return ShopBody(
      gap: 12,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text.rich(
            TextSpan(
              style: Tw.heading(24, color: t.ink),
              children: [
                const TextSpan(text: 'Your wishlist '),
                TextSpan(
                  text: '(${shown.length})',
                  style: Tw.base(color: t.inkFaint),
                ),
              ],
            ),
          ),
        ),
        if (shown.isEmpty)
          EmptyState(
            title: 'Nothing saved yet',
            body: 'Tap the heart on any product to save it here for later.',
            action: PcButton.text('Browse products', onPressed: () => context.go('/')),
          )
        else
          ProductGrid(items: shown),
      ],
    );
  }
}

final _notificationsProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  return (await ref.read(apiProvider).getMap('/api/notifications')).maps('items');
});

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _allRead = false;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final items = ref.watch(_notificationsProvider).value;
    if (items == null) return const ShopBody(children: [ListSkeleton()]);
    final unread = !_allRead && items.any((n) => !n.flag('read'));
    return ShopBody(
      gap: 12,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              Expanded(
                child: Text('Notifications', style: Tw.heading(24, color: t.ink)),
              ),
              if (unread)
                PcButton.text(
                  'Mark all as read',
                  variant: ButtonVariant.ghost,
                  size: ButtonSize.sm,
                  onPressed: () async {
                    try {
                      await ref.read(apiProvider).post('/api/notifications/read-all');
                      setState(() => _allRead = true);
                      ref.invalidate(unreadProvider);
                    } catch (_) {}
                  },
                ),
            ],
          ),
        ),
        if (items.isEmpty)
          const EmptyState(title: 'No notifications', body: 'Order updates and replies from support will appear here.')
        else
          Container(
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (var i = 0; i < items.length; i++) ...[
                  if (i > 0) Divider(height: 1, color: t.line),
                  _notification(context, items[i]),
                ],
              ],
            ),
          ),
      ],
    );
  }

  Widget _notification(BuildContext context, Json n) {
    final t = context.pc;
    final read = _allRead || n.flag('read');
    final body = Container(
      color: read ? null : t.primaryLight.withValues(alpha: 0.4),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            margin: const EdgeInsets.only(top: 8),
            width: 8,
            height: 8,
            decoration: BoxDecoration(shape: BoxShape.circle, color: read ? Colors.transparent : t.buy),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  n.str('title'),
                  style: Tw.body(weight: Tw.semibold, color: t.ink),
                ),
                Text(n.str('body'), style: Tw.body(color: t.inkSoft)),
                Text(dateTime(n.str('at')), style: Tw.xs(color: t.inkFaint)),
              ],
            ),
          ),
        ],
      ),
    );
    final link = n.str('link');
    return link.isEmpty ? body : GestureDetector(onTap: () => openLink(context, link), child: body);
  }
}
