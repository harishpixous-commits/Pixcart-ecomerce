"""Cart pricing, checkout, the sub-order state machine, cancellation, payment and refunds.

Rules (several adapted from the Pixcart requirement suite):
- One customer order is split into one sub-order per seller; each seller ships and is paid separately.
- Stock is taken when the order is created (rows locked in a fixed order, so concurrent checkouts
  cannot oversell). Unpaid online orders give the stock back when the payment window ends.
- A transition not listed in TRANSITIONS is refused, in exactly one place (``transition``).
- Every cancellation of paid money creates a refund record; the gateway call is retried by a job.
"""
from __future__ import annotations

import logging
import secrets
import string
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.errors import ApiError, Conflict
from app.core.money import apply_bps, compute_settlement, split_inclusive_gst
from app.core.validators import STATES, validate_gstin
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import (
    Address,
    CartItem,
    Category,
    Coupon,
    CouponRedemption,
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    Product,
    Refund,
    Seller,
    SubOrder,
    User,
    Variant,
    Warehouse,
)
from app.services import fee_invoices, inventory, payment_gateways, razorpay, regional
from app.services import fees as fees_svc
from app.services.catalog import images_for, refresh_product_aggregates, variant_label
from app.services.coupons import CouponResult, evaluate
from app.services.delivery import estimate
from app.services.invoices import assign_invoice
from app.services.ledger import post_delivery
from app.services.notify import notify, notify_seller
from app.services.platform_settings import get_settings
from app.services.reports import IST
from app.services.stats import bump

log = logging.getLogger("pixcart.orders")

TRANSITIONS: dict[str, tuple[str, ...]] = {
    "pending_payment": ("placed", "cancelled"),
    "placed": ("confirmed", "cancelled"),
    "confirmed": ("packed", "cancelled"),
    "packed": ("shipped", "cancelled"),
    "shipped": ("delivered", "cancelled"),  # cancelled after shipping = returned to origin (RTO)
    "delivered": (),
    "cancelled": (),
}
CUSTOMER_CANCELLABLE = ("placed", "confirmed", "packed")  # the most a customer may ever cancel by themselves


async def customer_cancellable(session: AsyncSession) -> tuple[str, ...]:
    """The package steps a customer can still cancel at, up to the owner's choice (Admin → Marketplace settings)."""
    until = (await get_settings(session))["customer_cancel_until"]
    return CUSTOMER_CANCELLABLE[: CUSTOMER_CANCELLABLE.index(until) + 1] if until in CUSTOMER_CANCELLABLE else CUSTOMER_CANCELLABLE


def can_transition(src: str, dst: str) -> bool:
    return dst in TRANSITIONS.get(src, ())


# ----------------------------------------------------------------------------- cart / quote


@dataclass
class CartLine:
    cart_item_id: uuid.UUID
    variant: Variant
    product: Product
    seller: Seller
    qty: int
    image: str
    problem: str = ""  # why this line cannot be bought right now
    max_qty: int = 0  # the most this line can hold now: stock, the per-item limit and units left at a deal price

    @property
    def line_total(self) -> int:
        return self.variant.price_paise * self.qty


@dataclass
class Piece:
    """The part of a cart line shipped from one warehouse: the whole line, unless no single warehouse holds all of it."""

    line: CartLine
    qty: int

    @property
    def line_total(self) -> int:
        return self.line.variant.price_paise * self.qty


@dataclass
class SellerGroup:
    seller: Seller
    lines: list[CartLine] = field(default_factory=list)
    shipping_fee: int = 0

    @property
    def items_total(self) -> int:
        return sum(line.line_total for line in self.lines if not line.problem)


