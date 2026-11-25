import 'package:customer_app/main.dart';
import 'package:customer_app/screens/categories.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'helpers.dart';

void main() {
  testWidgets('categories use catalog values and child native routes', (tester) async {
    await pumpRoute(tester, '/categories', replies: {
      '/api/catalog/categories': [
        {'id':'synthetic','name':'Synthetic category','slug':'grocery','product_count':37,'children':[
          {'id':'child','name':'Synthetic child','slug':'child','product_count':2,'children':[]}
        ]}
      ],
    });
    expect(requests, contains('GET /api/catalog/categories'));
    expect(find.text('All categories'), findsOneWidget);
    expect(find.descendant(of: find.byType(CategoriesScreen), matching: find.text('Synthetic category')), findsOneWidget);
    expect(find.text('37'), findsOneWidget);
    expect(find.text('Synthetic child'), findsOneWidget);
    expect(find.text('CategoriesScreen'), findsNothing);
    await expectLater(find.byType(PixCartApp), matchesGoldenFile('goldens/categories.png'));
    await tester.tap(find.text('Synthetic child'));
    await settle(tester);
    // the route the tap opened, read from the router itself (not from a widget's text)
    final router = GoRouter.of(tester.element(find.byType(CategoriesScreen, skipOffstage: false)));
    expect(router.routerDelegate.currentConfiguration.last.matchedLocation, '/c/child'); // a push lies on top of /categories
  });

  testWidgets('catalog failure matches the empty directory fallback', (tester) async {
    await pumpRoute(tester, '/categories', replies: {
      '/api/catalog/categories': (500, {'error':{'code':'synthetic','message':'Synthetic failure'}}),
    });
    expect(find.text('All categories'), findsOneWidget);
    expect(find.text('CategoriesScreen'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
