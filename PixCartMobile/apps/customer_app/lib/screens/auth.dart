// Sign in (/login) and Create account (/signup) with a one-time code (components/auth/auth-forms.tsx,
// components/auth/auth-frame.tsx): the peacock card with the awning edge, mobile number, the code with a resend
// countdown, and the create-account details as Admin → Sign-in and accounts sets them (/api/auth/options).

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

import '../shop/frame.dart';
import '../shop/header.dart';
import '../shop/links.dart';

/// Only same-site paths; never an absolute or protocol-relative URL (open-redirect guard).
String safeNext(String? raw) => raw != null && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

String _digits(String v) {
  final d = v.replaceAll(RegExp(r'\D'), '');
  return d.length > 10 ? d.substring(d.length - 10) : d;
}

/// "+91 98765 43210"
String prettyPhone(String v) {
  final d = _digits(v);
  return d.length == 10 ? '+91 ${d.substring(0, 5)} ${d.substring(5)}' : v;
}

/// What the sign-in screens offer (GET /api/auth/options).
final authOptionsProvider = FutureProvider.autoDispose<Json>((ref) => ref.read(apiProvider).getMap('/api/auth/options'));

/// The centred card (theme sign-in layout "card"): max-w-md, py-6.
class AuthFrame extends StatelessWidget {
  const AuthFrame({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 448), child: child)),
      );
}

/// The peacock header with title and subtitle, the awning edge, then the form (p-6 pt-3, gap-4).
class AuthCard extends StatelessWidget {
  const AuthCard({super.key, required this.title, required this.subtitle, required this.children});
  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(t.radius2xl), boxShadow: shadowSm),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          color: t.primary,
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: Tw.heading(24, weight: Tw.bold, color: Colors.white)),
            const SizedBox(height: 4),
            Text(subtitle, style: Tw.body(color: Colors.white.withValues(alpha: 0.85))),
          ]),
        ),
        SizedBox(height: 12, child: Awning(color: t.primary)),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: 16), children[i]],
          ]),
        ),
      ]),
    );
  }
}

/// A countdown in seconds that ticks down to zero (useCountdown).
mixin _Countdown<T extends StatefulWidget> on State<T> {
  int wait = 0;
  Timer? _timer;

  void startWait(int seconds) {
    _timer?.cancel();
    setState(() => wait = seconds);
    if (seconds <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      setState(() => wait = wait - 1);
      if (wait <= 0) timer.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

class _DevOtp extends StatelessWidget {
  const _DevOtp({required this.code, required this.onUse});
  final String code;
  final VoidCallback onUse;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return CustomPaint(
      painter: DashedBorderPainter(color: t.accent, radius: t.radiusLg),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: t.accentLight, borderRadius: BorderRadius.circular(t.radiusLg)),
        child: Row(children: [
          Icon(LucideIcons.flaskConical, size: 16, color: t.accentDark),
          const SizedBox(width: 8),
          Expanded(
            child: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: [
              const TextSpan(text: 'Test mode, no SMS sent. Your code is '),
              TextSpan(text: code, style: Tw.base(weight: Tw.bold, color: t.ink).copyWith(letterSpacing: 2.4)),
            ])),
          ),
          const SizedBox(width: 12),
          GestureDetector(
            onTap: onUse,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: t.primary.withValues(alpha: 0.3)),
              ),
              child: Text('Fill in', style: Tw.xs(weight: Tw.semibold, color: t.primary)),
            ),
          ),
        ]),
      ),
    );
  }
}

/// The one-time code step.
class CodeStep extends StatefulWidget {
  const CodeStep({
    super.key,
    required this.phone,
    required this.length,
    required this.wait,
    required this.busy,
    required this.verifyLabel,
    required this.onVerify,
    required this.onResend,
    required this.onChange,
    this.devOtp,
  });
  final String phone;
  final int length;
  final String? devOtp;
  final int wait;
  final bool busy;
  final String verifyLabel;
  final ValueChanged<String> onVerify;
  final VoidCallback onResend;
  final VoidCallback onChange;

