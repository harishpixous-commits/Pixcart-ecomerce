// Form fields (components/ui.tsx): Field (label, control, hint or error), PcInput (h-10, rounded-lg, border-line,
// focus ring peacock/20), PcTextField, PcTextarea, PcSelect (a native-select look that opens a bottom sheet),
// PcCheckbox.

import 'package:flutter/services.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:material_ui/material_ui.dart';

import 'sheet.dart';
import 'theme.dart';

class PcField extends StatelessWidget {
  const PcField({super.key, required this.label, required this.child, this.hint, this.error});
  final String label;
  final Widget child;
  final String? hint;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: Tw.sm(weight: Tw.medium, color: t.ink)),
        const SizedBox(height: 4),
        child,
        if (error != null && error!.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(error!, style: Tw.sm(color: t.buy)),
        ] else if (hint != null && hint!.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(hint!, style: Tw.xs(color: t.inkFaint)),
        ],
      ],
    );
  }
}

class PcInput extends StatefulWidget {
  const PcInput({
    super.key,
    this.controller,
    this.placeholder,
    this.invalid = false,
    this.keyboardType,
    this.maxLength,
    this.onChanged,
    this.onSubmitted,
    this.enabled = true,
    this.obscure = false,
    this.autofocus = false,
    this.inputFormatters,
    this.textInputAction,
    this.height = 40,
    this.prefix,
    this.suffix,
    this.maxLines = 1,
    this.minLines,
    this.focusNode,
    this.style,
    this.semanticLabel,
  });

  final TextEditingController? controller;
  final String? placeholder;
  final bool invalid;
  final TextInputType? keyboardType;
  final int? maxLength;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool enabled;
  final bool obscure;
  final bool autofocus;
  final List<TextInputFormatter>? inputFormatters;
  final TextInputAction? textInputAction;
  final double height;
  final Widget? prefix;
  final Widget? suffix;
  final int maxLines;
  final int? minLines;
  final FocusNode? focusNode;
  final TextStyle? style;
  final String? semanticLabel;

  @override
  State<PcInput> createState() => _PcInputState();
}

class _PcInputState extends State<PcInput> {
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() => _focused = _focus.hasFocus));
  }

  @override
  void dispose() {
    if (widget.focusNode == null) _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final multi = widget.maxLines > 1 || (widget.minLines ?? 1) > 1;
    final border = widget.invalid ? t.buy : (_focused ? t.primary : t.line);
    final field = TextField(
      controller: widget.controller,
      focusNode: _focus,
      enabled: widget.enabled,
      obscureText: widget.obscure,
      autofocus: widget.autofocus,
      keyboardType: widget.keyboardType,
      maxLength: widget.maxLength,
      maxLengthEnforcement: MaxLengthEnforcement.enforced,
      onChanged: widget.onChanged,
      onSubmitted: widget.onSubmitted,
      inputFormatters: widget.inputFormatters,
      textInputAction: widget.textInputAction,
      maxLines: widget.maxLines,
      minLines: widget.minLines,
      style: widget.style ?? Tw.body(color: t.ink),
      cursorColor: t.ink,
      cursorWidth: 1.2,
      decoration: InputDecoration(
        isCollapsed: true,
        counterText: '',
        border: InputBorder.none,
        hintText: widget.placeholder,
        hintStyle: (widget.style ?? Tw.body()).copyWith(color: t.inkFaint),
        contentPadding: EdgeInsets.symmetric(vertical: multi ? 8 : 0),
      ),
    );
    return Semantics(
      label: widget.semanticLabel,
      textField: true,
      child: Container(
        height: multi ? null : widget.height,
        constraints: multi ? const BoxConstraints(minHeight: 96) : null,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: widget.enabled ? Colors.white : t.page,
          borderRadius: BorderRadius.circular(t.radiusLg),
          border: Border.all(color: border),
          boxShadow: _focused ? [BoxShadow(color: t.primary.withValues(alpha: 0.2), spreadRadius: 2)] : null,
        ),
        alignment: multi ? Alignment.topLeft : Alignment.centerLeft,
        child: Row(children: [
          if (widget.prefix != null) ...[widget.prefix!, const SizedBox(width: 8)],
          Expanded(child: field),
          if (widget.suffix != null) ...[const SizedBox(width: 8), widget.suffix!],
        ]),
      ),
    );
  }
}

