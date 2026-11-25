// The Classic shop header (components/shop-chrome.tsx ShopHeader + components/shop-nav.tsx) as phones show it:
// announcement bar, the brand bar with logo, account and cart and the search box under them, the awning edge, and
// the second bar with the "All" menu, "Deliver to" and the marketplace's links.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import 'links.dart';

/// Two-tone wordmark (or the uploaded logo).
class Logo extends ConsumerWidget {
  const Logo({super.key, this.light = true, this.onTap});
  final bool light;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final site = ref.watch(siteValueProvider);
    final t = context.pc;
    final name = site.brandName.isEmpty ? AppConfig.appName : site.brandName;
    Widget body;
    if (site.logoUrl.isNotEmpty) {
      body = ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 160, maxHeight: 36),
        child: Image.network(mediaUrl(site.logoUrl), height: 36, fit: BoxFit.contain),
      );
    } else {
      final (first, second) = splitBrand(name);
      final style = Tw.display(24, 32).copyWith(letterSpacing: -0.6);
      body = Text.rich(
        TextSpan(children: [
          TextSpan(text: first, style: style.copyWith(color: light ? Colors.white : t.primary)),
          if (second.isNotEmpty) TextSpan(text: second, style: style.copyWith(color: t.accent)),
        ]),
      );
    }
    return Semantics(
      label: '$name home',
      button: true,
      child: GestureDetector(onTap: onTap ?? () => context.go('/'), child: body),
    );
  }
}

class AnnouncementBar extends ConsumerWidget {
  const AnnouncementBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final site = ref.watch(siteValueProvider);
    final a = site.announcement;
    if (!a.flag('enabled') || a.str('text').isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    final (bg, fg) = switch (a.str('tone')) {
      'primary' => (t.primaryDark, Colors.white),
      'dark' => (t.ink, Colors.white),
      _ => (t.accent, t.ink),
    };
    final link = a.str('link');
    return GestureDetector(
      onTap: link.isEmpty ? null : () => openLink(context, link),
      child: Container(
        width: double.infinity,
        color: bg,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Text(site.fill(a.str('text')),
            maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: Tw.sm(weight: Tw.medium, color: fg)),
      ),
    );
  }
}

/// The header (sticky on the website: it stays above the scrolling page).
class ShopHeader extends ConsumerWidget {
  const ShopHeader({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      const AnnouncementBar(),
      Container(
        color: t.primary,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        child: const Column(children: [
          SizedBox(
            height: 40,
            child: Row(children: [
              Logo(),
              Spacer(),
              NotificationBell(),
              SizedBox(width: 4),
              AccountButton(),
              SizedBox(width: 4),
              CartButton(),
            ]),
          ),
          SizedBox(height: 8),
          SearchBox(),
        ]),
      ),
      Container(
        decoration: const BoxDecoration(color: Colors.white, boxShadow: shadowSm),
        child: Stack(children: [
          Positioned(left: 0, right: 0, top: 0, height: 12, child: Awning(color: t.primary)),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
            child: NavBar(showPin: site.pdp.flag('header_pincode', true)),
          ),
        ]),
      ),
    ]);
  }
}

/// The market-stall awning edge: half circles of radius 12 every 24 px (`.awning`).
class Awning extends StatelessWidget {
  const Awning({super.key, required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) => CustomPaint(painter: _AwningPainter(color));
}

class _AwningPainter extends CustomPainter {
  _AwningPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..isAntiAlias = true;
    canvas.clipRect(Offset.zero & size);
    for (double x = 12; x < size.width + 24; x += 24) {
      canvas.drawCircle(Offset(x, 0), 11.75, p);
    }
  }

  @override
  bool shouldRepaint(_AwningPainter old) => old.color != color;
}

