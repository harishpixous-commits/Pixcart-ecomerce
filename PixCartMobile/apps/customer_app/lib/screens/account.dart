// Your account (app/(shop)/account/page.tsx): profile, signed-in devices, privacy and data, saved addresses and saved
// cards (components/saved-cards.tsx), sign out.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/address_form.dart';
import '../shop/frame.dart';

final addressesProvider = FutureProvider.autoDispose<List<Address>>((ref) async {
  return [for (final a in await ref.read(apiProvider).getList('/api/addresses')) Address(asMap(a))];
});

BoxDecoration _panel(BuildContext context) => BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(context.pc.radiusXl));

class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  String? _seeded;
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).patch('/api/auth/me', body: {'name': _name.text, if (_email.text.isNotEmpty) 'email': _email.text});
      await ref.read(sessionProvider.notifier).reloadUser();
      if (mounted) toast(context, 'Profile saved');
    } catch (e) {
      setState(() => _error = ApiError.messageOf(e, 'Could not save'));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _signOut() async {
    await ref.read(sessionProvider.notifier).signOut();
    if (mounted) context.go('/');
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final user = ref.watch(sessionProvider).user;
    final addresses = ref.watch(addressesProvider).value;
    if (user == null || addresses == null) return const ShopBody(children: [FormSkeleton()]);
    if (_seeded != user.id) {
      _seeded = user.id;
      _name.text = user.name;
      _email.text = user.email ?? '';
    }
    return ShopBody(gap: 16, children: [
      Container(
        padding: const EdgeInsets.all(20),
        decoration: _panel(context),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Your profile', style: Tw.heading(24, color: t.ink)),
          const SizedBox(height: 16),
          if (_error != null) ...[ErrorNote(_error), const SizedBox(height: 12)],
          PcTextField(label: 'Name', controller: _name),
          const SizedBox(height: 12),
          PcTextField(label: 'Email (for invoices)', controller: _email, keyboardType: TextInputType.emailAddress),
          const SizedBox(height: 12),
          Text('Signed in with mobile +91 ${user.phone ?? ''}', style: Tw.sm(color: t.inkSoft)),
          const SizedBox(height: 12),
          Row(children: [
            PcButton.text('Save profile', loading: _saving, onPressed: _save),
            const SizedBox(width: 8),
            PcButton.text('Sign out', variant: ButtonVariant.ghost, onPressed: _signOut),
          ]),
        ]),
      ),
      const _Devices(),
      _Privacy(marketing: user.marketingOptIn, onSignOut: _signOut),
      Container(
        padding: const EdgeInsets.all(20),
        decoration: _panel(context),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(child: Text('Saved addresses', style: Tw.heading(20, color: t.ink))),
            PcButton.text('Add address', variant: ButtonVariant.secondary, size: ButtonSize.sm, onPressed: () async {
              final saved = await showAddressSheet(context, ref);
              if (saved != null && context.mounted) {
                ref.invalidate(addressesProvider);
                toast(context, 'Address saved');
              }
            }),
          ]),
          const SizedBox(height: 12),
          if (addresses.isEmpty)
            Text('No saved addresses yet.', style: Tw.body(color: t.inkSoft))
          else
            for (var i = 0; i < addresses.length; i++) ...[
              if (i > 0) Divider(height: 1, color: t.line),
              _addressRow(context, addresses[i]),
            ],
        ]),
      ),
      const SavedCards(),
    ]);
  }

  Widget _addressRow(BuildContext context, Address a) {
    final t = context.pc;
    final kind = a.label.trim().isNotEmpty ? a.label.trim() : const {'home': 'Home', 'work': 'Work', 'other': 'Other'}[a.kind] ?? 'Home';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text(a.fullName, style: Tw.body(weight: Tw.semibold, color: t.ink)),
              Pill(kind),
              if (a.isDefault) const Pill('Default', tone: PillTone.blue),
              if (a.lat != null) const Pill('Pinned', tone: PillTone.green),
            ]),
            Text('${[a.line1, a.line2, a.landmark, a.city].where((s) => s.isNotEmpty).join(', ')}, ${a.state} ${a.pincode}', style: Tw.body(color: t.inkSoft)),
            Text(a.phone, style: Tw.sm(color: t.inkFaint)),
            if (a.instructions.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
                  TextSpan(text: 'Instructions: ', style: TextStyle(fontWeight: Tw.semibold, color: t.ink)),
                  TextSpan(text: a.instructions),
                ])),
              ),
          ]),
        ),
        PcButton.text('Edit', variant: ButtonVariant.ghost, size: ButtonSize.sm, onPressed: () async {
          final saved = await showAddressSheet(context, ref, initial: a);
          if (saved != null && context.mounted) {
            ref.invalidate(addressesProvider);
            toast(context, 'Address saved');
          }
        }),
        PcButton.text('Remove', variant: ButtonVariant.ghost, size: ButtonSize.sm, onPressed: () async {
          try {
            await ref.read(apiProvider).delete('/api/addresses/${a.id}');
            ref.invalidate(addressesProvider);
            if (context.mounted) toast(context, 'Address removed');
          } catch (e) {
            if (context.mounted) toast(context, ApiError.messageOf(e), error: true);
          }
        }),
      ]),
    );
  }
}