async def load_cart(session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> list[CartLine]:
    stmt = (
        select(CartItem, Variant, Product, Seller)
        .join(Variant, Variant.id == CartItem.variant_id)
        .join(Product, Product.id == Variant.product_id)
        .join(Seller, Seller.id == Product.seller_id)
        .where(CartItem.user_id == user_id)
        .order_by(Variant.id)  # fixed lock order prevents deadlocks between concurrent checkouts
    )
    if lock:
        stmt = stmt.with_for_update(of=Variant)
    rows = (await session.execute(stmt)).all()
    from app.services import deals as deals_svc

    imgs = await images_for(session, list({r.Product.id for r in rows}))
    per_item = (await get_settings(session))["max_qty_per_item"]
    at_deal = await deals_svc.units_left(session, [r.Variant.id for r in rows])  # read after the version rows are locked
    lines = []
    for item, variant, product, seller in rows:
        line = CartLine(item.id, variant, product, seller, item.qty, (imgs.get(product.id) or [""])[0])
        deal_left = at_deal.get(variant.id)
        line.max_qty = max(0, min(variant.stock, per_item, deal_left if deal_left else per_item))
        if product.status != "approved" or seller.status != "approved" or not variant.is_active:
            line.problem = "This item is no longer available"
        elif seller.holiday_mode:
            line.problem = "The seller is not taking orders right now"
        elif variant.stock <= 0:
            line.problem = "Out of stock"
        elif variant.stock < item.qty:
            line.problem = f"Only {variant.stock} left in stock"
        elif item.qty > per_item:
            line.problem = f"You can buy at most {per_item} of this item in one order"
        elif deal_left and item.qty > deal_left:
            line.problem = f"Only {deal_left} left at the deal price"
        lines.append(line)
    return lines


def free_threshold(seller: Seller, cfg: dict, bounds: tuple[int, int] | None) -> int:
    """The item total from which this seller's package ships free: the seller's own, kept inside the admin's bounds, else the marketplace's."""
    own = getattr(seller, "free_shipping_threshold_paise", None)
    if bounds is None or own is None:
        return cfg["free_shipping_threshold_paise"]
    return min(max(int(own), bounds[0]), bounds[1])


def group_by_seller(lines: list[CartLine], cfg: dict, remote: tuple[int, bool] = (0, True), bounds: tuple[int, int] | None = None, state_fee: int | None = None, member_free: bool = False) -> list[SellerGroup]:
    groups: dict[uuid.UUID, SellerGroup] = {}
    for line in lines:
        groups.setdefault(line.seller.id, SellerGroup(line.seller)).lines.append(line)
    for g in groups.values():
        has_items = g.items_total > 0
        g.shipping_fee = 0 if (not has_items or member_free or g.items_total >= free_threshold(g.seller, cfg, bounds)) else (cfg["shipping_fee_paise"] if state_fee is None else state_fee)
        # Remote-area surcharge (Admin -> Growth -> Shipping zones): once per seller package, not charged on an empty group.
        if has_items and remote[0] and not member_free and not (remote[1] and g.shipping_fee == 0):
            g.shipping_fee += remote[0]
    return list(groups.values())


def cart_payload(groups: list[SellerGroup], cfg: dict, online_available: bool, ck: dict | None = None, bounds: tuple[int, int] | None = None) -> dict:
    """The cart and its bill. With the checkout settings (``ck``) the marketplace's fees and the nudges are included."""
    items_total = sum(g.items_total for g in groups)
    shipping = sum(g.shipping_fee for g in groups)
    mrp_total = sum(line.variant.mrp_paise * line.qty for g in groups for line in g.lines if not line.problem)
    fee_lines = fees_svc.order_fees(ck, items_total) if ck else []
    fees_total = sum(f["amount"] for f in fee_lines)
    view = {
        "groups": [
            {
                "seller": {"id": str(g.seller.id), "name": g.seller.display_name, "slug": g.seller.slug},
                "items_total": g.items_total,
                "shipping_fee": g.shipping_fee,
                "free_shipping_gap": max(0, free_threshold(g.seller, cfg, bounds) - g.items_total) if 0 < g.items_total < free_threshold(g.seller, cfg, bounds) else 0,
                "lines": [
                    {
                        "id": str(line.cart_item_id),
                        "variant_id": str(line.variant.id),
                        "product_id": str(line.product.id),
                        "product_slug": line.product.slug,
                        "title": line.product.title,
                        "variant_label": variant_label(line.variant.options),
                        "image": line.image,
                        "qty": line.qty,
                        "price": line.variant.price_paise,
                        "mrp": line.variant.mrp_paise,
                        "line_total": line.line_total,
                        "stock_left": line.variant.stock,
                        "max_qty": line.max_qty,
                        "problem": line.problem,
                    }
                    for line in g.lines
                ],
            }
            for g in groups
        ],
        "summary": {
            "mrp_total": mrp_total,
            "discount": mrp_total - items_total,
            "items_total": items_total,
            "shipping_total": shipping,
            "fees": fee_lines,
            "fees_total": fees_total,
            "fee_savings": sum(f["list_amount"] - f["amount"] for f in fee_lines if f["list_amount"]),
            "grand_total": items_total + shipping + fees_total,
            "item_count": sum(line.qty for g in groups for line in g.lines if not line.problem),
            "has_problems": any(line.problem for g in groups for line in g.lines),
        },
        "cod_available": cfg["cod_enabled"],
        "cod_max_order_paise": cfg["cod_max_order_paise"],
        "online_available": online_available,
    }
    if ck:
        view["hints"] = fees_svc.hints(ck, cfg, items_total, view["groups"])
        view["checkout"] = fees_svc.public(ck)
    return view


# ----------------------------------------------------------------------------- numbering / events

_ALPHABET = string.ascii_uppercase.replace("O", "").replace("I", "") + "23456789"


def _order_number(now: datetime) -> str:
    return f"PC{now:%y%m%d}" + "".join(secrets.choice(_ALPHABET) for _ in range(6))


def add_event(session: AsyncSession, order_id: uuid.UUID, sub: SubOrder | None, src: str, dst: str, actor: str, note: str = "") -> None:
    session.add(
        OrderEvent(order_id=order_id, sub_order_id=sub.id if sub else None, from_status=src, to_status=dst, actor=actor, note=note[:1000], created_at=utcnow())
    )


# ----------------------------------------------------------------------------- placement


async def place_order(
    session: AsyncSession,
    user: User,
    *,
    address_id: uuid.UUID,
    payment_method: str,
    idempotency_key: str,
    expected_total: int | None,
    coupon_code: str | None = None,
    tip_paise: int = 0,
    buyer_gstin: str = "",
    buyer_business: str = "",
    instructions: str | None = None,
    no_bag: bool = False,
    currency: str | None = None,
) -> tuple[Order, Payment | None]:
    existing = (
        await session.execute(select(Order).where(Order.user_id == user.id, Order.idempotency_key == idempotency_key))
    ).scalar_one_or_none()
    if existing:
        pay = (await session.execute(select(Payment).where(Payment.order_id == existing.id).order_by(Payment.created_at.desc()).limit(1))).scalar_one_or_none()
        return existing, pay

    cfg = await get_settings(session)
    address = await session.get(Address, address_id)
    if address is None or address.user_id != user.id or address.is_deleted:
        raise ApiError("Choose a delivery address", "invalid_address")

    from app.services import deals as deals_svc

    await deals_svc.sync(session, force=True)  # a deal that just started or ended changes the price paid
    lines = await load_cart(session, user.id, lock=True)
    if not lines:
        raise ApiError("Your cart is empty", "cart_empty")
    bad = [line for line in lines if line.problem]
    if bad:
        raise Conflict(f"'{bad[0].product.title}': {bad[0].problem}. Update your cart and try again.", "cart_changed")
    max_qty = cfg["max_qty_per_item"]
    if any(line.qty > max_qty for line in lines):
        raise ApiError(f"You can buy at most {max_qty} of an item per order", "qty_limit")

    coupon: CouponResult | None = None
    if coupon_code:
        if not cfg["feature_coupons"]:
            raise ApiError("Coupons are not available right now", "coupons_off")
        coupon = await evaluate(session, coupon_code, user.id, lines)
        # Lock the coupon so its usage limit holds under concurrent checkouts.
        locked = (await session.execute(select(Coupon).where(Coupon.id == coupon.coupon.id).with_for_update())).scalar_one()
        if locked.usage_limit is not None and locked.used_count >= locked.usage_limit:
            raise ApiError("This coupon has been fully used", "coupon_exhausted")

    from app.services import growth as growth_svc

    cfg = await growth_svc.with_state_threshold(session, cfg, address.state_code)
    from app.services import loyalty as loyalty_svc

    groups = group_by_seller(lines, cfg, await growth_svc.remote_surcharge(session, address.pincode), await growth_svc.seller_free_bounds(session), await growth_svc.state_fee(session, address.state_code), await loyalty_svc.free_delivery(session, user.id))
    now = utcnow()
    is_online = payment_method == "online"
    categories = {c.id: c for c in (await session.execute(select(Category))).scalars()}

    # Plan sub-orders: one per (seller, warehouse) the stock is allocated from. A line no single warehouse can fill is
    # split across warehouses; each part ships in that warehouse's package.
    plans: list[dict] = []
    for g in groups:
        try:
            alloc = await inventory.allocate(session, g.seller, [(ln.variant, ln.qty) for ln in g.lines], address.state_code)
        except inventory.InsufficientStock as exc:
            short = next(ln for ln in g.lines if ln.variant.id == exc.variant_id)
            left = f"only {exc.available} left in stock" if exc.available else "it just sold out"
            raise Conflict(f"'{short.product.title}': {left}. Update your cart and try again.", "cart_changed") from exc
        by_wh: dict[uuid.UUID, list[Piece]] = {}
        whs: dict[uuid.UUID, Warehouse] = {}
        for ln in g.lines:
            for wh, qty in alloc[ln.variant.id]:
                by_wh.setdefault(wh.id, []).append(Piece(ln, qty))
                whs[wh.id] = wh
        for n, (wh_id, pieces) in enumerate(by_wh.items()):
            plans.append({"seller": g.seller, "warehouse": whs[wh_id], "lines": pieces, "shipping": g.shipping_fee if n == 0 else 0})
    # A line's coupon discount is shared by its parts in proportion to their quantity (the last part takes the rest).
    piece_disc: dict[tuple[uuid.UUID, uuid.UUID], int] = {}
    for ln in lines:
        whole = coupon.per_line.get(ln.variant.id, 0) if coupon else 0
        parts = [(plan["warehouse"].id, pc.qty) for plan in plans for pc in plan["lines"] if pc.line is ln]
        given = 0
        for i, (wh_id, q) in enumerate(parts):
            share = whole - given if i == len(parts) - 1 else whole * q // ln.qty
            piece_disc[(ln.variant.id, wh_id)] = share
            given += share

    items_total = sum(ln.line_total for ln in lines)
    shipping_total = sum(p["shipping"] for p in plans)
    cod_fee = cfg["cod_fee_paise"] if payment_method == "cod" else 0
    discount_total = coupon.discount if coupon else 0
    ck = await fees_svc.get(session)
    fee_lines = fees_svc.order_fees(ck, items_total)
    fees_total = sum(f["amount"] for f in fee_lines)
    try:
        tip = fees_svc.tip_amount(ck, tip_paise)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_tip") from exc
    gstin = ""
    business = ""
    if buyer_gstin.strip():
        if not ck["gstin_enabled"]:
            raise ApiError("Business invoices are not available right now", "gstin_off")
        try:
            gstin = validate_gstin(buyer_gstin)
            business = fees_svc.check_business(buyer_business)
        except ValueError as exc:
            raise ApiError(str(exc), "invalid_gstin", fields={"buyer_gstin": "Invalid"}) from exc
    note = " ".join((instructions if instructions is not None else address.instructions or "").split())[:300] if ck["instructions_enabled"] else ""
    grand_total = items_total + shipping_total + cod_fee + fees_total + tip - discount_total

    if payment_method == "cod":
        if not cfg["cod_enabled"]:
            raise ApiError("Cash on delivery is not available", "cod_unavailable")
        if grand_total > cfg["cod_max_order_paise"]:
            raise ApiError("Cash on delivery is not available for this order value. Please pay online.", "cod_limit")
        from app.services import growth as growth_svc  # Growth -> COD risk rules (off unless switched on)

        reason = await growth_svc.cod_block_reason(session, user.id, address.pincode, grand_total)
        if reason:
            raise ApiError(reason, "cod_risk")
    elif not (await get_integrations(session)).online_payments:
        raise ApiError("Online payment is not available right now. Please choose cash on delivery.", "online_unavailable")
    if expected_total is not None and expected_total != grand_total:
        raise Conflict("Prices in your cart changed. Please review the new total.", "total_changed")

    order = Order(
        number=_order_number(now),
        user_id=user.id,
        status="pending_payment" if is_online else "placed",
        payment_method=payment_method,
        payment_status="pending" if is_online else "cod",
        ship_to={
            "full_name": address.full_name, "phone": address.phone, "line1": address.line1, "line2": address.line2,
            "landmark": address.landmark, "city": address.city, "state_code": address.state_code,
            "state": STATES.get(address.state_code, ""), "pincode": address.pincode, "label": address.label, "kind": address.kind,
            "lat": float(address.lat) if address.lat is not None else None, "lng": float(address.lng) if address.lng is not None else None,
            "instructions": note, "no_bag": bool(no_bag and ck["no_bag_enabled"]),
        },
        items_total=items_total,
        shipping_total=shipping_total,
        cod_fee=cod_fee,
        discount_total=discount_total,
        coupon_code=coupon.coupon.code if coupon else "",
        fees=fee_lines,
        fees_total=fees_total,
        tip_paise=tip,
        buyer_gstin=gstin,
        buyer_business=business,
        grand_total=grand_total,
        idempotency_key=idempotency_key,
        payment_expires_at=now + timedelta(minutes=(await get_settings(session))["payment_window_minutes"]) if is_online else None,
        placed_at=None if is_online else now,
    )
    session.add(order)
    await session.flush()

    seller_funded = bool(coupon and coupon.coupon.funded_by == "seller")
    sub_status = "pending_payment" if is_online else "placed"
    counted: set[uuid.UUID] = set()  # a split line counts as one order of the product in the stats
    for idx, plan in enumerate(plans, start=1):
        seller, wh = plan["seller"], plan["warehouse"]
        interstate = wh.state_code != address.state_code
        sub_cod = cod_fee if idx == 1 else 0
        sub_items = sum(pc.line_total for pc in plan["lines"])
        line_disc = {pc.line.variant.id: piece_disc[(pc.line.variant.id, wh.id)] for pc in plan["lines"]}
        sub_seller_disc = sum(line_disc.values()) if seller_funded else 0
        sub_platform_disc = 0 if seller_funded else sum(line_disc.values())
        sub = SubOrder(
            order_id=order.id,
            seller_id=seller.id,
            warehouse_id=wh.id,
            number=f"{order.number}-{idx}",
            status=sub_status,
            items_total=sub_items,
            shipping_fee=plan["shipping"],
            cod_fee=sub_cod,
            seller_discount=sub_seller_disc,
            platform_discount=sub_platform_disc,
            total=sub_items + plan["shipping"] + sub_cod - sub_seller_disc,
            taxable_total=0,
            is_interstate=interstate,
            expected_delivery_at=datetime.fromisoformat(estimate(cfg, seller.dispatch_days, wh.pincode, wh.state_code, address.pincode, cutoff=seller.dispatch_cutoff)["max_date"]).replace(tzinfo=now.tzinfo),
        )
        session.add(sub)
        await session.flush()
        taxable = commission = max_rate = 0
        for pc in plan["lines"]:
            ln = pc.line
            v, p = ln.variant, ln.product
            await inventory.change(session, v, wh.id, -pc.qty, "sale", reference=sub.number)
            p.sold_count += pc.qty
            item_seller_disc = line_disc[v.id] if seller_funded else 0
            item_platform_disc = 0 if seller_funded else line_disc[v.id]
            value = pc.line_total - item_seller_disc
            split = split_inclusive_gst(value, p.gst_bps, interstate=interstate)
            cat = categories.get(p.category_id)
            bps = seller.commission_bps_override if seller.commission_bps_override is not None else (cat.commission_bps if cat else 0)
            line_commission = apply_bps(value, bps)
            commission += line_commission
            taxable += split.taxable
            max_rate = max(max_rate, p.gst_bps)
            session.add(
                OrderItem(
                    sub_order_id=sub.id, product_id=p.id, variant_id=v.id, title=p.title, variant_label=variant_label(v.options),
                    image_url=ln.image, sku=v.sku, hsn_code=p.hsn_code, qty=pc.qty, unit_price=v.price_paise, unit_mrp=v.mrp_paise,
                    line_total=pc.line_total, gst_bps=p.gst_bps, taxable_value=split.taxable, cgst=split.cgst, sgst=split.sgst,
                    igst=split.igst, commission_bps=bps, commission_paise=line_commission,
                    seller_discount=item_seller_disc, platform_discount=item_platform_disc,
                    return_window_days=p.return_window_days,
                )
            )
            await bump(session, p.id, orders=0 if v.id in counted else 1, units=pc.qty, revenue=value)
            counted.add(v.id)
            # after the item is recorded at the deal price: may end a lightning deal whose units are now gone
            await deals_svc.record_sale(session, v.id, pc.qty)
        extra = sub.shipping_fee + sub.cod_fee
        taxable += split_inclusive_gst(extra, max_rate, interstate=interstate).taxable if extra else 0
        sub.shipping_gst_bps = max_rate
        sub.taxable_total = taxable
        s_ = compute_settlement(
            gross=sub.total, taxable=taxable, commission=commission,
            commission_gst_bps=cfg["commission_gst_bps"], tcs_bps=cfg["tcs_bps"], tds_bps=cfg["tds_bps"],
        )
        sub.commission_paise, sub.commission_gst_paise = s_.commission, s_.commission_gst
        sub.tcs_paise, sub.tds_paise, sub.seller_payout_paise = s_.tcs, s_.tds, s_.payout
        add_event(session, order.id, sub, "", sub_status, "customer")

    for p in {ln.product.id: ln.product for ln in lines}.values():
        await refresh_product_aggregates(session, p)
    await session.execute(CartItem.__table__.delete().where(CartItem.user_id == user.id))

    if coupon:
        coupon.coupon.used_count += 1
        session.add(CouponRedemption(coupon_id=coupon.coupon.id, user_id=user.id, order_id=order.id, discount_paise=coupon.discount, created_at=now))

    payment = None
    # the shopper's currency (Admin → Languages and currencies): kept on the order with today's rate; Razorpay charges it
    # only when the admin chose "charge in the shopper's currency", otherwise rupees
    reg = await regional.get_regional(session)
    shown = (currency or regional.BASE).upper()
    shown_rate = regional.currency_rate(reg, shown)
    if shown_rate is not None:
        order.currency, order.fx_rate = shown, shown_rate
    charge_currency, _, charge = regional.charge_plan(reg, currency, grand_total) if is_online else (regional.BASE, None, None)
    if is_online:
        # Created inside the transaction: if every gateway fails, nothing above is committed. Routing and failover
        # between gateways live in services/payment_gateways.py.
        payment = await payment_gateways.start_payment(session, order, user, amount=grand_total, charge=charge, charge_currency=charge_currency,
                                                       cfg=await get_integrations(session))
    else:
        await _announce_placed(session, order, user)
    await session.commit()
    return order, payment


async def _announce_placed(session: AsyncSession, order: Order, user: User | None = None) -> None:
    user = user or await session.get(User, order.user_id)
    await notify(session, "order_placed", user, {"order_number": order.number, "amount": f"₹{order.grand_total / 100:,.2f}"}, link=f"/orders/{order.id}")
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == order.id))).scalars())
    for sub in subs:
        seller = await session.get(Seller, sub.seller_id)
        titles = [t for t in (await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id))).scalars()]
        await notify_seller(
            session, sub.seller_id, "seller_new_order",
            {"order_number": sub.number, "items": ", ".join(titles)[:150], "amount": f"₹{sub.total / 100:,.2f}", "dispatch_days": seller.dispatch_days if seller else 2},
            link=f"/seller/orders/{sub.id}",
        )


