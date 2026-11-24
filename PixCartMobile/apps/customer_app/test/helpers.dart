// Test helpers: open a route of the real app with a fake API (path → JSON reply), offline site settings and empty
// shared preferences.

import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A reply: a JSON value (200), or `(status, json)`.
typedef Replies = Map<String, Object?>;

/// The API requests the fake server saw ("GET /api/cart").
final requests = <String>[];

/// The site settings the tests use (Classic theme, brand colours).
const testSite = <String, dynamic>{
  'brand_name': 'PixCart',
  'tagline': 'Shop from verified sellers across India',
  'colors': {'primary': '#0B5563', 'primary_dark': '#073B45', 'accent': '#F5A524', 'buy': '#D7263D', 'success': '#1E8E3E', 'page': '#EEF2F4'},
  'radius': 'rounded',
  'theme': 'classic',
  'announcement': {'enabled': true, 'text': 'Free delivery on orders over {free_delivery_amount} from a seller', 'link': '', 'tone': 'accent'},
  'features': {'wishlist': true, 'reviews': true, 'qa': true, 'coupons': true},
  'free_shipping_threshold_paise': 49900,
  'nav': {'all_menu': true, 'search_categories': true, 'show_categories': true, 'links': [], 'trending': []},
  'home_extras': {'back_to_top': true},
  'footer_columns': [],
  'footer': {'copyright': ''},
};

ApiClient fakeApi(Replies replies) => ApiClient(
      baseUrl: 'http://api.test',
      browserCookies: false,
      tokenStore: MemoryRefreshTokenStore(),
      httpClient: MockClient((req) async {
        final key = '${req.method} ${req.url.path}';
        requests.add(key);
        final reply = replies.containsKey(key) ? replies[key] : replies[req.url.path];
        if (reply == null && !replies.containsKey(key) && !replies.containsKey(req.url.path)) {
          if (req.url.path == '/api/site') return http.Response(jsonEncode(testSite), 200);
          if (req.url.path == '/api/catalog/categories') return http.Response('[]', 200);
          return http.Response(jsonEncode({'error': {'code': 'not_found', 'message': 'Not found'}}), 404);
        }
        if (reply is (int, Object?)) return http.Response(jsonEncode(reply.$2), reply.$1, headers: {'content-type': 'application/json'});
        return http.Response(jsonEncode(reply), 200, headers: {'content-type': 'application/json; charset=utf-8'});
      }),
    );

/// Opens [location] in the app. [signedIn]: the session starts with this user (no refresh call).
Future<ProviderContainer> pumpRoute(WidgetTester tester, String location, {Replies replies = const {}, Json? signedIn}) async {
  SharedPreferences.setMockInitialValues({});
  requests.clear();
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final api = fakeApi({
    if (signedIn != null) 'GET /api/cart': {'groups': [], 'summary': {'item_count': 0}},
    ...replies,
  });
  if (signedIn != null) api.setAccessToken('test.token.x');
  final container = ProviderContainer(overrides: [
    apiProvider.overrideWithValue(api),
    initialLocationProvider.overrideWithValue(location),
    if (signedIn != null) sessionProvider.overrideWith(() => _SignedIn(User(signedIn))),
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const PixCartApp()));
  await settle(tester);
  return container;
}

/// Lets fake replies and timers run (screens poll or tick, so pumpAndSettle may never settle).
Future<void> settle(WidgetTester tester, [int frames = 12]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

class _SignedIn extends SessionNotifier {
  _SignedIn(this.user);
  final User user;

  @override
  SessionState build() => SessionState(user: user, ready: true);

  @override
  Future<void> get restored async {}
}

const testUser = <String, dynamic>{
  'id': 'u1',
  'name': 'Asha Rao',
  'phone': '9999900001',
  'email': 'asha@example.com',
  'is_admin': false,
  'seller': null,
  'delivery': null,
};
