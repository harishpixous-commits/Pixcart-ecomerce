"""Notifications: an outbox table plus a dispatcher job.

Business code calls ``notify(...)`` inside its own transaction, so a message is recorded if and only if
the change it describes commits. The dispatcher sends pending email/SMS/WhatsApp rows with retries.
Templates live in the database and are editable in the admin panel; the defaults below are used until
an admin changes them. Variables use {{name}} placeholders.
"""
from __future__ import annotations

import asyncio
import logging
import re
import smtplib
import uuid
from email.message import EmailMessage
from email.utils import formataddr

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, settings
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import Notification, NotificationTemplate, Seller, User

log = logging.getLogger("pixcart.notify")

EVENTS: dict[str, dict[str, tuple[str, str]]] = {
    "order_placed": {
        "inapp": ("Order placed", "Your order {{order_number}} for {{amount}} is placed."),
        "email": ("Your {{brand}} order {{order_number}} is placed", "Hi {{name}},\n\nThank you for shopping on {{brand}}. Your order {{order_number}} for {{amount}} is placed. We will tell you when each package ships.\n\nTrack it here: {{link}}"),
        "sms": ("", "Your {{brand}} order {{order_number}} for {{amount}} is placed."),
    },
    "order_shipped": {
        "inapp": ("Package shipped", "{{item}} has shipped with {{courier}}, tracking {{awb}}."),
        "email": ("Your package from {{seller}} has shipped", "Hi {{name}},\n\n{{item}} has shipped with {{courier}} (tracking {{awb}}).\n\nTrack it here: {{link}}"),
        "sms": ("", "Your {{brand}} package {{order_number}} has shipped with {{courier}}, AWB {{awb}}."),
    },
    "order_delivered": {
        "inapp": ("Delivered", "{{item}} was delivered. Tell others what you think by writing a review."),
        "email": ("Delivered: {{item}}", "Hi {{name}},\n\nYour package was delivered. If something is wrong, you can request a return until {{return_by}}.\n\n{{link}}"),
    },
    "abandoned_cart": {
        "inapp": ("You left something in your cart", "{{item}}{{more}} is still waiting in your cart ({{amount}}).{{offer}}"),
        "email": ("{{item}} is still in your {{brand}} cart", "Hi {{name}},\n\n{{item}}{{more}} is still waiting in your cart ({{amount}}).{{offer}}\n\nFinish your order: {{link}}"),
    },
    "saved_search_match": {
        "inapp": ("New for your search: {{query}}", "{{item}}{{more}} just arrived."),
    },
    "seller_ship_reminder": {
        "inapp": ("Order {{order_number}} is waiting to ship", "You confirmed it {{hours}} hours ago. Ship it and add the tracking number so the customer is not left waiting."),
        "email": ("Order {{order_number}} is waiting to ship", "Hi {{name}},\n\nYou confirmed order {{order_number}} {{hours}} hours ago and it has not shipped yet. Ship it and add the tracking number so the customer is not left waiting.\n\n{{link}}"),
    },
    "order_delay": {
        "inapp": ("Your package is running late", "Package {{order_number}} was due on {{expected}} and has not arrived yet. It is still on its way. You can follow it in your orders."),
        "email": ("Your package {{order_number}} is running late", "Hi {{name}},\n\nPackage {{order_number}} was due on {{expected}} and has not arrived yet. It is still on its way.\n\nFollow it here: {{link}}"),
    },
    "assistant_digest": {
        "inapp": ("Your weekly business digest", "{{digest}}"),
        "email": ("Your weekly business digest", "Hi {{name}},\n\n{{digest}}\n\n{{link}}"),
    },
    "seller_restock": {
        "inapp": ("Restock {{item}}", "{{item}} has {{stock}} left and sold {{sold}} in the last {{days}} days, so it may run out in about {{left}} days. Consider adding about {{suggest}} units."),
        "email": ("Restock {{item}}", "Hi {{name}},\n\n{{item}} has {{stock}} left and sold {{sold}} in the last {{days}} days, so it may run out in about {{left}} days. Consider adding about {{suggest}} units.\n\n{{link}}"),
    },
    "seller_tracking_reminder": {
        "inapp": ("Add tracking for order {{order_number}}", "You marked it shipped {{hours}} hours ago but no tracking number is on it. Add the courier and tracking number so the customer can follow the parcel."),
        "email": ("Add tracking for order {{order_number}}", "Hi {{name}},\n\nOrder {{order_number}} was marked shipped {{hours}} hours ago but has no tracking number. Add the courier and tracking number.\n\n{{link}}"),
    },
    "review_reminder": {
        "inapp": ("How was {{item}}?", "Tell other shoppers what you think. It takes a minute."),
        "email": ("How was {{item}}?", "Hi {{name}},\n\nTell other shoppers what you think of {{item}}. It takes a minute.\n\n{{link}}"),
    },
    "points_expiring": {
        "inapp": ("{{points}} points expire soon", "{{points}} of your loyalty points expire within {{days}} days. Use them at checkout."),
        "email": ("{{points}} points expire soon", "Hi {{name}},\n\n{{points}} of your loyalty points expire within {{days}} days. Use them on your next order.\n\n{{link}}"),
    },
    "gift_card_bought": {
        "email": ("Your {{brand}} gift card", "Hi {{name}},\n\nThank you. Your gift card for {{amount}} is ready.\n\nCode: {{code}}\nValid until {{expires}}\n\nUse it at checkout, or see the balance here: {{link}}"),
    },
    "gift_card_refunded": {
        "inapp": ("Gift card refunded", "Your gift card purchase of {{amount}} was refunded (reference {{reference}})."),
        "email": ("Your gift card was refunded", "Hi {{name}},\n\nYour gift card purchase of {{amount}} was refunded. Payment reference: {{reference}}.\n\nThe card can no longer be used."),
    },
    "marketing_message": {
        "inapp": ("{{title}}", "{{message}}"),
    },
    "order_cancelled": {
        "inapp": ("Order cancelled", "{{item}} was cancelled: {{reason}}."),
        "email": ("Cancelled: part of order {{order_number}}", "Hi {{name}},\n\n{{item}} was cancelled ({{reason}}). {{refund_text}}\n\n{{link}}"),
        "sms": ("", "Part of your {{brand}} order {{order_number}} was cancelled. {{refund_text}}"),
    },
    "refund_processed": {
        "inapp": ("Refund started", "We have refunded {{amount}} for order {{order_number}}. It reaches your account in 5 to 7 working days."),
        "email": ("Refund of {{amount}} started", "Hi {{name}},\n\nWe have refunded {{amount}} for order {{order_number}}. It reaches your original payment method in 5 to 7 working days."),
    },
    "return_update": {
        "inapp": ("Return {{return_number}}: {{status}}", "{{message}}"),
        "email": ("Your return {{return_number}}: {{status}}", "Hi {{name}},\n\n{{message}}\n\n{{link}}"),
    },
    "ticket_reply": {
        "inapp": ("Reply on ticket {{ticket_number}}", "Our team replied to your request: {{subject}}."),
        "email": ("Reply on your request {{ticket_number}}", "Hi {{name}},\n\nWe replied to your request \"{{subject}}\".\n\n{{link}}"),
    },
    "seller_new_order": {
        "inapp": ("New order {{order_number}}", "{{items}} for {{amount}}. Confirm it from your orders page."),
        "email": ("New order {{order_number}} on {{brand}}", "You have a new order {{order_number}} ({{items}}) for {{amount}}. Please confirm and ship it within {{dispatch_days}} days.\n\n{{link}}"),
        "sms": ("", "New {{brand}} order {{order_number}} for {{amount}}. Please confirm and ship on time."),
    },
    "seller_order_cancelled": {
        "inapp": ("Order {{order_number}} cancelled", "The customer cancelled {{order_number}}. Do not ship it."),
        "email": ("Do not ship: order {{order_number}} cancelled", "Order {{order_number}} was cancelled ({{reason}}). Do not ship it.\n\n{{link}}"),
    },
    "seller_return_requested": {
        "inapp": ("Return requested on {{order_number}}", "Reason: {{reason}}. Review it from your returns page."),
        "email": ("Return requested on {{order_number}}", "A customer asked to return items from {{order_number}}. Reason: {{reason}}.\n\n{{link}}"),
    },
    "seller_kyc_update": {
        "inapp": ("Seller account {{status}}", "{{message}}"),
        "email": ("Your {{brand}} seller account: {{status}}", "{{message}}\n\n{{link}}"),
    },
    "listing_update": {
        "inapp": ("Listing {{status}}", "{{title}}: {{message}}"),
        "email": ("Your listing was {{status}}", "{{title}}\n\n{{message}}\n\n{{link}}"),
    },
    "payout_sent": {
        "inapp": ("Payout {{payout_number}} sent", "{{amount}} was sent to your bank account ending {{last4}}. UTR {{utr}}."),
        "email": ("Payout of {{amount}} sent", "We have sent {{amount}} to your bank account ending {{last4}} (UTR {{utr}}).\n\n{{link}}"),
    },
    "staff_message": {
        "inapp": ("{{subject}}", "{{message}}"),
        "email": ("{{subject}}", "Hi {{name}},\n\n{{message}}\n\n{{link}}"),
    },
    "security_notice": {
        "inapp": ("Security notice: {{what}}", "{{message}} If this was not you or someone you asked, contact {{brand}} support at once."),
        "email": ("Security notice from {{brand}}: {{what}}",
                  "Hi {{name}},\n\n{{message}}\n\nIf this was not you or someone you asked, contact {{brand}} support at once so we can secure your account."),
        "sms": ("", "{{brand}} security notice: {{what}}. Not you? Contact support at once."),
    },
    "product_live": {
        "inapp": ("Your product is live", "{{item}} is now live in the shop."),
    },
    "low_stock": {
        "inapp": ("Low stock", "{{count}} of your product options have {{threshold}} or fewer units left."),
    },
    "back_in_stock": {
        "inapp": ("Back in stock", "{{item}} is available again. Order before it sells out."),
        "email": ("Back in stock: {{item}}", "Hi {{name}},\n\n{{item}} is back in stock at {{price}}. Stocks can run out again, so order soon.\n\n{{link}}"),
    },
    "price_drop": {
        "inapp": ("Price dropped", "{{item}} in your wishlist is now {{price}} (was {{old_price}})."),
        "email": ("Price drop: {{item}} is now {{price}}", "Hi {{name}},\n\n{{item}}, which you saved, is now {{price}} (it was {{old_price}} when you saved it).\n\n{{link}}"),
    },
    "question_answered": {
        "inapp": ("Your question was answered", "{{answerer}} answered your question about {{item}}."),
        "email": ("Answer to your question about {{item}}", "Hi {{name}},\n\nYou asked: {{question}}\n\n{{answerer}} answered: {{answer}}\n\n{{link}}"),
    },
    "seller_new_question": {
        "inapp": ("New customer question", "A shopper asked about {{item}}: {{question}}"),
        "email": ("A shopper asked about {{item}}", "A shopper asked: {{question}}\n\nAnswer it from your seller hub so others see it too.\n\n{{link}}"),
    },
    # ---- own delivery fleet
    "delivery_kyc_update": {
        "inapp": ("Delivery partner account {{status}}", "{{message}}"),
        "sms": ("", "{{brand}} delivery partner account {{status}}. {{message}}"),
    },
    "delivery_new_offer": {
        "inapp": ("New delivery request", "Pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}. {{fee}}{{cod}}. Accept within {{seconds}} seconds."),
    },
    "delivery_assigned": {
        "inapp": ("Delivery assigned to you", "{{order_number}}: pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}."),
    },
    "delivery_trip_cancelled": {
        "inapp": ("Delivery cancelled: {{order_number}}", "{{message}}"),
    },
    "delivery_partner_assigned": {  # customer
        "inapp": ("Delivery partner assigned", "{{partner}} will deliver {{item}}. You can track the delivery on your order page."),
    },
    "seller_pickup_assigned": {
        "inapp": ("Pickup assigned: {{order_number}}", "{{partner}} ({{vehicle}}) will pick up {{order_number}}. Give the package against pickup code {{code}}."),
    },
    "delivery_out_for_delivery": {
        "inapp": ("Out for delivery", "{{item}} is on the way with {{partner}}. Share OTP {{otp}} only when you receive the package."),
        "sms": ("", "{{brand}}: {{item}} is out for delivery with {{partner}}. Share OTP {{otp}} only when you receive it."),
        "email": ("Out for delivery: {{item}}", "Hi {{name}},\n\n{{item}} is on the way with {{partner}}.\n\nYour delivery OTP is {{otp}}. Share it only when you have the package in your hands.\n\nTrack it here: {{link}}"),
    },
    "delivery_arriving": {
        "inapp": ("Your delivery partner has arrived", "{{partner}} is at your address with {{item}}. Keep OTP {{otp}} ready."),
    },
    "seller_package_delivered": {
        "inapp": ("Delivered: {{order_number}}", "{{partner}} delivered {{order_number}} to the customer."),
    },
    "delivery_rate": {
        "inapp": ("How was your delivery?", "Rate {{partner}}'s delivery of {{item}}. It takes a second."),
    },
    "delivery_failed": {
        "inapp": ("Delivery attempt failed", "We could not deliver {{item}}: {{reason}}. We will try again or contact you."),
        "sms": ("", "{{brand}}: we could not deliver {{item}} ({{reason}}). We will contact you."),
    },
    "delivery_payout_paid": {
        "inapp": ("Payout {{amount}} paid", "Your earnings for {{period}} were paid. Reference {{reference}}."),
        "sms": ("", "{{brand}}: your delivery earnings {{amount}} for {{period}} were paid. Ref {{reference}}."),
    },
    "staff_delivery_kyc": {
        "inapp": ("Delivery partner to verify", "{{name}} ({{city}}) submitted documents. Check them in Delivery → Partners."),
    },
    "staff_delivery_bank": {
        "inapp": ("Partner payout details changed", "{{name}} ({{phone}}) changed their bank or UPI details. Check them before the next payout."),
    },
    "staff_delivery_unassigned": {
        "inapp": ("No delivery partner took {{order_number}}", "{{reason}} Assign it by hand in Delivery → Queue."),
    },
    "staff_review": {
        "inapp": ("{{subject}}", "{{message}}"),
    },
    "staff_ticket": {
        "inapp": ("{{subject}}", "{{message}}"),
    },
    "staff_delivery_stuck": {
        "inapp": ("Delivery stuck: {{order_number}}", "It has been '{{status}}' for {{minutes}} minutes with {{partner}}."),
    },
    "staff_delivery_ready": {
        "inapp": ("Ready for pickup: {{order_number}}", "{{store}} has a package ready for pickup ({{pickup_area}} to {{drop_area}}). Assign a partner in Delivery → Queue."),
    },
    "staff_delivery_failed": {
        "inapp": ("Delivery failed: {{order_number}}", "{{partner}} could not deliver: {{reason}}. Choose to try again or return it to the seller."),
    },
    "seller_package_returned": {
        "inapp": ("Package returned: {{order_number}}", "{{partner}} returned {{order_number}} to your store ({{reason}}). The stock is back in your inventory."),
    },
    # returns collected by the own delivery fleet
    "delivery_new_return_pickup": {  # partner
        "inapp": ("New return pickup", "Collect a return from a customer in {{drop_area}} and bring it to {{store}} ({{pickup_area}}). {{fee}}. Accept within {{seconds}} seconds."),
    },
    "delivery_return_pickup_assigned": {  # partner
        "inapp": ("Return pickup assigned to you", "{{order_number}}: collect the return from a customer in {{drop_area}} and bring it to {{store}}."),
    },
    "return_pickup_scheduled": {  # customer
        "inapp": ("Return pickup on the way", "{{partner}} will collect your return {{return_number}}. Keep the item packed and give pickup code {{code}} when you hand it over."),
        "sms": ("", "{{brand}}: {{partner}} will collect your return {{return_number}}. Pickup code {{code}}."),
    },
    "return_pickup_failed": {  # customer
        "inapp": ("Return pickup missed: {{return_number}}", "We could not collect your return ({{reason}}). We will arrange another pickup."),
    },
    "seller_return_arriving": {
        "inapp": ("Return on its way: {{return_number}}", "{{partner}} collected return {{return_number}} ({{order_number}}) and is bringing it to you. Give pickup code {{code}} when you receive it."),
    },
    "seller_return_delivered": {
        "inapp": ("Return delivered: {{return_number}}", "{{partner}} brought return {{return_number}} to your store. Check the item, then mark it received to refund the customer."),
    },
}