def checkout_payload(order: Order, payment: Payment | None, user: User, brand: str, cfg: Settings) -> dict | None:
    if payment is None or order.status != "pending_payment":
        return None
    if payment.provider != "razorpay":
        return payment_gateways.payload(order, payment, user, brand, cfg)
    return {
        "provider": "razorpay",
        "mode": "modal",
        "key_id": cfg.razorpay_key_id,
        "checkout_url": cfg.razorpay_checkout_url,
        "razorpay_order_id": payment.provider_order_id,
        "amount": payment.charge_amount or payment.amount_paise,
        "currency": payment.currency or "INR",
        "name": brand,
        "description": f"Order {order.number}",
        "prefill": {"name": user.name, "contact": f"+91{user.phone}" if user.phone else "", "email": user.email or ""},
        "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
    }


# ----------------------------------------------------------------------------- payment


async def mark_paid(session: AsyncSession, payment: Payment, provider_payment_id: str, method: str, amount: int) -> str:
    """Idempotently records a captured payment. Returns 'paid', 'already' or 'refund' (a duplicate or late payment,
    refunded in full). The order's first captured payment stays its payment: cancellations and returns are refunded
    against it, so a duplicate never takes its place."""
    order = (await session.execute(select(Order).where(Order.id == payment.order_id).with_for_update())).scalar_one()
    payment = (await session.execute(select(Payment).where(Payment.id == payment.id).with_for_update().execution_options(populate_existing=True))).scalar_one()
    if payment.status == "captured" and payment.provider_payment_id == provider_payment_id:
        return "already"
    if (await session.execute(select(Refund.id).where(Refund.provider_payment_id == provider_payment_id))).first():
        return "already"  # a duplicate payment already being refunded
    if amount != (payment.charge_amount or payment.amount_paise):
        raise ApiError("Payment amount does not match the order", "amount_mismatch")
    if payment.status == "captured":
        # A second successful payment for the same order (two tabs, a retried UPI request): refund it in full, to itself.
        session.add(Refund(order_id=order.id, payment_id=payment.id, provider_payment_id=provider_payment_id, amount_paise=payment.amount_paise,
                           reason="Duplicate payment"))
        return "refund"
    payment.status = "captured"
    payment.provider_payment_id = provider_payment_id
    payment.method = method[:20]
    if order.status == "pending_payment":
        now = utcnow()
        order.status = "placed"
        order.payment_status = "paid"
        order.placed_at = now
        subs = (await session.execute(select(SubOrder).where(SubOrder.order_id == order.id))).scalars()
        for sub in subs:
            if sub.status == "pending_payment":
                sub.status = "placed"
                add_event(session, order.id, sub, "pending_payment", "placed", "payment", f"paid via {method}")
        await session.flush()
        await _announce_placed(session, order)
        return "paid"
    # Paid after the order was cancelled (payment window expired): refund in full.
    order.payment_status = "refunded"
    session.add(Refund(order_id=order.id, payment_id=payment.id, amount_paise=payment.amount_paise, reason="Payment received after order was cancelled"))
    order.refunded_total += payment.amount_paise
    return "refund"


