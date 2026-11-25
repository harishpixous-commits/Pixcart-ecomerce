/// An error reply from the API: `{"error": {"code", "message", "fields"}}` (same as `ApiError` in lib/api.ts).
class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, [Map<String, String>? fields]) : fields = fields ?? const {};

  /// HTTP status; 0 for a network failure.
  final int status;
  final String code;
  final String message;
  final Map<String, String> fields;

  bool get isUnauthorized => status == 401;
  bool get isNetwork => status == 0;

  /// Builds the error from a reply body (any shape); falls back to the website's generic messages.
  factory ApiError.fromBody(int status, Object? body) {
    Map<String, dynamic> e = const {};
    if (body is Map && body['error'] is Map) e = Map<String, dynamic>.from(body['error'] as Map);
    final fields = <String, String>{};
    final raw = e['fields'];
    if (raw is Map) {
      raw.forEach((k, v) => fields['$k'] = '$v');
    }
    return ApiError(
      status,
      (e['code'] as String?) ?? 'error',
      (e['message'] as String?) ?? 'Something went wrong ($status). Try again.',
      fields,
    );
  }

  static ApiError network() => ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.');

  /// The message to show for any caught error.
  static String messageOf(Object error, [String fallback = 'Something went wrong. Try again.']) =>
      error is ApiError ? error.message : fallback;

  @override
  String toString() => 'ApiError($status, $code, $message)';
}
