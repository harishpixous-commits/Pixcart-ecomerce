// The website's toast (components/ui.tsx ToastProvider): centred above the bottom tab bar (bottom-20), ink for
// success and vermilion for errors, rounded-lg, 15 px medium text, gone after 4 seconds.

import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'theme.dart';

class _ToastItem {
  _ToastItem(this.id, this.text, this.error);
  final int id;
  final String text;
  final bool error;
}

class ToastHost extends StatefulWidget {
  const ToastHost({super.key, required this.child, this.bottom = 80});
  final Widget child;

  /// distance from the bottom (above the tab bar)
  final double bottom;

  static ToastHostState? maybeOf(BuildContext context) => context.findAncestorStateOfType<ToastHostState>();

  @override
  State<ToastHost> createState() => ToastHostState();
}

class ToastHostState extends State<ToastHost> {
  final _items = <_ToastItem>[];
  var _seq = 0;

  void show(String text, {bool error = false}) {
    final item = _ToastItem(++_seq, text, error);
    setState(() => _items.add(item));
    Timer(const Duration(seconds: 4), () {
      if (mounted) setState(() => _items.remove(item));
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Stack(children: [
      widget.child,
      Positioned(
        left: 16,
        right: 16,
        bottom: widget.bottom + MediaQuery.paddingOf(context).bottom,
        child: IgnorePointer(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final i in _items)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Semantics(
                  liveRegion: true,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    decoration: BoxDecoration(
                      color: i.error ? t.buy : t.ink,
                      borderRadius: BorderRadius.circular(t.radiusLg),
                      boxShadow: shadowLg,
                    ),
                    child: Text(i.text, textAlign: TextAlign.center, style: Tw.body(weight: Tw.medium, color: Colors.white)),
                  ),
                ),
              ),
          ]),
        ),
      ),
    ]);
  }
}

/// Shows a toast from anywhere under a ToastHost (the app shell has one).
void toast(BuildContext context, String text, {bool error = false}) => ToastHost.maybeOf(context)?.show(text, error: error);