class _HeaderIcon extends StatelessWidget {
  const _HeaderIcon({required this.icon, required this.label, required this.onTap, this.badge, this.trailing, this.width});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Widget? badge;
  final Widget? trailing;
  final double? width;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: SizedBox(
            height: 40,
            width: width,
            child: Stack(clipBehavior: Clip.none, alignment: Alignment.center, children: [
              Padding(
                padding: EdgeInsets.symmetric(horizontal: width == null ? 8 : 0),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(icon, size: 20, color: Colors.white),
                  if (trailing != null) ...[const SizedBox(width: 6), trailing!],
                ]),
              ),
              ?badge,
            ]),
          ),
        ),
      );
}

class NotificationBell extends ConsumerStatefulWidget {
  const NotificationBell({super.key});

  @override
  ConsumerState<NotificationBell> createState() => _NotificationBellState();
}

/// Unread notifications (reloaded when the screen changes).
final unreadProvider = FutureProvider.autoDispose<int>((ref) async {
  final user = ref.watch(sessionProvider.select((s) => s.user));
  if (user == null) return 0;
  final r = await ref.read(apiProvider).getMap('/api/notifications');
  return r.integer('unread');
});

class _NotificationBellState extends ConsumerState<NotificationBell> {
  @override
  Widget build(BuildContext context) {
    final user = ref.watch(sessionProvider.select((s) => s.user));
    if (user == null) return const SizedBox.shrink();
    final count = ref.watch(unreadProvider).value ?? 0;
    final t = context.pc;
    return _HeaderIcon(
      icon: LucideIcons.bell,
      label: 'Notifications, $count unread',
      width: 40,
      onTap: () => context.push('/notifications'),
      badge: count > 0
          ? Positioned(
              right: 4,
              top: 4,
              child: Container(
                constraints: const BoxConstraints(minWidth: 18),
                padding: const EdgeInsets.symmetric(horizontal: 4),
                decoration: BoxDecoration(color: t.buy, borderRadius: BorderRadius.circular(999)),
                child: Text(count > 9 ? '9+' : '$count',
                    textAlign: TextAlign.center, style: Tw.px(11, line: 18, weight: Tw.bold, color: Colors.white)),
              ),
            )
          : null,
    );
  }
}

class AccountButton extends ConsumerWidget {
  const AccountButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    if (!s.ready) return const SizedBox(width: 40, height: 40);
    if (s.user == null) {
      return _HeaderIcon(
        icon: LucideIcons.user,
        label: 'Sign in',
        onTap: () => context.push('/login?next=${Uri.encodeComponent(GoRouterState.of(context).uri.toString())}'),
      );
    }
    return _HeaderIcon(
      icon: LucideIcons.user,
      label: 'Account menu',
      trailing: const Icon(LucideIcons.chevronDown, size: 16, color: Colors.white),
      onTap: () => showAccountMenu(context, ref),
    );
  }
}

/// The account menu (orders, wishlist, help, profile, selling, sign out) as a sheet.
Future<void> showAccountMenu(BuildContext context, WidgetRef ref) {
  final site = ref.read(siteValueProvider);
  final user = ref.read(sessionProvider).user;
  return showPcSheet<void>(context, title: 'Hello, ${user?.firstName.isNotEmpty == true ? user!.firstName : 'there'}', builder: (ctx) {
    final t = ctx.pc;
    Widget row(String label, VoidCallback onTap, {bool top = false}) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () {
            Navigator.of(ctx).pop();
            onTap();
          },
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: top ? BoxDecoration(border: Border(top: BorderSide(color: t.line))) : null,
            child: Text(label, style: Tw.body(color: t.ink)),
          ),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      row('Your orders', () => context.push('/orders')),
      row('Wishlist', () => context.push('/wishlist')),
      row('Help and support', () => openLink(context, '/support')),
      row('Contact us', () => openLink(context, '/contact')),
      row('Profile and addresses', () => context.push('/account')),
      row(user?.seller != null ? 'Seller dashboard' : 'Sell on ${site.brandName}', () => openLink(context, user?.seller != null ? '/seller' : '/sell')),
      row('Sign out', () => ref.read(sessionProvider.notifier).signOut(), top: true),
    ]);
  });
}

