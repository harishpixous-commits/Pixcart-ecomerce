import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pixcart_core/pixcart_core.dart';

void main() {
  group('format', () {
    tearDown(() => setDisplayCurrency(null));

    test('rupees in Indian grouping, paise only when present', () {
      expect(rupees(12345678 * 100), '₹1,23,45,678');
      expect(rupees(49900), '₹499');
      expect(rupees(123450), '₹1,234.50');
      expect(rupeesExact(49900), '₹499.00');
      expect(inRupees(123456), '₹1,234.56');
    });

    test('the shopper currency converts at the admin rate', () {
      setDisplayCurrency(const DisplayCurrency(code: 'USD', rate: 0.012, digits: 2));
      expect(rupees(100000), r'$12.00');
      expect(inRupees(100000), '₹1,000'); // what is charged stays in rupees
      expect(currencySymbol(), r'$');
      expect(money(123450, 'AED'), 'AED 1,234.50');
    });

    test('dates in India time', () {
      expect(date('2026-11-24T09:35:00+00:00'), '24 Nov 2026');
      expect(dateTime('2026-11-24T09:35:00+00:00'), '24 Nov, 3:05 pm');
      expect(dateTime('2026-11-23T20:00:00+00:00'), '24 Nov, 1:30 am');
      expect(date(null), '');
    });

    test('helpers', () {
      expect(pct(1800), '18%');
      expect(pct(250), '2.50%'); // toFixed(2) like the website
      expect(toPaise('₹1,234.50'), 123450);
      expect(paiseToInput(49900), '499');
      expect(count(123456), '1,23,456');
      expect(duration(const Duration(hours: 28)), '1 day 4 hours');
      expect(duration(const Duration(minutes: 5)), '5 min');
      expect(timeLeft(const Duration(hours: 7, minutes: 48, seconds: 33)), '07:48:33');
      expect(splitBrand('PixCart'), ('Pix', 'Cart'));
      expect(fillTokens('Free delivery over {free_delivery_amount} at {brand}', brand: 'PixCart', freeShippingThresholdPaise: 49900),
          'Free delivery over ₹499 at PixCart');
      expect(humanize('pending_payment'), 'Pending payment');
    });
  });

  group('theme tokens (lib/theme.ts colorVars)', () {
    test('light and dark steps from the brand colours', () {
      final t = resolveTokens({
        'theme': 'classic',
        'radius': 'rounded',
        'colors': {'primary': '#0B5563', 'primary_dark': '#073B45', 'accent': '#F5A524', 'buy': '#D7263D', 'success': '#1E8E3E', 'page': '#EEF2F4'},
      });
      // --c-primary-light: mix(primary, 255, 0.88) = 226 235 236
      expect(t.primaryLight.toARGB32(), 0xFFE2EBEC);
      // --c-accent-dark: mix(accent, 0, 0.12) = 216 145 32
      expect(t.accentDark.toARGB32(), 0xFFD89120);
      expect(t.radiusXl, 12);
      expect(t.chrome, 'brand');
    });

    test('a theme preset and the owner layout changes', () {
      final t = resolveTokens({
        'theme': 'fresh',
        'colors': {'primary': '#000000'},
        'theme_settings': {
          'fresh': {'preset': 'berry', 'layout': {'cart': 'side'}},
        },
      });
      expect(t.primary.toARGB32(), 0xFFB3135A);
      expect(t.radiusLg, 12);
      expect(t.option('cart'), 'side');
      expect(t.option('categories'), 'squares');
    });
  });

  group('api client', () {
    test('parses the refresh cookie', () {
      expect(ApiClient.parseRefreshCookie('pc_refresh=abc123; HttpOnly; Max-Age=2592000; Path=/api/auth; SameSite=lax'), 'abc123');
      expect(ApiClient.parseRefreshCookie('pc_refresh=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/api/auth'), '');
      expect(ApiClient.parseRefreshCookie('other=1'), isNull);
    });

    test('errors carry the API code, message and fields', () async {
      final client = ApiClient(
        baseUrl: 'http://api.test',
        browserCookies: false,
        tokenStore: MemoryRefreshTokenStore(),
        httpClient: MockClient((req) async => http.Response(
            jsonEncode({'error': {'code': 'validation_error', 'message': 'Enter your name', 'fields': {'name': 'Required'}}}), 422)),
      );
      await expectLater(
        client.post('/api/addresses', body: {}),
        throwsA(isA<ApiError>()
            .having((e) => e.code, 'code', 'validation_error')
            .having((e) => e.fields['name'], 'field', 'Required')
            .having((e) => e.status, 'status', 422)),
      );
    });

    test('a 401 refreshes once with the stored cookie and retries; the rotated cookie is kept', () async {
      final store = MemoryRefreshTokenStore()..token = 'old';
      final seen = <String>[];
      final client = ApiClient(
        baseUrl: 'http://api.test',
        browserCookies: false,
        tokenStore: store,
        httpClient: MockClient((req) async {
          seen.add('${req.method} ${req.url.path} ${req.headers['Cookie'] ?? ''} ${req.headers['Authorization'] ?? ''}');
          if (req.url.path == '/api/auth/refresh') {
            expect(req.headers['X-Requested-With'], 'pixcart');
            return http.Response(jsonEncode({'access_token': 'a.b.c'}), 200,
                headers: {'set-cookie': 'pc_refresh=new; HttpOnly; Path=/api/auth; Max-Age=100'});
          }
          if (req.headers['Authorization'] == 'Bearer a.b.c') return http.Response(jsonEncode({'ok': true}), 200);
          return http.Response('{}', 401);
        }),
      );
      final r = await client.getMap('/api/cart');
      expect(r['ok'], true);
      expect(store.token, 'new');
      expect(seen[1], contains('pc_refresh=old'));
      expect(seen.length, 3);
    });

    test('query strings repeat list values and skip empty ones', () {
      final c = ApiClient(baseUrl: 'http://x', browserCookies: false, tokenStore: MemoryRefreshTokenStore(), httpClient: MockClient((_) async => http.Response('', 204)));
      expect(c.buildUri('/api/search', {'q': 'a b', 'brand': ['X', 'Y'], 'page': null, 'sort': ''}).toString(),
          'http://x/api/search?q=a+b&brand=X&brand=Y');
    });
  });

  test('models read the API JSON', () {
    final p = ProductCard({
      'id': '1', 'slug': 's', 'title': 'T', 'brand': 'B', 'image': '/media/a.webp', 'price': 129900, 'mrp': 299900,
      'discount_pct': 56, 'rating_avg': 4.2, 'rating_count': 1418, 'in_stock': true, 'seller_name': 'S',
      'deal': {'kind': 'deal_of_day', 'label': 'Deal of the Day', 'ends_at': '2026-11-25T00:00:00+00:00', 'deal_price': 1, 'regular_price': null, 'claimed_pct': null, 'variant_id': 'v'},
      'unit_price': {'paise': 149667, 'per': '100 ml'}, 'variant_count': 4, 'variant_id': null,
    });
    expect(p.deal!.label, 'Deal of the Day');
    expect(p.unitPrice!.per, '100 ml');
    expect(p.variantId, isNull);
    expect(p.ratingAvg, 4.2);
  });
}
