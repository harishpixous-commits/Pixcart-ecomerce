// A category's icon when it has no picture (components/category-icon.tsx).

import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:material_ui/material_ui.dart';

const _icons = <String, IconData>{
  'mobiles-electronics': LucideIcons.laptop,
  'fashion': LucideIcons.shirt,
  'home-kitchen': LucideIcons.sofa,
  'beauty-personal-care': LucideIcons.sparkles,
  'grocery': LucideIcons.shoppingBasket,
  'books': LucideIcons.bookOpen,
  'toys-baby': LucideIcons.baby,
  'sports-fitness': LucideIcons.dumbbell,
};

IconData categoryIconData(String slug) => _icons[slug] ?? LucideIcons.tag;

class CategoryIcon extends StatelessWidget {
  const CategoryIcon({super.key, required this.slug, this.size = 24, this.color});
  final String slug;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => Icon(categoryIconData(slug), size: size, color: color);
}