class CartButton extends ConsumerWidget {
  const CartButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(sessionProvider.select((s) => s.cartCount));
    final t = context.pc;
    return Semantics(
      button: true,
      label: 'Cart, $count items',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => context.go('/cart'),
        child: SizedBox(
          height: 40,
          width: 44,
          child: Stack(clipBehavior: Clip.none, children: [
            const Positioned(left: 12, top: 10, child: Icon(LucideIcons.shoppingCart, size: 20, color: Colors.white)),
            if (count > 0)
              Positioned(
                left: 24,
                top: -2,
                child: Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999)),
                  child: Text(count > 99 ? '99+' : '$count',
                      textAlign: TextAlign.center, style: Tw.px(12, line: 20, weight: Tw.bold, color: t.ink)),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------------ search */

const _recentKey = 'pc_recent_searches';

class SearchBox extends ConsumerStatefulWidget {
  const SearchBox({super.key});

  @override
  ConsumerState<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends ConsumerState<SearchBox> {
  final _q = TextEditingController();
  String _cat = '';
  String _lastUrlQ = '';

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final uri = GoRouterState.of(context).uri;
    final q = uri.path == '/search' ? (uri.queryParameters['q'] ?? '') : '';
    if (q != _lastUrlQ) {
      _lastUrlQ = q;
      _q.text = q;
      _cat = uri.queryParameters['category'] ?? _cat;
    }
  }

  Future<void> _open() async {
    final picked = await Navigator.of(context).push<String>(PageRouteBuilder(
      opaque: false,
      pageBuilder: (_, _, _) => SearchSheet(initial: _q.text, category: _cat),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
    if (picked == null || !mounted) return;
    if (picked.startsWith('/')) {
      await openLink(context, picked);
      return;
    }
    await go(picked);
  }

  Future<void> go(String text) async {
    final q = text.trim();
    if (q.isEmpty) return;
    await saveRecentSearch(ref, q);
    if (!mounted) return;
    _q.text = q;
    unawaited(context.push('/search?q=${Uri.encodeQueryComponent(q)}${_cat.isNotEmpty ? '&category=${Uri.encodeQueryComponent(_cat)}' : ''}'));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final cats = ref.watch(categoriesProvider).value ?? const <CategoryNode>[];
    final showCats = site.nav.flag('search_categories', true) && cats.isNotEmpty;
    final placeholder = 'Search ${site.brandName.isEmpty ? 'the store' : site.brandName}';
    return LayoutBuilder(builder: (context, c) {
      return Container(
        height: 44,
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusLg)),
        child: Row(children: [
          if (showCats)
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: c.maxWidth * 0.3),
              child: PcSelect<String>(
                value: _cat,
                title: 'Search in',
                height: 44,
                border: false,
                background: t.page,
                padding: const EdgeInsets.only(left: 8, right: 6),
                borderRadius: BorderRadius.horizontal(left: Radius.circular(t.radiusLg)),
                style: Tw.px(13, line: 20, color: t.inkSoft),
                options: [const SelectOption('', 'All'), for (final c in cats) SelectOption(c.slug, c.name)],
                onChanged: (v) => setState(() => _cat = v),
              ),
            ),
          if (showCats) Container(width: 1, color: t.line),
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _open,
              child: Padding(
                padding: const EdgeInsets.only(left: 12, right: 48),
                child: ValueListenableBuilder(
                  valueListenable: _q,
                  builder: (_, v, _) => Text(
                    v.text.isEmpty ? placeholder : v.text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Tw.body(color: v.text.isEmpty ? t.inkFaint : t.ink),
                  ),
                ),
              ),
            ),
          ),
        ]),
      );
    }).withSearchButton(onTap: () => _q.text.trim().isEmpty ? _open() : go(_q.text), color: t.accent, ink: t.ink, radius: 6);
  }
}

