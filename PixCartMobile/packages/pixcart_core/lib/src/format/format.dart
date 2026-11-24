// Money and date formatting, identical to `frontend/src/lib/format.ts`.
//
// Money is integer paise end to end and is formatted only here. Shop screens show amounts in the shopper's currency
// (Admin → Languages and currencies) at the admin's rate; what is actually charged, cash on delivery and invoices are
// always rupees (`inRupees`). Dates are shown in India time (IST, UTC+5:30) like the website.

import 'package:intl/intl.dart';

/// The shopper's display currency.
class DisplayCurrency {
  const DisplayCurrency({required this.code, required this.rate, required this.digits});
  final String code;
  final double rate;
  final int digits;

  static const base = DisplayCurrency(code: 'INR', rate: 1, digits: 2);
}

DisplayCurrency _display = DisplayCurrency.base;
final _formats = <String, NumberFormat>{};
final _inr0 = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
final _inr2 = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);
final _grouping = NumberFormat.decimalPattern('en_IN');

/// Sets the currency shop screens show (null or INR: rupees).
void setDisplayCurrency(DisplayCurrency? d) {
  _display = d != null && d.code != 'INR' && d.rate > 0 ? d : DisplayCurrency.base;
}

DisplayCurrency displayCurrency() => _display;

const _nbsp = '\u00A0';

/// `Intl.NumberFormat("en-US", {currencyDisplay: "narrowSymbol"})` symbols, as browsers show them.
const _narrow = <String, String>{
  'USD': r'$', 'EUR': '€', 'GBP': '£', 'AED': 'AED', 'SGD': r'$', 'AUD': r'$', 'CAD': r'$', 'JPY': '¥', 'CNY': '¥', 'HKD': r'$',
  'NZD': r'$', 'CHF': 'CHF', 'MYR': 'RM', 'THB': '฿', 'ZAR': 'R', 'QAR': 'QAR', 'KWD': 'KWD', 'OMR': 'OMR', 'BHD': 'BHD',
  'SAR': 'SAR', 'LKR': 'Rs', 'NPR': 'Rs', 'BDT': '৳', 'IDR': 'Rp', 'PHP': '₱', 'KRW': '₩', 'SEK': 'kr', 'NOK': 'kr', 'DKK': 'kr',
  'RUB': '₽', 'BRL': r'R$', 'MXN': r'$', 'TRY': '₺', 'ILS': '₪', 'EGP': 'E£', 'NGN': '₦', 'KES': 'KES', 'PKR': 'Rs', 'INR': '₹',
};

/// The narrow symbol of a currency as browsers show it (the code when there is none).
String narrowSymbol(String code) => _narrow[code] ?? code;

String _foreign(double value, String code, int digits) {
  final key = '$code:$digits';
  final f = _formats[key] ??= NumberFormat.currency(locale: 'en_US', symbol: '', decimalDigits: digits);
  final number = f.format(value.abs()).trim();
  final sym = narrowSymbol(code);
  // Intl puts a no-break space after an alphabetic symbol ("AED 12.50") and none after a sign ("$12.50").
  final spaced = RegExp(r'^[A-Za-z]+$').hasMatch(sym) ? '$sym$_nbsp' : sym;
  return '${value < 0 ? '-' : ''}$spaced$number';
}

/// ₹1,23,456, with paise only when present. In the shopper's currency on shop screens.
String rupees(num paise) {
  if (_display.code != 'INR') return _foreign(paise / 100 * _display.rate, _display.code, _display.digits);
  return paise % 100 == 0 ? _inr0.format(paise / 100) : _inr2.format(paise / 100);
}

/// Always two decimals (invoices, settlements). In the shopper's currency on shop screens.
String rupeesExact(num paise) {
  if (_display.code != 'INR') return _foreign(paise / 100 * _display.rate, _display.code, _display.digits);
  return _inr2.format(paise / 100);
}

/// Always rupees, whatever the shopper picked: what is actually charged, cash on delivery, invoices.
String inRupees(num paise) => paise % 100 == 0 ? _inr0.format(paise / 100) : _inr2.format(paise / 100);

/// An amount Razorpay charged, in its currency's smallest unit.
String money(num minor, String code, [int digits = 2]) {
  if (code == 'INR') return inRupees(minor);
  return _foreign(minor / _pow10(digits), code, digits);
}

num _pow10(int d) {
  var v = 1;
  for (var i = 0; i < d; i++) {
    v *= 10;
  }
  return v;
}

/// The symbol of the shopper's currency, for labels like "Price (₹)".
String currencySymbol() => _display.code == 'INR' ? '₹' : narrowSymbol(_display.code);

/// An amount the shopper typed in their currency ("12.50") as paise; null if not a number.
int? shownToPaise(String text) {
  final clean = text.replaceAll(RegExp(r'[^\d.]'), '');
  if (!RegExp(r'^\d+(\.\d{1,3})?$').hasMatch(clean)) return null;
  return (double.parse(clean) / (_display.code == 'INR' ? 1 : _display.rate) * 100).round();
}

