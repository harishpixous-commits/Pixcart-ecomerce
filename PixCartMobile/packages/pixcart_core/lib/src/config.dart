import 'package:flutter/foundation.dart';

/// Build-time configuration (`--dart-define=NAME=value`).
///
/// - `API_BASE`: the API origin, e.g. `https://shop.example.in` (no trailing slash, no `/api`). Empty on the web
///   build means "same origin" (the site serves the app and proxies `/api` like the Next.js website does). Empty on a
///   phone means the Android emulator's view of this computer (`http://10.0.2.2:8100`).
/// - `APP_NAME`: the name shown before /api/site answers (the brand name from the API replaces it).
class AppConfig {
  AppConfig._();

  static const String _apiBase = String.fromEnvironment('API_BASE');
  static const String appName = String.fromEnvironment('APP_NAME', defaultValue: 'PixCart');

  /// Overridden in tests.
  static String? debugApiBase;

  static String get apiBase {
    final v = debugApiBase ?? _apiBase;
    if (v.isNotEmpty) return v.endsWith('/') ? v.substring(0, v.length - 1) : v;
    return kIsWeb ? '' : 'http://10.0.2.2:8100';
  }

  /// An absolute URL for an API path or a media path the API returned ("/media/products/a.webp").
  static String url(String path) {
    if (path.isEmpty || path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) return path;
    final base = apiBase;
    if (base.isEmpty) return path;
    return '$base${path.startsWith('/') ? '' : '/'}$path';
  }
}

/// A media URL ready for Image.network (relative paths from the API get the API origin).
String mediaUrl(String? path) => AppConfig.url(path ?? '');