extension on Widget {
  Widget withSearchButton({required VoidCallback onTap, required Color color, required Color ink, required double radius}) => Stack(children: [
        this,
        Positioned(
          right: 4,
          top: 4,
          child: Semantics(
            button: true,
            label: 'Search',
            child: GestureDetector(
              onTap: onTap,
              child: Container(
                width: 40,
                height: 36,
                decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(radius)),
                child: Icon(LucideIcons.search, size: 20, color: ink),
              ),
            ),
          ),
        ),
      ]);
}

Future<List<String>> readRecentSearches(WidgetRef ref) async {
  try {
    final prefs = await ref.read(prefsProvider.future);
    return [for (final x in jsonDecode(prefs.getString(_recentKey) ?? '[]') as List) '$x'];
  } catch (_) {
    return [];
  }
}

Future<void> saveRecentSearch(WidgetRef ref, String q) async {
  final max = ref.read(siteValueProvider).list('recent_searches_max');
  if (max <= 0) return;
  final list = [q, ...(await readRecentSearches(ref)).where((x) => x.toLowerCase() != q.toLowerCase())].take(max).toList();
  final prefs = await ref.read(prefsProvider.future);
  await prefs.setString(_recentKey, jsonEncode(list));
}

/// Typing a search: the field on top, recent and trending searches, or suggestions from /api/catalog/suggest.
/// Pops with the query text, or with a path ("/p/slug", "/c/slug") for a suggestion.
class SearchSheet extends ConsumerStatefulWidget {
  const SearchSheet({super.key, this.initial = '', this.category = ''});
  final String initial;
  final String category;

  @override
  ConsumerState<SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends ConsumerState<SearchSheet> {
  late final _q = TextEditingController(text: widget.initial);
  List<String> _recent = [];
  List<Json> _products = [];
  List<Json> _cats = [];
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    readRecentSearches(ref).then((r) {
      if (mounted) setState(() => _recent = r.take(ref.read(siteValueProvider).list('recent_searches_max')).toList());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _q.dispose();
    super.dispose();
  }

  void _changed(String v) {
    _timer?.cancel();
    if (v.trim().length < 2) {
      setState(() {
        _products = [];
        _cats = [];
      });
      return;
    }
    _timer = Timer(const Duration(milliseconds: 160), () async {
      try {
        final r = await ref.read(apiProvider).getMap('/api/catalog/suggest', query: {'q': v.trim()});
        if (mounted) {
          setState(() {
            _products = r.maps('products');
            _cats = r.maps('categories');
          });
        }
      } catch (_) {}
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final empty = _q.text.trim().length < 2;
    Widget head(String text, {Widget? trailing}) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Row(children: [
            Expanded(child: Text(text.toUpperCase(), style: Tw.xs(weight: Tw.semibold, color: t.inkFaint).copyWith(letterSpacing: 0.3))),
            ?trailing,
          ]),
        );
    Widget row(IconData icon, String label, VoidCallback onTap) => InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(children: [
              Icon(icon, size: 16, color: t.inkFaint),
              const SizedBox(width: 8),
              Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: Tw.body(color: t.ink))),
            ]),
          ),
        );
    return Material(
      color: Colors.black.withValues(alpha: 0.35),
      child: SafeArea(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            color: t.primary,
            padding: const EdgeInsets.fromLTRB(4, 8, 12, 8),
            child: Row(children: [
              IconButton(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(LucideIcons.chevronLeft, color: Colors.white),
                tooltip: 'Back',
              ),
              Expanded(
                child: PcInput(
                  controller: _q,
                  autofocus: true,
                  height: 44,
                  placeholder: 'Search ${site.brandName.isEmpty ? 'the store' : site.brandName}',
                  textInputAction: TextInputAction.search,
                  onChanged: _changed,
                  onSubmitted: (v) => v.trim().isEmpty ? null : Navigator.of(context).pop(v.trim()),
                  semanticLabel: 'Search products',
                ),
              ),
            ]),
          ),
          Container(
            color: Colors.white,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              if (empty) ...[
                if (_recent.isNotEmpty) ...[
                  head('Recent searches',
                      trailing: GestureDetector(
                        onTap: () async {
                          await (await ref.read(prefsProvider.future)).remove(_recentKey);
                          setState(() => _recent = []);
                        },
                        child: Text('Clear', style: Tw.xs(weight: Tw.semibold, color: t.primary)),
                      )),
                  for (final r in _recent) row(LucideIcons.clock, r, () => Navigator.of(context).pop(r)),
                ],
                if (site.trending.isNotEmpty) ...[
                  head('Trending'),
                  for (final r in site.trending) row(LucideIcons.trendingUp, r, () => Navigator.of(context).pop(r)),
                ],
              ] else ...[
                for (final c in _cats) row(LucideIcons.layoutGrid, c.str('name'), () => Navigator.of(context).pop('/c/${c.str('slug')}')),
                for (final p in _products)
                  row(LucideIcons.search, p.str('title'), () {
                    saveRecentSearch(ref, _q.text.trim());
                    Navigator.of(context).pop('/p/${p.str('slug')}');
                  }),
              ],
              const SizedBox(height: 4),
            ]),
          ),
          Expanded(child: GestureDetector(onTap: () => Navigator.of(context).pop())),
        ]),
      ),
    );
  }
}