async def confirm_with_gateway(session: AsyncSession, payment: Payment, provider_payment_id: str) -> str:
    """Asks Razorpay for the payment's real state (never trust the browser) and records it."""
    data = await razorpay.fetch_payment(provider_payment_id)
    if data.get("order_id") != payment.provider_order_id:
        raise ApiError("Payment does not belong to this order", "payment_mismatch")
    status = data.get("status")
    if status == "authorized":
        data = await razorpay.capture_payment(provider_payment_id, payment.charge_amount or payment.amount_paise, payment.currency or "INR")
        status = data.get("status")
    if status != "captured":
        payment.status = "failed" if status == "failed" else payment.status
        payment.error = (data.get("error_description") or status or "")[:500]
        return "not_captured"
    return await mark_paid(session, payment, provider_payment_id, data.get("method", ""), int(data.get("amount", 0)))


def refund_charge(payment: Payment, paise: int) -> int:
    """A refund in rupees as Razorpay must send it: in the currency the shopper paid, at the order's own rate."""
    if not payment.charge_amount or payment.currency in ("", "INR") or not payment.amount_paise:
        return paise
    if paise >= payment.amount_paise:
        return payment.charge_amount
    return max(1, (paise * payment.charge_amount + payment.amount_paise // 2) // payment.amount_paise)


async def check_with_gateway(session: AsyncSession, payment: Payment) -> dict:
    """Asks Razorpay whether this order was paid, from Razorpay's own records (never the browser's word). Used when the
    shopper comes back from a UPI app, by the order page while it waits, and by the admin "Check payment" button.

    result: already_paid | paid | already | refund (a duplicate payment, refunded) | not_paid
    waiting: a UPI request is still open (the shopper may not have approved it yet)
    reason: why the last attempt failed, in Razorpay's words.  Raises razorpay.GatewayError when Razorpay is unreachable."""
    if payment.status == "captured":
        return {"result": "already_paid", "attempts": [], "payment": {"id": payment.provider_payment_id, "method": payment.method, "status": "captured"},
                "waiting": False, "reason": ""}
    if payment.provider != "razorpay":
        return await payment_gateways.check(session, payment, mark_paid)
    attempts = await razorpay.order_payments(payment.provider_order_id)
    attempts = sorted(attempts, key=lambda a: int(a.get("created_at") or 0), reverse=True)
    seen = [{"id": a.get("id"), "status": a.get("status"), "method": a.get("method", ""), "error": a.get("error_description") or ""} for a in attempts]
    done = next((a for a in attempts if a.get("status") in ("captured", "authorized")), None)
    if done is None:
        failed = next((a for a in attempts if a.get("status") == "failed"), None)
        reason = (failed.get("error_description") or "The payment did not go through") if failed else ""
        if failed and payment.status != "captured":
            payment.error = reason[:500]
        return {"result": "not_paid", "attempts": seen, "waiting": any(a.get("status") == "created" for a in attempts), "reason": reason}
    result = await confirm_with_gateway(session, payment, done["id"])
    return {"result": result, "attempts": seen, "payment": {"id": done["id"], "method": done.get("method", ""), "status": "captured"},
            "waiting": False, "reason": ""}


# ----------------------------------------------------------------------------- transitions / cancel


async def _release_stock(session: AsyncSession, sub: SubOrder, kind: str = "release") -> None:
    from app.services import deals as deals_svc

    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalars())
    for it in sorted(items, key=lambda i: i.variant_id):
        qty = it.qty - it.returned_qty
        if qty <= 0:
            continue
        variant = (await session.execute(select(Variant).where(Variant.id == it.variant_id).with_for_update())).scalar_one()
        if sub.warehouse_id:
            await inventory.change(session, variant, sub.warehouse_id, qty, kind, reference=sub.number)
        else:
            variant.stock += qty
        await deals_svc.release_sale(session, it.variant_id, qty, it.unit_price)  # units back on offer at the deal price
        await session.execute(update(Product).where(Product.id == it.product_id).values(sold_count=func.greatest(Product.sold_count - qty, 0)))
    for pid in {it.product_id for it in items}:
        p = (await session.execute(select(Product).where(Product.id == pid).execution_options(populate_existing=True))).scalar_one()
        await refresh_product_aggregates(session, p)


async def _first_title(session: AsyncSession, sub: SubOrder) -> str:
    titles = list((await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id))).scalars())
    return titles[0] + (f" and {len(titles) - 1} more" if len(titles) > 1 else "") if titles else sub.number


