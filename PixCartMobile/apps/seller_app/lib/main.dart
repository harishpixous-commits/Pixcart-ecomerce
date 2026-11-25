// PixCart seller app: an empty shell (theme from /api/site, routing). Its screens come in a later module; see
// docs/FLUTTER_GUIDELINES.md, "What is left for the partner and seller apps".

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

void main() => runApp(const ProviderScope(child: ShellApp()));

final _router = GoRouter(routes: [
  GoRoute(path: '/', builder: (context, state) => const ShellHome()),
]);

class ShellApp extends ConsumerWidget {
  const ShellApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = ref.watch(tokensProvider);
    return MaterialApp.router(
      title: AppConfig.appName,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(tokens),
      routerConfig: _router,
    );
  }
}

class ShellHome extends ConsumerWidget {
  const ShellHome({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    return Scaffold(
      backgroundColor: t.page,
      appBar: AppBar(
        backgroundColor: t.primary,
        foregroundColor: Colors.white,
        title: Text(site.brandName.isEmpty ? AppConfig.appName : site.brandName, style: Tw.xl(color: Colors.white)),
      ),
      body: const Padding(
        padding: EdgeInsets.all(16),
        child: EmptyState(title: 'Seller hub app', body: 'This app is being built. Use the website for now.'),
      ),
    );
  }
}
