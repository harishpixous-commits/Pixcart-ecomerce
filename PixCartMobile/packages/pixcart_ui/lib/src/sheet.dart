// Modal (components/ui.tsx) as phones show it: a sheet from the bottom with rounded top corners (rounded-t-2xl),
// white, p-5, a display-font title and a close button, over ink/50. Also a picker sheet for selects.

import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:material_ui/material_ui.dart';

import 'field.dart';
import 'theme.dart';

Future<T?> showPcSheet<T>(BuildContext context, {required String title, required WidgetBuilder builder}) {
  final t = context.pc;
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.white,
    barrierColor: t.ink.withValues(alpha: 0.5),
    constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.92),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(t.radius2xl))),
    builder: (ctx) => PcSheet(title: title, child: builder(ctx)),
  );
}

class PcSheet extends StatelessWidget {
  const PcSheet({super.key, required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Text(title, style: Tw.xl(color: t.ink))),
              const SizedBox(width: 16),
              Semantics(
                button: true,
                label: 'Close',
                child: GestureDetector(
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Padding(padding: const EdgeInsets.all(4), child: Icon(LucideIcons.x, size: 20, color: t.inkSoft)),
                ),
              ),
            ]),
            const SizedBox(height: 16),
            child,
          ],
        ),
      ),
    );
  }
}

/// The options of a select, one per row; the chosen one is ticked.
Future<SelectOption<T>?> showOptionSheet<T>(BuildContext context,
    {required String title, required List<SelectOption<T>> options, T? selected}) {
  return showPcSheet<SelectOption<T>>(
    context,
    title: title,
    builder: (ctx) {
      final t = ctx.pc;
      return Column(mainAxisSize: MainAxisSize.min, children: [
        for (final o in options)
          InkWell(
            onTap: () => Navigator.of(ctx).pop(o),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.line))),
              child: Row(children: [
                Expanded(
                  child: Text(o.label,
                      style: Tw.body(weight: o.value == selected ? Tw.semibold : FontWeight.w400, color: t.ink)),
                ),
                if (o.value == selected) Icon(LucideIcons.check, size: 18, color: t.primary),
              ]),
            ),
          ),
      ]);
    },
  );
}

/// A yes/no question in a sheet (the website's confirm dialogs). True when confirmed.
Future<bool> confirmSheet(BuildContext context,
    {required String title, required String message, String confirm = 'Yes', String cancel = 'No', bool danger = false}) async {
  final r = await showPcSheet<bool>(context, title: title, builder: (ctx) {
    final t = ctx.pc;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(message, style: Tw.body(color: t.inkSoft)),
      const SizedBox(height: 16),
      Row(children: [
        Expanded(child: _SheetButton(label: cancel, onTap: () => Navigator.of(ctx).pop(false), filled: false)),
        const SizedBox(width: 8),
        Expanded(child: _SheetButton(label: confirm, onTap: () => Navigator.of(ctx).pop(true), filled: true, danger: danger)),
      ]),
    ]);
  });
  return r ?? false;
}

class _SheetButton extends StatelessWidget {
  const _SheetButton({required this.label, required this.onTap, required this.filled, this.danger = false});
  final String label;
  final VoidCallback onTap;
  final bool filled;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final bg = filled ? (danger ? t.buy : t.primary) : Colors.white;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(t.radiusLg),
          border: filled ? null : Border.all(color: t.primary.withValues(alpha: 0.4)),
        ),
        child: Text(label, style: Tw.body(weight: Tw.semibold, color: filled ? Colors.white : t.primary)),
      ),
    );
  }
}