async def transition(session: AsyncSession, sub: SubOrder, dst: str, actor: str, note: str = "", *, announce: bool = True) -> None:
    """Moves a package to its next status. ``announce=False`` skips the "shipped" message (the own delivery fleet
    sends "out for delivery" with the OTP instead)."""
    if not can_transition(sub.status, dst):
        raise Conflict(f"Cannot move this order from '{sub.status}' to '{dst}'", "illegal_transition")
    src = sub.status
    now = utcnow()
    sub.status = dst
    if dst == "confirmed":
        sub.confirmed_at = now
    elif dst == "packed":
        sub.packed_at = now
    elif dst == "shipped":
        sub.shipped_at = now
        await assign_invoice(session, sub)
        order = await session.get(Order, sub.order_id)
        seller = await session.get(Seller, sub.seller_id)
        if announce:
            await notify(
                session, "order_shipped", await session.get(User, order.user_id),
                {"order_number": order.number, "item": await _first_title(session, sub), "courier": sub.courier_name or "courier",
                 "awb": sub.tracking_number, "seller": seller.display_name if seller else ""},
                link=f"/orders/{order.id}",
            )
    elif dst == "delivered":
        sub.delivered_at = now
        # the return windows saved on the items when the order was placed (a later edit to the listing changes nothing),
        # and the period in which damaged, defective or wrong items are taken back whatever the listing says
        window = (await session.execute(select(func.max(OrderItem.return_window_days)).where(OrderItem.sub_order_id == sub.id))).scalar_one() or 0
        sub.settlement_due_at = now + timedelta(days=max(int(window), (await get_settings(session))["defect_return_days"]))
        sub.settlement_status = "pending"
        await session.flush()
        order = await session.get(Order, sub.order_id)
        await _sync_cod_status(session, order)
        # cash on delivery taken by the seller's own courier is already with the seller: it comes off their payout
        held = await collect_amount(session, sub, order) if order.payment_method == "cod" and sub.shipping_provider == "manual" else 0
        await post_delivery(session, sub, cod_held_by_seller=held)
        await fee_invoices.issue(session, order)  # the marketplace's own invoice for its fees, at the first delivery
        from app.services import loyalty  # points for the delivered package (off unless staff switch loyalty on)
        await loyalty.earn_for_delivery(session, sub, order.user_id)
        from app.services import referral  # both sides' reward on the friend's first delivered package (off unless switched on)
        await referral.reward_on_delivery(session, sub, order.user_id)
        await notify(
            session, "order_delivered", await session.get(User, order.user_id),
            {"order_number": order.number, "item": await _first_title(session, sub), "return_by": sub.settlement_due_at.astimezone(IST).strftime("%d %b %Y")},
            link=f"/orders/{order.id}",
        )
    add_event(session, sub.order_id, sub, src, dst, actor, note)


