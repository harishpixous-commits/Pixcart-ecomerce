// Home page blocks (components/home-blocks.tsx and components/home-media.tsx): the hero carousel, card rows, the
// deals rail with its timer, sponsored and personal rails, countdown banners, the sign-in prompt, banners and the
// image block. Videos show their poster picture (the app has no video player yet).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/links.dart';
import '../shop/product.dart';
import '../shop/wishlist.dart';

/// Storefront text with {brand} and {free_delivery_amount} filled in.
String fillText(WidgetRef ref, String? text) => ref.read(siteValueProvider).fill(text ?? '');

/// A product list from the API (`{items: [...]}`), loaded once per URL.
final productListProvider = FutureProvider.autoDispose.family<List<ProductCard>, String>((ref, url) async {
  final uri = Uri.parse(url);
  final r = await ref.read(apiProvider).getMap(uri.path, query: uri.queryParameters);
  return r.list('items', ProductCard.new);
});

/// A picture that fills its box (object-cover).
class CoverImage extends StatelessWidget {
  const CoverImage(this.src, {super.key, this.fit = BoxFit.cover});
  final String src;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) => src.isEmpty
      ? const SizedBox.shrink()
      : Image.network(mediaUrl(src), fit: fit, width: double.infinity, height: double.infinity, gaplessPlayback: true, errorBuilder: (_, _, _) => const SizedBox.shrink());
}

/* ---------------------------------------------------------------- hero carousel */

class HeroCarousel extends ConsumerStatefulWidget {
  const HeroCarousel({super.key, required this.slides, this.autoplay = true, this.interval = 5, this.fade = false});
  final List<Json> slides;
  final bool autoplay;
  final int interval;

  /// "fade": full width with a fade into the page under it (phones: 4:3); otherwise a rounded 16:11 box.
  final bool fade;

  @override
  ConsumerState<HeroCarousel> createState() => _HeroCarouselState();
}

