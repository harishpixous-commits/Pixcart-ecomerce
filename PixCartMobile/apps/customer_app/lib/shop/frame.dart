// The shop's frame (themes/shop-frame.tsx) for phones: the sticky header, the page with the back bar, "Back to top",
// the region strip and the footer, the bottom tab bar and the help button.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import 'header.dart';
import 'links.dart';

/// The shell around every shop route: header on top, tab bar at the bottom, toasts above it.
class ShopFrame extends ConsumerWidget {
  const ShopFrame({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    return ToastHost(
      child: Scaffold(
        backgroundColor: t.page,
        resizeToAvoidBottomInset: true,
        body: SafeArea(
          bottom: false,
          child: Column(children: [
            const ShopHeader(),
            Expanded(child: Stack(children: [child, const Positioned(right: 16, bottom: 24, child: HelpLauncher())])),
          ]),
        ),
        bottomNavigationBar: const MobileTabBar(),
      ),
    );
  }
}

/// The scrolling page: the back bar (not on the home page), the content (px-3 py-4), "Back to top", the region
/// strip and the footer. [children] are laid out like the page's main column.
class ShopBody extends ConsumerStatefulWidget {
  const ShopBody({super.key, required this.children, this.back, this.onRefresh, this.gap = 0, this.padding, this.bottom, this.controller});
  final List<Widget> children;

  /// the back bar (default: on every page but the home page)
  final bool? back;
  final Future<void> Function()? onRefresh;
  final double gap;
  final EdgeInsets? padding;

  /// a bar that stays at the bottom of the page (cart total, buy bar)
  final Widget? bottom;
  final ScrollController? controller;

  @override
  ConsumerState<ShopBody> createState() => _ShopBodyState();
}

class _ShopBodyState extends ConsumerState<ShopBody> {
  late final ScrollController _scroll = widget.controller ?? ScrollController();

  @override
  void dispose() {
    if (widget.controller == null) _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final site = ref.watch(siteValueProvider);
    final main = Padding(
      padding: widget.padding ?? const EdgeInsets.fromLTRB(12, 16, 12, 16),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: MediaQuery.sizeOf(context).height * 0.6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (var i = 0; i < widget.children.length; i++) ...[
            if (i > 0 && widget.gap > 0) SizedBox(height: widget.gap),
            widget.children[i],
          ],
        ]),
      ),
    );
    Widget list = SingleChildScrollView(
      controller: _scroll,
      physics: const AlwaysScrollableScrollPhysics(),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (widget.back ?? GoRouterState.of(context).uri.path != '/') const BackBar(),
        main,
        if (site.homeExtras.flag('back_to_top', true))
          BackToTop(onTap: () => _scroll.animateTo(0, duration: const Duration(milliseconds: 400), curve: Curves.easeOut)),
        const RegionStrip(),
        const ShopFooter(),
      ]),
    );
    if (widget.onRefresh != null) list = RefreshIndicator(onRefresh: widget.onRefresh!, child: list);
    if (widget.bottom == null) return list;
    return Column(children: [Expanded(child: list), widget.bottom!]);
  }
}

/// The parent page for a shop address: /orders/123 → /orders.
String shopParent(String path) {
  final parts = path.split('/').where((p) => p.isNotEmpty).toList();
  if (parts.length <= 1) return '/';
  if (['p', 'c', 'store', 'pages'].contains(parts.first)) return '/';
  return '/${parts.first}';
}

void goBack(BuildContext context) {
  if (context.canPop()) {
    context.pop();
  } else {
    context.go(shopParent(GoRouterState.of(context).uri.path));
  }
}

