import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import 'router.dart';

void main() {
  // Website-style addresses on the web build (/p/slug, not /#/p/slug), so deep links match the website's.
  usePathUrlStrategy();
  runApp(const ProviderScope(child: PixCartApp()));
}

class PixCartApp extends ConsumerWidget {
  const PixCartApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = ref.watch(tokensProvider);
    final site = ref.watch(siteValueProvider);
    ref.watch(regionalProvider); // sets the shopper's currency before prices show
    return MaterialApp.router(
      title: site.brandName.isEmpty ? AppConfig.appName : site.brandName,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(tokens),
      routerConfig: ref.watch(routerProvider),
    );
  }
}
