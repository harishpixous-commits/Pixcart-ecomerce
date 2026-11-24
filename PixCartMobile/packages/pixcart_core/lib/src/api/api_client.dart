import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'api_error.dart';
import 'http_client_io.dart' if (dart.library.js_interop) 'http_client_web.dart' as platform;
import 'token_store.dart';

typedef Query = Map<String, Object?>;

/// The API client (port of `frontend/src/lib/api.ts`).
///
/// - The access token (JWT) lives in memory only and goes out as `Authorization: Bearer`.
/// - The refresh token is the API's `pc_refresh` cookie. Phones keep it in secure storage and send it back as that
///   cookie to `/api/auth/*`; the browser build lets the browser keep it.
/// - Every request carries `X-Requested-With: pixcart` (required by the cookie endpoints).
/// - A 401 outside `/api/auth/` triggers one silent refresh and one retry.
class ApiClient {
  ApiClient({http.Client? httpClient, RefreshTokenStore? tokenStore, String? baseUrl, this.userAgent, bool? browserCookies})
      : _http = httpClient ?? platform.createHttpClient(),
        _store = tokenStore ?? defaultTokenStore(),
        // ignore: prefer_initializing_formals
        _baseUrl = baseUrl,
        _browserCookies = browserCookies ?? platform.browserManagesCookies;

  static const refreshCookie = 'pc_refresh';

  final http.Client _http;
  final RefreshTokenStore _store;
  final String? _baseUrl;
  final bool _browserCookies;

  /// Sent on phones (the server shows it in "Signed-in devices"); browsers send their own.
  final String? userAgent;

  /// Extra cookies the website sets for the API (`pc_cur`, `pc_lang`); phones send them by hand.
  final Map<String, String> cookies = {};

  String? _accessToken;
  Future<bool>? _refreshing;
  final _tokens = StreamController<String?>.broadcast();

  String get baseUrl => _baseUrl ?? AppConfig.apiBase;
  String? get accessToken => _accessToken;
  bool get hasToken => _accessToken != null;

  /// Fires when the access token changes (null: signed out or the session ended).
  Stream<String?> get tokenChanges => _tokens.stream;

  void setAccessToken(String? token) {
    _accessToken = token;
    _tokens.add(token);
  }

  /// True when a refresh token is probably stored (phones); signed-out visitors skip the refresh call.
  Future<bool> hasRefreshToken() async => _browserCookies ? true : ((await _store.read())?.isNotEmpty ?? false);

  Uri buildUri(String path, [Query? query]) {
    final pairs = <String>[];
    query?.forEach((k, v) {
      if (v == null || v == '') return;
      final values = v is Iterable ? [for (final x in v) '$x'] : ['$v'];
      for (final x in values) {
        pairs.add('${Uri.encodeQueryComponent(k)}=${Uri.encodeQueryComponent(x)}');
      }
    });
    final url = '$baseUrl$path';
    if (pairs.isEmpty) return Uri.parse(url);
    return Uri.parse('$url${url.contains('?') ? '&' : '?'}${pairs.join('&')}');
  }

  Future<Map<String, String>> _headers(String path, {bool json = false, Map<String, String>? extra}) async {
    final h = <String, String>{...?extra, 'X-Requested-With': 'pixcart', 'Accept': 'application/json'};
    if (json) h['Content-Type'] = 'application/json';
    if (_accessToken != null) h['Authorization'] = 'Bearer $_accessToken';
    if (!_browserCookies) {
      if (userAgent != null) h['User-Agent'] = userAgent!;
      final jar = <String>[for (final e in cookies.entries) '${e.key}=${e.value}'];
      if (path.startsWith('/api/auth/')) {
        final t = await _store.read();
        if (t != null && t.isNotEmpty) jar.add('$refreshCookie=$t');
      }
      if (jar.isNotEmpty) h['Cookie'] = jar.join('; ');
    }
    return h;
  }

  /// Keeps the rotated refresh token from a `Set-Cookie` reply (phones only).
  Future<void> _captureCookie(http.BaseResponse res) async {
    if (_browserCookies) return;
    final raw = res.headers['set-cookie'];
    if (raw == null) return;
    final cookie = parseRefreshCookie(raw);
    if (cookie == null) return;
    await _store.write(cookie.isEmpty ? null : cookie);
  }

  /// The refresh token in a Set-Cookie header: null when the header does not mention it, '' when it deletes it.
  static String? parseRefreshCookie(String header) {
    final i = header.indexOf('$refreshCookie=');
    if (i < 0) return null;
    final rest = header.substring(i + refreshCookie.length + 1);
    final end = rest.indexOf(';');
    var value = (end < 0 ? rest : rest.substring(0, end)).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.substring(1, value.length - 1);
    final attrs = (end < 0 ? '' : rest.substring(end)).toLowerCase();
    final expired = value.isEmpty || RegExp(r'max-age=0(?!\d)').hasMatch(attrs) || attrs.contains('expires=thu, 01 jan 1970');
    return expired ? '' : value;
  }