_VAR = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def render(text: str, variables: dict) -> str:
    return _VAR.sub(lambda m: str(variables.get(m.group(1), "")), text)


async def _template(session: AsyncSession, event: str, channel: str) -> tuple[str, str, str, bool] | None:
    row = (
        await session.execute(select(NotificationTemplate).where(NotificationTemplate.event == event, NotificationTemplate.channel == channel))
    ).scalar_one_or_none()
    if row is not None:
        return row.subject, row.body, row.provider_template, row.is_active
    default = EVENTS.get(event, {}).get(channel)
    if default is None:
        return None
    return default[0], default[1], "", True


async def notify(
    session: AsyncSession, event: str, user: User | None, variables: dict, *, link: str = "",
    channels: tuple[str, ...] = ("inapp", "push", "email", "sms", "whatsapp"),
) -> None:
    """Sends one event to a user on each channel that has an active template. "push" reaches the phones and browsers
    where the user turned notifications on (nothing happens until Firebase is set up in Admin → Integrations)."""
    if user is None or user.deleted_at is not None:
        return
    from app.services.cms import get_site, public_business

    business = public_business(await get_site(session))
    cfg = await get_integrations(session)
    variables = {"name": user.name or "there", "brand": business["brand"], "link": f"{settings.public_web_url}{link}" if link.startswith("/") else link, **variables}
    now = utcnow()
    for channel in channels:
        if channel == "push":
            # the in-app text, sent to the user's phones and browsers after this transaction commits
            from app.services import push

            tpl = await _template(session, event, "push") or await _template(session, event, "inapp")
            if tpl is None or not tpl[3] or not push.configured(cfg):
                continue
            push.queue(session, user.id, render(tpl[0], variables)[:120], render(tpl[1], variables)[:400], link,
                       {"event": event, **({"urgent": "1"} if event in ("delivery_new_offer", "delivery_new_return_pickup") else {})})
            continue
        tpl = await _template(session, event, channel)
        if tpl is None:
            continue
        subject, body, provider_template, active = tpl
        if not active:
            continue
        recipient = ""
        if channel == "email":
            if not user.email or not cfg.smtp_host:
                continue
            recipient = user.email
        elif channel == "sms":
            if not user.phone or cfg.sms_provider != "msg91" or not provider_template:
                continue
            recipient = user.phone
        elif channel == "whatsapp":
            if not user.phone or not cfg.whatsapp_token or not provider_template:
                continue
            recipient = user.phone
        session.add(
            Notification(
                user_id=user.id,
                event=event,
                channel=channel,
                recipient=recipient,
                subject=render(subject, variables)[:200],
                body=render(body, variables) + (_email_footer(business) if channel == "email" else ""),
                link=link[:300],
                variables={k: str(v) for k, v in variables.items()} | ({"_template": provider_template} if provider_template else {}),
                status="sent" if channel == "inapp" else "pending",
                sent_at=now if channel == "inapp" else None,
                created_at=now,
            )
        )