async def collect_amount(session: AsyncSession, sub: SubOrder, order: Order) -> int:
    """What the customer pays when this package is handed over (0 for prepaid orders). The seller's part is the package
    total less any discount the marketplace funded; the marketplace's fees and the tip ride with the first live
    package (lowest number), so they are collected once."""
    if order.payment_method != "cod":
        return 0
    amount = sub.total - sub.platform_discount
    if order.fees_total or order.tip_paise:
        first = (await session.execute(select(SubOrder.id).where(SubOrder.order_id == order.id, SubOrder.status != "cancelled")
                                       .order_by(SubOrder.number).limit(1))).scalar_one_or_none()
        if first == sub.id:
            amount += order.fees_total + order.tip_paise
    return amount


def refund_on_cancel(sub: SubOrder, order: Order, *, others_live: int, fees_back: bool) -> int:
    """What cancelling this package gives back to a customer who paid online: the package's share (less what the
    marketplace's coupon paid), plus, when no other package of the order is left, the tip (it was for a delivery that
    will not happen) and the marketplace's fees when Admin → Checkout and fees says they are refunded."""
    amount = sub.total - sub.platform_discount
    if others_live == 0:
        amount += order.tip_paise + (order.fees_total if fees_back else 0)
    return amount


async def _sync_cod_status(session: AsyncSession, order: Order) -> None:
    """A COD order counts as paid once every part that was not cancelled has been delivered."""
    if order.payment_method != "cod":
        return
    statuses = list((await session.execute(select(SubOrder.status).where(SubOrder.order_id == order.id))).scalars())
    live = [st for st in statuses if st != "cancelled"]
    if live and all(st == "delivered" for st in live):
        order.payment_status = "paid"


