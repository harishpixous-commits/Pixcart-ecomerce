// Placeholder: replaced by the screen port.

import 'package:material_ui/material_ui.dart';

import '../shop/frame.dart';

class ProductScreen extends StatelessWidget {
  const ProductScreen({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context) => ShopBody(children: [Text(slug)]);
}