class _HeroCarouselState extends ConsumerState<HeroCarousel> {
  int _i = 0;
  bool _stopped = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    if (!widget.autoplay || _stopped || widget.slides.length < 2) return;
    _timer = Timer.periodic(Duration(seconds: widget.interval < 3 ? 3 : widget.interval), (_) {
      if (mounted) setState(() => _i = (_i + 1) % widget.slides.length);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _go(int d) {
    setState(() => _i = (_i + d + widget.slides.length) % widget.slides.length);
    _schedule();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.slides.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final s = widget.slides[_i.clamp(0, widget.slides.length - 1)];
    final dark = s.str('theme') == 'dark';
    final center = s.str('align') == 'center';
    final fade = widget.fade;
    String tx(String k) => fillText(ref, s.str(k));
    final heading = tx('heading');
    final text = tx('text');
    final offer = tx('offer');
    final note = tx('note');
    final hasVideo = widget.slides.any((x) => x.str('video').isNotEmpty);

    Widget offerNote() => Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (offer.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.95), borderRadius: BorderRadius.circular(t.radiusLg), boxShadow: shadowSm),
              child: Text(offer, style: Tw.xs(weight: Tw.semibold, color: t.ink)),
            ),
          if (note.isNotEmpty) Text(note, style: Tw.px(11, color: dark ? t.inkSoft : Colors.white.withValues(alpha: 0.8))),
        ]);

    final words = (heading.isEmpty && text.isEmpty)
        ? null
        : Container(
            decoration: dark
                ? null
                : BoxDecoration(
                    gradient: LinearGradient(colors: [t.ink.withValues(alpha: 0.6), t.ink.withValues(alpha: 0.2), t.ink.withValues(alpha: 0)]),
                  ),
            padding: EdgeInsets.fromLTRB(20, 24, 20, fade ? 32 : 24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
              children: [
                if (heading.isNotEmpty)
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 576),
                    child: Text(heading,
                        textAlign: center ? TextAlign.center : TextAlign.start,
                        style: Tw.display(24, 30, color: dark ? t.ink : Colors.white)),
                  ),
                if (text.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 448),
                    child: Text(text,
                        textAlign: center ? TextAlign.center : TextAlign.start,
                        style: Tw.body(color: dark ? t.inkSoft : Colors.white.withValues(alpha: 0.9))),
                  ),
                ],
                if (s.str('cta').isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(t.radiusLg), boxShadow: shadowSm),
                    child: Text(tx('cta'), style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                  ),
                ],
                if (fade && (offer.isNotEmpty || note.isNotEmpty)) ...[const SizedBox(height: 12), offerNote()],
              ],
            ),
          );

    final picture = s.str('image_mobile').isNotEmpty ? s.str('image_mobile') : s.str('image');
    Widget slide = AspectRatio(
      aspectRatio: fade ? 4 / 3 : 16 / 11,
      child: Stack(fit: StackFit.expand, children: [
        CoverImage(picture),
        ?words,
        if (!fade && (offer.isNotEmpty || note.isNotEmpty)) Positioned(left: 12, right: 12, bottom: 12, child: offerNote()),
        if (fade)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            height: MediaQuery.sizeOf(context).width * 3 / 8,
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [t.page.withValues(alpha: 0), t.page])),
              ),
            ),
          ),
      ]),
    );
    final link = s.str('link');
    if (link.isNotEmpty) slide = GestureDetector(onTap: () => openLink(context, link), child: slide);

    final controls = (widget.slides.length > 1 || hasVideo)
        ? Positioned(
            right: 12,
            top: fade ? 12 : null,
            bottom: fade ? null : 8,
            child: Row(children: [
              if ((widget.autoplay && widget.slides.length > 1) || hasVideo)
                Semantics(
                  button: true,
                  label: _stopped ? 'Play slides' : 'Pause slides',
                  child: GestureDetector(
                    onTap: () {
                      setState(() => _stopped = !_stopped);
                      _schedule();
                    },
                    child: Container(
                      width: 24,
                      height: 24,
                      margin: const EdgeInsets.only(right: 4),
                      decoration: BoxDecoration(color: t.ink.withValues(alpha: 0.6), shape: BoxShape.circle),
                      child: Icon(_stopped ? Icons.play_arrow_rounded : Icons.pause_rounded, size: 14, color: Colors.white),
                    ),
                  ),
                ),
              if (widget.slides.length > 1)
                for (var n = 0; n < widget.slides.length; n++)
                  GestureDetector(
                    onTap: () {
                      setState(() => _i = n);
                      _schedule();
                    },
                    child: AnimatedContainer(
                      duration: reduce ? Duration.zero : const Duration(milliseconds: 150),
                      margin: const EdgeInsets.only(left: 6),
                      width: n == _i ? 24 : 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: n == _i ? Colors.white : Colors.white.withValues(alpha: 0.6),
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                  ),
            ]),
          )
        : null;

    final body = GestureDetector(
      onHorizontalDragEnd: (d) {
        final v = d.primaryVelocity ?? 0;
        if (v.abs() > 100) _go(v < 0 ? 1 : -1);
      },
      child: Semantics(
        label: 'Offers',
        child: Container(
          color: t.primary,
          child: Stack(children: [slide, ?controls]),
        ),
      ),
    );
    if (fade) {
      // -mx-3: the banner runs edge to edge on phones
      return Transform.translate(
        offset: Offset.zero,
        child: OverflowBox(
          maxWidth: MediaQuery.sizeOf(context).width,
          minWidth: MediaQuery.sizeOf(context).width,
          child: body,
        ),
      );
    }
    return ClipRRect(borderRadius: BorderRadius.circular(t.radiusXl), child: body);
  }
}

/* ---------------------------------------------------------------- card row ("quad cards") */

