// Payment logos (components/pay-logos.tsx): card networks, UPI apps and ways to pay as small white badges.

import 'package:flutter_svg/flutter_svg.dart';
import 'package:material_ui/material_ui.dart';

import 'pay_icons.dart';
import 'theme.dart';

class _Word {
  const _Word(this.title, this.parts, {this.size = 15});
  final String title;
  final List<(String, Color)> parts;
  final double size;
}

const _green = Color(0xFF097A44);
const _teal = Color(0xFF0B5563);
const _words = <String, _Word>{
  'rupay': _Word('RuPay', [('Ru', Color(0xFF1B3F94)), ('Pay', _green)]),
  'maestro': _Word('Maestro', [('maestro', Color(0xFF0099DF))], size: 12),
  'upi': _Word('UPI', [('UP', Color(0xFF5F6368)), ('I', Color(0xFF097939))]),
  'netbanking': _Word('Net banking', [('NetBanking', _teal)], size: 9),
  'wallet': _Word('Wallets', [('Wallets', _teal)], size: 11),
  'emi': _Word('EMI', [('EMI', _teal)]),
  'paylater': _Word('Pay Later', [('PayLater', _teal)], size: 10),
  'cod': _Word('Cash on delivery', [('COD', _teal)]),
};

const networkNames = <String, String>{
  'visa': 'Visa', 'mastercard': 'Mastercard', 'rupay': 'RuPay', 'amex': 'American Express', 'diners': 'Diners Club',
  'maestro': 'Maestro', 'discover': 'Discover', 'jcb': 'JCB',
};

/// Razorpay's network names ("MasterCard", "American Express") as logo names.
String networkKey(String network) {
  final n = network.toLowerCase().replaceAll(RegExp('[^a-z]'), '');
  if (n.startsWith('americanexpress') || n == 'amex') return 'amex';
  if (n.startsWith('diners')) return 'diners';
  return n;
}

/// One logo on a white card-shaped badge (h-7 w-11, rounded-md, ring black/10).
class PayLogo extends StatelessWidget {
  const PayLogo(this.name, {super.key});
  final String name;

  @override
  Widget build(BuildContext context) {
    final icon = payIcons[name];
    final word = _words[name];
    final title = icon?.title ?? word?.title ?? name;
    Widget inner;
    if (icon != null) {
      inner = SvgPicture.string(
        '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${icon.d}" fill="${icon.hex}"/></svg>',
        width: 32,
        height: 16,
      );
    } else if (word != null) {
      inner = SizedBox(
        width: 40,
        height: 16,
        child: FittedBox(
          child: SizedBox(
            width: 64,
            height: 24,
            child: Center(
              child: Text.rich(
                TextSpan(children: [
                  for (final (text, color) in word.parts)
                    TextSpan(text: text, style: TextStyle(color: color, fontSize: word.size, fontWeight: FontWeight.w800, fontStyle: FontStyle.italic)),
                ]),
                maxLines: 1,
              ),
            ),
          ),
        ),
      );
    } else {
      inner = Text(name.toUpperCase(), style: Tw.px(10, line: 14, weight: FontWeight.w700, color: context.pc.inkSoft));
    }
    return Tooltip(
      message: title,
      child: Semantics(
        label: title,
        child: Container(
          width: 44,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: Colors.black.withValues(alpha: 0.1)),
          ),
          child: inner,
        ),
      ),
    );
  }
}

/// "We accept": the card networks, then UPI and the other ways to pay that are on.
class AcceptedPayments extends StatelessWidget {
  const AcceptedPayments({super.key, required this.networks, this.methods, this.cod = false, this.label = 'We accept'});
  final List<String> networks;
  final Map<String, bool>? methods;
  final bool cod;
  final String label;

  @override
  Widget build(BuildContext context) {
    final m = methods;
    final ways = ['upi', 'netbanking', 'wallet', 'emi', 'paylater'].where((w) => m?[w] != false && (m != null ? m[w] == true : w == 'upi'));
    final cards = m != null && m['card'] == false ? const <String>[] : networks;
    final all = [if (m?['upi'] != false) ...['gpay', 'phonepe', 'paytm'], ...cards, ...ways, if (cod) 'cod'];
    if (all.isEmpty) return const SizedBox.shrink();
    return Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
      if (label.isNotEmpty)
        Padding(padding: const EdgeInsets.only(right: 4), child: Text(label, style: Tw.xs(weight: Tw.semibold, color: context.pc.inkSoft))),
      for (final n in all) PayLogo(n),
    ]);
  }
}
