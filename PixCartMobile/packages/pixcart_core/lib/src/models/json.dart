// Small helpers for reading the API's JSON safely (fields may be missing or null on older servers).

import '../api/api_client.dart';

typedef Json = Map<String, dynamic>;

extension JsonRead on Json {
  String str(String k, [String fallback = '']) {
    final v = this[k];
    return v == null ? fallback : '$v';
  }

  String? strOrNull(String k) {
    final v = this[k];
    return v == null ? null : '$v';
  }

  int integer(String k, [int fallback = 0]) {
    final v = this[k];
    if (v is int) return v;
    if (v is num) return v.round();
    if (v is String) return int.tryParse(v) ?? fallback;
    return fallback;
  }

  int? intOrNull(String k) {
    final v = this[k];
    if (v is int) return v;
    if (v is num) return v.round();
    return null;
  }

  double dbl(String k, [double fallback = 0]) {
    final v = this[k];
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v) ?? fallback;
    return fallback;
  }

  double? dblOrNull(String k) {
    final v = this[k];
    return v is num ? v.toDouble() : null;
  }

  bool flag(String k, [bool fallback = false]) {
    final v = this[k];
    return v is bool ? v : fallback;
  }

  Json obj(String k) => asMap(this[k]);

  Json? objOrNull(String k) => this[k] is Map ? asMap(this[k]) : null;

  List<Json> maps(String k) => [for (final x in asList(this[k])) asMap(x)];

  List<String> strings(String k) => [for (final x in asList(this[k])) '$x'];

  List<T> list<T>(String k, T Function(Json) parse) => [for (final x in asList(this[k])) parse(asMap(x))];
}