class CardRow extends ConsumerWidget {
  const CardRow({super.key, required this.cards});
  final List<Json> cards;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final viewed = ref.watch(viewedProvider).value ?? const <Json>[];
    final wantsAgain = cards.any((c) => c.str('mode') == 'buy_again');
    final again = session.ready && session.user != null && wantsAgain
        ? ref.watch(productListProvider('/api/orders/buy-again?limit=4')).value
        : null;
    final shown = <(Json, List<Json>)>[];
    for (final c in cards) {
      switch (c.str('mode')) {
        case 'recent':
          if (viewed.isNotEmpty) shown.add((c, viewed));
        case 'buy_again':
          if (again != null && again.isNotEmpty) shown.add((c, [for (final p in again) p.raw]));
        case 'products':
          final items = c.maps('products');
          if (items.isNotEmpty) shown.add((c, items));
        default:
          if (c.maps('tiles').isNotEmpty) shown.add((c, const []));
      }
    }
    if (shown.isEmpty) return const SizedBox.shrink();
    final t = context.pc;
    return Column(children: [
      for (var n = 0; n < shown.length; n++) ...[
        if (n > 0) const SizedBox(height: 16),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl), boxShadow: cardShadow(t)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(fillText(ref, shown[n].$1.str('title')), style: Tw.display(18, 18 * 1.375, weight: Tw.semibold, color: t.ink)),
            const SizedBox(height: 12),
            if (shown[n].$1.str('mode') == 'tiles') _TileGrid(tiles: shown[n].$1.maps('tiles')) else _ProductQuad(items: shown[n].$2),
            if (shown[n].$1.str('link').isNotEmpty) ...[
              const SizedBox(height: 12),
              PcLink(fillText(ref, shown[n].$1.str('link_text', 'See more').isEmpty ? 'See more' : shown[n].$1.str('link_text', 'See more')),
                  onTap: () => openLink(context, shown[n].$1.str('link'))),
            ] else if (shown[n].$1.str('mode') == 'recent') ...[
              const SizedBox(height: 12),
              Text('Only you can see this', style: Tw.xs(color: t.inkFaint)),
            ],
          ]),
        ),
      ],
    ]);
  }
}

class _ProductQuad extends StatelessWidget {
  const _ProductQuad({required this.items});
  final List<Json> items;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final list = items.take(4).toList();
    return LayoutBuilder(builder: (_, c) {
      final w = (c.maxWidth - 12) / 2;
      return Wrap(spacing: 12, runSpacing: 12, children: [
        for (final p in list)
          SizedBox(
            width: w,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => context.push('/p/${p.str('slug')}'),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Container(
                  width: w,
                  height: w,
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusLg)),
                  child: p.str('image').isEmpty
                      ? null
                      : Image.network(mediaUrl(p.str('image')),
                          fit: BoxFit.contain,
                          // mix-blend-multiply: the white around a product photo takes the grey of the box
                          color: t.page,
                          colorBlendMode: BlendMode.multiply,
                          errorBuilder: (_, _, _) => const SizedBox.shrink()),
                ),
                if (p.objOrNull('deal') != null || p.integer('discount_pct') > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      if (p.integer('discount_pct') > 0)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          decoration: BoxDecoration(color: t.buy, borderRadius: BorderRadius.circular(4)),
                          child: Text('${p.integer('discount_pct')}% off', style: Tw.px(11, line: 16, weight: Tw.semibold, color: Colors.white)),
                        ),
                      if (p.objOrNull('deal') != null) Text(p.obj('deal').str('label'), style: Tw.px(11, line: 16, weight: Tw.semibold, color: t.buy)),
                    ]),
                  ),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(p.str('title'), maxLines: 1, overflow: TextOverflow.ellipsis, style: Tw.px(13, color: t.ink)),
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(rupees(p.integer('price')), style: Tw.px(13, weight: Tw.semibold, color: t.ink)),
                ),
              ]),
            ),
          ),
      ]);
    });
  }
}