/* ------------------------------------------------------------------ second bar */

class NavBar extends ConsumerWidget {
  const NavBar({super.key, this.showPin = true});
  final bool showPin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final cats = ref.watch(categoriesProvider).value ?? const <CategoryNode>[];
    return SizedBox(
      height: 32,
      child: Row(children: [
        if (site.nav.flag('all_menu', true))
          GestureDetector(
            onTap: () => showAllMenu(context, ref),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(children: [
                Icon(LucideIcons.menu, size: 20, color: t.ink),
                const SizedBox(width: 4),
                Text('All', style: Tw.body(weight: Tw.semibold, color: t.ink)),
              ]),
            ),
          ),
        const SizedBox(width: 4),
        if (showPin) const Flexible(child: DeliverTo()),
        Container(width: 1, height: 20, margin: const EdgeInsets.symmetric(horizontal: 8), color: t.line),
        Expanded(
          child: ListView(scrollDirection: Axis.horizontal, children: [
            for (final l in site.navLinks)
              _NavChip(label: site.fill(l.label), onTap: () => openLink(context, l.href), strong: true),
            if (site.nav.flag('show_categories', true))
              for (final c in cats) _NavChip(label: c.name, onTap: () => context.push('/c/${c.slug}')),
          ]),
        ),
      ]),
    );
  }
}

class _NavChip extends StatelessWidget {
  const _NavChip({required this.label, required this.onTap, this.strong = false});
  final String label;
  final VoidCallback onTap;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(right: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        alignment: Alignment.center,
        child: Text(label, style: Tw.body(weight: strong ? Tw.semibold : Tw.medium, color: strong ? t.ink : t.inkSoft)),
      ),
    );
  }
}

/// "Deliver to 641001": one PIN code for the whole visit.
class DeliverTo extends ConsumerWidget {
  const DeliverTo({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final pin = ref.watch(pincodeProvider);
    return GestureDetector(
      onTap: () => showPinSheet(context, ref),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(LucideIcons.mapPin, size: 16, color: t.primary),
          const SizedBox(width: 4),
          if (pin.isNotEmpty)
            Flexible(child: Text.rich(maxLines: 1, overflow: TextOverflow.ellipsis, TextSpan(children: [
              TextSpan(text: 'Deliver to ', style: Tw.px(14, line: 22.75, color: t.inkSoft)),
              TextSpan(text: pin, style: Tw.px(14, line: 22.75, weight: Tw.semibold, color: t.ink)),
            ])))
          else
            Flexible(child: Text('Set delivery PIN', maxLines: 1, overflow: TextOverflow.ellipsis, style: Tw.px(14, line: 22.75, weight: Tw.semibold, color: t.inkSoft))),
          const SizedBox(width: 4),
          Icon(LucideIcons.chevronDown, size: 14, color: t.inkSoft),
        ]),
      ),
    );
  }
}

