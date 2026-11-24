// The wishlist's saved ids and the heart button (lib/wishlist.tsx), plus recently viewed products.

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

class WishlistNotifier extends Notifier<Set<String>> {
  @override
  Set<String> build() {
    final user = ref.watch(sessionProvider.select((s) => s.user?.id));
    if (user != null) _load();
    return {};
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).getMap('/api/wishlist');
      state = r.strings('ids').toSet();
    } catch (_) {}
  }

  /// Saves or removes; false when the shopper must sign in first.
  Future<bool> toggle(String id) async {
    if (ref.read(sessionProvider).user == null) return false;
    final on = state.contains(id);
    state = on ? ({...state}..remove(id)) : {...state, id};
    try {
      if (on) {
        await ref.read(apiProvider).delete('/api/wishlist/$id');
      } else {
        await ref.read(apiProvider).put('/api/wishlist/$id');
      }
    } catch (_) {
      state = on ? {...state, id} : ({...state}..remove(id));
    }
    return true;
  }
}

final wishlistProvider = NotifierProvider<WishlistNotifier, Set<String>>(WishlistNotifier.new);

class WishlistHeart extends ConsumerWidget {
  const WishlistHeart({super.key, required this.productId, this.size = 36});
  final String productId;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final site = ref.watch(siteValueProvider);
    if (!site.feature('wishlist')) return const SizedBox.shrink();
    final on = ref.watch(wishlistProvider).contains(productId);
    final t = context.pc;
    return Semantics(
      button: true,
      toggled: on,
      label: on ? 'Remove from wishlist' : 'Save to wishlist',
      child: GestureDetector(
        onTap: () async {
          final ok = await ref.read(wishlistProvider.notifier).toggle(productId);
          if (!ok && context.mounted) {
            await context.push('/login?next=${Uri.encodeComponent(GoRouterState.of(context).uri.toString())}');
          }
        },
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.9),
            shape: BoxShape.circle,
            border: Border.all(color: t.line),
            boxShadow: shadowSm,
          ),
          child: on ? Icon(Icons.favorite_rounded, size: 21, color: t.buy) : Icon(LucideIcons.heart, size: 20, color: t.inkFaint),
        ),
      ),
    );
  }
}

const _recentKey = 'pc_recent_v1';

/// Remembers a product page the shopper opened (home "Recently viewed").
Future<void> rememberViewed(WidgetRef ref, ProductPage p, int max) async {
  try {
    final prefs = await ref.read(prefsProvider.future);
    final list = (jsonDecode(prefs.getString(_recentKey) ?? '[]') as List).where((x) => asMap(x)['id'] != p.id).toList()
      ..insert(0, {'id': p.id, 'slug': p.slug, 'title': p.title, 'image': p.images.isEmpty ? '' : p.images.first, 'price': p.price, 'mrp': p.mrp});
    await prefs.setString(_recentKey, jsonEncode(list.take(max < 1 ? 1 : max).toList()));
  } catch (_) {}
}

final viewedProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  try {
    final prefs = await ref.read(prefsProvider.future);
    return [for (final x in jsonDecode(prefs.getString(_recentKey) ?? '[]') as List) asMap(x)];
  } catch (_) {
    return [];
  }
});