class _TileGrid extends ConsumerWidget {
  const _TileGrid({required this.tiles});
  final List<Json> tiles;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    Widget badge(String text, {bool small = false}) => Container(
          padding: EdgeInsets.symmetric(horizontal: small ? 8 : 10, vertical: small ? 2 : 4),
          decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999), boxShadow: shadowSm),
          child: Text(fillText(ref, text), style: small ? Tw.px(11, line: 16, weight: Tw.bold, color: t.ink) : Tw.xs(weight: Tw.bold, color: t.ink)),
        );
    if (tiles.length == 1) {
      final x = tiles.first;
      return GestureDetector(
        onTap: () => openLink(context, x.str('link')),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(t.radiusLg),
          child: AspectRatio(
            aspectRatio: 1,
            child: Stack(fit: StackFit.expand, children: [
              Container(color: t.page, child: CoverImage(x.str('image'))),
              if (x.str('label').isNotEmpty)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(8, 24, 8, 8),
                    decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [t.ink.withValues(alpha: 0.7), t.ink.withValues(alpha: 0)])),
                    child: Text(fillText(ref, x.str('label')), style: Tw.sm(weight: Tw.semibold, color: Colors.white)),
                  ),
                ),
              if (x.str('badge').isNotEmpty) Positioned(left: 8, bottom: 8, child: badge(x.str('badge'))),
            ]),
          ),
        ),
      );
    }
    return LayoutBuilder(builder: (_, c) {
      final w = (c.maxWidth - 12) / 2;
      return Wrap(spacing: 12, runSpacing: 12, children: [
        for (final x in tiles)
          SizedBox(
            width: w,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => openLink(context, x.str('link')),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(t.radiusLg),
                  child: SizedBox(
                    width: w,
                    height: w,
                    child: Stack(fit: StackFit.expand, children: [
                      Container(color: t.page, child: CoverImage(x.str('image'))),
                      if (x.str('badge').isNotEmpty) Positioned(left: 6, bottom: 6, child: badge(x.str('badge'), small: true)),
                    ]),
                  ),
                ),
                if (x.str('label').isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(fillText(ref, x.str('label')), maxLines: 1, overflow: TextOverflow.ellipsis, style: Tw.px(13, color: t.ink)),
                  ),
              ]),
            ),
          ),
      ]);
    });
  }
}

/* ---------------------------------------------------------------- rails */

class DealsRail extends StatelessWidget {
  const DealsRail({super.key, required this.title, required this.items});
  final String title;
  final List<ProductCard> items;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final ends = [for (final p in items) if (p.deal != null && p.deal!.endsAt.isNotEmpty) p.deal!.endsAt]..sort();
    return ProductRail(
      title: title.isEmpty ? "Today's deals" : title,
      items: items,
      href: '/deals',
      linkText: 'See all deals',
      extra: ends.isEmpty
          ? null
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
              decoration: BoxDecoration(color: t.buyLight, borderRadius: BorderRadius.circular(999)),
              child: DealCountdown(endsAt: ends.first, style: Tw.sm(weight: Tw.semibold, color: t.buy)),
            ),
    );
  }
}

/// A rail whose products come from the API (sponsored, inspired, buy again).
class FetchedRail extends ConsumerWidget {
  const FetchedRail({super.key, required this.url, required this.title, this.note, this.showAdd = false});
  final String? url;
  final String title;
  final String? note;
  final bool showAdd;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (url == null) return const SizedBox.shrink();
    final items = ref.watch(productListProvider(url!)).value ?? const <ProductCard>[];
    if (items.isEmpty) return const SizedBox.shrink();
    return ProductRail(title: title, items: items, note: note, showAdd: showAdd);
  }
}

class InspiredRail extends ConsumerWidget {
  const InspiredRail({super.key, required this.title, required this.limit});
  final String title;
  final int limit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final viewed = ref.watch(viewedProvider).value ?? const <Json>[];
    final ids = viewed.take(10).map((v) => v.str('id')).join(',');
    return FetchedRail(
      url: ids.isEmpty ? null : '/api/catalog/related?ids=$ids&limit=$limit',
      title: title.isEmpty ? 'Inspired by your browsing history' : title,
    );
  }
}

class BuyAgainRail extends ConsumerWidget {
  const BuyAgainRail({super.key, required this.title, required this.limit});
  final String title;
  final int limit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    return FetchedRail(
      url: s.ready && s.user != null ? '/api/orders/buy-again?limit=$limit' : null,
      title: title.isEmpty ? 'Buy it again' : title,
      showAdd: true,
    );
  }
}

