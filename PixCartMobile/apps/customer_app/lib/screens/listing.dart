// Placeholder: replaced by the screen port.

import 'package:material_ui/material_ui.dart';

import '../shop/frame.dart';

class CategoryScreen extends StatelessWidget {
  const CategoryScreen({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context) => ShopBody(children: [Text(slug)]);
}

class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) => const ShopBody(children: [Text('SearchScreen')]);
}
