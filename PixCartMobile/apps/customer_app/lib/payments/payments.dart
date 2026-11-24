// Paying for an order with Razorpay (port of lib/razorpay.ts) behind a small platform adapter:
//  - Android and iOS: razorpay_flutter (Razorpay's native checkout: every UPI app, cards incl. saved cards with the
//    shopper's customer_id, net banking, wallets), see pay_native.dart;
//  - the web build (used for screenshots and as a fallback): Razorpay's checkout.js, or the local simulator's script
//    that the API names in checkout_url, see pay_web.dart.
// Nothing is decided on the phone: a success is verified by the API (/api/payments/razorpay/verify), and the order
// page asks /api/orders/{id}/payment-status whenever the result is unclear.

import 'dart:ui';

import 'package:pixcart_core/pixcart_core.dart';

import 'pay_native.dart' if (dart.library.js_interop) 'pay_web.dart' as platform;

/// What happened in the payment window.
class PayResult {
  const PayResult({this.order, this.failure, this.closed = false});

  /// Paid and verified by the API.
  final OrderDetail? order;

  /// Razorpay's reason for a failed attempt.
  final String? failure;

  /// The shopper closed the window (the money may still arrive from a UPI app).
  final bool closed;
}

/// The options Razorpay checkout gets (same as payWithRazorpay on the website).
Map<String, dynamic> razorpayOptions(CheckoutPayload p, {required Color theme}) {
  String hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';
  return {
    'key': p.keyId,
    'amount': p.amount,
    'currency': p.currency,
    'name': p.name,
    'description': p.description,
    'order_id': p.razorpayOrderId,
    'prefill': {
      'name': p.prefill.str('name'),
      'contact': p.prefill.str('contact'),
      'email': p.prefill.str('email'),
    },
    'theme': {'color': hex(theme)},
    'retry': {'enabled': true},
    if (p.methods.isNotEmpty) 'method': p.methods,
    if ((p.customerId ?? '').isNotEmpty) ...{'customer_id': p.customerId, 'remember_customer': true},
    'modal': {'confirm_close': true, 'escape': true, 'backdropclose': false},
  };
}

/// Verifies a successful payment with the API and returns the confirmed order.
Future<OrderDetail> verifyPayment(ApiClient api, {required String orderId, required String paymentId, required String signature}) async {
  final r = asMap(await api.post('/api/payments/razorpay/verify', body: {
    'razorpay_order_id': orderId,
    'razorpay_payment_id': paymentId,
    'razorpay_signature': signature,
  }));
  return OrderDetail(r.obj('order'));
}

/// Opens Razorpay checkout for an order's payment.
Future<PayResult> payWithRazorpay(ApiClient api, CheckoutPayload payment, {required Color theme}) =>
    platform.openCheckout(api, payment, razorpayOptions(payment, theme: theme));