/* ---------------------------------------------------------------- countdown banner and sign-in prompt */

class CountdownBanner extends ConsumerStatefulWidget {
  const CountdownBanner({super.key, required this.title, required this.cfg});
  final String title;
  final Json cfg;

  @override
  ConsumerState<CountdownBanner> createState() => _CountdownBannerState();
}

class _CountdownBannerState extends ConsumerState<CountdownBanner> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) => mounted ? setState(() {}) : null);
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final cfg = widget.cfg;
    final end = DateTime.tryParse(cfg.str('ends_at'));
    if (end == null || !end.isAfter(DateTime.now())) return const SizedBox.shrink();
    final left = end.difference(DateTime.now()).inSeconds;
    final parts = [('Days', left ~/ 86400), ('Hours', (left % 86400) ~/ 3600), ('Mins', (left % 3600) ~/ 60), ('Secs', left % 60)];
    final (bg, fg) = switch (cfg.str('tone')) {
      'accent' => (t.accent, t.ink),
      'primary' => (t.primary, Colors.white),
      'dark' => (t.ink, Colors.white),
      _ => (t.buy, Colors.white),
    };
    final body = Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(t.radiusXl)),
      child: Column(children: [
        Text(fillText(ref, cfg.str('heading').isEmpty ? widget.title : cfg.str('heading')),
            textAlign: TextAlign.center, style: Tw.display(24, 32, color: fg)),
        if (cfg.str('text').isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(fillText(ref, cfg.str('text')), textAlign: TextAlign.center, style: Tw.body(color: fg.withValues(alpha: 0.9))),
        ],
        const SizedBox(height: 12),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (final (label, v) in parts)
            Container(
              constraints: const BoxConstraints(minWidth: 56),
              margin: const EdgeInsets.symmetric(horizontal: 4),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(t.radiusLg),
                border: Border.all(color: Colors.white.withValues(alpha: 0.25)),
              ),
              child: Column(children: [
                Text(v.toString().padLeft(2, '0'), style: Tw.display(24, 32, color: fg).copyWith(fontFeatures: const [FontFeature.tabularFigures()])),
                Text(label.toUpperCase(), style: Tw.px(10, line: 15, color: fg.withValues(alpha: 0.8)).copyWith(letterSpacing: 0.25)),
              ]),
            ),
        ]),
        if (cfg.str('cta').isNotEmpty) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusLg), boxShadow: shadowSm),
            child: Text(fillText(ref, cfg.str('cta')), style: Tw.sm(weight: Tw.semibold, color: t.ink)),
          ),
        ],
        if (cfg.str('image').isNotEmpty) ...[
          const SizedBox(height: 16),
          ClipRRect(
            borderRadius: BorderRadius.circular(t.radiusLg),
            child: SizedBox(height: 128, child: Image.network(mediaUrl(cfg.str('image')), fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink())),
          ),
        ],
      ]),
    );
    final link = cfg.str('link');
    return link.isEmpty ? body : GestureDetector(onTap: () => openLink(context, link), child: body);
  }
}

class SigninPrompt extends ConsumerWidget {
  const SigninPrompt({super.key, required this.heading, required this.text});
  final String heading;
  final String text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(sessionProvider);
    final site = ref.watch(siteValueProvider);
    if (!s.ready || s.user != null || !site.homeExtras.flag('signin_prompt', true)) return const SizedBox.shrink();
    final t = context.pc;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
      child: Column(children: [
        Text(heading.isEmpty ? 'See personalised recommendations' : heading, textAlign: TextAlign.center, style: Tw.lg(weight: Tw.semibold, color: t.ink)),
        if (text.isNotEmpty) ...[
          const SizedBox(height: 8),
          ConstrainedBox(constraints: const BoxConstraints(maxWidth: 448), child: Text(text, textAlign: TextAlign.center, style: Tw.sm(color: t.inkSoft))),
        ],
        const SizedBox(height: 12),
        GestureDetector(
          onTap: () => context.push('/login'),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 260),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999)),
            alignment: Alignment.center,
            child: Text('Sign in', style: Tw.body(weight: Tw.semibold, color: t.ink)),
          ),
        ),
        const SizedBox(height: 8),
        GestureDetector(
          onTap: () => context.push('/signup'),
          child: Text.rich(TextSpan(style: Tw.xs(color: t.inkSoft), children: [
            const TextSpan(text: 'New customer? '),
            TextSpan(text: 'Start here.', style: TextStyle(fontWeight: Tw.semibold, color: t.primary)),
          ])),
        ),
      ]),
    );
  }
}

