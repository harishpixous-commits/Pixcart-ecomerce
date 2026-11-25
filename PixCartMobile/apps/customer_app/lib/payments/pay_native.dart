// Android and iOS: Razorpay's native checkout (razorpay_flutter). It lists the UPI apps on the phone (the manifest's
// <queries> and iOS LSApplicationQueriesSchemes make them visible), cards (saved cards through customer_id), net
// banking and wallets, and returns here when the shopper finishes in the UPI app.

import 'dart:async';

import 'package:pixcart_core/pixcart_core.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

import 'payments.dart';

Future<PayResult> openCheckout(ApiClient api, CheckoutPayload payment, Map<String, dynamic> options) {
  final done = Completer<PayResult>();
  final rzp = Razorpay();
  void finish(PayResult r) {
    if (!done.isCompleted) done.complete(r);
    rzp.clear();
  }

  rzp.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse r) async {
    try {
      final order = await verifyPayment(api, orderId: r.orderId ?? payment.razorpayOrderId, paymentId: r.paymentId ?? '', signature: r.signature ?? '');
      finish(PayResult(order: order));
    } catch (e) {
      finish(PayResult(failure: ApiError.messageOf(e, 'We could not confirm the payment yet')));
    }
  });
  rzp.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse r) {
    if (r.code == Razorpay.PAYMENT_CANCELLED) {
      finish(const PayResult(closed: true));
    } else {
      final err = r.error?['error'];
      final why = err is Map ? '${err['description'] ?? ''}' : '';
      finish(PayResult(failure: why.isNotEmpty ? why : (r.message?.isNotEmpty == true ? r.message : 'The payment did not go through')));
    }
  });
  rzp.on(Razorpay.EVENT_EXTERNAL_WALLET, (ExternalWalletResponse r) => finish(const PayResult(closed: true)));
  try {
    rzp.open(options);
  } catch (e) {
    finish(const PayResult(failure: 'The payment could not be started'));
  }
  return done.future;
}
