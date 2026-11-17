"""Changes the assistant can propose. Nothing here runs until the staff member presses Confirm.

Flow: the model calls ``propose_action`` → ``prepare()`` checks the permission, finds the record and
writes an ``AssistantAction`` (status ``pending``) with a plain-language summary → the chat shows a
Confirm / Cancel card → ``execute()`` runs the *same admin endpoint function* the admin panel uses, so
validation, side effects (refunds, notifications) and the audit log are identical to doing it by hand.

Pending actions expire after 30 minutes and can only be confirmed by the person they were proposed to.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from fastapi import BackgroundTasks
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import audit
from app.core.errors import ApiError
from app.core.permissions import load_roles, permissions_for
from app.db import utcnow
from app.models import AssistantAction, Coupon, Product, Refund, ReturnRequest, Review, Seller, SubOrder, SupportTicket, User

from .queries import inr, resolve_seller

EXPIRES_AFTER = timedelta(minutes=30)


@dataclass(frozen=True)
class ActionDef:
    kind: str
    label: str
    permission: str
    params: dict[str, str]  # name -> description (for the model)
    required: tuple[str, ...] = ()


ACTIONS: dict[str, ActionDef] = {a.kind: a for a in (
    ActionDef("approve_product", "Approve a listing", "catalog", {"product": "product id or exact title"}, ("product",)),
    ActionDef("reject_product", "Send a listing back to the seller", "catalog", {"product": "product id or exact title", "reason": "what the seller must fix (5+ characters)"}, ("product", "reason")),
    ActionDef("approve_seller", "Approve a seller", "sellers", {"seller": "seller id, store name or GSTIN"}, ("seller",)),
    ActionDef("reject_seller", "Ask a seller to fix their application", "sellers", {"seller": "seller id, store name or GSTIN", "reason": "what to fix"}, ("seller", "reason")),
    ActionDef("suspend_seller", "Suspend a seller", "sellers", {"seller": "seller id, store name or GSTIN", "reason": "why"}, ("seller", "reason")),
    ActionDef("set_seller_commission", "Change a seller's commission", "sellers", {"seller": "seller", "percent": "commission percent, or empty to use category rates"}, ("seller",)),
    ActionDef("cancel_package", "Cancel a package and refund it", "orders", {"package": "package number", "reason": "why (shown to the customer)"}, ("package", "reason")),
    ActionDef("mark_delivered", "Mark a package delivered", "orders", {"package": "package number"}, ("package",)),
    ActionDef("retry_refund", "Retry a failed refund", "refunds", {"refund_id": "refund id"}, ("refund_id",)),
    ActionDef("return_decision", "Decide on a return", "refunds", {"return_number": "return number", "decision": "approve | reject | received | mark_refunded",
                                                                     "note": "note for the customer", "reference": "UPI/bank reference (mark_refunded only)"}, ("return_number", "decision")),
    ActionDef("block_customer", "Block a customer", "customers", {"customer": "mobile, email or customer id", "reason": "why"}, ("customer", "reason")),
    ActionDef("unblock_customer", "Unblock a customer", "customers", {"customer": "mobile, email or customer id"}, ("customer",)),
    ActionDef("create_coupon", "Create a platform coupon", "marketing", {
        "code": "4-30 letters/digits", "kind": "percent | flat", "value": "percent (1-90) or rupees", "min_order_rupees": "minimum order in rupees",
        "max_discount_rupees": "cap for percent coupons", "usage_limit": "total uses", "ends_on": "last day YYYY-MM-DD", "description": "shown to customers"},
        ("code", "kind", "value")),
    ActionDef("set_coupon_active", "Switch a coupon on or off", "marketing", {"code": "coupon code", "active": "true or false"}, ("code", "active")),
    ActionDef("reply_ticket", "Reply to a support ticket", "support", {"ticket": "ticket number", "message": "the reply the customer will read",
                                                                         "status": "open | awaiting_customer | resolved | closed (optional)"}, ("ticket", "message")),
    ActionDef("moderate_review", "Publish or hide a review", "catalog", {"review_id": "review id", "decision": "publish | hide"}, ("review_id", "decision")),
    ActionDef("update_setting", "Change a marketplace setting", "settings", {"key": "setting key from get_settings", "value": "new value (rupees for *_paise keys)"}, ("key", "value")),
    ActionDef("set_announcement", "Change the storefront announcement bar", "marketing", {"text": "announcement text (empty to hide)", "link": "optional link like /search?q=diwali"}, ("text",)),
    ActionDef("run_payouts", "Create payouts for sellers with money due", "payouts", {}),
)}


class ActionError(ValueError):
    pass


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v))
    except ValueError:
        return None


async def _product(session: AsyncSession, ref: str) -> Product:
    pid = _uuid(ref)
    p = await session.get(Product, pid) if pid else None
    if p is None:
        rows = (await session.execute(select(Product).where(func.lower(Product.title) == str(ref).strip().lower()).limit(2))).scalars().all()
        if len(rows) != 1:
            raise ActionError("I could not find exactly one listing with that id or title. Search the catalogue first.")
        p = rows[0]
    return p


async def _seller(session: AsyncSession, ref: str) -> Seller:
    s = await resolve_seller(session, str(ref))
    if s is None:
        raise ActionError("I could not find exactly one seller with that name, GSTIN or id.")
    return s


async def _package(session: AsyncSession, ref: str) -> SubOrder:
    sub = (await session.execute(select(SubOrder).where(func.upper(SubOrder.number) == str(ref).strip().upper()))).scalar_one_or_none()
    if sub is None:
        raise ActionError(f"No package numbered {ref}.")
    return sub


async def _customer(session: AsyncSession, ref: str) -> User:
    ref = str(ref).strip()
    uid = _uuid(ref)
    digits = "".join(c for c in ref if c.isdigit())
    stmt = select(User).where(User.is_admin.is_(False))
    if uid:
        stmt = stmt.where(User.id == uid)
    elif "@" in ref:
        stmt = stmt.where(func.lower(User.email) == ref.lower())
    elif len(digits) >= 10:
        stmt = stmt.where(User.phone == digits[-10:])
    else:
        raise ActionError("Give the customer's mobile number, email or id.")
    u = (await session.execute(stmt)).scalar_one_or_none()
    if u is None:
        raise ActionError("No customer found with that mobile, email or id.")
    return u


def _rupees_to_paise(v: Any, label: str) -> int | None:
    if v in (None, ""):
        return None
    try:
        return round(float(str(v).replace(",", "").replace("₹", "")) * 100)
    except ValueError:
        raise ActionError(f"{label} must be an amount in rupees") from None


async def prepare(session: AsyncSession, user: User, conversation_id: uuid.UUID, kind: str, params: dict[str, Any]) -> AssistantAction:
    """Validates a proposal and stores it as pending. Raises ActionError with a message for the model."""
    spec = ACTIONS.get(kind)
    if spec is None:
        raise ActionError(f"Unknown action. Available: {', '.join(ACTIONS)}")
    await load_roles(session)
    if spec.permission not in permissions_for(user):
        raise ActionError(f"Your role cannot do this ({spec.permission}). Ask an owner to change your role.")
    missing = [p for p in spec.required if params.get(p) in (None, "")]
    if missing:
        raise ActionError(f"Missing: {', '.join(missing)}")
    clean: dict[str, Any] = {}
    details: list[list[str]] = []
    if kind in ("approve_product", "reject_product"):
        p = await _product(session, params["product"])
        if kind == "approve_product" and p.status != "pending":
            raise ActionError(f"This listing is {p.status}, not waiting for review.")
        seller = await session.get(Seller, p.seller_id)
        clean = {"product_id": str(p.id)}
        details = [["Listing", p.title], ["Seller", seller.display_name if seller else ""], ["Status now", p.status]]
        summary = f"{'Approve' if kind == 'approve_product' else 'Send back'} “{p.title}”"
        if kind == "reject_product":
            clean["reason"] = str(params["reason"]).strip()[:1000]
            details.append(["Reason for seller", clean["reason"]])
    elif kind in ("approve_seller", "reject_seller", "suspend_seller", "set_seller_commission"):
        s = await _seller(session, params["seller"])
        clean = {"seller_id": str(s.id)}
        details = [["Seller", s.display_name], ["Legal name", s.legal_name], ["Status now", s.status]]
        verb = {"approve_seller": "Approve", "reject_seller": "Ask to fix", "suspend_seller": "Suspend", "set_seller_commission": "Change commission for"}[kind]
        summary = f"{verb} {s.display_name}"
        if kind in ("reject_seller", "suspend_seller"):
            clean["reason"] = str(params["reason"]).strip()[:1000]
            details.append(["Reason", clean["reason"]])
        if kind == "set_seller_commission":
            pct = params.get("percent")
            clean["bps"] = None if pct in (None, "") else round(float(pct) * 100)
            if clean["bps"] is not None and not 0 <= clean["bps"] <= 5000:
                raise ActionError("Commission must be between 0% and 50%")
            details.append(["New commission", "Category rates" if clean["bps"] is None else f"{clean['bps'] / 100:g}%"])
    elif kind in ("cancel_package", "mark_delivered"):
        sub = await _package(session, params["package"])
        clean = {"sub_id": str(sub.id)}
        details = [["Package", sub.number], ["Status now", sub.status], ["Value", inr(sub.total)]]
        summary = f"{'Cancel' if kind == 'cancel_package' else 'Mark delivered'} package {sub.number}"
        if kind == "cancel_package":
            clean["reason"] = str(params["reason"]).strip()[:1000]
            details.append(["Reason", clean["reason"]])
    elif kind == "retry_refund":
        rid = _uuid(params["refund_id"])
        r = await session.get(Refund, rid) if rid else None
        if r is None:
            raise ActionError("No refund with that id.")
        clean = {"refund_id": str(r.id)}
        details = [["Amount", inr(r.amount_paise)], ["Status now", r.status], ["Attempts", str(r.attempts)]]
        summary = f"Retry refund of {inr(r.amount_paise)}"
    elif kind == "return_decision":
        ret = (await session.execute(select(ReturnRequest).where(func.upper(ReturnRequest.number) == str(params["return_number"]).strip().upper()))).scalar_one_or_none()
        if ret is None:
            raise ActionError("No return with that number.")
        decision = str(params["decision"]).strip()
        if decision not in ("approve", "reject", "received", "mark_refunded"):
            raise ActionError("decision is approve, reject, received or mark_refunded")
        clean = {"return_id": str(ret.id), "decision": decision, "note": str(params.get("note") or "")[:2000], "reference": str(params.get("reference") or "")[:60]}
        details = [["Return", ret.number], ["Status now", ret.status], ["Refund", inr(ret.refund_amount)], ["Decision", decision.replace("_", " ")]]
        summary = f"{decision.replace('_', ' ').capitalize()} return {ret.number}"
    elif kind in ("block_customer", "unblock_customer"):
        u = await _customer(session, params["customer"])
        clean = {"user_id": str(u.id)}
        details = [["Customer", u.name or "—"], ["Mobile", u.phone or "—"], ["Active now", "yes" if u.is_active else "no"]]
        summary = f"{'Block' if kind == 'block_customer' else 'Unblock'} {u.name or u.phone or 'customer'}"
        if kind == "block_customer":
            clean["reason"] = str(params["reason"]).strip()[:1000]
            details.append(["Reason", clean["reason"]])
    elif kind == "create_coupon":
        code = str(params["code"]).strip().upper()
        kind_v = str(params["kind"]).strip().lower()
        if kind_v not in ("percent", "flat"):
            raise ActionError("kind is percent or flat")
        value = float(params["value"])
        clean = {"code": code, "kind": kind_v, "value": int(value) if kind_v == "percent" else round(value * 100),
                 "min_order_paise": _rupees_to_paise(params.get("min_order_rupees"), "Minimum order") or 0,
                 "max_discount_paise": _rupees_to_paise(params.get("max_discount_rupees"), "Maximum discount"),
                 "usage_limit": int(params["usage_limit"]) if params.get("usage_limit") not in (None, "") else None,
                 "ends_on": str(params.get("ends_on") or ""), "description": str(params.get("description") or "")[:200]}
        details = [["Code", code], ["Discount", f"{clean['value']}%" if kind_v == "percent" else inr(clean["value"])],
                   ["Minimum order", inr(clean["min_order_paise"])], ["Cap", inr(clean["max_discount_paise"]) if clean["max_discount_paise"] else "None"],
                   ["Total uses", str(clean["usage_limit"] or "Unlimited")], ["Last day", clean["ends_on"] or "No end date"]]
        summary = f"Create coupon {code}"
    elif kind == "set_coupon_active":
        c = (await session.execute(select(Coupon).where(func.upper(Coupon.code) == str(params["code"]).strip().upper()))).scalar_one_or_none()
        if c is None:
            raise ActionError("No coupon with that code.")
        active = str(params["active"]).strip().lower() in ("true", "1", "yes", "on")
        clean = {"coupon_id": str(c.id), "active": active}
        details = [["Coupon", c.code], ["Now", "on" if c.is_active else "off"], ["After", "on" if active else "off"]]
        summary = f"Switch coupon {c.code} {'on' if active else 'off'}"
    elif kind == "reply_ticket":
        t = (await session.execute(select(SupportTicket).where(func.upper(SupportTicket.number) == str(params["ticket"]).strip().upper()))).scalar_one_or_none()
        if t is None:
            raise ActionError("No ticket with that number.")
        status = params.get("status") or None
        if status and status not in ("open", "awaiting_customer", "resolved", "closed"):
            raise ActionError("status is open, awaiting_customer, resolved or closed")
        clean = {"ticket_id": str(t.id), "message": str(params["message"]).strip()[:5000], "status": status}
        details = [["Ticket", f"{t.number} — {t.subject}"], ["Reply", clean["message"]]] + ([["New status", status]] if status else [])
        summary = f"Reply to ticket {t.number}"
    elif kind == "moderate_review":
        rid = _uuid(params["review_id"])
        r = await session.get(Review, rid) if rid else None
        if r is None:
            raise ActionError("No review with that id.")
        decision = str(params["decision"]).strip()
        if decision not in ("publish", "hide"):
            raise ActionError("decision is publish or hide")
        clean = {"review_id": str(r.id), "decision": decision}
        details = [["Review", f"{r.rating}★ {r.title or r.body[:60]}"], ["Decision", decision]]
        summary = f"{decision.capitalize()} a {r.rating}-star review"
    elif kind == "update_setting":
        from app.services.platform_settings import LIMITS, get_settings

        key = str(params["key"]).strip()
        if key not in LIMITS:
            raise ActionError(f"Unknown setting. Settings: {', '.join(LIMITS)}")
        typ = LIMITS[key][0]
        raw = params["value"]
        if typ is bool:
            value: Any = str(raw).strip().lower() in ("true", "1", "yes", "on")
        elif key.endswith("_paise"):
            value = _rupees_to_paise(raw, key)
        else:
            try:
                value = int(float(str(raw)))
            except ValueError:
                raise ActionError(f"{key} needs a whole number") from None
        from app.services.platform_settings import validate_updates

        try:
            validate_updates({key: value})
        except ValueError as exc:
            raise ActionError(str(exc)) from None
        now_value = (await get_settings(session))[key]
        clean = {"key": key, "value": value}
        show = (lambda v: inr(v)) if key.endswith("_paise") else (lambda v: f"{v / 100:g}%" if key.endswith("_bps") else str(v))
        details = [["Setting", key.replace("_", " ")], ["Now", show(now_value)], ["After", show(value)]]
        summary = f"Change {key.replace('_', ' ')} to {show(value)}"
    elif kind == "set_announcement":
        text = " ".join(str(params.get("text") or "").split())[:160]
        link = str(params.get("link") or "").strip()[:200]
        if link and not (link.startswith("/") and not link.startswith("//")):
            raise ActionError("The link must be a page on this site, starting with /")
        clean = {"text": text, "link": link}
        details = [["Announcement", text or "(hidden)"], ["Link", link or "—"]]
        summary = "Hide the announcement bar" if not text else "Change the announcement bar"
    elif kind == "run_payouts":
        from app.assistant.queries import payouts_overview

        ov = await payouts_overview(session, limit=1)
        clean = {}
        details = [["Sellers with money due", str(len(ov["due_now"]))], ["Total due now", inr(ov["due_now_total"])]]
        summary = "Create payouts for all sellers with money due"
    else:  # pragma: no cover — every ACTIONS key is handled above
        raise ActionError("Not supported")
    act = AssistantAction(conversation_id=conversation_id, user_id=user.id, kind=kind, params=clean, summary=summary[:500],
                          status="pending", result={"details": details}, created_at=utcnow())
    session.add(act)
    await session.flush()
    return act


async def execute(session: AsyncSession, user: User, act: AssistantAction) -> dict[str, Any]:
    """Runs a confirmed action through the admin endpoint it mirrors."""
    from app.routers import admin as admin_r
    from app.routers import admin_extras as extras_r

    if act.user_id != user.id:
        raise ApiError("Only the person who asked can confirm this", "not_yours", 403)
    if act.status != "pending":
        raise ApiError(f"This action is already {act.status}", "action_done", 409)
    if utcnow() - act.created_at > EXPIRES_AFTER:
        act.status = "expired"
        await session.commit()
        raise ApiError("This suggestion expired. Ask again to get a fresh one.", "action_expired", 409)
    spec = ACTIONS[act.kind]
    await load_roles(session)
    if spec.permission not in permissions_for(user):
        raise ApiError(f"Your role no longer allows this ({spec.permission})", "forbidden", 403)
    p = act.params
    bg = BackgroundTasks()
    out: Any = None
    k = act.kind
    if k == "approve_product":
        out = await admin_r.approve_product(uuid.UUID(p["product_id"]), user, session)
    elif k == "reject_product":
        out = await admin_r.reject_product(uuid.UUID(p["product_id"]), admin_r.ReasonIn(reason=p["reason"]), user, session)
    elif k == "approve_seller":
        out = await admin_r.approve_seller(uuid.UUID(p["seller_id"]), user, session)
    elif k == "reject_seller":
        out = await admin_r.reject_seller(uuid.UUID(p["seller_id"]), admin_r.ReasonIn(reason=p["reason"]), user, session)
    elif k == "suspend_seller":
        out = await admin_r.suspend_seller(uuid.UUID(p["seller_id"]), admin_r.ReasonIn(reason=p["reason"]), user, session)
    elif k == "set_seller_commission":
        out = await admin_r.seller_commission(uuid.UUID(p["seller_id"]), admin_r.CommissionIn(commission_bps_override=p["bps"]), user, session)
    elif k == "cancel_package":
        out = await admin_r.admin_cancel(uuid.UUID(p["sub_id"]), admin_r.ReasonIn(reason=p["reason"]), user, session, bg)
    elif k == "mark_delivered":
        out = await admin_r.admin_deliver(uuid.UUID(p["sub_id"]), user, session)
    elif k == "retry_refund":
        out = await admin_r.retry_refund(uuid.UUID(p["refund_id"]), user, session, bg)
    elif k == "return_decision":
        out = await extras_r.admin_return_action(uuid.UUID(p["return_id"]), extras_r.AdminReturnAction(action=p["decision"], note=p["note"], reference=p["reference"]), user, session, bg)
    elif k == "block_customer":
        out = await admin_r.block_user(uuid.UUID(p["user_id"]), admin_r.ReasonIn(reason=p["reason"]), user, session)
    elif k == "unblock_customer":
        out = await admin_r.unblock_user(uuid.UUID(p["user_id"]), user, session)
    elif k == "create_coupon":
        from datetime import datetime, time

        from app.services.reports import IST

        ends = datetime.combine(datetime.fromisoformat(p["ends_on"]).date(), time(23, 59, 59), IST) if p.get("ends_on") else None
        body = extras_r.AdminCouponIn(code=p["code"], kind=p["kind"], value=p["value"], min_order_paise=p["min_order_paise"], max_discount_paise=p["max_discount_paise"],
                                      usage_limit=p["usage_limit"], ends_at=ends, description=p["description"])
        out = await extras_r.create_coupon(body, user, session)
    elif k == "set_coupon_active":
        c = await session.get(Coupon, uuid.UUID(p["coupon_id"]))
        c.is_active = bool(p["active"])
        audit(session, user, "coupon.update", "coupon", c.code, f"active={c.is_active} (assistant)")
        await session.commit()
        out = {"code": c.code, "is_active": c.is_active}
    elif k == "reply_ticket":
        out = await extras_r.staff_reply(uuid.UUID(p["ticket_id"]), extras_r.StaffReply(body=p["message"], status=p.get("status")), user, session)
    elif k == "moderate_review":
        out = await extras_r.moderate_review(uuid.UUID(p["review_id"]), p["decision"], user, session)
    elif k == "update_setting":
        out = await admin_r.write_settings({p["key"]: p["value"]}, user, session)
    elif k == "set_announcement":
        from app.services.cms import get_site, save_site

        site = await get_site(session)
        site["announcement"] = {**site["announcement"], "enabled": bool(p["text"]), "text": p["text"] or site["announcement"].get("text", ""), "link": p["link"]}
        await save_site(session, site)
        audit(session, user, "storefront.announcement", "settings", "site", "assistant")
        await session.commit()
        out = {"ok": True}
    elif k == "run_payouts":
        out = await extras_r.run_payouts(user, session)
    await bg()  # refunds and other follow-up work, same as the endpoint's background tasks
    return out if isinstance(out, dict) else {"ok": True}