async def cancel_sub_order(session: AsyncSession, sub: SubOrder, *, actor: str, reason: str) -> Refund | None:
    if not can_transition(sub.status, "cancelled"):
        raise Conflict("This order can no longer be cancelled", "not_cancellable")
    order = (await session.execute(select(Order).where(Order.id == sub.order_id).with_for_update())).scalar_one()
    src = sub.status
    sub.status = "cancelled"
    sub.cancelled_at = utcnow()
    sub.cancelled_by = actor
    sub.cancel_reason = reason[:300]
    sub.settlement_status = "void"
    add_event(session, order.id, sub, src, "cancelled", actor, reason)
    await _release_stock(session, sub)
    if sub.shipping_provider == "fleet":
        from app.services import fleet  # the delivery fleet stops (or returns) a cancelled package

        await fleet.on_cancelled(session, sub, reason)

    refund = None
    others_live = (
        await session.execute(select(func.count()).where(SubOrder.order_id == order.id, SubOrder.status != "cancelled", SubOrder.id != sub.id))
    ).scalar_one()
    fees_back = bool((await fees_svc.get(session))["fees_refund_on_cancel"])
    paid_share = refund_on_cancel(sub, order, others_live=others_live, fees_back=fees_back)
    if others_live == 0 and not fees_back and order.payment_method == "online" and order.payment_status in ("paid", "partially_refunded"):
        await fee_invoices.issue(session, order)  # the marketplace keeps its fees: they are invoiced
    if order.payment_method == "online" and order.payment_status in ("paid", "partially_refunded"):
        payment = (
            await session.execute(select(Payment).where(Payment.order_id == order.id, Payment.status == "captured").order_by(Payment.created_at).limit(1))
        ).scalar_one_or_none()
        if payment is not None:
            refund = Refund(order_id=order.id, payment_id=payment.id, sub_order_id=sub.id, amount_paise=paid_share, reason=reason[:300])
            session.add(refund)
            order.refunded_total += paid_share
            order.payment_status = "refunded" if order.refunded_total >= order.grand_total else "partially_refunded"

    remaining = (
        await session.execute(select(func.count()).where(SubOrder.order_id == order.id, SubOrder.status != "cancelled", SubOrder.id != sub.id))
    ).scalar_one()
    await session.flush()
    await _sync_cod_status(session, order)
    if remaining == 0:
        order.status = "cancelled"
        order.cancelled_at = utcnow()
        if order.payment_method == "online" and order.payment_status == "pending":
            order.payment_status = "failed"
        red = (await session.execute(select(CouponRedemption).where(CouponRedemption.order_id == order.id, CouponRedemption.released.is_(False)))).scalar_one_or_none()
        if red:
            red.released = True
            await session.execute(update(Coupon).where(Coupon.id == red.coupon_id).values(used_count=func.greatest(Coupon.used_count - 1, 0)))
    await session.flush()
    if src != "pending_payment":
        item = await _first_title(session, sub)
        refund_text = f"A refund of ₹{paid_share / 100:,.2f} has been started." if refund else ("Nothing was charged for it." if order.payment_method == "cod" else "")
        await notify(session, "order_cancelled", await session.get(User, order.user_id),
                     {"order_number": order.number, "item": item, "reason": reason, "refund_text": refund_text}, link=f"/orders/{order.id}")
        if actor != "seller":
            await notify_seller(session, sub.seller_id, "seller_order_cancelled", {"order_number": sub.number, "reason": reason}, link=f"/seller/orders/{sub.id}")
    return refund


