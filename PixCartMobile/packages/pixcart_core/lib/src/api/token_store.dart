import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the refresh token lives between app starts.
///
/// On phones the API's HttpOnly `pc_refresh` cookie cannot live in a browser, so the app keeps the token in the
/// platform keystore (Keychain / Android Keystore via flutter_secure_storage) and sends it back as the same cookie.
/// On the web build the browser keeps the cookie itself and this store is not used.
abstract class RefreshTokenStore {
  Future<String?> read();
  Future<void> write(String? token);
}

class SecureRefreshTokenStore implements RefreshTokenStore {
  SecureRefreshTokenStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'pc_refresh';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() async {
    try {
      return await _storage.read(key: _key);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(String? token) async {
    try {
      if (token == null || token.isEmpty) {
        await _storage.delete(key: _key);
      } else {
        await _storage.write(key: _key, value: token);
      }
    } catch (_) {
      /* keystore unavailable: the session lasts until the app closes */
    }
  }
}

/// Keeps the token in memory only (tests, and the web build where the browser holds the cookie).
class MemoryRefreshTokenStore implements RefreshTokenStore {
  String? token;
  @override
  Future<String?> read() async => token;
  @override
  Future<void> write(String? t) async => token = t;
}

RefreshTokenStore defaultTokenStore() => kIsWeb ? MemoryRefreshTokenStore() : SecureRefreshTokenStore();
