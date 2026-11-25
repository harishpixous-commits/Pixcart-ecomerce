// Placeholder: replaced by the screen port.

import 'package:material_ui/material_ui.dart';

import '../shop/frame.dart';

class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context) => ShopBody(children: [Text(id)]);
}