async def notify_seller(session: AsyncSession, seller_id: uuid.UUID, event: str, variables: dict, *, link: str = "") -> None:
    seller = await session.get(Seller, seller_id)
    if seller is None:
        return
    user = await session.get(User, seller.user_id)
    await notify(session, event, user, variables, link=link)


async def notify_staff(session: AsyncSession, permission: str, event: str, variables: dict, *, link: str = "") -> int:
    """Tells every active staff member whose role has ``permission`` (in-app). Returns how many were told."""
    from app.core.permissions import load_roles, permissions_for

    await load_roles(session)
    staff = (await session.execute(select(User).where(User.is_admin.is_(True), User.is_active.is_(True), User.deleted_at.is_(None)))).scalars().all()
    told = 0
    for u in staff:
        if permission in permissions_for(u):
            await notify(session, event, u, variables, link=link, channels=("inapp", "push"))
            told += 1
    return told


# ----------------------------------------------------------------------------- providers


def _email_footer(b: dict) -> str:
    """Who is writing and how to reach them, under every email (taken from Admin → Storefront → Business)."""
    lines = [b["legal_name"], b["registered_address"]]
    contact = ", ".join(x for x in (b["support_email"], b["support_phone"]) if x)
    if contact:
        lines.append(f"Customer care: {contact}")
    if b["grievance"]["email"]:
        lines.append(f"Grievance officer: {b['grievance']['name']}, {b['grievance']['email']}".replace(" , ", " "))
    return "\n\n--\n" + "\n".join(x for x in lines if x)