class _Devices extends ConsumerStatefulWidget {
  const _Devices();

  @override
  ConsumerState<_Devices> createState() => _DevicesState();
}

class _DevicesState extends ConsumerState<_Devices> {
  List<Json>? _rows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).getMap('/api/auth/sessions');
      if (mounted) setState(() => _rows = r.maps('sessions'));
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final rows = _rows;
    if (rows == null) return const SizedBox.shrink();
    final others = rows.where((r) => !r.flag('current')).length;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: _panel(context),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Signed-in devices', style: Tw.heading(18, color: t.ink)),
        Text('Where your account is signed in now. Sign the others out if you lost a phone or used a shared computer.', style: Tw.sm(color: t.inkSoft)),
        const SizedBox(height: 12),
        for (final r in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text(r.str('device'), style: Tw.body(weight: Tw.medium, color: t.ink)),
                if (r.flag('current'))
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(color: t.successLight, borderRadius: BorderRadius.circular(999)),
                    child: Text('This device', style: Tw.px(12, line: 20, weight: Tw.bold, color: t.success)),
                  ),
              ]),
              Text('Last active ${dateTime(r.str('last_active'))}', style: Tw.xs(color: t.inkFaint)),
            ]),
          ),
        if (others > 0)
          Align(
            alignment: Alignment.centerLeft,
            child: PcButton.text('Sign out other devices', variant: ButtonVariant.secondary, size: ButtonSize.sm, onPressed: () async {
              try {
                final r = asMap(await ref.read(apiProvider).post('/api/auth/sessions/sign-out-others'));
                if (context.mounted) toast(context, 'Signed out ${r.integer('signed_out')} other device${r.integer('signed_out') == 1 ? '' : 's'}');
                await _load();
              } catch (e) {
                if (context.mounted) toast(context, ApiError.messageOf(e), error: true);
              }
            }),
          ),
      ]),
    );
  }
}

class _Privacy extends ConsumerWidget {
  const _Privacy({required this.marketing, required this.onSignOut});
  final bool marketing;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.pc;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: _panel(context),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Privacy and data', style: Tw.heading(20, color: t.ink)),
        const SizedBox(height: 12),
        PcCheckbox(
          value: marketing,
          onChanged: (v) async {
            await ref.read(apiProvider).put('/api/account/consent', body: {'marketing_opt_in': v});
            await ref.read(sessionProvider.notifier).reloadUser();
            if (context.mounted) toast(context, 'Saved');
          },
          label: Text('Send me offers and deals by SMS, WhatsApp and email. Order updates are always sent.', style: Tw.body(color: t.ink)),
        ),
        const SizedBox(height: 16),
        Wrap(spacing: 8, runSpacing: 8, children: [
          PcButton.text('Delete my account', variant: ButtonVariant.danger, size: ButtonSize.sm, onPressed: () => _delete(context, ref)),
        ]),
      ]),
    );
  }

  Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final typed = TextEditingController();
    String? error;
    await showPcSheet<void>(context, title: 'Delete your account?', builder: (ctx) {
      return StatefulBuilder(builder: (ctx, setState) {
        final t = ctx.pc;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(
              'Your profile, addresses and wishlist are erased and you are signed out everywhere. Invoices and order records are kept for the period the GST law requires, without your name or contact details on your account.',
              style: Tw.body(color: t.inkSoft)),
          const SizedBox(height: 12),
          if (error != null) ...[ErrorNote(error), const SizedBox(height: 12)],
          PcTextField(label: 'Type "DELETE" to confirm', controller: typed, onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: PcButton.text('Delete my account', variant: ButtonVariant.buy, onPressed: typed.text != 'DELETE' ? null : () async {
              try {
                await ref.read(apiProvider).delete('/api/account');
                if (ctx.mounted) Navigator.of(ctx).pop();
                if (context.mounted) toast(context, 'Your account has been deleted');
                await onSignOut();
              } catch (e) {
                setState(() => error = ApiError.messageOf(e, 'Could not delete the account'));
              }
            }),
          ),
        ]);
      });
    });
  }
}