/* ---------------------------------------------------------------- banners and the image block */

class MediaBanner extends ConsumerWidget {
  const MediaBanner({super.key, required this.cfg, this.compact = false});
  final Json cfg;
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final image = cfg.str('image');
    if (image.isEmpty && cfg.str('video').isEmpty) return const SizedBox.shrink();
    final heading = fillText(ref, cfg.str('heading'));
    final text = fillText(ref, cfg.str('text'));
    final cta = fillText(ref, cfg.str('cta'));
    final body = ClipRRect(
      borderRadius: BorderRadius.circular(t.radiusXl),
      child: Stack(children: [
        if (image.isNotEmpty)
          Image.network(mediaUrl(image), width: double.infinity, fit: BoxFit.cover, errorBuilder: (_, _, _) => AspectRatio(aspectRatio: 16 / 9, child: Container(color: t.page)))
        else
          AspectRatio(aspectRatio: 16 / 9, child: Container(color: t.page)),
        if (heading.isNotEmpty || text.isNotEmpty || cta.isNotEmpty)
          Positioned.fill(
            child: Container(
              padding: EdgeInsets.all(compact ? 16 : 24),
              decoration: BoxDecoration(gradient: LinearGradient(colors: [t.ink.withValues(alpha: 0.6), t.ink.withValues(alpha: 0)])),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (heading.isNotEmpty) Text(heading, style: Tw.display(compact ? 20 : 24, compact ? 28 : 32, color: Colors.white)),
                if (text.isNotEmpty) Text(text, style: (compact ? Tw.sm : Tw.body)(color: Colors.white.withValues(alpha: 0.9))),
                if (cta.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(t.radiusLg)),
                    child: Text(cta, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                  ),
              ]),
            ),
          ),
      ]),
    );
    final link = cfg.str('link');
    return link.isEmpty ? body : GestureDetector(onTap: () => openLink(context, link), child: body);
  }
}

class MediaBlock extends ConsumerWidget {
  const MediaBlock({super.key, required this.cfg, required this.title});
  final Json cfg;
  final String title;

