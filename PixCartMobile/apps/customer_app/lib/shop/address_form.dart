// Adding or editing an address (components/address-form.tsx) in a bottom sheet: "Use my current location" pins the
// door (geolocator; the website also shows a map to fine-tune the pin), the address (the state follows the PIN code),
// Home / Work / Other with a name, delivery instructions with quick choices, default address.

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

const _pin2 = {
  '11': '07', '12': '06', '13': '06', '14': '03', '15': '03', '16': '03', '17': '02', '18': '01', '19': '01',
  '20': '09', '21': '09', '22': '09', '23': '09', '24': '09', '25': '09', '26': '09', '27': '09', '28': '09',
  '30': '08', '31': '08', '32': '08', '33': '08', '34': '08', '36': '24', '37': '24', '38': '24', '39': '24',
  '40': '27', '41': '27', '42': '27', '43': '27', '44': '27', '45': '23', '46': '23', '47': '23', '48': '23', '49': '22',
  '50': '36', '51': '37', '52': '37', '53': '37', '56': '29', '57': '29', '58': '29', '59': '29',
  '60': '33', '61': '33', '62': '33', '63': '33', '64': '33', '67': '32', '68': '32', '69': '32',
  '70': '19', '71': '19', '72': '19', '73': '19', '74': '19', '75': '21', '76': '21', '77': '21', '78': '18', '79': '18',
  '80': '10', '81': '10', '82': '10', '83': '20', '84': '10', '85': '10',
};

const _pin3 = {
  '160': '04', '194': '38', '246': '05', '248': '05', '249': '05', '262': '05', '263': '05',
  '396': '26', '403': '30', '605': '34', '609': '34', '682': '32', '737': '11', '744': '35',
  '790': '12', '791': '12', '792': '12', '793': '17', '794': '17', '795': '14', '796': '15', '797': '13', '798': '13', '799': '16',
  '813': '20', '814': '20', '815': '20', '816': '20', '820': '20', '821': '20', '822': '20', '825': '20', '826': '20',
  '827': '20', '828': '20', '829': '20', '831': '20', '832': '20', '833': '20', '834': '20', '835': '20',
  '490': '22', '491': '22', '492': '22', '493': '22', '494': '22', '495': '22', '496': '22', '497': '22',
};

/// The state code for a PIN code (lib/pin-state.ts), or null.
String? stateForPin(String pin) {
  if (!RegExp(r'^[1-9]\d{5}$').hasMatch(pin)) return null;
  return _pin3[pin.substring(0, 3)] ?? _pin2[pin.substring(0, 2)];
}

const quickNotes = ['Leave at the door', 'Call when you arrive', 'Ring the bell', 'Hand it to security', 'Do not ring the bell'];

/// Opens the address form; returns the saved address (POST /api/addresses or PUT /api/addresses/{id}), or null.
Future<Address?> showAddressSheet(BuildContext context, WidgetRef ref, {Address? initial}) =>
    showPcSheet<Address>(context, title: initial == null ? 'Add a new address' : 'Edit address', builder: (_) => AddressForm(initial: initial));

class AddressForm extends ConsumerStatefulWidget {
  const AddressForm({super.key, this.initial});
  final Address? initial;

  @override
  ConsumerState<AddressForm> createState() => _AddressFormState();
}

class _AddressFormState extends ConsumerState<AddressForm> {
  late final Address? a = widget.initial;
  late final _name = TextEditingController(text: a?.fullName ?? '');
  late final _phone = TextEditingController(text: a?.phone ?? '');
  late final _line1 = TextEditingController(text: a?.line1 ?? '');
  late final _line2 = TextEditingController(text: a?.line2 ?? '');
  late final _landmark = TextEditingController(text: a?.landmark ?? '');
  late final _pin = TextEditingController(text: a?.pincode ?? '');
  late final _city = TextEditingController(text: a?.city ?? '');
  late final _label = TextEditingController(text: a?.label ?? '');
  late final _notes = TextEditingController(text: a?.instructions ?? '');
  late String _state = a?.stateCode ?? '33';
  late String _kind = a?.kind ?? 'home';
  late bool _default = a?.isDefault ?? false;
  late double? _lat = a?.lat;
  late double? _lng = a?.lng;
  late bool _stateTouched = a != null;
  bool _busy = false;
  String _locating = 'idle';
  double? _accuracy;
  String? _error;
  Map<String, String> _fields = {};