  /// Renews the access token with the refresh cookie (one call at a time). False when the session has ended.
  Future<bool> refreshSession() {
    return _refreshing ??= () async {
      try {
        if (!(await hasRefreshToken())) {
          setAccessToken(null);
          return false;
        }
        final res = await _http.post(buildUri('/api/auth/refresh'), headers: await _headers('/api/auth/refresh'));
        await _captureCookie(res);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (res.statusCode == 401) await _store.write(null);
          setAccessToken(null);
          return false;
        }
        final data = asMap(jsonDecode(utf8.decode(res.bodyBytes)));
        setAccessToken(data['access_token'] as String?);
        return true;
      } catch (_) {
        return false;
      } finally {
        scheduleMicrotask(() => _refreshing = null);
      }
    }();
  }

  /// Forgets the session on this device (after /api/auth/logout).
  Future<void> clearSession() async {
    await _store.write(null);
    setAccessToken(null);
  }

  /// Stores a refresh token received another way (tests).
  Future<void> setRefreshToken(String? token) => _store.write(token);

  Future<dynamic> request(String method, String path,
      {Object? body, Query? query, Map<String, String>? headers, bool retried = false}) async {
    final req = http.Request(method, buildUri(path, query));
    req.headers.addAll(await _headers(path, json: body != null, extra: headers));
    if (body != null) req.body = jsonEncode(body);
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req));
    } catch (_) {
      throw ApiError.network();
    }
    if (path.startsWith('/api/auth/')) await _captureCookie(res);
    if (res.statusCode == 401 && !retried && !path.startsWith('/api/auth/')) {
      if (await refreshSession()) return request(method, path, body: body, query: query, headers: headers, retried: true);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      Object? data;
      try {
        data = jsonDecode(utf8.decode(res.bodyBytes));
      } catch (_) {
        /* non-JSON error */
      }
      throw ApiError.fromBody(res.statusCode, data);
    }
    if (res.statusCode == 204 || res.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(res.bodyBytes));
  }

  Future<dynamic> get(String path, {Query? query, Map<String, String>? headers}) =>
      request('GET', path, query: query, headers: headers);
  Future<dynamic> post(String path, {Object? body, Query? query}) =>
      request('POST', path, body: body ?? const <String, Object?>{}, query: query);
  Future<dynamic> put(String path, {Object? body}) => request('PUT', path, body: body ?? const <String, Object?>{});
  Future<dynamic> patch(String path, {Object? body}) => request('PATCH', path, body: body ?? const <String, Object?>{});
  Future<dynamic> delete(String path, {Query? query}) => request('DELETE', path, query: query);

  /// GET returning a JSON object.
  Future<Map<String, dynamic>> getMap(String path, {Query? query}) async => asMap(await get(path, query: query));

  /// GET returning a JSON list.
  Future<List<dynamic>> getList(String path, {Query? query}) async {
    final v = await get(path, query: query);
    return v is List ? v : const [];
  }

  /// Multipart upload of one file (`file` field), like `uploadWithProgress` (progress is not reported).
  Future<dynamic> upload(String path, List<int> bytes, String filename, {bool retried = false}) async {
    final req = http.MultipartRequest('POST', buildUri(path));
    req.headers.addAll(await _headers(path));
    req.files.add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req));
    } catch (_) {
      throw ApiError(0, 'network', 'The upload stopped. Check your connection and try again.');
    }
    if (res.statusCode == 401 && !retried && await refreshSession()) return upload(path, bytes, filename, retried: true);
    Object? data;
    try {
      data = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      /* not JSON */
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return data;
    if (res.statusCode == 413 && data == null) throw ApiError(413, 'error', 'The file is too large');
    throw ApiError.fromBody(res.statusCode, data);
  }

  void close() {
    _tokens.close();
    _http.close();
  }
}

/// A JSON object from any decoded value (empty when it is not an object).
Map<String, dynamic> asMap(Object? v) =>
    v is Map<String, dynamic> ? v : (v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{});

/// A JSON list from any decoded value.
List<dynamic> asList(Object? v) => v is List ? v : const [];

/// The user id inside an access token (not verified here; the server verifies every request).
String? tokenSubject(String token) {
  try {
    final part = token.split('.')[1];
    final json = utf8.decode(base64Url.decode(base64Url.normalize(part)));
    return asMap(jsonDecode(json))['sub'] as String?;
  } catch (_) {
    return null;
  }
}
