// The bill in the cart, at checkout and on the order page (components/bill.tsx). Every number comes from the server.

import 'package:material_ui/material_ui.dart';
import 'package:pixcart_core/pixcart_core.dart';
import 'package:pixcart_ui/pixcart_ui.dart';

class BillData {
  const BillData({
    this.mrpTotal,
    required this.itemsTotal,
    this.itemCount = 0,
    required this.shippingTotal,
    this.codFee = 0,
    this.fees = const [],
    this.feeSavings = 0,
    this.tip = 0,
    this.couponCode,
    this.couponDiscount = 0,
    required this.grandTotal,
  });

  factory BillData.fromSummary(CartSummary s) => BillData(
        mrpTotal: s.mrpTotal,
        itemsTotal: s.itemsTotal,
        itemCount: s.itemCount,
        shippingTotal: s.shippingTotal,
        codFee: s.codFee,
        fees: s.fees,
        feeSavings: s.feeSavings,
        tip: s.tip,
        couponDiscount: s.couponDiscount,
        grandTotal: s.grandTotal,
      );

  final int? mrpTotal;
  final int itemsTotal;
  final int itemCount;
  final int shippingTotal;
  final int codFee;
  final List<FeeLine> fees;
  final int feeSavings;
  final int tip;
  final String? couponCode;
  final int couponDiscount;
  final int grandTotal;
}

class BillDetails extends StatelessWidget {
  const BillDetails({super.key, required this.bill, this.deliveryLabel = 'Delivery fee', this.deliveryInfo = '', this.hints = const [], this.totalLabel = 'To pay'});
  final BillData bill;
  final String deliveryLabel;
  final String deliveryInfo;
  final List<String> hints;
  final String totalLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    final mrpSaving = ((bill.mrpTotal ?? bill.itemsTotal) - bill.itemsTotal).clamp(0, 1 << 40);
    final savings = mrpSaving + bill.feeSavings + bill.couponDiscount;
    Widget amount(int value, {int? was, bool free = false}) => Text.rich(
          TextSpan(children: [
            if (was != null && was > value) ...[
              TextSpan(text: rupees(was), style: Tw.sm(color: t.inkFaint).copyWith(decoration: TextDecoration.lineThrough, decorationColor: t.inkFaint)),
              const TextSpan(text: '  '),
            ],
            free ? TextSpan(text: 'FREE', style: TextStyle(fontWeight: Tw.semibold, color: t.success)) : TextSpan(text: rupees(value)),
          ]),
          style: Tw.body(color: t.ink),
          textAlign: TextAlign.right,
        );
    Widget row(Widget label, Widget value) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: label), const SizedBox(width: 16), value]),
        );
    final total = Tw.display(18, 28, color: t.ink);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('BILL DETAILS', style: Tw.xs(weight: Tw.bold, color: t.inkSoft).copyWith(letterSpacing: 1.4)),
      const SizedBox(height: 12),
      row(
        Text.rich(TextSpan(style: Tw.body(color: t.ink), children: [
          const TextSpan(text: 'Item total'),
          if (bill.itemCount > 0) TextSpan(text: ' (${bill.itemCount} item${bill.itemCount == 1 ? '' : 's'})', style: TextStyle(color: t.inkFaint)),
        ])),
        amount(bill.itemsTotal, was: bill.mrpTotal),
      ),
      row(_Explained(label: deliveryLabel, info: deliveryInfo), amount(bill.shippingTotal, free: bill.shippingTotal == 0)),
      if (bill.codFee > 0) row(Text('Cash on delivery fee', style: Tw.body(color: t.ink)), amount(bill.codFee)),
      for (final f in bill.fees) ...[
        row(_Explained(label: f.label, info: f.info, gst: f.raw.integer('gst'), gstBps: f.raw.integer('gst_bps')), amount(f.amount, was: f.listAmount)),
        if (f.hint.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(f.hint, style: Tw.xs(color: t.inkFaint))),
      ],
      if (bill.tip > 0) row(Text('Delivery partner tip', style: Tw.body(color: t.ink)), amount(bill.tip)),
      if (bill.couponDiscount > 0)
        row(Text('Coupon${bill.couponCode != null && bill.couponCode!.isNotEmpty ? ' ${bill.couponCode}' : ''}', style: Tw.body(color: t.success)),
            Text('−${rupees(bill.couponDiscount)}', style: Tw.body(weight: Tw.semibold, color: t.success))),
      CustomPaint(painter: _DashedLine(t.line), child: const SizedBox(height: 1, width: double.infinity)),
      const SizedBox(height: 12),
      Row(children: [Expanded(child: Text(totalLabel, style: total)), Text(rupees(bill.grandTotal), style: total)]),
      if (savings > 0) ...[
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: t.successLight, borderRadius: BorderRadius.circular(t.radiusXl)),
          child: Row(children: [
            Icon(LucideIcons.badgePercent, size: 16, color: t.success),
            const SizedBox(width: 8),
            Expanded(child: Text('You save ${rupees(savings)} on this order', style: Tw.sm(weight: Tw.semibold, color: t.success))),
          ]),
        ),
      ],
      for (final h in hints) ...[
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: t.accentLight.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(t.radiusXl)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.truck, size: 16, color: t.accentDark)),
            const SizedBox(width: 8),
            Expanded(child: Text(h, style: Tw.sm(color: t.ink))),
          ]),
        ),
      ],
    ]);
  }
}

class _Explained extends StatefulWidget {
  const _Explained({required this.label, this.info = '', this.gst = 0, this.gstBps = 0});
  final String label;
  final String info;
  final int gst;
  final int gstBps;

  @override
  State<_Explained> createState() => _ExplainedState();
}

class _ExplainedState extends State<_Explained> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final t = context.pc;
    if (widget.info.isEmpty && widget.gst == 0) return Text(widget.label, style: Tw.body(color: t.ink));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        onTap: () => setState(() => _open = !_open),
        child: Container(
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.inkFaint, style: BorderStyle.solid, width: 0.5))),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Flexible(child: Text(widget.label, style: Tw.body(color: t.ink).copyWith(height: 1.375))),
            const SizedBox(width: 4),
            AnimatedRotation(turns: _open ? 0.5 : 0, duration: const Duration(milliseconds: 150), child: Icon(LucideIcons.chevronDown, size: 14, color: t.inkFaint)),
          ]),
        ),
      ),
      if (_open)
        Container(
          margin: const EdgeInsets.only(top: 4),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(color: t.page, borderRadius: BorderRadius.circular(t.radiusLg)),
          child: Text(
            [widget.info, if (widget.gst > 0) 'Includes GST of ${rupees(widget.gst)}${widget.gstBps > 0 ? ' (${widget.gstBps / 100}%)' : ''}.']
                .where((s) => s.isNotEmpty)
                .join('\n'),
            style: Tw.xs(color: t.inkSoft).copyWith(height: 1.625),
          ),
        ),
    ]);
  }
}

class _DashedLine extends CustomPainter {
  _DashedLine(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (double x = 0; x < size.width; x += 6) {
      canvas.drawLine(Offset(x, 0), Offset((x + 3).clamp(0, size.width), 0), p);
    }
  }

  @override
  bool shouldRepaint(_DashedLine old) => old.color != color;
}