class BackBar extends StatelessWidget {
  const BackBar({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 12, 0),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Semantics(
          button: true,
          label: 'Go back',
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => goBack(context),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 4, 8, 4),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.chevronLeft, size: 20, color: t.primary),
                const SizedBox(width: 2),
                Text('Back', style: Tw.sm(weight: Tw.semibold, color: t.primary)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class BackToTop extends StatelessWidget {
  const BackToTop({super.key, required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(top: 24),
        padding: const EdgeInsets.symmetric(vertical: 14),
        color: t.primaryDark.withValues(alpha: 0.9),
        alignment: Alignment.center,
        child: Text('Back to top', style: Tw.sm(weight: Tw.semibold, color: Colors.white)),
      ),
    );
  }
}

String _languageName(String code) => const {'en': 'English', 'hi': 'हिन्दी', 'ta': 'தமிழ்'}[code] ?? code;

String currencyName(String code) {
  const names = {'INR': 'Indian Rupee', 'USD': 'US Dollar', 'EUR': 'Euro', 'GBP': 'British Pound', 'AED': 'UAE Dirham', 'SGD': 'Singapore Dollar'};
  final sym = narrowSymbol(code);
  return '${names[code] ?? code} ($code${sym != code ? ' $sym' : ''})';
}

/// "Pay with" logos and the language and currency (components/region-picker.tsx RegionStrip).
class RegionStrip extends ConsumerWidget {
  const RegionStrip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final reg = ref.watch(regionalProvider).value;
    final networks = reg?.cardNetworks ?? const ['visa', 'mastercard', 'rupay', 'amex', 'diners'];
    final methods = reg?.payMethods ?? const {'upi': true, 'card': true, 'netbanking': true, 'wallet': true, 'emi': true, 'paylater': true};
    final has = reg != null && reg.showSwitcher && (reg.currencies.length > 1 || reg.raw.maps('languages').length > 1);
    return Container(
      decoration: BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: t.line))),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Column(children: [
        Center(child: AcceptedPayments(networks: networks, methods: methods, cod: true, label: 'Pay with')),
        if (has) ...[
          const SizedBox(height: 12),
          Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, runSpacing: 4, children: [
            Icon(LucideIcons.globe, size: 16, color: t.primary),
            Text(_languageName('en'), style: Tw.sm(color: t.inkSoft)),
            if (reg.currencies.length > 1) Text('· ${currencyName(reg.currency)}', style: Tw.sm(color: t.inkSoft)),
            GestureDetector(
              onTap: () => showRegionSheet(context, ref),
              child: Text('Change', style: Tw.sm(weight: Tw.semibold, color: t.primary)),
            ),
          ]),
        ],
      ]),
    );
  }
}

Future<void> showRegionSheet(BuildContext context, WidgetRef ref) {
  final reg = ref.read(regionalProvider).value;
  if (reg == null) return Future.value();
  return showPcSheet<void>(context, title: 'Language and currency', builder: (ctx) {
    final t = ctx.pc;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Currency', style: Tw.sm(weight: Tw.medium, color: t.ink)),
      const SizedBox(height: 4),
      PcSelect<String>(
        value: reg.currency,
        title: 'Currency',
        options: [for (final c in reg.currencies) SelectOption(c.str('code'), currencyName(c.str('code')))],
        onChanged: (v) {
          ref.read(regionalProvider.notifier).setCurrency(v);
          Navigator.of(ctx).pop();
        },
      ),
      const SizedBox(height: 8),
      Text('Prices are shown in your currency; you pay in rupees.', style: Tw.xs(color: t.inkFaint)),
    ]);
  });
}

String fillCopyright(String template, {required String legalName, required String brand}) => template
    .replaceAll('{year}', '${DateTime.now().year}')
    .replaceAll('{legal_name}', legalName)
    .replaceAll('{brand}', brand);

