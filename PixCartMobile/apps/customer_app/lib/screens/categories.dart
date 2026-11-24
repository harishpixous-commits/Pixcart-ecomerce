import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/frame.dart';

/// The category directory uses the same catalog tree and links as the shop website.
class CategoriesScreen extends ConsumerWidget {
  const CategoriesScreen({super.key});

  IconData _icon(String slug) => switch (slug) {
        'mobiles-electronics' => LucideIcons.laptop,
        'fashion' => LucideIcons.shirt,
        'home-kitchen' => LucideIcons.sofa,
        'beauty-personal-care' => LucideIcons.sparkles,
        'grocery' => LucideIcons.shoppingBasket,
        'books' => LucideIcons.bookOpen,
        'toys-baby' => LucideIcons.baby,
        'sports-fitness' => LucideIcons.dumbbell,
        _ => LucideIcons.tag,
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final categories = ref.watch(categoriesProvider).value ?? <CategoryNode>[];
    return ShopBody(gap: 12, children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Text('All categories', style: Tw.px(24, line: 32, weight: Tw.semibold, color: t.ink)),
      ),
      for (final category in categories)
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            InkWell(
              onTap: () => context.push('/c/${category.slug}'),
              child: Row(children: [
                Container(
                  width: 44, height: 44,
                  decoration: BoxDecoration(color: t.primaryLight, shape: BoxShape.circle),
                  child: Icon(_icon(category.slug), size: 24, color: t.primary),
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(category.name, style: Tw.display(18, 28, weight: Tw.semibold, color: t.ink))),
                const SizedBox(width: 12),
                Text('${category.productCount}', style: Tw.sm(color: t.inkFaint)),
              ]),
            ),
            if (category.children.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final child in category.children)
                  InkWell(
                    onTap: () => context.push('/c/${child.slug}'),
                    borderRadius: BorderRadius.circular(999),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(999)),
                      child: Text(child.name, style: Tw.sm(color: t.ink)),
                    ),
                  ),
              ]),
            ],
          ]),
        ),
    ]);
  }
}
