// Opening the website's links inside the app: paths the app has a screen for go through the router; other shop
// pages (help, deals, policies...) open on the website (SITE_URL) in the in-app browser.

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:url_launcher/url_launcher.dart';

/// The website's origin for pages the app does not have yet (`--dart-define=SITE_URL=https://...`).
const siteUrl = String.fromEnvironment('SITE_URL');

/// The paths the app has screens for (go_router routes mirror the website's URLs).
final _appPaths = <RegExp>[
  RegExp(r'^/$'),
  RegExp(r'^/(login|signup|categories|search|cart|checkout|orders|account|wishlist|notifications)$'),
  RegExp(r'^/(c|p|orders)/[^/]+$'),
  RegExp(r'^/account/(addresses|cards)$'),
];

bool isAppPath(String href) {
  final path = Uri.parse(href).path;
  return _appPaths.any((r) => r.hasMatch(path));
}

/// Follows a website link: an app screen, a website page or an outside link.
Future<void> openLink(BuildContext context, String href, {bool replace = false}) async {
  if (href.isEmpty) return;
  if (href.startsWith('https://') || href.startsWith('http://')) {
    await launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication);
    return;
  }
  if (isAppPath(href)) {
    if (replace) {
      context.go(href);
    } else {
      await context.push(href);
    }
    return;
  }
  final base = siteUrl.isNotEmpty ? siteUrl : AppConfig.apiBase;
  await launchUrl(Uri.parse('$base$href'), mode: LaunchMode.inAppBrowserView);
}
