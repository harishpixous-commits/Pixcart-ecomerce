// All categories (app/(shop)/categories/page.tsx): one white card per top category with its sub-categories as chips.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/category_icon.dart';
import '../shop/frame.dart';

class CategoriesScreen extends ConsumerWidget {
  const CategoriesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final cats = ref.watch(categoriesProvider);
    return ShopBody(
      onRefresh: () => ref.refresh(categoriesProvider.future),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text('All categories', style: Tw.heading(24, color: t.ink)),
        ),
        const SizedBox(height: 12),
        ...cats.when(
          loading: () => [const CategoriesSkeleton()],
          error: (e, _) => [EmptyState(title: 'Categories are unavailable right now', body: ApiError.messageOf(e))],
          data: (list) => [
            for (var i = 0; i < list.length; i++) ...[
              if (i > 0) const SizedBox(height: 12),
              _CategoryCard(cat: list[i]),
            ],
          ],
        ),
      ],
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({required this.cat});
  final CategoryNode cat;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => context.push('/c/${cat.slug}'),
          child: Row(children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(color: t.primaryLight, shape: BoxShape.circle),
              child: CategoryIcon(slug: cat.slug, size: 24, color: t.primary),
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(cat.name, style: Tw.display(18, 28, weight: Tw.semibold, color: t.ink))),
            Text('${cat.productCount}', style: Tw.sm(color: t.inkFaint)),
          ]),
        ),
        if (cat.children.isNotEmpty) ...[
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final s in cat.children)
              GestureDetector(
                onTap: () => context.push('/c/${s.slug}'),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(999)),
                  child: Text(s.name, style: Tw.sm(color: t.ink)),
                ),
              ),
          ]),
        ],
      ]),
    );
  }
}

/// CategoriesSkeleton (components/skeletons.tsx).
class CategoriesSkeleton extends StatelessWidget {
  const CategoriesSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return DelayedFallback(
      child: Column(children: [
        for (var i = 0; i < 4; i++)
          Container(
            margin: const EdgeInsets.only(bottom: 12),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radiusXl)),
            child: const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                SkeletonBlock(width: 44, height: 44, circle: true),
                SizedBox(width: 12),
                SkeletonBlock(width: 160, height: 20),
              ]),
              SizedBox(height: 12),
              Row(children: [
                SkeletonBlock(width: 70, height: 28),
                SizedBox(width: 8),
                SkeletonBlock(width: 110, height: 28),
                SizedBox(width: 8),
                SkeletonBlock(width: 80, height: 28),
              ]),
            ]),
          ),
      ]),
    );
  }
}