Future<void> showPinSheet(BuildContext context, WidgetRef ref) {
  final ctrl = TextEditingController(text: ref.read(pincodeProvider));
  String? error;
  final user = ref.read(sessionProvider).user;
  return showPcSheet<void>(context, title: 'Choose your location', builder: (ctx) {
    return StatefulBuilder(builder: (ctx, setState) {
      final t = ctx.pc;
      void apply() {
        if (!isPincode(ctrl.text)) {
          setState(() => error = 'Enter a valid 6-digit PIN code');
          return;
        }
        ref.read(pincodeProvider.notifier).set(ctrl.text);
        Navigator.of(ctx).pop();
      }

      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Text('Delivery dates, charges and cash on delivery depend on where you are.', style: Tw.sm(color: t.inkSoft)),
        const SizedBox(height: 12),
        if (user != null)
          FutureBuilder(
            future: ref.read(apiProvider).getList('/api/addresses'),
            builder: (_, snap) {
              final list = [for (final a in snap.data ?? const []) Address(asMap(a))];
              if (list.isEmpty) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Column(children: [
                  for (final a in list)
                    GestureDetector(
                      onTap: () {
                        ref.read(pincodeProvider.notifier).set(a.pincode);
                        Navigator.of(ctx).pop();
                      },
                      child: Container(
                        width: double.infinity,
                        margin: const EdgeInsets.only(bottom: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: a.pincode == ctrl.text ? t.primaryLight : Colors.white,
                          borderRadius: BorderRadius.circular(t.radiusLg),
                          border: Border.all(color: a.pincode == ctrl.text ? t.primary : t.line),
                        ),
                        child: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: [
                          TextSpan(text: a.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
                          TextSpan(text: ' · ${a.city} ${a.pincode}'),
                        ])),
                      ),
                    ),
                ]),
              );
            },
          ),
        Row(children: [
          Expanded(
            child: PcInput(
              controller: ctrl,
              autofocus: true,
              placeholder: 'Enter PIN code',
              keyboardType: TextInputType.number,
              maxLength: 6,
              onChanged: (_) => setState(() => error = null),
              onSubmitted: (_) => apply(),
              semanticLabel: 'PIN code',
            ),
          ),
          const SizedBox(width: 8),
          PcButton.text('Apply', onPressed: apply),
        ]),
        if (error != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(error!, style: Tw.sm(color: t.buy))),
        if (user == null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: GestureDetector(
              onTap: () {
                Navigator.of(ctx).pop();
                context.push('/login');
              },
              child: Text.rich(TextSpan(style: Tw.xs(color: t.inkFaint), children: [
                TextSpan(text: 'Sign in', style: TextStyle(fontWeight: FontWeight.w600, color: t.primary)),
                const TextSpan(text: ' to use your saved addresses.'),
              ])),
            ),
          ),
      ]);
    });
  });
}

/// The "All" side menu: account, popular pages, every category, programmes and help.
Future<void> showAllMenu(BuildContext context, WidgetRef ref) {
  return Navigator.of(context).push(PageRouteBuilder(
    opaque: false,
    barrierDismissible: true,
    pageBuilder: (_, _, _) => const _AllMenu(),
    transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
  ));
}

class _AllMenu extends ConsumerStatefulWidget {
  const _AllMenu();

  @override
  ConsumerState<_AllMenu> createState() => _AllMenuState();
}

class _AllMenuState extends ConsumerState<_AllMenu> {
  String? _expanded;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final user = ref.watch(sessionProvider).user;
    final cats = ref.watch(categoriesProvider).value ?? const <CategoryNode>[];
    void go(String href) {
      Navigator.of(context).pop();
      openLink(context, href);
    }

