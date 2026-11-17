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
from app.integrations import get as get_integrations
from app.db import utcnow
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
    "low_stock": {
        "inapp": ("Low stock", "{{count}} of your product options have 5 or fewer units left."),
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
    session: AsyncSession, event: str, user: User | None, variables: dict, *, link: str = "", channels: tuple[str, ...] = ("inapp", "email", "sms", "whatsapp")
) -> None:
    if user is None or user.deleted_at is not None:
        return
    from app.services.cms import get_site, public_business

    business = public_business(await get_site(session))
    cfg = await get_integrations(session)
    variables = {"name": user.name or "there", "brand": business["brand"], "link": f"{settings.public_web_url}{link}" if link.startswith("/") else link, **variables}
    now = utcnow()
    for channel in channels:
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
