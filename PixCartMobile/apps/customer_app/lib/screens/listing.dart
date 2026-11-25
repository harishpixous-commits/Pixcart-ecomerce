// Category listing and search (components/search-view.tsx) as phones show them: breadcrumbs, the title panel with
// the result count, "Filters" (a sheet) and the sort select, departments, active filter chips, the results grid with
// "Add to cart"/"See options", pages, and the sponsored rail. Every filter lives in the URL like on the website.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/frame.dart';
import '../shop/product.dart';

const sorts = [
  ('relevance', 'Featured'),
  ('popular', 'Best sellers'),
  ('price_asc', 'Price: low to high'),
  ('price_desc', 'Price: high to low'),
  ('rating', 'Avg. customer review'),
  ('newest', 'Newest arrivals'),
  ('discount', 'Biggest discount'),
];

const _delivery = [('1', 'Get it by tomorrow'), ('2', 'Get it in 2 days'), ('4', 'Get it in 4 days')];

class CategoryScreen extends StatelessWidget {
  const CategoryScreen({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context) => SearchView(key: ValueKey(GoRouterState.of(context).uri.toString()), category: slug);
}

class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) => SearchView(key: ValueKey(GoRouterState.of(context).uri.toString()));
}

typedef _Args = ({String query, String? category, String pin});

final _searchProvider = FutureProvider.autoDispose.family<Json, _Args>((ref, a) async {
  final p = Uri(query: a.query).queryParametersAll;
  String? one(String k) => p[k]?.firstOrNull;
  return ref.read(apiProvider).getMap('/api/catalog/products', query: {
    'q': one('q'),
    'category': a.category ?? one('category'),
    'brand': p['brand'] ?? const <String>[],
    'min_price': one('min_price'),
    'max_price': one('max_price'),
    'min_rating': one('min_rating'),
    'min_discount': one('min_discount'),
    'in_stock': one('in_stock'),
    'deal': one('deal'),
    'pincode': a.pin.isEmpty ? null : a.pin,
    'delivery': a.pin.isEmpty ? null : one('delivery'),
    'sort': one('sort') ?? 'relevance',
    'page': one('page') ?? '1',
  });
});

class SearchView extends ConsumerWidget {
  const SearchView({super.key, this.category});
  final String? category;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final uri = GoRouterState.of(context).uri;
    final pin = ref.watch(pincodeProvider);
    final res = ref.watch(_searchProvider((query: uri.query, category: category, pin: pin)));
    return ShopBody(children: [
      res.when(
        loading: () => const ProductGridSkeleton(),
        error: (e, _) => EmptyState(title: 'Search is unavailable right now', body: ApiError.messageOf(e)),
        data: (raw) => _Results(raw: raw, uri: uri, category: category),
      ),
    ]);
  }
}

class _Results extends ConsumerWidget {
  const _Results({required this.raw, required this.uri, required this.category});
  final Json raw;
  final Uri uri;
  final String? category;