def _send_email_sync(cfg: Settings, to: str, subject: str, body: str, from_name: str) -> None:
    msg = EmailMessage()
    sender = cfg.smtp_from or cfg.smtp_user
    # A configured "Name <address>" wins; a bare address gets the storefront's brand name.
    msg["From"] = sender if "<" in sender else formataddr((from_name, sender))
    msg["To"] = to
    msg["Subject"] = " ".join(subject.split())  # no header injection through line breaks
    msg.set_content(body)
    server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=20) if cfg.smtp_security == "ssl" else smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=20)
    with server as s:
        if cfg.smtp_security == "starttls":
            s.starttls()
        if cfg.smtp_user:
            s.login(cfg.smtp_user, cfg.smtp_password)
        s.send_message(msg)


async def _send_sms(cfg: Settings, n: Notification) -> None:
    # MSG91 Flow API: the template (flow) must be DLT-approved; variables are passed by name.
    variables = {k: v for k, v in n.variables.items() if not k.startswith("_")}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{cfg.msg91_api_base}/api/v5/flow",
            headers={"authkey": cfg.msg91_auth_key, "accept": "application/json", "content-type": "application/json"},
            json={"template_id": n.variables["_template"], "recipients": [{"mobiles": f"91{n.recipient}", **variables}]},
        )
    if r.status_code >= 400 or r.json().get("type") == "error":
        raise RuntimeError(f"MSG91 {r.status_code}: {r.text[:200]}")


