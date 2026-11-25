// The home page (app/(shop)/page.tsx + components/home-sections.tsx): the sections from Admin → Storefront → Home
// page, in the theme's layout, as phones show them (sections for "desktop" only are left out).

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/category_icon.dart';
import '../shop/frame.dart';
import '../shop/product.dart';
import '../shop/wishlist.dart';
import 'home_blocks.dart';

final homeProvider = FutureProvider.autoDispose<List<HomeSection>>((ref) async {
  final r = await ref.read(apiProvider).getMap('/api/home');
  return r.list('sections', HomeSection.new);
});

const _sourceLink = {
  'deals': '/deals?tab=discounts',
  'deals_live': '/deals',
  'bestsellers': '/bestsellers',
  'top_rated': '/search?sort=rating',
  'new': '/new-releases',
};

const _uspIcons = {
  'badge': LucideIcons.badgeCheck,
  'wallet': LucideIcons.wallet,
  'truck': LucideIcons.truck,
  'return': LucideIcons.rotateCcw,
  'shield': LucideIcons.shieldCheck,
  'gift': LucideIcons.gift,
  'support': LucideIcons.headphones,
  'check': LucideIcons.check,
};

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    return ShopBody(
      back: false,
      onRefresh: () async => ref.invalidate(homeProvider),
      children: [
        home.when(
          data: (sections) => HomeSections(sections: sections),
          loading: () => const HomeSkeleton(),
          error: (_, _) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 80),
            child: Text('The store is waking up. Refresh the page in a moment.',
                textAlign: TextAlign.center, style: Tw.body(color: context.pc.inkSoft)),
          ),
        ),
      ],
    );
  }
}

class HomeSkeleton extends StatelessWidget {
  const HomeSkeleton({super.key});

  @override
  Widget build(BuildContext context) => const Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DelayedFallback(child: SkeletonBlock(height: 260)),
        SizedBox(height: 16),
        ProductGridSkeleton(count: 4),
      ]);
}

class HomeSections extends ConsumerWidget {
  const HomeSections({super.key, required this.sections});
  final List<HomeSection> sections;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final plain = t.option('sections') == 'plain';
    final children = <Widget>[];
    for (final s in sections) {
      if (s.device == 'desktop') continue;
      final body = _section(context, ref, s, plain);
      if (body != null) children.add(body);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (var i = 0; i < children.length; i++) ...[if (i > 0) SizedBox(height: plain ? 32 : 16), children[i]],
    ]);
  }

  Widget? _section(BuildContext context, WidgetRef ref, HomeSection s, bool plain) {
    final t = context.pc;
    final c = s.config;
    final site = ref.read(siteValueProvider);
    Widget title(String text, {TextAlign? align}) => Text(text, textAlign: align, style: Tw.heading(plain ? 24 : 20, color: t.ink));
    switch (s.kind) {
      case 'hero':
        final slides = c.maps('slides');
        if (slides.isEmpty) return null;
        return HeroCarousel(slides: slides, autoplay: c['autoplay'] != false, interval: c.integer('interval', 5), fade: c.str('style') == 'fade');
      case 'categories':
        if (s.categories.isEmpty) return null;
        final style = const {'circles', 'cards', 'squares', 'chips'}.contains(c.str('style')) ? c.str('style') : t.option('categories');
        return ShopPanel(
          padding: style == 'circles' ? const EdgeInsets.symmetric(horizontal: 8, vertical: 12) : const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (s.title.isNotEmpty)
              Padding(
                padding: EdgeInsets.only(bottom: 12, left: style == 'circles' && !plain ? 8 : 0),
                child: title(s.title, align: style == 'chips' ? TextAlign.center : null),
              ),
            HomeCategories(cats: s.categories, style: style),
          ]),
        );
      case 'products':
        if (s.products.isEmpty) return null;
        final href = c.str('see_all').isNotEmpty
            ? c.str('see_all')
            : (c.str('source') == 'category' ? '/c/${c.str('category_slug')}' : _sourceLink[c.str('source')]);
        if (c.str('layout') == 'grid') {
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (s.title.isNotEmpty)
              Padding(
                padding: EdgeInsets.fromLTRB(plain ? 0 : 4, 0, plain ? 0 : 4, 12),
                child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Expanded(child: title(s.title)),
                  if (href != null) PcLink('See all', onTap: () => context.push(href)),
                ]),
              ),
            ProductGrid(items: s.products, showAdd: c.flag('show_add'), ranked: c.flag('ranked')),
          ]);
        }
        return ProductRail(title: s.title, items: s.products, href: href, showAdd: c.flag('show_add'), ranked: c.flag('ranked'));
      case 'banner':
        return MediaBanner(cfg: c);
      case 'banner_grid':
        final items = c.maps('items');
        if (items.isEmpty) return null;
        return LayoutBuilder(builder: (_, box) {
          final w = (box.maxWidth - 12) / 2;
          return Wrap(spacing: 12, runSpacing: 12, children: [
            for (final b in items) SizedBox(width: w, child: MediaBanner(cfg: b, compact: true)),
          ]);
        });
      case 'media':
        return MediaBlock(cfg: c, title: s.title);
      case 'text':
        return ShopPanel(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: c.str('align') == 'center' ? CrossAxisAlignment.center : CrossAxisAlignment.start,
            children: [
              if (s.title.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(s.title, style: Tw.heading(24, color: t.ink))),
              MiniMarkdown(site.fill(c.str('markdown'))),
            ],
          ),
        );
      case 'usp':
        final items = c.maps('items');
        if (items.isEmpty) return null;
        return Container(
          decoration: BoxDecoration(color: t.line, borderRadius: BorderRadius.circular(t.radiusXl), border: Border.all(color: t.line)),
          clipBehavior: Clip.antiAlias,
          child: LayoutBuilder(builder: (_, box) {
            final w = (box.maxWidth - 1) / 2;
            return Wrap(spacing: 1, runSpacing: 1, children: [
              for (final it in items)
                Container(
                  width: w,
                  color: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Row(children: [
                    Icon(_uspIcons[it.str('icon')] ?? LucideIcons.check, size: 20, color: t.primary),
                    const SizedBox(width: 10),
                    Expanded(child: Text(site.fill(it.str('text')), style: Tw.sm(color: t.inkSoft))),
                  ]),
                ),
            ]);
          }),
        );
      case 'recent':
        return _Recent(title: s.title);
      case 'cards':
        return CardRow(cards: c.maps('cards'));
      case 'deals':
        return DealsRail(title: s.title, items: s.products);
      case 'sponsored':
        return FetchedRail(
          url: '/api/ads/serve?placement=home&limit=${c.integer('limit', 10)}',
          title: s.title.isEmpty ? 'Sponsored products' : s.title,
          note: 'Sponsored',
        );
      case 'countdown':
        return CountdownBanner(title: s.title, cfg: c);
      case 'signin':
        return SigninPrompt(heading: c.str('heading'), text: c.str('text'));
      case 'inspired':
        return InspiredRail(title: s.title, limit: c.integer('limit', 12));
      case 'buy_again':
        return BuyAgainRail(title: s.title, limit: c.integer('limit', 12));
    }
    return null;
  }
}