  /// One navigation with every change (null removes the parameter); a filter change goes back to page 1.
  void _set(BuildContext context, Map<String, Object?> changes) {
    final next = <String, List<String>>{for (final e in uri.queryParametersAll.entries) e.key: [...e.value]};
    changes.forEach((k, v) {
      next.remove(k);
      if (v is List<String>) {
        if (v.isNotEmpty) next[k] = v;
      } else if (v is String && v.isNotEmpty) {
        next[k] = [v];
      }
    });
    if (!changes.containsKey('page')) next.remove('page');
    final qs = [for (final e in next.entries) for (final v in e.value) '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(v)}'].join('&');
    context.go(qs.isEmpty ? uri.path : '${uri.path}?$qs');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final data = SearchResult(raw);
    final p = uri.queryParametersAll;
    String? one(String k) => p[k]?.firstOrNull;
    final q = one('q');
    final cat = data.category;
    final heading = cat != null ? cat.str('name') : (q != null && q.isNotEmpty ? null : 'All products');
    final from = data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
    final to = (data.page * data.pageSize).clamp(0, data.total);
    final keys = ['brand', 'min_price', 'max_price', 'min_rating', 'min_discount', 'in_stock', 'deal', 'delivery', if (category == null) 'category'];
    final active = keys.any((k) => (one(k) ?? '').isNotEmpty);
    final sponsored = data.page == 1 ? raw.list('sponsored', ProductCard.new) : const <ProductCard>[];
    final seen = {for (final s in sponsored) s.id};
    final results = [...sponsored, ...data.items.where((x) => !seen.contains(x.id))];
    final shown = {for (final r in results) r.id};
    final rail = raw.list('sponsored_rail', ProductCard.new).where((x) => !shown.contains(x.id)).toList();
    final departments = raw.maps('categories');
    final pages = data.pageSize > 0 ? (data.total / data.pageSize).ceil() : 1;
    int? paise(String k) => int.tryParse(one(k) ?? '');
    final lo = paise('min_price'), hi = paise('max_price');
    final priceLabel = lo != null && hi != null
        ? '${rupees(lo)} to ${rupees(hi)}'
        : lo != null
            ? '${rupees(lo)} and above'
            : hi != null
                ? 'Up to ${rupees(hi)}'
                : null;
    void clearAll() => context.go(q != null && q.isNotEmpty ? '${uri.path}?q=${Uri.encodeQueryComponent(q)}' : uri.path);

    final chips = <Widget>[
      if (one('deal') != null) _Chip("Today's deals", () => _set(context, {'deal': null})),
      if (one('delivery') != null)
        _Chip(one('delivery') == '1' ? 'Get it by tomorrow' : 'Get it in ${one('delivery')} days', () => _set(context, {'delivery': null})),
      if (category == null && one('category') != null)
        _Chip(departments.where((c) => c.str('slug') == one('category')).firstOrNull?.str('name') ?? 'Department', () => _set(context, {'category': null})),
      for (final b in p['brand'] ?? const <String>[])
        _Chip(b, () => _set(context, {'brand': [for (final x in p['brand']!) if (x != b) x]})),
      if (priceLabel != null) _Chip(priceLabel, () => _set(context, {'min_price': null, 'max_price': null})),
      if (one('min_rating') != null) _Chip('${one('min_rating')}★ & up', () => _set(context, {'min_rating': null})),
      if (one('min_discount') != null) _Chip('${one('min_discount')}% off or more', () => _set(context, {'min_discount': null})),
      if (one('in_stock') != null) _Chip('In stock', () => _set(context, {'in_stock': null})),
    ];

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (data.breadcrumbs.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Wrap(children: [
            GestureDetector(onTap: () => context.go('/'), child: Text('Home', style: Tw.sm(color: t.inkFaint))),
            for (final b in data.breadcrumbs) ...[
              Text(' › ', style: Tw.sm(color: t.inkFaint)),
              GestureDetector(onTap: () => context.push('/c/${b.slug}'), child: Text(b.name, style: Tw.sm(color: t.inkFaint))),
            ],
          ]),
        ),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (heading != null) Text(heading, style: Tw.heading(24, color: t.ink)),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: data.total > 0 ? '$from-$to of ${count(data.total)} results' : 'No results'),
              if (q != null && q.isNotEmpty) ...[
                const TextSpan(text: ' for '),
                TextSpan(text: '“$q”', style: TextStyle(fontWeight: Tw.semibold, color: t.buy)),
              ],
            ]),
            style: heading != null ? Tw.sm(color: t.inkFaint) : Tw.body(color: t.ink),
          ),
          const SizedBox(height: 12),
          Row(children: [
            PcButton(
              variant: ButtonVariant.secondary,
              size: ButtonSize.sm,
              height: 36,
              onPressed: () => _showFilters(context, ref, data, raw),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.slidersHorizontal, size: 16, color: t.primary),
                const SizedBox(width: 8),
                Text('Filters${active ? ' (on)' : ''}'),
              ]),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: PcSelect<String>(
                value: one('sort') ?? 'relevance',
                title: 'Sort by',
                height: 36,
                style: Tw.sm(color: t.ink),
                options: [for (final (v, l) in sorts) SelectOption(v, 'Sort by: $l')],
                onChanged: (v) => _set(context, {'sort': v}),
              ),
            ),
          ]),
        ]),
      ),
      if (category == null && departments.length > 1) ...[
        const SizedBox(height: 12),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (final c in departments)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: GestureDetector(
                  onTap: () => _set(context, {'category': one('category') == c.str('slug') ? null : c.str('slug')}),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: one('category') == c.str('slug') ? t.primary : Colors.white,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: one('category') == c.str('slug') ? t.primary : t.line),
                    ),
                    child: Text.rich(TextSpan(style: Tw.sm(color: one('category') == c.str('slug') ? Colors.white : t.ink), children: [
                      TextSpan(text: '${c.str('name')} '),
                      TextSpan(
                        text: '(${c.integer('count')})',
                        style: TextStyle(color: one('category') == c.str('slug') ? Colors.white.withValues(alpha: 0.8) : t.inkFaint),
                      ),
                    ])),
                  ),
                ),
              ),
          ]),
        ),
      ],
      if (active) ...[
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          ...chips,
          GestureDetector(onTap: clearAll, child: Text('Clear all', style: Tw.sm(weight: Tw.semibold, color: t.primary))),
        ]),
      ],
      const SizedBox(height: 12),
      if (results.isEmpty)
        EmptyState(
          title: 'No products match',
          body: active ? 'Try removing a filter or two.' : 'Try a different word, or browse the categories above.',
          action: active ? PcButton.text('Clear filters', variant: ButtonVariant.secondary, onPressed: clearAll) : null,
        )
      else
        ProductGrid(items: results, showAdd: true),
      if (pages > 1)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            PcButton.text('Previous',
                variant: ButtonVariant.secondary,
                size: ButtonSize.sm,
                onPressed: data.page <= 1 ? null : () => _set(context, {'page': '${data.page - 1}'})),
            const SizedBox(width: 8),
            Text('Page ${data.page} of $pages', style: Tw.sm(color: t.inkSoft)),
            const SizedBox(width: 8),
            PcButton.text('Next',
                variant: ButtonVariant.secondary,
                size: ButtonSize.sm,
                onPressed: data.page >= pages ? null : () => _set(context, {'page': '${data.page + 1}'})),
          ]),
        ),
      if (data.page == 1 && rail.isNotEmpty) ...[
        const SizedBox(height: 12),
        ProductRail(title: q != null && q.isNotEmpty ? 'Sponsored products related to your search' : 'Sponsored products', items: rail, note: 'Sponsored'),
      ],
    ]);
  }

  Future<void> _showFilters(BuildContext context, WidgetRef ref, SearchResult data, Json raw) {
    final p = uri.queryParametersAll;
    String? one(String k) => p[k]?.firstOrNull;
    final pin = ref.read(pincodeProvider);
    final minCtrl = TextEditingController(text: one('min_price') == null ? '' : paiseToInput(int.tryParse(one('min_price')!) ?? 0));
    final maxCtrl = TextEditingController(text: one('max_price') == null ? '' : paiseToInput(int.tryParse(one('max_price')!) ?? 0));
    final pinCtrl = TextEditingController();
    return showPcSheet<void>(context, title: 'Filters', builder: (ctx) {
      final t = ctx.pc;
      void set(Map<String, Object?> changes) {
        Navigator.of(ctx).pop();
        _set(context, changes);
      }

      Widget legend(String text, {IconData? icon, Color? iconColor}) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(children: [
              if (icon != null) ...[Icon(icon, size: 16, color: iconColor ?? t.primary), const SizedBox(width: 6)],
              Text(text, style: Tw.body(weight: Tw.semibold, color: t.ink)),
            ]),
          );
      Widget check(bool on, String label, ValueChanged<bool> onChanged, {String? extra}) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: PcCheckbox(
              value: on,
              onChanged: onChanged,
              label: Text.rich(TextSpan(style: Tw.body(color: t.ink), children: [
                TextSpan(text: label),
                if (extra != null) TextSpan(text: ' $extra', style: TextStyle(color: t.inkFaint)),
              ])),
            ),
          );
      Widget radio(bool on, String label, VoidCallback onTap) => GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(children: [
                Container(
                  width: 14,
                  height: 14,
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: on ? t.primary : const Color(0xFF767676), width: on ? 4 : 1)),
                ),
                const SizedBox(width: 8),
                Text(label, style: Tw.body(color: t.ink)),
              ]),
            ),
          );
      final brands = p['brand'] ?? const <String>[];
      final departments = raw.maps('categories');
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        legend('Delivery day', icon: LucideIcons.truck),
        if (pin.isEmpty)
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(LucideIcons.mapPin, size: 16, color: t.inkSoft),
              const SizedBox(width: 4),
              Text('Enter your PIN code to see delivery days', style: Tw.sm(color: t.inkSoft)),
            ]),
            const SizedBox(height: 4),
            Row(children: [
              SizedBox(width: 112, child: PcInput(controller: pinCtrl, height: 36, placeholder: 'PIN code', keyboardType: TextInputType.number, maxLength: 6)),
              const SizedBox(width: 8),
              PcButton.text('Apply', size: ButtonSize.sm, variant: ButtonVariant.secondary, onPressed: () {
                if (isPincode(pinCtrl.text)) {
                  ref.read(pincodeProvider.notifier).set(pinCtrl.text);
                  Navigator.of(ctx).pop();
                }
              }),
            ]),
          ])
        else ...[
          for (final (d, label) in _delivery) check(one('delivery') == d, label, (on) => set({'delivery': on ? d : null})),
          Text('To PIN $pin', style: Tw.xs(color: t.inkFaint)),
        ],
        const SizedBox(height: 24),
        GestureDetector(
          onTap: () => set({'deal': one('deal') == 'true' ? null : 'true'}),
          child: Row(children: [
            IgnorePointer(child: PcCheckbox(value: one('deal') == 'true', onChanged: (_) {}, label: const SizedBox.shrink())),
            Icon(LucideIcons.zap, size: 16, color: t.buy),
            const SizedBox(width: 6),
            Text("Today's deals", style: Tw.body(weight: Tw.semibold, color: t.ink)),
          ]),
        ),
        if (category == null && departments.isNotEmpty) ...[
          const SizedBox(height: 24),
          legend('Department'),
          for (final c in departments)
            GestureDetector(
              onTap: () => set({'category': one('category') == c.str('slug') ? null : c.str('slug')}),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text.rich(TextSpan(
                  style: Tw.body(
                      weight: one('category') == c.str('slug') ? Tw.semibold : FontWeight.w400,
                      color: one('category') == c.str('slug') ? t.primary : t.ink),
                  children: [
                    TextSpan(text: '${c.str('name')} '),
                    TextSpan(text: '(${c.integer('count')})', style: TextStyle(color: t.inkFaint)),
                  ],
                )),
              ),
            ),
        ],
        if (data.brands.isNotEmpty) ...[
          const SizedBox(height: 24),
          legend('Brand'),
          for (final b in data.brands)
            check(brands.contains(b.name), b.name,
                (on) => set({'brand': on ? [...brands, b.name] : [for (final x in brands) if (x != b.name) x]}),
                extra: '(${b.count})'),
        ],
        const SizedBox(height: 24),
        legend('Price'),
        Row(children: [
          Expanded(child: PcInput(controller: minCtrl, height: 36, placeholder: 'Min ${currencySymbol()}', keyboardType: TextInputType.number)),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text('to', style: Tw.body(color: t.inkFaint))),
          Expanded(child: PcInput(controller: maxCtrl, height: 36, placeholder: 'Max ${currencySymbol()}', keyboardType: TextInputType.number)),
          const SizedBox(width: 8),
          PcButton.text('Go', size: ButtonSize.sm, onPressed: () {
            final lo = minCtrl.text.isEmpty ? null : shownToPaise(minCtrl.text);
            final hi = maxCtrl.text.isEmpty ? null : shownToPaise(maxCtrl.text);
            set({'min_price': lo?.toString(), 'max_price': hi?.toString()});
          }),
        ]),
        if (data.priceMax > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('From ${rupees(data.priceMin)} to ${rupees(data.priceMax)}', style: Tw.xs(color: t.inkFaint)),
          ),
        const SizedBox(height: 24),
        legend('Customer reviews'),
        for (final r in ['4', '3']) radio(one('min_rating') == r, '$r★ & up', () => set({'min_rating': r})),
        const SizedBox(height: 24),
        legend('Discount'),
        for (final d in ['10', '25', '50', '70']) radio(one('min_discount') == d, '$d% off or more', () => set({'min_discount': d})),
        const SizedBox(height: 24),
        check(one('in_stock') == 'true', 'Hide out of stock items', (on) => set({'in_stock': on ? 'true' : null})),
      ]);
    });
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label, this.onClear);
  final String label;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
      decoration: BoxDecoration(color: t.primaryLight, borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(label, style: Tw.sm(color: t.primary)),
        const SizedBox(width: 4),
        Semantics(
          button: true,
          label: 'Remove filter $label',
          child: GestureDetector(onTap: onClear, child: Padding(padding: const EdgeInsets.all(2), child: Icon(LucideIcons.x, size: 14, color: t.primary))),
        ),
      ]),
    );
  }
}