    Widget row(String label, VoidCallback onTap, {Widget? trailing}) => InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
            child: Row(children: [Expanded(child: Text(label, style: Tw.body(color: t.ink))), ?trailing]),
          ),
        );
    Widget section(String title, List<Widget> rows, {bool last = false}) => Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: last ? null : BoxDecoration(border: Border(bottom: BorderSide(color: t.line))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8), child: Text(title, style: Tw.lg(weight: Tw.semibold, color: t.ink))),
            ...rows,
          ]),
        );
    final width = (MediaQuery.sizeOf(context).width * 0.86).clamp(0.0, 365.0);
    return Material(
      color: t.ink.withValues(alpha: 0.6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: width,
          color: Colors.white,
          child: ListView(padding: EdgeInsets.zero, children: [
            Container(
              color: t.primary,
              padding: EdgeInsets.fromLTRB(24, 16 + MediaQuery.paddingOf(context).top, 24, 16),
              child: Row(children: [
                Container(
                  width: 28,
                  height: 28,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.2), shape: BoxShape.circle),
                  child: const Icon(LucideIcons.user, size: 20, color: Colors.white),
                ),
                const SizedBox(width: 8),
                GestureDetector(
                  onTap: user == null ? () => go('/login') : null,
                  child: Text(user == null ? 'Hello, sign in' : 'Hello, ${user.firstName.isEmpty ? 'there' : user.firstName}',
                      style: Tw.lg(weight: Tw.semibold, color: Colors.white)),
                ),
              ]),
            ),
            if (site.navLinks.isNotEmpty) section('Trending', [for (final l in site.navLinks) row(site.fill(l.label), () => go(l.href))]),
            section('Shop by category', [
              for (final c in cats) ...[
                if (c.children.isEmpty)
                  row(c.name, () => go('/c/${c.slug}'))
                else
                  row(c.name, () => setState(() => _expanded = _expanded == c.slug ? null : c.slug),
                      trailing: AnimatedRotation(
                        turns: _expanded == c.slug ? 0.25 : 0,
                        duration: const Duration(milliseconds: 150),
                        child: Icon(LucideIcons.chevronRight, size: 16, color: t.inkFaint),
                      )),
                if (_expanded == c.slug)
                  Container(
                    color: t.page.withValues(alpha: 0.6),
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      InkWell(
                        onTap: () => go('/c/${c.slug}'),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 8),
                          child: Text('All of ${c.name}', style: Tw.sm(weight: Tw.semibold, color: t.primary)),
                        ),
                      ),
                      for (final ch in c.children)
                        InkWell(
                          onTap: () => go('/c/${ch.slug}'),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 8),
                            child: Text(ch.name, style: Tw.sm(color: t.ink)),
                          ),
                        ),
                    ]),
                  ),
              ],
            ]),
            section('Programs and features', [
              for (final l in site.drawerLinks) row(site.fill(l.label), () => go(l.href)),
              if (site.feature('wishlist')) row('Your wishlist', () => go('/wishlist')),
            ]),
            section('Help and settings', [
              row('Your account', () => go('/account')),
              row('Your orders', () => go('/orders')),
              row('Customer service', () => go('/help')),
              if (user != null)
                row('Sign out', () {
                  Navigator.of(context).pop();
                  ref.read(sessionProvider.notifier).signOut();
                })
              else
                row('Sign in', () => go('/login')),
            ], last: true),
          ]),
        ),
        Padding(
          padding: EdgeInsets.only(left: 8, top: 12 + MediaQuery.paddingOf(context).top),
          child: IconButton(
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(LucideIcons.x, size: 28, color: Colors.white),
            tooltip: 'Close menu',
          ),
        ),
        Expanded(child: GestureDetector(onTap: () => Navigator.of(context).pop())),
      ]),
    );
  }
}