/// The category block in four styles (circles, cards, squares, chips).
class HomeCategories extends StatelessWidget {
  const HomeCategories({super.key, required this.cats, required this.style});
  final List<CategoryNode> cats;
  final String style;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    Widget picture(CategoryNode c, double size, double radius, double icon) => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: t.primaryLight, borderRadius: BorderRadius.circular(radius)),
          clipBehavior: Clip.antiAlias,
          alignment: Alignment.center,
          child: c.imageUrl.isNotEmpty
              ? ProductImage(src: c.imageUrl, fit: BoxFit.cover, width: size, height: size)
              : CategoryIcon(slug: c.slug, size: icon, color: t.primary),
        );
    if (style == 'chips') {
      return Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
        for (final c in cats)
          GestureDetector(
            onTap: () => context.push('/c/${c.slug}'),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusLg), border: Border.all(color: t.line)),
              child: Text(c.name, style: Tw.sm(weight: Tw.medium, color: t.ink)),
            ),
          ),
      ]);
    }
    if (style == 'cards' || style == 'squares') {
      final cards = style == 'cards';
      final cols = cards ? 3 : 4;
      final gap = cards ? 10.0 : 8.0;
      return LayoutBuilder(builder: (_, box) {
        final w = (box.maxWidth - gap * (cols - 1)) / cols;
        return Wrap(spacing: gap, runSpacing: cards ? 10 : 12, children: [
          for (final c in cats)
            GestureDetector(
              onTap: () => context.push('/c/${c.slug}'),
              child: Container(
                width: w,
                padding: cards ? const EdgeInsets.all(10) : EdgeInsets.zero,
                decoration: cards ? BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl), boxShadow: cardShadow(t)) : null,
                child: Column(children: [
                  picture(c, cards ? w - 20 : w, cards ? t.radiusLg : t.radius2xl, cards ? 36 : 32),
                  const SizedBox(height: 6),
                  Text(c.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: Tw.px(cards ? 13 : 12, line: cards ? 16.25 : 15, weight: Tw.semibold, color: t.ink)),
                ]),
              ),
            ),
        ]);
      });
    }
    // circles: the original look, a row that swipes
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final c in cats)
          GestureDetector(
            onTap: () => context.push('/c/${c.slug}'),
            child: Container(
              width: 84,
              margin: const EdgeInsets.only(right: 4),
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: Column(children: [
                picture(c, 56, 28, 28),
                const SizedBox(height: 6),
                Text(c.name, textAlign: TextAlign.center, style: Tw.px(13, line: 16.25, weight: Tw.medium, color: t.ink)),
              ]),
            ),
          ),
      ]),
    );
  }
}

class _Recent extends ConsumerWidget {
  const _Recent({required this.title});
  final String title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(viewedProvider).value ?? const <Json>[];
    if (items.length < 2) return const SizedBox.shrink();
    final t = context.pc;
    return ShopPanel(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(title.isEmpty ? 'Recently viewed' : title, style: Tw.heading(20, color: t.ink))),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final p in items)
              GestureDetector(
                onTap: () => context.push('/p/${p.str('slug')}'),
                child: Container(
                  width: 128,
                  margin: const EdgeInsets.only(right: 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Container(
                      width: 128,
                      height: 128,
                      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusLg), border: Border.all(color: t.line)),
                      clipBehavior: Clip.antiAlias,
                      child: ProductImage(src: p.str('image'), alt: p.str('title')),
                    ),
                    const SizedBox(height: 4),
                    Text(p.str('title'), maxLines: 2, overflow: TextOverflow.ellipsis, style: Tw.sm(color: t.ink)),
                    Text(rupees(p.integer('price')), style: Tw.display(15, 24.375, color: t.ink)),
                  ]),
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