async def _send_whatsapp(cfg: Settings, n: Notification) -> None:
    # WhatsApp Cloud API template message; body parameters follow the order of "params" in variables.
    params = [p for p in n.variables.get("_params", "").split("|") if p] or [n.body[:1000]]
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{cfg.whatsapp_api_base}/{cfg.whatsapp_api_version}/{cfg.whatsapp_phone_number_id}/messages",
            headers={"Authorization": f"Bearer {cfg.whatsapp_token}"},
            json={
                "messaging_product": "whatsapp",
                "to": f"91{n.recipient}",
                "type": "template",
                "template": {
                    "name": n.variables["_template"],
                    "language": {"code": cfg.whatsapp_language},
                    "components": [{"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}],
                },
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"WhatsApp {r.status_code}: {r.text[:200]}")


async def dispatch_pending(session: AsyncSession, limit: int = 100) -> int:
    rows = list(
        (
            await session.execute(
                select(Notification).where(Notification.status == "pending").order_by(Notification.created_at).limit(limit).with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    sent = 0
    cfg = await get_integrations(session)
    for n in rows:
        n.attempts += 1
        try:
            if n.channel == "email":
                await asyncio.to_thread(_send_email_sync, cfg, n.recipient, n.subject, n.body, n.variables.get("brand", settings.app_name))
            elif n.channel == "sms":
                await _send_sms(cfg, n)
            elif n.channel == "whatsapp":
                await _send_whatsapp(cfg, n)
            n.status, n.sent_at, n.error = "sent", utcnow(), ""
            sent += 1
        except Exception as exc:  # provider errors are recorded and retried
            n.error = str(exc)[:500]
            if n.attempts >= 5:
                n.status = "failed"
            log.warning("notification %s via %s failed: %s", n.id, n.channel, exc)
    await session.commit()
    return sent