  @override
  State<CodeStep> createState() => _CodeStepState();
}

class _CodeStepState extends State<CodeStep> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final ready = _code.text.length >= widget.length;
    final resendOff = widget.wait > 0 || widget.busy;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
        TextSpan(text: 'Enter the ${widget.length}-digit code sent to '),
        TextSpan(text: prettyPhone(widget.phone), style: TextStyle(fontWeight: Tw.bold, color: t.ink)),
        const TextSpan(text: '.'),
      ])),
      const SizedBox(height: 16),
      PcField(
        label: 'One-time code',
        child: PcInput(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          maxLength: widget.length,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: Tw.lg(color: t.ink).copyWith(letterSpacing: 7.2),
          onChanged: (_) => setState(() {}),
          onSubmitted: (v) => v.length >= widget.length ? widget.onVerify(v) : null,
          semanticLabel: 'One-time code',
        ),
      ),
      if (widget.devOtp != null) ...[
        const SizedBox(height: 16),
        _DevOtp(code: widget.devOtp!, onUse: () => setState(() => _code.text = widget.devOtp!)),
      ],
      const SizedBox(height: 16),
      PcButton.text(widget.verifyLabel,
          size: ButtonSize.lg, loading: widget.busy, onPressed: ready ? () => widget.onVerify(_code.text) : null),
      const SizedBox(height: 16),
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        PcLink('Change number', onTap: widget.onChange),
        PcLink(
          widget.wait > 0 ? 'Resend code in ${widget.wait}s' : 'Resend code',
          onTap: resendOff ? null : widget.onResend,
          style: Tw.sm(weight: Tw.semibold, color: resendOff ? t.inkFaint : t.primary),
        ),
      ]),
      const SizedBox(height: 16),
      Row(children: [
        Icon(LucideIcons.shieldCheck, size: 14, color: t.inkFaint),
        const SizedBox(width: 6),
        Expanded(child: Text('We never ask for this code on a call. Do not share it.', style: Tw.xs(color: t.inkFaint))),
      ]),
    ]);
  }
}

/// The note shown when the number has no account (sign in) or already has one (create account).
class _NumberNote extends StatelessWidget {
  const _NumberNote({required this.title, required this.children});
  final String title;
  final List<InlineSpan> children;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: t.primaryLight,
        borderRadius: BorderRadius.circular(t.radiusLg),
        border: Border.all(color: t.primary.withValues(alpha: 0.3)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: Tw.sm(weight: Tw.semibold, color: t.ink)),
        const SizedBox(height: 2),
        Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: children)),
      ]),
    );
  }
}

/// The footer line: "New to PixCart? Create an account" (border-t, pt-4, centred).
class _AuthFooter extends StatelessWidget {
  const _AuthFooter({required this.children});
  final List<InlineSpan> children;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    return Container(
      padding: const EdgeInsets.only(top: 16),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
      child: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: children), textAlign: TextAlign.center),
    );
  }
}

/// Text links inside sentences; the recognizers are disposed with the screen.
mixin _Links<T extends StatefulWidget> on State<T> {
  final _recognizers = <TapGestureRecognizer>[];

  TextSpan link(String text, VoidCallback onTap, {bool underline = false}) {
    final t = context.pc;
    final r = TapGestureRecognizer()..onTap = onTap;
    _recognizers.add(r);
    return TextSpan(
      text: text,
      recognizer: r,
      style: TextStyle(
          fontWeight: Tw.semibold, color: t.primary, decoration: underline ? TextDecoration.underline : null, decorationColor: t.primary),
    );
  }

  /// Call at the start of build: the previous build's recognizers are no longer used.
  void resetLinks() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    resetLinks();
    super.dispose();
  }
}

/// Sends a signed-in person on when the screen opens (not after signing in here, so the name step still shows).
mixin _LeaveIfSignedIn<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  bool checkedSession = false;

  void leaveIfSignedIn(String next) {
    final s = ref.watch(sessionProvider);
    if (!s.ready || checkedSession) return;
    checkedSession = true;
    if (s.user != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) context.go(next);
      });
    }
  }
}