  @override
  void dispose() {
    for (final c in [_name, _phone, _line1, _line2, _landmark, _pin, _city, _label, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _locate() async {
    setState(() => _locating = 'asking');
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        setState(() => _locating = 'denied');
        return;
      }
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)),
      );
      double round(double n) => (n * 1e6).round() / 1e6;
      setState(() {
        _lat = round(p.latitude);
        _lng = round(p.longitude);
        _accuracy = p.accuracy;
        _locating = 'ok';
      });
    } catch (_) {
      if (mounted) setState(() => _locating = 'error');
    }
  }

  void _addNote(String text) {
    final cur = _notes.text.trim();
    if (cur.toLowerCase().contains(text.toLowerCase())) return;
    final joined = cur.isEmpty ? text : '${cur.replaceAll(RegExp(r'[.,;]$'), '')}. $text';
    setState(() => _notes.text = joined.length > 300 ? joined.substring(0, 300) : joined);
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
      _fields = {};
    });
    final body = {
      'full_name': _name.text,
      'phone': _phone.text,
      'line1': _line1.text,
      'line2': _line2.text,
      'landmark': _landmark.text,
      'city': _city.text,
      'state_code': _state,
      'pincode': _pin.text,
      'kind': _kind,
      'is_default': _default,
      'label': _kind == 'other' ? _label.text.trim() : '',
      'instructions': _notes.text.trim(),
      'lat': _lat,
      'lng': _lng,
    };
    try {
      final api = ref.read(apiProvider);
      final saved = a == null ? await api.post('/api/addresses', body: body) : await api.put('/api/addresses/${a!.id}', body: body);
      if (mounted) Navigator.of(context).pop(Address(asMap(saved)));
    } catch (e) {
      setState(() {
        _error = ApiError.messageOf(e, 'Could not save the address. Try again.');
        if (e is ApiError) _fields = e.fields;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final pinned = _lat != null && _lng != null;
    const gap = SizedBox(height: 12);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      if (_error != null) ...[ErrorNote(_error), gap],
      Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: t.page.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(t.radius2xl), border: Border.all(color: t.line)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(color: pinned ? t.success : t.primaryLight, borderRadius: BorderRadius.circular(t.radiusXl)),
              child: Icon(LucideIcons.mapPin, size: 20, color: pinned ? Colors.white : t.primary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(pinned ? 'Location pinned on the map' : 'Pin your location (recommended)', style: Tw.body(weight: Tw.semibold, color: t.ink)),
                Text(pinned ? 'The delivery partner navigates straight to this spot.' : 'Helps the delivery partner reach your door without calls.',
                    style: Tw.sm(color: t.inkSoft)),
              ]),
            ),
          ]),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            GestureDetector(
              onTap: _locating == 'asking' ? null : _locate,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: BoxDecoration(color: t.primary, borderRadius: BorderRadius.circular(999), boxShadow: shadowSm),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (_locating == 'asking')
                    const SpinningLoader(size: 16, color: Colors.white)
                  else
                    const Icon(LucideIcons.crosshair, size: 16, color: Colors.white),
                  const SizedBox(width: 8),
                  Text('Use my current location', style: Tw.sm(weight: Tw.semibold, color: Colors.white)),
                ]),
              ),
            ),
            if (pinned)
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.locateFixed, size: 16, color: t.success),
                const SizedBox(width: 4),
                Text('Location pinned${_accuracy != null ? ' (about ${_accuracy!.round()} m)' : ''}', style: Tw.sm(weight: Tw.semibold, color: t.success)),
              ]),
          ]),
          if (_locating == 'denied')
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(color: t.buyLight, borderRadius: BorderRadius.circular(t.radiusXl)),
              child: Text('Location is blocked for this app. Allow it in your phone settings, or fill in the address below.', style: Tw.sm(color: t.buy)),
            ),
          if (_locating == 'error') Padding(padding: const EdgeInsets.only(top: 8), child: Text('Could not get your location.', style: Tw.sm(color: t.inkSoft))),
          if (pinned)
            GestureDetector(
              onTap: () => setState(() => (_lat = null, _lng = null)),
              child: Padding(padding: const EdgeInsets.only(top: 4), child: Text('Remove pin', style: Tw.xs(weight: Tw.semibold, color: t.buy))),
            ),
        ]),
      ),
      gap,
      PcTextField(label: 'Full name', controller: _name, error: _fields['full_name']),
      gap,
      PcTextField(label: 'Mobile number', controller: _phone, keyboardType: TextInputType.phone, error: _fields['phone']),
      gap,
      PcTextField(label: 'House no., building, street', controller: _line1, error: _fields['line1']),
      gap,
      PcTextField(label: 'Area, locality (optional)', controller: _line2),
      gap,
      PcTextField(label: 'Landmark (optional)', controller: _landmark, placeholder: 'Near the temple, opposite the park'),
      gap,
      PcTextField(
        label: 'PIN code',
        controller: _pin,
        keyboardType: TextInputType.number,
        maxLength: 6,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        error: _fields['pincode'],
        onChanged: (v) {
          final st = stateForPin(v);
          if (!_stateTouched && st != null) setState(() => _state = st);
        },
      ),
      gap,
      PcTextField(label: 'Town or city', controller: _city, error: _fields['city']),
      gap,
      PcField(
        label: 'State',
        child: PcSelect<String>(
          value: _state,
          title: 'State',
          options: [for (final e in stateOptions) SelectOption(e.key, e.value)],
          onChanged: (v) => setState(() {
            _stateTouched = true;
            _state = v;
          }),
        ),
      ),
      gap,
      Text('Save as', style: Tw.sm(weight: Tw.medium, color: t.ink)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: [
        for (final (key, label, icon) in [('home', 'Home', LucideIcons.home), ('work', 'Work', LucideIcons.briefcase), ('other', 'Other', LucideIcons.tag)])
          GestureDetector(
            onTap: () => setState(() => _kind = key),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: _kind == key ? t.primary : Colors.white,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: _kind == key ? t.primary : t.line),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 16, color: _kind == key ? Colors.white : t.ink),
                const SizedBox(width: 6),
                Text(label, style: Tw.sm(weight: Tw.semibold, color: _kind == key ? Colors.white : t.ink)),
              ]),
            ),
          ),
      ]),
      if (_kind == 'other') ...[
        gap,
        PcTextField(label: 'Name this address', controller: _label, maxLength: 40, placeholder: "e.g. Mom's house, Hostel", error: _fields['label']),
      ],
      gap,
      PcField(
        label: 'Delivery instructions (optional)',
        hint: 'Saved with this address and shown to the delivery partner.',
        child: PcInput(controller: _notes, maxLength: 300, maxLines: 4, minLines: 2, placeholder: 'e.g. Second floor, blue gate'),
      ),
      const SizedBox(height: 8),
      Wrap(spacing: 6, runSpacing: 6, children: [
        for (final n in quickNotes)
          GestureDetector(
            onTap: () => _addNote(n),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: t.line)),
              child: Text('+ $n', style: Tw.xs(weight: Tw.semibold, color: t.inkSoft)),
            ),
          ),
      ]),
      gap,
      PcCheckbox(value: _default, onChanged: (v) => setState(() => _default = v), label: Text('Make this my default address', style: Tw.sm(color: t.ink))),
      const SizedBox(height: 16),
      Row(children: [
        PcButton.text('Save address', loading: _busy, onPressed: _submit),
        const SizedBox(width: 8),
        PcButton.text('Cancel', variant: ButtonVariant.ghost, onPressed: () => Navigator.of(context).pop()),
      ]),
    ]);
  }
}