/// Account → Saved cards (tokenised by Razorpay; last 4 digits, network, expiry; remove).
class SavedCards extends ConsumerStatefulWidget {
  const SavedCards({super.key});

  @override
  ConsumerState<SavedCards> createState() => _SavedCardsState();
}

class _SavedCardsState extends ConsumerState<SavedCards> {
  List<Json>? _cards;
  bool _enabled = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).getMap('/api/account/cards');
      if (mounted) {
        setState(() {
          _cards = r.maps('items');
          _enabled = r.flag('enabled', true);
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _cards = [];
          _error = ApiError.messageOf(e, 'Could not load your saved cards');
        });
      }
    }
  }

  Future<void> _remove(Json c) async {
    final ok = await confirmSheet(context,
        title: 'Remove this card?',
        message: 'The card ending ${c.str('last4')} will no longer be offered when you pay. You can save it again next time.',
        confirm: 'Remove card',
        cancel: 'Keep it',
        danger: true);
    if (!ok) return;
    try {
      await ref.read(apiProvider).delete('/api/account/cards/${c.str('id')}');
      if (mounted) toast(context, 'Card removed');
      await _load();
    } catch (e) {
      if (mounted) toast(context, ApiError.messageOf(e, 'Could not remove the card'), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final cards = _cards;
    if (!_enabled && (cards?.isEmpty ?? true)) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: _panel(context),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Icon(LucideIcons.creditCard, size: 20, color: t.primary),
          const SizedBox(width: 8),
          Text('Saved cards', style: Tw.heading(20, color: t.ink)),
        ]),
        const SizedBox(height: 4),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.shieldCheck, size: 16, color: t.success)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
                'Saved securely by Razorpay as RBI requires: your card number is never stored on this site. To save a card, tick "Save this card" when you pay. You confirm each payment with your CVV and your bank\'s OTP.',
                style: Tw.sm(color: t.inkSoft)),
          ),
        ]),
        const SizedBox(height: 12),
        if (cards == null)
          const Center(child: SpinningLoader())
        else if (_error != null)
          Text(_error!, style: Tw.sm(color: t.buy))
        else if (cards.isEmpty)
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusLg)),
            child: Text('No saved cards yet.', style: Tw.sm(color: t.inkSoft)),
          )
        else
          for (final c in cards) _card(context, c),
      ]),
    );
  }

  Widget _card(BuildContext context, Json c) {
    final t = context.pc;
    final key = networkKey(c.str('network'));
    final m = c.intOrNull('expiry_month'), y = c.intOrNull('expiry_year');
    final exp = m != null && y != null ? '${m.toString().padLeft(2, '0')}/${'$y'.substring('$y'.length - 2)}' : '';
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(t.radiusXl), border: Border.all(color: t.line)),
      child: Row(children: [
        PayLogo(key),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${networkNames[key] ?? c.str('network')} •••• ${c.str('last4')}', style: Tw.body(weight: Tw.semibold, color: t.ink)),
            Text(
              [c.str('issuer'), if (c.str('type').isNotEmpty) '${c.str('type')} card', if (exp.isNotEmpty) 'expires $exp'].where((s) => s.isNotEmpty).join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Tw.sm(color: t.inkSoft),
            ),
          ]),
        ),
        PcButton.text('Remove', variant: ButtonVariant.ghost, size: ButtonSize.sm, onPressed: () => _remove(c)),
      ]),
    );
  }
}
