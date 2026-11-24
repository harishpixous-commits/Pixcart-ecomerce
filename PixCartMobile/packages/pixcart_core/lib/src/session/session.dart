// Sign-in and cart state (port of lib/session.tsx): the signed-in user, the cart count, the guest cart kept on the
// phone while signed out (merged into the account's cart on sign-in), and following the session when it ends.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../models/models.dart';
import '../providers.dart';

class SessionState {
  const SessionState({this.user, this.ready = false, this.cartCount = 0, this.guestLines = const []});
  final User? user;

  /// True once the saved sign-in has been restored (or found missing).
  final bool ready;
  final int cartCount;
  final List<GuestLine> guestLines;

  bool get signedIn => user != null;

  SessionState copyWith({User? user, bool clearUser = false, bool? ready, int? cartCount, List<GuestLine>? guestLines}) =>
      SessionState(
        user: clearUser ? null : (user ?? this.user),
        ready: ready ?? this.ready,
        cartCount: cartCount ?? this.cartCount,
        guestLines: guestLines ?? this.guestLines,
      );
}

class SessionNotifier extends Notifier<SessionState> {
  static const guestKey = 'pc_guest_cart_v1';

  final _restored = Completer<void>();
  StreamSubscription<String?>? _tokens;

  ApiClient get _api => ref.read(apiProvider);

  @override
  SessionState build() {
    _tokens = _api.tokenChanges.listen(_onToken);
    ref.onDispose(() => _tokens?.cancel());
    unawaited(_restore());
    return const SessionState();
  }

  /// Waits until the saved sign-in has been restored.
  Future<void> get restored => _restored.future;

  Future<void> _restore() async {
    try {
      if (await _api.hasRefreshToken() && await _api.refreshSession()) {
        try {
          await _loadUser();
        } catch (_) {
          _api.setAccessToken(null);
        }
      }
      if (state.user != null) await _mergeGuest();
    } finally {
      state = state.copyWith(ready: true);
      if (!_restored.isCompleted) _restored.complete();
      await refreshCart();
    }
  }

  /// The session can end outside this screen (it expires, or this device was signed out from another one).
  void _onToken(String? token) {
    final current = state.user;
    if (token == null) {
      if (current != null) {
        state = state.copyWith(clearUser: true);
        unawaited(refreshCart());
      }
      return;
    }
    if (current != null && tokenSubject(token) != current.id) {
      unawaited(_loadUser().then((_) => refreshCart()).catchError((Object _) {
        _api.setAccessToken(null);
        return null;
      }));
    }
  }

  Future<User> _loadUser() async {
    final me = User(await _api.getMap('/api/auth/me'));
    state = state.copyWith(user: me);
    return me;
  }

  Future<List<GuestLine>> _readGuest() async {
    try {
      final prefs = await ref.read(prefsProvider.future);
      final raw = prefs.getString(guestKey);
      final parsed = raw == null ? const <dynamic>[] : jsonDecode(raw);
      return [for (final l in asList(parsed)) if (l is Map && l['variant_id'] is String) GuestLine.fromJson(asMap(l))];
    } catch (_) {
      return [];
    }
  }

  Future<void> _writeGuest(List<GuestLine> lines) async {
    try {
      final prefs = await ref.read(prefsProvider.future);
      await prefs.setString(guestKey, jsonEncode([for (final l in lines) l.toJson()]));
    } catch (_) {
      /* storage unavailable: the cart lives for this run only */
    }
  }

  /// Moves lines added while signed out into the account's cart; keeps them if that fails.
  Future<void> _mergeGuest() async {
    final g = await _readGuest();
    if (g.isEmpty) return;
    try {
      await _api.post('/api/cart/merge', body: {
        'items': [for (final l in g) {'variant_id': l.variantId, 'qty': l.qty}],
      });
      await _writeGuest([]);
      state = state.copyWith(guestLines: const []);
    } catch (_) {
      /* keep the guest cart */
    }
  }

  /// Reloads the cart count (and returns the account's cart when signed in).
  Future<CartView?> refreshCart() async {
    if (state.user == null) {
      final g = await _readGuest();
      state = state.copyWith(guestLines: g, cartCount: g.fold<int>(0, (n, l) => n + l.qty));
      return null;
    }
    try {
      final cart = CartView(await _api.getMap('/api/cart'));
      final problems = cart.lines.where((l) => l.problem.isNotEmpty).fold<int>(0, (n, l) => n + l.qty);
      state = state.copyWith(cartCount: cart.summary.itemCount + problems);
      return cart;
    } catch (_) {
      return null;
    }
  }

  /// After a successful OTP verify: keeps the access token, merges the guest cart.
  Future<void> signIn(String token, User user) async {
    _api.setAccessToken(token);
    state = state.copyWith(user: user, ready: true);
    await _mergeGuest();
    await refreshCart();
  }

  Future<void> signOut() async {
    try {
      await _api.post('/api/auth/logout');
    } catch (_) {
      /* already signed out */
    }
    state = state.copyWith(clearUser: true);
    await _api.clearSession();
    await refreshCart();
  }

  Future<void> reloadUser() async {
    await _loadUser();
  }

  /// Adds to the cart; returns a note when the quantity had to be lowered (stock, per-item limit, deal units).
  Future<String?> addToCart(GuestLine line) async {
    String? note;
    await restored;
    if (state.user != null) {
      final r = CartView(asMap(await _api.post('/api/cart/items', body: {'variant_id': line.variantId, 'qty': line.qty})));
      note = (r.notice ?? '').isEmpty ? null : r.notice;
    } else {
      final g = await _readGuest();
      final cap = (line.max ?? 10) < 1 ? 1 : (line.max ?? 10);
      final existing = g.where((l) => l.variantId == line.variantId).firstOrNull;
      final wanted = (existing?.qty ?? 0) + line.qty;
      if (wanted > cap) note = 'You can add at most $cap of this item, so your cart has $cap.';
      if (existing != null) {
        existing
          ..qty = wanted > cap ? cap : wanted
          ..max = cap;
      } else {
        g.add(line
          ..qty = line.qty > cap ? cap : line.qty
          ..max = cap);
      }
      await _writeGuest(g);
    }
    await refreshCart();
    return note;
  }

  Future<void> setGuestQty(String variantId, int qty) async {
    final g = (await _readGuest())
      ..forEach((l) {
        if (l.variantId == variantId) l.qty = qty;
      })
      ..removeWhere((l) => l.qty <= 0);
    await _writeGuest(g);
    state = state.copyWith(guestLines: g, cartCount: g.fold<int>(0, (n, l) => n + l.qty));
  }
}

final sessionProvider = NotifierProvider<SessionNotifier, SessionState>(SessionNotifier.new);
