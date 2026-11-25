import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

/// Loads the real fonts (Mukta, Baloo 2, Lucide) so text in tests and goldens has the app's metrics, not the
/// test font's square glyphs.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final f in files) {
      loader.addFont(Future.value(ByteData.sublistView(Uint8List.fromList(File(f).readAsBytesSync()))));
    }
    await loader.load();
  }

  const ui = '../../packages/pixcart_ui/fonts';
  await load('packages/pixcart_ui/Mukta', ['$ui/Mukta-400.ttf', '$ui/Mukta-500.ttf', '$ui/Mukta-600.ttf']);
  await load('packages/pixcart_ui/Baloo2', ['$ui/Baloo2-500.ttf', '$ui/Baloo2-600.ttf', '$ui/Baloo2-700.ttf']);
  final cache = Platform.environment['PUB_CACHE'] ??
      (Platform.isWindows ? '${Platform.environment['LOCALAPPDATA']}/Pub/Cache' : '${Platform.environment['HOME']}/.pub-cache');
  final lucide = Directory('$cache/hosted/pub.dev').listSync().whereType<Directory>().where((d) => d.path.contains('lucide_icons_flutter-')).toList();
  if (lucide.isNotEmpty) {
    final ttf = File('${lucide.last.path}/assets/lucide.ttf');
    if (ttf.existsSync()) await load('packages/lucide_icons_flutter/Lucide', [ttf.path]);
  }
  await testMain();
}
