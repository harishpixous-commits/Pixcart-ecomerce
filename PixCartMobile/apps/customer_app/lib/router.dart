// Routes mirror the website's URLs, so deep links (`/p/:slug`, `/orders/:id`, `/c/:slug`, `/search?q=`) open the
// same screen in the app as on the website.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import 'screens/account.dart';
import 'screens/auth.dart';
import 'screens/cart.dart';
import 'screens/categories.dart';
import 'screens/checkout.dart';
import 'screens/home.dart';
import 'screens/listing.dart';
import 'screens/notifications.dart';
import 'screens/order.dart';
import 'screens/orders.dart';
import 'screens/product.dart';
import 'screens/wishlist.dart';
import 'shop/frame.dart';

/// Pages that need a signed-in shopper: signed-out visitors go to /login?next=... (like the website's layouts).
const signedInOnly = ['/checkout', '/orders', '/account', '/wishlist', '/notifications'];

bool needsSignIn(String path) => signedInOnly.any((p) => path == p || path.startsWith('$p/'));

GoRouter createRouter(Ref ref, {String initialLocation = '/'}) {
  final session = ValueNotifier<SessionState>(ref.read(sessionProvider));
  ref.listen(sessionProvider, (_, s) => session.value = s);
  ref.onDispose(session.dispose);
  Page<void> page(GoRouterState s, Widget child) => NoTransitionPage(key: s.pageKey, child: child);
  return GoRouter(
    initialLocation: initialLocation,
    refreshListenable: session,
    redirect: (context, state) {
      final s = session.value;
      if (!s.ready) return null;
      if (s.user == null && needsSignIn(state.uri.path)) {
        return '/login?next=${Uri.encodeComponent(state.uri.toString())}';
      }
      return null;
    },
    errorBuilder: (context, state) => ShopFrame(child: NotFoundScreen(path: state.uri.path)),
    routes: [
      ShellRoute(
        builder: (context, state, child) => ShopFrame(child: child),
        routes: [
          GoRoute(path: '/', pageBuilder: (c, s) => page(s, const HomeScreen())),
          GoRoute(path: '/categories', pageBuilder: (c, s) => page(s, const CategoriesScreen())),
          GoRoute(path: '/c/:slug', pageBuilder: (c, s) => page(s, CategoryScreen(slug: s.pathParameters['slug']!))),
          GoRoute(path: '/search', pageBuilder: (c, s) => page(s, SearchScreen(key: ValueKey(s.uri.toString())))),
          GoRoute(path: '/p/:slug', pageBuilder: (c, s) => page(s, ProductScreen(slug: s.pathParameters['slug']!))),
          GoRoute(path: '/login', pageBuilder: (c, s) => page(s, const LoginScreen())),
          GoRoute(path: '/signup', pageBuilder: (c, s) => page(s, const SignupScreen())),
          GoRoute(path: '/cart', pageBuilder: (c, s) => page(s, const CartScreen())),
          GoRoute(path: '/checkout', pageBuilder: (c, s) => page(s, const CheckoutScreen())),
          GoRoute(path: '/orders', pageBuilder: (c, s) => page(s, const OrdersScreen())),
          GoRoute(path: '/orders/:id', pageBuilder: (c, s) => page(s, OrderScreen(id: s.pathParameters['id']!))),
          GoRoute(path: '/account', pageBuilder: (c, s) => page(s, const AccountScreen())),
          GoRoute(path: '/wishlist', pageBuilder: (c, s) => page(s, const WishlistScreen())),
          GoRoute(path: '/notifications', pageBuilder: (c, s) => page(s, const NotificationsScreen())),
        ],
      ),
    ],
  );
}

/// Where the app opens (tests open a given screen).
final initialLocationProvider = Provider<String>((ref) => '/');

final routerProvider = Provider<GoRouter>((ref) {
  final r = createRouter(ref, initialLocation: ref.read(initialLocationProvider));
  ref.onDispose(r.dispose);
  return r;
});

/// The not-found page (components/error-pages.tsx).
class NotFoundScreen extends ConsumerWidget {
  const NotFoundScreen({super.key, required this.path});
  final String path;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final site = ref.watch(siteValueProvider);
    final pages = site.raw.obj('error_pages');
    return ShopBody(children: [
      EmptyState(
        title: pages.str('not_found_title', "We couldn't find that page"),
        body: pages.str('not_found_message', 'The link may be old, or the product is no longer sold.'),
        action: PcButton.text('Go to the home page', onPressed: () => context.go('/')),
      ),
    ]);
  }
}
