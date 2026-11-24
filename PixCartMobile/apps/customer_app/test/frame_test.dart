import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  testWidgets('the shop frame: announcement, header, tab bar', (tester) async {
    await pumpRoute(tester, '/');
    expect(find.text('Free delivery on orders over ₹499 from a seller'), findsOneWidget);
    for (final tab in ['Home', 'Categories', 'Orders', 'Cart', 'Account']) {
      expect(find.text(tab), findsOneWidget);
    }
    expect(find.text('Search PixCart'), findsOneWidget);
    expect(find.text('Set delivery PIN'), findsOneWidget);
  });

  testWidgets('signed-in pages send signed-out visitors to sign in', (tester) async {
    await pumpRoute(tester, '/orders');
    expect(find.text('OrdersScreen'), findsNothing);
  });
}
