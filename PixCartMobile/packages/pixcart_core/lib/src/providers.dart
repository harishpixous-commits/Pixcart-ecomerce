// App-wide state with Riverpod: the API client, site settings and theme, the shopper's currency, categories, the
// delivery PIN code. The session (sign-in and cart) is in session/session.dart.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/api_client.dart';
import 'format/format.dart' as fmt;
import 'models/models.dart';
import 'site/site.dart';
import 'site/theme_tokens.dart';

/// The one API client. Apps may override it (tests use a fake HTTP client).
final apiProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(userAgent: kIsWeb ? null : 'PixCartApp/1.0 (${defaultTargetPlatform == TargetPlatform.iOS ? 'iPhone' : 'Android'})');
  ref.onDispose(client.close);
  return client;
});

/// Shared preferences (non-secret: guest cart, PIN code, recent searches, currency choice).
final prefsProvider = FutureProvider<SharedPreferences>((ref) => SharedPreferences.getInstance());

/// Site settings. Falls back to the defaults while the API cannot be reached, so the app still opens.
class SiteNotifier extends AsyncNotifier<Site> {
  @override
  Future<Site> build() async {
    try {
      return Site(await ref.read(apiProvider).getMap('/api/site'));
    } catch (_) {
      return Site.fallback();
    }
  }

  Future<void> reload() async {
    state = AsyncData(await build());
  }
}

final siteProvider = AsyncNotifierProvider<SiteNotifier, Site>(SiteNotifier.new);

/// The site, or the fallback while it loads (screens never wait on it).
final siteValueProvider = Provider<Site>((ref) => ref.watch(siteProvider).value ?? Site.fallback());

/// Theme tokens (colours, radii, fonts) for ThemeData.
final tokensProvider = Provider<PcTokens>((ref) => ref.watch(siteValueProvider).tokens);

/// Languages and currencies (GET /api/regional) and the shopper's currency choice (`pc_cur`).
class Regional {
  Regional(this.raw, this.currency);
  final Json raw;
  final String currency;
  List<Json> get currencies => raw.maps('currencies');
  bool get showSwitcher => raw.flag('show_switcher', true);
  Map<String, bool> get payMethods => raw.obj('pay_methods').map((k, v) => MapEntry(k, v == true));
  List<String> get cardNetworks => raw.strings('card_networks');
}

class RegionalNotifier extends AsyncNotifier<Regional> {
  static const curKey = 'pc_cur';

  @override
  Future<Regional> build() async {
    final api = ref.read(apiProvider);
    Json data = const {'currencies': [{'code': 'INR', 'rate': 1, 'digits': 2}]};
    try {
      data = await api.getMap('/api/regional');
    } catch (_) {}
    final prefs = await ref.read(prefsProvider.future);
    final codes = [for (final c in data.maps('currencies')) c.str('code')];
    final saved = prefs.getString(curKey);
    final suggested = data.obj('suggest').str('currency', 'INR');
    final code = saved != null && codes.contains(saved) ? saved : (codes.contains(suggested) ? suggested : 'INR');
    _apply(data, code);
    return Regional(data, code);
  }

  void _apply(Json data, String code) {
    final info = data.maps('currencies').where((c) => c.str('code') == code).firstOrNull;
    fmt.setDisplayCurrency(info == null
        ? null
        : fmt.DisplayCurrency(code: code, rate: info.dbl('rate', 1), digits: info.integer('digits', 2)));
    ref.read(apiProvider).cookies['pc_cur'] = code;
  }

  Future<void> setCurrency(String code) async {
    final prefs = await ref.read(prefsProvider.future);
    await prefs.setString(curKey, code);
    final current = state.value;
    if (current == null) return;
    _apply(current.raw, code);
    state = AsyncData(Regional(current.raw, code));
  }
}

final regionalProvider = AsyncNotifierProvider<RegionalNotifier, Regional>(RegionalNotifier.new);

/// The category tree (GET /api/catalog/categories), cached for the app's life.
final categoriesProvider = FutureProvider<List<CategoryNode>>((ref) async {
  final list = await ref.read(apiProvider).getList('/api/catalog/categories');
  return [for (final c in list) CategoryNode(asMap(c))];
});

/// "Deliver to 641001": one PIN code for the visit (lib/pincode.ts, `pc_pin`).
class PincodeNotifier extends Notifier<String> {
  static const key = 'pc_pin';

  @override
  String build() {
    unawaited(_load());
    return '';
  }

  Future<void> _load() async {
    final prefs = await ref.read(prefsProvider.future);
    final v = prefs.getString(key) ?? '';
    if (v.isNotEmpty && state.isEmpty) state = v;
  }

  Future<bool> hasSaved() async => ((await ref.read(prefsProvider.future)).getString(key) ?? '').isNotEmpty;

  Future<void> set(String pin) async {
    if (!isPincode(pin)) return;
    state = pin;
    await (await ref.read(prefsProvider.future)).setString(key, pin);
  }
}

bool isPincode(String v) => RegExp(r'^[1-9]\d{5}$').hasMatch(v);

final pincodeProvider = NotifierProvider<PincodeNotifier, String>(PincodeNotifier.new);