/// A labelled input (TextField in ui.tsx).
class PcTextField extends StatelessWidget {
  const PcTextField({
    super.key,
    required this.label,
    this.controller,
    this.hint,
    this.error,
    this.placeholder,
    this.keyboardType,
    this.maxLength,
    this.onChanged,
    this.inputFormatters,
    this.autofocus = false,
    this.obscure = false,
    this.onSubmitted,
    this.enabled = true,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final String? error;
  final String? placeholder;
  final TextInputType? keyboardType;
  final int? maxLength;
  final ValueChanged<String>? onChanged;
  final List<TextInputFormatter>? inputFormatters;
  final bool autofocus;
  final bool obscure;
  final ValueChanged<String>? onSubmitted;
  final bool enabled;

  @override
  Widget build(BuildContext context) => PcField(
        label: label,
        hint: hint,
        error: error,
        child: PcInput(
          controller: controller,
          placeholder: placeholder,
          invalid: error != null && error!.isNotEmpty,
          keyboardType: keyboardType,
          maxLength: maxLength,
          onChanged: onChanged,
          inputFormatters: inputFormatters,
          autofocus: autofocus,
          obscure: obscure,
          onSubmitted: onSubmitted,
          enabled: enabled,
          semanticLabel: label,
        ),
      );
}

class PcTextarea extends StatelessWidget {
  const PcTextarea({super.key, this.controller, this.placeholder, this.maxLength, this.onChanged, this.minLines = 4});
  final TextEditingController? controller;
  final String? placeholder;
  final int? maxLength;
  final ValueChanged<String>? onChanged;
  final int minLines;

  @override
  Widget build(BuildContext context) => PcInput(
        controller: controller,
        placeholder: placeholder,
        maxLength: maxLength,
        onChanged: onChanged,
        maxLines: 8,
        minLines: minLines,
        keyboardType: TextInputType.multiline,
      );
}

class SelectOption<T> {
  const SelectOption(this.value, this.label);
  final T value;
  final String label;
}

/// A native-select look (h-10, rounded-lg, border-line, chevron) that opens the options in a bottom sheet, as phones
/// show a <select>.
class PcSelect<T> extends StatelessWidget {
  const PcSelect({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.title,
    this.height = 40,
    this.style,
    this.background,
    this.borderRadius,
    this.border = true,
    this.padding,
  });

  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;
  final String? title;
  final double height;
  final TextStyle? style;
  final Color? background;
  final BorderRadius? borderRadius;
  final bool border;
  final EdgeInsets? padding;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final current = options.where((o) => o.value == value).firstOrNull;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () async {
        final picked = await showOptionSheet<T>(context, title: title ?? 'Choose', options: options, selected: value);
        if (picked != null) onChanged(picked.value);
      },
      child: Container(
        height: height,
        padding: padding ?? const EdgeInsets.only(left: 12, right: 8),
        decoration: BoxDecoration(
          color: background ?? Colors.white,
          borderRadius: borderRadius ?? BorderRadius.circular(t.radiusLg),
          border: border ? Border.all(color: t.line) : null,
        ),
        child: Row(children: [
          Expanded(
            child: Text(current?.label ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: style ?? Tw.body(color: t.ink)),
          ),
          Icon(LucideIcons.chevronDown, size: 16, color: (style?.color ?? t.ink)),
        ]),
      ),
    );
  }
}

class PcCheckbox extends StatelessWidget {
  const PcCheckbox({super.key, required this.value, required this.onChanged, required this.label});
  final bool value;
  final ValueChanged<bool> onChanged;
  final Widget label;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(!value),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          margin: const EdgeInsets.only(top: 4),
          width: 16,
          height: 16,
          decoration: BoxDecoration(
            color: value ? t.primary : Colors.white,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: value ? t.primary : const Color(0xFF767676)),
          ),
          child: value ? const Icon(LucideIcons.check, size: 12, color: Colors.white) : null,
        ),
        const SizedBox(width: 8),
        Expanded(child: DefaultTextStyle.merge(style: Tw.sm(color: t.inkSoft), child: label)),
      ]),
    );
  }
}