class ShopFooter extends ConsumerWidget {
  const ShopFooter({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final b = site.business;
    final f = site.raw.obj('footer');
    final legal = b.str('legal_name').isEmpty ? site.brandName : b.str('legal_name');
    final g = b.obj('grievance');
    final white80 = Colors.white.withValues(alpha: 0.8);
    final columns = site.raw.maps('footer_columns');
    final business = f.flag('show_business', true) &&
            (b.str('registered_address').isNotEmpty || (f.flag('show_gstin', true) && b.str('gstin').isNotEmpty) || b.str('cin').isNotEmpty)
        ? [
            b.str('legal_name'),
            if (b.str('registered_address').isNotEmpty) 'Registered office: ${b.str('registered_address')}',
            if (f.flag('show_gstin', true) && b.str('gstin').isNotEmpty) 'GSTIN ${b.str('gstin')}',
            if (b.str('cin').isNotEmpty) 'CIN ${b.str('cin')}',
          ].where((s) => s.isNotEmpty).join('. ')
        : '';
    return Container(
      margin: const EdgeInsets.only(top: 48),
      color: t.primaryDark,
      padding: const EdgeInsets.only(bottom: 80),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 40),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Logo(),
            if (site.tagline.isNotEmpty) ...[const SizedBox(height: 12), Text(site.tagline, style: Tw.sm(color: white80))],
            for (final col in columns) ...[
              const SizedBox(height: 32),
              Text(col.str('title'), style: Tw.sm(weight: Tw.semibold, color: Colors.white)),
              for (final l in col.maps('links')) ...[
                const SizedBox(height: 6),
                GestureDetector(onTap: () => openLink(context, l.str('href')), child: Text(l.str('label'), style: Tw.sm(color: white80))),
              ],
            ],
            if (f.flag('show_grievance', true) && g.str('name').isNotEmpty) ...[
              const SizedBox(height: 32),
              Text('Grievance officer', style: Tw.sm(weight: Tw.semibold, color: Colors.white)),
              Text('${g.str('name')}${g.str('designation').isNotEmpty ? ', ${g.str('designation')}' : ''}', style: Tw.sm(color: white80)),
              if (g.str('email').isNotEmpty) Text(g.str('email'), style: Tw.sm(color: white80)),
              if (g.str('phone').isNotEmpty) Text(g.str('phone'), style: Tw.sm(color: white80)),
            ],
          ]),
        ),
        Container(
          decoration: BoxDecoration(border: Border(top: BorderSide(color: Colors.white.withValues(alpha: 0.1)))),
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (f.str('copyright').isNotEmpty)
              Text(fillCopyright(f.str('copyright'), legalName: legal, brand: site.brandName), style: Tw.xs(color: Colors.white.withValues(alpha: 0.6))),
            if (business.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(business, style: Tw.xs(color: Colors.white.withValues(alpha: 0.6)))),
          ]),
        ),
      ]),
    );
  }
}

class MobileTabBar extends ConsumerWidget {
  const MobileTabBar({super.key});

  static const tabs = [
    ('/', 'Home', LucideIcons.home),
    ('/categories', 'Categories', LucideIcons.layoutGrid),
    ('/orders', 'Orders', LucideIcons.package),
    ('/cart', 'Cart', LucideIcons.shoppingCart),
    ('/account', 'Account', LucideIcons.user),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final path = GoRouterState.of(context).uri.path;
    final cartCount = ref.watch(sessionProvider.select((s) => s.cartCount));
    return Container(
      decoration: BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: t.line))),
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      child: Row(children: [
        for (final (href, label, icon) in tabs)
          Expanded(
            child: Semantics(
              button: true,
              selected: href == '/' ? path == '/' : path.startsWith(href),
              label: label,
              excludeSemantics: true,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => context.go(href),
                child: LayoutBuilder(builder: (_, c) {
                  final active = href == '/' ? path == '/' : path.startsWith(href);
                  final color = active ? t.primary : t.inkFaint;
                  return Stack(children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Center(child: Icon(icon, size: 20, color: color)),
                        const SizedBox(height: 2),
                        Text(label, style: Tw.px(11, line: 11 * 1.625, weight: Tw.medium, color: color)),
                      ]),
                    ),
                    if (href == '/cart' && cartCount > 0)
                      Positioned(
                        right: c.maxWidth * 0.22,
                        top: 4,
                        child: Container(width: 8, height: 8, decoration: BoxDecoration(color: t.buy, shape: BoxShape.circle)),
                      ),
                  ]);
                }),
              ),
            ),
          ),
      ]),
    );
  }
}

/// The help button (shop assistant launcher): opens help and support.
class HelpLauncher extends StatelessWidget {
  const HelpLauncher({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Semantics(
      button: true,
      label: 'Open help',
      child: GestureDetector(
        onTap: () => openLink(context, '/support'),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(color: t.primary, borderRadius: BorderRadius.circular(999), boxShadow: shadowLg),
          child: const Icon(LucideIcons.messageCircle, size: 20, color: Colors.white),
        ),
      ),
    );
  }
}