int? toPaise(String rupeesText) {
  final clean = rupeesText.replaceAll(RegExp(r'[,₹\s]'), '');
  if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(clean)) return null;
  return (double.parse(clean) * 100).round();
}

String paiseToInput(int paise) => paise % 100 == 0 ? '${paise ~/ 100}' : (paise / 100).toStringAsFixed(2);

String pct(num bps) {
  final v = bps / 100;
  return '${v == v.roundToDouble() ? v.toInt() : v.toStringAsFixed(2)}%';
}

/// 1,23,456 (Indian digit grouping, like `toLocaleString("en-IN")`).
String count(num n) => _grouping.format(n);

const _ist = Duration(hours: 5, minutes: 30);

/// The time in India for an ISO time from the API.
DateTime? istOf(String? iso) {
  if (iso == null || iso.isEmpty) return null;
  final d = DateTime.tryParse(iso);
  if (d == null) return null;
  // DateTime.parse returns UTC when the text has an offset; a time without one is taken as UTC (API times are UTC).
  final utc = d.isUtc ? d : DateTime.utc(d.year, d.month, d.day, d.hour, d.minute, d.second, d.millisecond);
  return utc.add(_ist);
}

/// "24 Nov 2026".
String date(String? iso) {
  final d = istOf(iso);
  return d == null ? '' : '${d.day} ${_months[d.month - 1]} ${d.year}';
}

/// "24 Nov, 3:05 pm".
String dateTime(String? iso) {
  final d = istOf(iso);
  if (d == null) return '';
  return '${d.day} ${_months[d.month - 1]}, ${_clock(d)}';
}

/// "Tue, 3:05 pm" (deal start times).
String weekdayTime(String? iso) {
  final d = istOf(iso);
  if (d == null) return '';
  return '${_days[d.weekday - 1]}, ${_clock(d)}';
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _clock(DateTime d) {
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'am' : 'pm'}';
}

/// "3 hours", "2 days", "1 day 4 hours" for a length of time.
String duration(Duration length) {
  final ms = length.inMilliseconds;
  final hours = (ms / 3600000).round().clamp(0, 1 << 30);
  final days = hours ~/ 24;
  final rest = hours % 24;
  String h(int n) => '$n hour${n == 1 ? '' : 's'}';
  if (days == 0) {
    return ms < 3600000 ? '${(ms / 60000).round().clamp(1, 60)} min' : h(hours);
  }
  return '$days day${days == 1 ? '' : 's'}${rest > 0 ? ' ${h(rest)}' : ''}';
}

/// "Under 1 hour", "5 hours", "2.5 days" for averages measured in hours.
String hoursLabel(num? h) {
  if (h == null) return '—';
  if (h < 1) return 'Under 1 hour';
  if (h < 48) return '${h.round()} hour${h.round() == 1 ? '' : 's'}';
  return '${(h / 24).toStringAsFixed(1)} days';
}

const states = <String, String>{
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

/// The states sorted by name (state code, name).
final List<MapEntry<String, String>> stateOptions = states.entries.toList()..sort((a, b) => a.value.compareTo(b.value));

const subStatusLabel = <String, String>{
  'pending_payment': 'Awaiting payment',
  'placed': 'Order placed',
  'confirmed': 'Confirmed by seller',
  'packed': 'Packed',
  'shipped': 'Shipped',
  'delivered': 'Delivered',
  'cancelled': 'Cancelled',
};

const paymentStatusLabel = <String, String>{
  'pending': 'Payment pending',
  'paid': 'Paid',
  'cod': 'Pay on delivery',
  'failed': 'Payment not completed',
  'refunded': 'Refunded',
  'partially_refunded': 'Partly refunded',
};

const gstRates = [0, 25, 300, 500, 1200, 1800, 2800, 4000];

/// Day names by the backend's weekday number (0 = Monday).
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/// "Ends in 02:13:44" style countdown text for the time left (tiles and deal badges).
String timeLeft(Duration left) {
  if (left.inMilliseconds <= 0) return 'Ended';
  final s = left.inSeconds;
  final d = s ~/ 86400;
  if (d >= 2) return '$d days';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(s ~/ 3600)}:${two((s % 3600) ~/ 60)}:${two(s % 60)}';
}

/// "Status text" from a snake_case status: "pending_payment" → "Pending payment".
String humanize(String status) {
  final s = status.replaceAll('_', ' ');
  return s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}

/// {brand} and {free_delivery_amount} placeholders in storefront text (lib/tokens.ts).
String fillTokens(String text, {required String brand, required int freeShippingThresholdPaise}) =>
    text.replaceAll('{brand}', brand).replaceAll('{free_delivery_amount}', rupees(freeShippingThresholdPaise));

/// Two-tone wordmark: a CamelCase name is split at its last capital ("PixCart" → "Pix" + "Cart").
(String, String) splitBrand(String name) {
  final m = RegExp(r'[A-Z][^A-Z]*$').firstMatch(name);
  final i = m?.start ?? -1;
  return i > 0 ? (name.substring(0, i), name.substring(i)) : (name, '');
}