  static const _aspects = {'21/9': 16 / 9, '16/9': 16 / 9, '4/3': 4 / 3, '1/1': 1.0, '4/5': 4 / 5};

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final image = cfg.str('image');
    if (image.isEmpty && cfg.str('video').isEmpty) return const SizedBox.shrink();
    final aspect = _aspects[cfg.str('aspect')] ?? 16 / 9;
    final portrait = cfg.str('aspect') == '1/1' || cfg.str('aspect') == '4/5';
    final light = cfg.str('tone') != 'dark';
    final center = cfg.str('align') == 'center';
    final full = cfg.str('width') == 'full';
    final heading = fillText(ref, cfg.str('heading'));
    final text = fillText(ref, cfg.str('text'));
    final cta = fillText(ref, cfg.str('cta'));
    final hasWords = heading.isNotEmpty || text.isNotEmpty || cta.isNotEmpty;
    final fg = light ? Colors.white : t.ink;
    Widget media = AspectRatio(
      aspectRatio: aspect,
      child: Container(
        color: t.page,
        child: Stack(fit: StackFit.expand, children: [
          CoverImage(image),
          if (hasWords)
            Container(
              padding: const EdgeInsets.all(16),
              decoration: !light
                  ? null
                  : BoxDecoration(
                      color: center && !portrait ? t.ink.withValues(alpha: 0.45) : null,
                      gradient: center && !portrait
                          ? null
                          : LinearGradient(
                              begin: portrait ? Alignment.bottomCenter : Alignment.centerLeft,
                              end: portrait ? Alignment.topCenter : Alignment.centerRight,
                              colors: [t.ink.withValues(alpha: 0.75), t.ink.withValues(alpha: 0.35), t.ink.withValues(alpha: 0)],
                            ),
                    ),
              child: Column(
                mainAxisAlignment: portrait ? MainAxisAlignment.end : MainAxisAlignment.center,
                crossAxisAlignment: center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
                children: [
                  if (heading.isNotEmpty)
                    Text(heading, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: center ? TextAlign.center : TextAlign.start, style: Tw.heading(20, weight: Tw.bold, color: fg)),
                  if (text.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: center ? TextAlign.center : TextAlign.start,
                          style: Tw.sm(color: light ? Colors.white.withValues(alpha: 0.9) : t.inkSoft)),
                    ),
                  if (cta.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(top: 14),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(t.radiusLg), boxShadow: shadowSm),
                      child: Text(cta, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
                    ),
                ],
              ),
            ),
        ]),
      ),
    );
    media = full ? media : ClipRRect(borderRadius: BorderRadius.circular(t.radiusXl), child: media);
    final link = cfg.str('link');
    if (link.isNotEmpty) media = GestureDetector(onTap: () => openLink(context, link), child: media);
    if (full) {
      return OverflowBox(minWidth: MediaQuery.sizeOf(context).width, maxWidth: MediaQuery.sizeOf(context).width, child: media);
    }
    return Semantics(label: heading.isEmpty ? (title.isEmpty ? 'Featured' : title) : heading, child: media);
  }
}

/// A very small Markdown view for the home "text" block: headings, paragraphs, lists, **bold** and [links](/path).
class MiniMarkdown extends StatelessWidget {
  const MiniMarkdown(this.source, {super.key, this.center = false});
  final String source;
  final bool center;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final blocks = <Widget>[];
    for (final raw in source.split(RegExp(r'\n\s*\n'))) {
      final lines = raw.trim().split('\n');
      if (lines.first.isEmpty) continue;
      final h = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(lines.first);
      if (h != null) {
        final size = [30.0, 24.0, 20.0][h.group(1)!.length - 1];
        blocks.add(Padding(
          padding: const EdgeInsets.only(top: 16, bottom: 8),
          child: Text(h.group(2)!, textAlign: center ? TextAlign.center : TextAlign.start, style: Tw.heading(size, color: t.ink)),
        ));
        continue;
      }
      if (lines.every((l) => RegExp(r'^\s*([-*]|\d+\.)\s+').hasMatch(l))) {
        for (final l in lines) {
          blocks.add(Padding(
            padding: const EdgeInsets.only(left: 8, bottom: 4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('•  ', style: Tw.body(color: t.inkSoft)),
              Expanded(child: _inline(context, l.replaceFirst(RegExp(r'^\s*([-*]|\d+\.)\s+'), ''))),
            ]),
          ));
        }
        continue;
      }
      blocks.add(Padding(padding: const EdgeInsets.only(bottom: 12), child: _inline(context, lines.join(' '))));
    }
    return Column(crossAxisAlignment: center ? CrossAxisAlignment.center : CrossAxisAlignment.start, children: blocks);
  }

  Widget _inline(BuildContext context, String text) {
    final t = context.pc;
    final spans = <InlineSpan>[];
    final re = RegExp(r'\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)');
    var at = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > at) spans.add(TextSpan(text: text.substring(at, m.start)));
      if (m.group(1) != null) {
        spans.add(TextSpan(text: m.group(1), style: TextStyle(fontWeight: Tw.semibold, color: t.ink)));
      } else {
        final href = m.group(3)!;
        spans.add(WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: GestureDetector(onTap: () => openLink(context, href), child: Text(m.group(2)!, style: Tw.body(weight: Tw.semibold, color: t.primary))),
        ));
      }
      at = m.end;
    }
    if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
    return Text.rich(TextSpan(style: Tw.body(color: t.inkSoft), children: spans), textAlign: center ? TextAlign.center : TextAlign.start);
  }
}