async def process_refund(session: AsyncSession, refund_id: uuid.UUID) -> None:
    """Sends one pending refund to Razorpay. Safe to call repeatedly (receipt = our refund id)."""
    refund = (await session.execute(select(Refund).where(Refund.id == refund_id).with_for_update(skip_locked=True))).scalar_one_or_none()
    if refund is None or refund.status != "pending":
        return
    payment = await session.get(Payment, refund.payment_id)
    refund.attempts += 1
    try:
        if payment.provider != "razorpay":
            data = await payment_gateways.refund(session, payment, refund.provider_payment_id or payment.provider_payment_id or "",
                                                 refund_charge(payment, refund.amount_paise), str(refund.id), refund.reason or "Refund")
        else:
            data = await razorpay.refund_payment(refund.provider_payment_id or payment.provider_payment_id or "", refund_charge(payment, refund.amount_paise), str(refund.id),
                                                 {"refund_id": str(refund.id)})
    except razorpay.GatewayError as exc:
        refund.last_error = str(exc)[:500]
        if refund.attempts >= 8:
            refund.status = "failed"  # needs manual attention in the admin panel
        await session.commit()
        return
    refund.provider_refund_id = data.get("id")
    refund.status = "processed" if data.get("status") == "processed" else "pending"
    if refund.status == "pending":
        refund.last_error = ""
    else:
        await notify_refund(session, refund)
    await session.commit()


async def notify_refund(session: AsyncSession, refund: Refund) -> None:
    """Tells the customer a refund has gone through (call once, when it becomes processed)."""
    order = await session.get(Order, refund.order_id)
    if order is None:
        return
    await notify(session, "refund_processed", await session.get(User, order.user_id),
                 {"amount": f"₹{refund.amount_paise / 100:,.2f}", "order_number": order.number}, link=f"/orders/{order.id}")


async def expire_unpaid_orders(session: AsyncSession) -> int:
    """Cancels online orders whose payment window passed — after checking the gateway for a late capture."""
    now = utcnow()
    orders = list(
        (
            await session.execute(
                select(Order).where(Order.status == "pending_payment", Order.payment_expires_at < now).limit(100)
            )
        ).scalars()
    )
    cancelled = 0
    for order in orders:
        payments = list((await session.execute(select(Payment).where(Payment.order_id == order.id))).scalars())
        paid = False
        for pay in payments:
            try:
                # whichever gateway took the payment answers from its own records (Razorpay, Cashfree, PhonePe, PayU, Stripe)
                res = await check_with_gateway(session, pay)
            except Exception as exc:  # noqa: BLE001 - gateway down, not configured, or a mismatch: never cancel blindly
                log.warning("late capture check failed for %s: %s", order.number, exc)
                paid = True
                break
            if res["result"] in ("paid", "already_paid", "already", "refund"):
                paid = True
        if paid:
            await session.commit()
            continue
        subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == order.id))).scalars())
        for sub in subs:
            if sub.status == "pending_payment":
                await cancel_sub_order(session, sub, actor="system", reason="Payment not completed in time")
        await session.commit()
        cancelled += 1
    return cancelled


async def pending_refund_ids(session: AsyncSession) -> list[uuid.UUID]:
    return list((await session.execute(select(Refund.id).where(Refund.status == "pending", Refund.provider_refund_id.is_(None)).limit(50))).scalars())


async def cancel_unconfirmed(session: AsyncSession) -> int:
    cfg = await get_settings(session)
    hours = cfg["auto_cancel_unconfirmed_hours"]
    if not hours:
        return 0
    cutoff = utcnow() - timedelta(hours=hours)
    subs = list(
        (await session.execute(select(SubOrder).where(SubOrder.status == "placed", SubOrder.created_at < cutoff).limit(50).with_for_update(skip_locked=True))).scalars()
    )
    for sub in subs:
        await cancel_sub_order(session, sub, actor="system", reason="The seller did not confirm the order in time")
    await session.commit()
    return len(subs)
