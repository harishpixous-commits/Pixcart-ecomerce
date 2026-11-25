// The web build (razorpay_flutter has no web support): Razorpay's checkout.js, or the local Razorpay simulator's
// script when the API names it in checkout_url (development), exactly like lib/razorpay.ts.

import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:pixcart_core/pixcart_core.dart';
import 'package:web/web.dart' as web;

import 'payments.dart';

const _defaultCheckout = 'https://checkout.razorpay.com/v1/checkout.js';
Future<void>? _loading;

Future<void> _loadScript(String? url) {
  if (globalContext.has('Razorpay')) return Future.value();
  return _loading ??= () {
    final done = Completer<void>();
    final s = web.document.createElement('script') as web.HTMLScriptElement
      ..src = url != null && RegExp(r'^https?://').hasMatch(url) ? url : _defaultCheckout
      ..async = true;
    s.onload = ((web.Event _) => done.complete()).toJS;
    s.onerror = ((web.Event _) {
      _loading = null;
      done.completeError(Exception('Could not load the payment window. Check your connection and try again.'));
    }).toJS;
    web.document.body!.appendChild(s);
    return done.future;
  }();
}

Future<PayResult> openCheckout(ApiClient api, CheckoutPayload payment, Map<String, dynamic> options) async {
  await _loadScript(payment.checkoutUrl);
  final done = Completer<PayResult>();
  String? failed;
  final opts = options.jsify() as JSObject;
  final modal = opts['modal'] as JSObject;
  modal['ondismiss'] = (() {
    if (!done.isCompleted) done.complete(PayResult(closed: failed == null, failure: failed));
  }).toJS;
  opts['handler'] = ((JSObject resp) {
    String field(String k) => (resp[k] as JSString?)?.toDart ?? '';
    verifyPayment(api, orderId: field('razorpay_order_id'), paymentId: field('razorpay_payment_id'), signature: field('razorpay_signature')).then(
      (order) {
        if (!done.isCompleted) done.complete(PayResult(order: order));
      },
      onError: (Object e) {
        if (!done.isCompleted) done.complete(PayResult(failure: ApiError.messageOf(e, 'We could not confirm the payment yet')));
      },
    );
  }).toJS;
  final ctor = globalContext['Razorpay'] as JSFunction;
  final rzp = ctor.callAsConstructor<JSObject>(opts);
  rzp.callMethod<JSAny?>(
    'on'.toJS,
    'payment.failed'.toJS,
    ((JSObject r) {
      final err = r['error'] as JSObject?;
      failed = (err?['description'] as JSString?)?.toDart ?? 'The payment did not go through';
    }).toJS,
  );
  rzp.callMethod<JSAny?>('open'.toJS);
  return done.future;
}