/* ---------------------------------------------------------------- sign in */

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

enum _LoginStep { phone, code, name }

class _LoginScreenState extends ConsumerState<LoginScreen> with _Countdown, _Links, _LeaveIfSignedIn {
  final _phone = TextEditingController();
  final _name = TextEditingController();
  _LoginStep _step = _LoginStep.phone;
  Json? _sent;
  bool _busy = false;
  String? _error;
  bool _noAccount = false;
  String _next = '/';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final q = GoRouterState.of(context).uri.queryParameters;
    _next = safeNext(q['next']);
    if (_phone.text.isEmpty && (q['phone'] ?? '').isNotEmpty) _phone.text = q['phone']!;
  }

  @override
  void dispose() {
    _phone.dispose();
    _name.dispose();
    super.dispose();
  }

  String get _signupHref =>
      '/signup?next=${Uri.encodeComponent(_next)}${_digits(_phone.text).length == 10 ? '&phone=${_digits(_phone.text)}' : ''}';

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = null;
      _noAccount = false;
    });
    try {
      final r = asMap(await ref.read(apiProvider).post('/api/auth/otp/request', body: {'phone': _phone.text, 'purpose': 'signin'}));
      setState(() {
        _sent = r;
        _step = _LoginStep.code;
      });
      startWait(r.integer('resend_in'));
    } catch (e) {
      if (e is ApiError && e.code == 'no_account') {
        setState(() => _noAccount = true);
      } else {
        setState(() => _error = ApiError.messageOf(e, 'Could not send the code'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify(String code) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = asMap(await ref.read(apiProvider).post('/api/auth/otp/verify', body: {'phone': _phone.text, 'code': code, 'purpose': 'signin'}));
      final user = User(r.obj('user'));
      checkedSession = true;
      await ref.read(sessionProvider.notifier).signIn(r.str('access_token'), user);
      if (!mounted) return;
      if (user.name.isEmpty) {
        setState(() => _step = _LoginStep.name);
      } else {
        context.go(_next);
      }
    } catch (e) {
      setState(() => _error = ApiError.messageOf(e, 'Could not verify the code'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveName() async {
    setState(() => _busy = true);
    try {
      await ref.read(apiProvider).patch('/api/auth/me', body: {'name': _name.text});
      await ref.read(sessionProvider.notifier).reloadUser();
      if (mounted) context.go(_next);
    } catch (e) {
      setState(() => _error = ApiError.messageOf(e, 'Could not save your name'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    resetLinks();
    leaveIfSignedIn(_next);
    final site = ref.watch(siteValueProvider);
    final options = ref.watch(authOptionsProvider).value;
    final canSignup = options == null || options.flag('customer_signup', true);
    final sent = _sent;
    return ShopBody(children: [
      AuthFrame(
        child: AuthCard(
          title: _step == _LoginStep.name ? 'Welcome to ${site.brandName}' : 'Sign in',
          subtitle: switch (_step) {
            _LoginStep.phone => 'Sign in with your mobile number. We will send you a one-time code.',
            _LoginStep.code => 'Check your messages.',
            _LoginStep.name => 'What should we call you?',
          },
          children: [
            if (_error != null) ErrorNote(_error),
            if (_step == _LoginStep.phone) ...[
              PcTextField(
                label: 'Mobile number',
                controller: _phone,
                placeholder: '98765 43210',
                keyboardType: TextInputType.phone,
                autofocus: true,
                hint: '10-digit Indian mobile number',
                onChanged: (_) => setState(() => _noAccount = false),
                onSubmitted: (_) => _send(),
              ),
              if (_noAccount)
                _NumberNote(
                  title: 'No account uses ${prettyPhone(_phone.text)} yet.',
                  children: canSignup
                      ? [
                          const TextSpan(text: 'New here? '),
                          link('Create an account', () => context.go(_signupHref), underline: true),
                          const TextSpan(text: ' with this number.'),
                        ]
                      : [const TextSpan(text: 'New accounts are paused right now. Please try again later.')],
                ),
              PcButton.text('Send code', size: ButtonSize.lg, loading: _busy, onPressed: _send),
            ],
            if (_step == _LoginStep.code && sent != null)
              CodeStep(
                phone: _phone.text,
                length: sent.integer('length') > 0 ? sent.integer('length') : 6,
                devOtp: sent.strOrNull('dev_otp'),
                wait: wait,
                busy: _busy,
                verifyLabel: 'Verify and continue',
                onVerify: _verify,
                onResend: _send,
                onChange: () => setState(() {
                  _step = _LoginStep.phone;
                  _sent = null;
                }),
              ),
            if (_step == _LoginStep.name) ...[
              PcTextField(label: 'Your name', controller: _name, autofocus: true, onSubmitted: (_) => _saveName()),
              PcButton.text('Continue', size: ButtonSize.lg, loading: _busy, onPressed: _saveName),
            ],
            if (_step == _LoginStep.phone && canSignup)
              _AuthFooter(children: [
                TextSpan(text: 'New to ${site.brandName}? '),
                link('Create an account', () => context.go(_signupHref)),
              ]),
          ],
        ),
      ),
    ]);
  }
}

/* ---------------------------------------------------------------- create account */

class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> with _Countdown, _Links, _LeaveIfSignedIn {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  bool _terms = false;
  bool _offers = false;
  bool _codeStep = false;
  Json? _sent;
  bool _busy = false;
  String? _error;
  Map<String, String> _fields = {};
  bool _exists = false;
  String _next = '/';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final q = GoRouterState.of(context).uri.queryParameters;
    _next = safeNext(q['next']);
    if (_phone.text.isEmpty && (q['phone'] ?? '').isNotEmpty) _phone.text = q['phone']!;
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  String get _signinHref =>
      '/login?next=${Uri.encodeComponent(_next)}${_digits(_phone.text).length == 10 ? '&phone=${_digits(_phone.text)}' : ''}';

  Future<void> _send(String emailMode) async {
    final problems = <String, String>{};
    if (_name.text.trim().length < 2) problems['name'] = 'Enter your full name';
    if (_digits(_phone.text).length != 10) problems['phone'] = 'Enter a 10-digit mobile number';
    if (emailMode == 'required' && _email.text.trim().isEmpty) problems['email'] = 'Enter your email';
    if (!_terms) problems['terms'] = 'Please accept to continue';
    setState(() {
      _error = null;
      _exists = false;
      _fields = problems;
    });
    if (problems.isNotEmpty) return;
    setState(() => _busy = true);
    try {
      final r = asMap(await ref
          .read(apiProvider)
          .post('/api/auth/otp/request', body: {'phone': _phone.text, 'purpose': 'signup', 'for_seller': false}));
      setState(() {
        _sent = r;
        _codeStep = true;
      });
      startWait(r.integer('resend_in'));
    } catch (e) {
      if (e is ApiError && e.code == 'account_exists') {
        setState(() => _exists = true);
      } else {
        setState(() => _error = ApiError.messageOf(e, 'Could not send the code'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify(String code, String emailMode) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = asMap(await ref.read(apiProvider).post('/api/auth/otp/verify', body: {
        'phone': _phone.text,
        'code': code,
        'purpose': 'signup',
        'for_seller': false,
        'name': _name.text,
        'email': emailMode == 'hidden' || _email.text.trim().isEmpty ? null : _email.text.trim(),
        'accept_terms': _terms,
        'marketing_opt_in': _offers,
      }));
      checkedSession = true;
      await ref.read(sessionProvider.notifier).signIn(r.str('access_token'), User(r.obj('user')));
      if (mounted) context.go(_next);
    } catch (e) {
      setState(() {
        if (e is ApiError && e.fields.isNotEmpty) {
          _codeStep = false;
          _fields = e.fields;
        }
        _error = ApiError.messageOf(e, 'Could not verify the code');
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    resetLinks();
    leaveIfSignedIn(_next);
    final t = context.pc;
    final site = ref.watch(siteValueProvider);
    final options = ref.watch(authOptionsProvider).value;
    final emailMode = options?.str('signup_email', 'optional') ?? 'optional';
    final open = options == null || options.flag('customer_signup', true);
    if (!open) {
      return ShopBody(children: [
        AuthFrame(
          child: AuthCard(title: 'Create account', subtitle: 'New accounts are paused right now.', children: [
            Text.rich(TextSpan(style: Tw.sm(color: t.inkSoft), children: [
              const TextSpan(text: 'Please try again later. If you already have an account, you can '),
              link('sign in', () => context.go(_signinHref)),
              const TextSpan(text: '.'),
            ])),
          ]),
        ),
      ]);
    }
    final sent = _sent;
    return ShopBody(children: [
      AuthFrame(
        child: AuthCard(
          title: 'Create your ${site.brandName} account',
          subtitle: _codeStep ? 'Almost done. Check your messages.' : 'It takes less than a minute.',
          children: [
            if (_error != null) ErrorNote(_error),
            if (!_codeStep) ...[
              PcTextField(label: 'Full name', controller: _name, autofocus: true, error: _fields['name']),
              PcTextField(
                label: 'Mobile number',
                controller: _phone,
                placeholder: '98765 43210',
                keyboardType: TextInputType.phone,
                error: _fields['phone'],
                hint: 'You will sign in with this number',
                onChanged: (_) => setState(() => _exists = false),
              ),
              if (_exists)
                _NumberNote(title: '${prettyPhone(_phone.text)} already has an account.', children: [
                  link('Sign in instead', () => context.go(_signinHref), underline: true),
                  const TextSpan(text: '.'),
                ]),
              if (emailMode != 'hidden')
                PcTextField(
                  label: 'Email${emailMode == 'optional' ? ' (optional)' : ''}',
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  error: _fields['email'],
                  hint: 'For invoices and order updates',
                ),
              PcCheckbox(
                value: _terms,
                onChanged: (v) => setState(() => _terms = v),
                label: Text.rich(TextSpan(style: Tw.sm(color: t.ink), children: [
                  const TextSpan(text: 'I agree to the '),
                  link('terms of use', () => openLink(context, '/pages/terms')),
                  const TextSpan(text: ' and '),
                  link('privacy policy', () => openLink(context, '/pages/privacy')),
                  const TextSpan(text: '.'),
                  if (_fields['terms'] != null) TextSpan(text: '\n${_fields['terms']}', style: TextStyle(color: t.buy)),
                ])),
              ),
              PcCheckbox(
                value: _offers,
                onChanged: (v) => setState(() => _offers = v),
                label: const Text('Send me offers and new arrivals (you can turn this off any time)'),
              ),
              PcButton.text('Continue', size: ButtonSize.lg, loading: _busy, onPressed: () => _send(emailMode)),
              _AuthFooter(children: [
                const TextSpan(text: 'Already have an account? '),
                link('Sign in', () => context.go(_signinHref)),
              ]),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.circleCheck, size: 14, color: t.inkFaint),
                const SizedBox(width: 6),
                Flexible(
                  child: Text.rich(TextSpan(style: Tw.xs(color: t.inkFaint), children: [
                    TextSpan(text: 'Want to sell on ${site.brandName}? '),
                    link('Become a seller', () => openLink(context, '/sell')),
                  ])),
                ),
              ]),
            ],
            if (_codeStep && sent != null)
              CodeStep(
                phone: _phone.text,
                length: sent.integer('length') > 0 ? sent.integer('length') : 6,
                devOtp: sent.strOrNull('dev_otp'),
                wait: wait,
                busy: _busy,
                verifyLabel: 'Verify and create account',
                onVerify: (c) => _verify(c, emailMode),
                onResend: () => _send(emailMode),
                onChange: () => setState(() {
                  _codeStep = false;
                  _sent = null;
                }),
              ),
          ],
        ),
      ),
    ]);
  }
}
