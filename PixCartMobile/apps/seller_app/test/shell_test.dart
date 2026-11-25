import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixcart_core/pixcart_core.dart';

import 'package:seller_app/main.dart';

void main() {
  testWidgets('the shell opens with the fallback site', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [siteProvider.overrideWith(_OfflineSite.new)],
      child: const ShellApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('app'), findsWidgets);
  });
}

class _OfflineSite extends SiteNotifier {
  @override
  Future<Site> build() async => Site.fallback();
}
