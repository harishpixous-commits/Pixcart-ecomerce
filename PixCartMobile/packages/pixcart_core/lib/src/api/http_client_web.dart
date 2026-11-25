import 'package:http/browser_client.dart';
import 'package:http/http.dart' as http;

/// In the browser the refresh cookie is kept by the browser; withCredentials sends it to a cross-origin API_BASE too.
http.Client createHttpClient() => BrowserClient()..withCredentials = true;
const bool browserManagesCookies = true;
