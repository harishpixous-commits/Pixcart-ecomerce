"""The shop assistant's knowledge: help articles written for customers, published storefront pages, and a
whitelist of public settings (delivery fee, COD, the marketplace fees on the bill, transit days, grievance contact).

Nothing else is readable from here: not the admin assistant's notes, not raw platform settings (which hold
commission, TCS/TDS and payout rules), not staff data.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CmsPage, ShopKbArticle
from app.services.cms import get_site
from app.services.platform_settings import RETURN_REASONS, get_settings

STOP = set("""a an the i me my we our you your is are am was were be to of in on for at by with and or but if so do does did can could
would should will shall please pls plz hi hello hey want need know tell about how what when where which who why this that it its
from as have has had not no yes ok okay sir madam bro na da pa la ah oh enna epdi eppadi ennoda en""".split())


def inr(paise: int) -> str:
    rupees = paise / 100
    return f"₹{rupees:,.0f}" if rupees == int(rupees) else f"₹{rupees:,.2f}"


async def fees_text(session: AsyncSession) -> str:
    """The marketplace's own fees as a shopper would read them (Admin → Checkout and fees), including whether the bad
    weather fee is being charged right now and the late night window. Only what the bill would show."""
    from app.services import fees as fees_svc

    ck = await fees_svc.get(session)
    parts = []
    if ck["handling_enabled"] and ck["handling_paise"]:
        free = f", free on orders of {inr(ck['handling_free_above_paise'])} or more" if ck["handling_free_above_paise"] else ""
        parts.append(f"{ck['handling_label']} {inr(ck['handling_paise'])} per order{free}")
    if ck["small_cart_enabled"] and ck["small_cart_paise"]:
        parts.append(f"{ck['small_cart_label']} {inr(ck['small_cart_paise'])} when the item total is below {inr(ck['small_cart_below_paise'])}")
    if ck["platform_enabled"] and ck["platform_paise"]:
        parts.append(f"{ck['platform_label']} {inr(ck['platform_paise'])} per order")
    if fees_svc.surge_active(ck):
        parts.append(f"{ck['surge_label']} {inr(ck['surge_paise'])} per order right now ({ck['surge_info'].rstrip('.')})")
    if ck["late_night_enabled"] and ck["late_night_paise"]:
        parts.append(f"{ck['late_night_label']} {inr(ck['late_night_paise'])} on orders placed between {fees_svc.clock(ck['late_night_from'])} "
                     f"and {fees_svc.clock(ck['late_night_to'])}")
    text = ("Besides delivery, the bill can include: " + "; ".join(parts) + ". These fees include GST.") if parts else \
        "Besides delivery (and the cash on delivery fee, if any), there are no extra fees on your order."
    if ck["tip_enabled"]:
        text += " You can add a tip for the delivery partner at checkout; it goes to them in full."
    return text + " Every charge is shown on the bill before you pay; tap a fee's name to read why it applies."


async def public_facts(session: AsyncSession) -> dict[str, Any]:
    """Customer-facing facts only. Add a key here deliberately; never pass the settings dict through."""
    cfg = await get_settings(session)
    site = await get_site(session)
    g = (site.get("business") or {}).get("grievance") or {}
    cod = (f"Cash on delivery is available on orders up to {inr(cfg['cod_max_order_paise'])}"
           + (f" (COD fee {inr(cfg['cod_fee_paise'])})" if cfg["cod_fee_paise"] else "") + ". Pay the courier in cash or by UPI when the package arrives."
           if cfg["cod_enabled"] else "Cash on delivery is not available right now; please pay online with UPI, card or net banking.")
    contact = ", ".join(x for x in (g.get("email"), g.get("phone")) if x)
    grievance = (f"Our Grievance Officer is {g.get('name') or 'the Grievance Officer'}" + (f" ({contact})" if contact else "")
                 + (f", available {g['hours']}" if g.get("hours") else "") + ". Complaints are acknowledged within 48 hours and resolved within one month. "
                 "You can also raise a grievance from the Support page.")
    return {
        "brand": site.get("brand_name") or "our store",
        "shipping_fee": inr(cfg["shipping_fee_paise"]),
        "free_delivery_amount": inr(cfg["free_shipping_threshold_paise"]),
        "cod_enabled": bool(cfg["cod_enabled"]),
        "cod_text": cod,
        "fees_text": await fees_text(session),
        "transit_same_city": cfg["transit_days_same_city"],
        "transit_same_state": cfg["transit_days_same_state"],
        "transit_national": cfg["transit_days_national"],
        "returns_enabled": bool(cfg["feature_returns"]),
        "support_enabled": bool(cfg["feature_support"]),
        "coupons_enabled": bool(cfg["feature_coupons"]),
        "return_reasons": list(RETURN_REASONS.values()),
        "grievance_text": grievance,
    }


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def render(text: str, facts: dict[str, Any]) -> str:
    return text.format_map(_Safe({k: v for k, v in facts.items() if isinstance(v, str | int)}))


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    return re.sub(r"[^\w\s₹]+", " ", text).strip()


def tokens(text: str) -> list[str]:
    return [t for t in normalize(text).split() if t not in STOP and len(t) > 1]


SEEDED_KEY = "shop_assistant_kb_seeded"
STARTER_VERSION = 2
NEW_IN_VERSION = {2: ("Fees on your bill",)}  # starter articles added later reach knowledge bases seeded earlier, once


async def ensure_starter(session: AsyncSession) -> None:
    """Adds the starter articles once, to an empty knowledge base, and articles added to the starter set later once to
    knowledge bases seeded before. Deleting them afterwards does not bring them back."""
    from app.db import SessionLocal, utcnow
    from app.models import PlatformSetting

    from .starter import STARTER

    row = await session.get(PlatformSetting, SEEDED_KEY)
    if row is not None and int((row.value or {}).get("version", 1)) >= STARTER_VERSION:
        return
    async with SessionLocal() as s:  # its own transaction: never commits the caller's pending work
        seeded = (await s.execute(select(PlatformSetting).where(PlatformSetting.key == SEEDED_KEY).with_for_update())).scalar_one_or_none()
        done = int((seeded.value or {}).get("version", 1)) if seeded else 0
        if done >= STARTER_VERSION:
            return
        if seeded is None:
            if (await s.execute(select(ShopKbArticle.id).limit(1))).first() is None:
                for i, (topic, title, link, body, kw) in enumerate(STARTER):
                    s.add(ShopKbArticle(title=title, body=body, keywords=kw, topic=topic, link=link, is_published=True, position=i, uses=0))
            s.add(PlatformSetting(key=SEEDED_KEY, value={"at": utcnow().isoformat(), "version": STARTER_VERSION}, updated_at=utcnow()))
        else:
            titles = {t for v in range(done + 1, STARTER_VERSION + 1) for t in NEW_IN_VERSION.get(v, ())}
            have = set((await s.execute(select(ShopKbArticle.title).where(ShopKbArticle.title.in_(titles)))).scalars()) if titles else set()
            last = (await s.execute(select(ShopKbArticle.position).order_by(ShopKbArticle.position.desc()).limit(1))).scalar_one_or_none() or 0
            for topic, title, link, body, kw in STARTER:
                if title in titles and title not in have:
                    last += 1
                    s.add(ShopKbArticle(title=title, body=body, keywords=kw, topic=topic, link=link, is_published=True, position=last, uses=0))
            seeded.value = {**(seeded.value or {}), "version": STARTER_VERSION}
            seeded.updated_at = utcnow()
        try:
            await s.commit()
        except Exception:  # noqa: BLE001 — another request seeded at the same moment
            await s.rollback()


@dataclass
class Hit:
    id: str
    title: str
    body: str
    link: str
    source: str  # article | page
    score: float


async def search(session: AsyncSession, query: str, *, limit: int = 3, min_score: float = 2.0) -> list[Hit]:
    q_norm = f" {normalize(query)} "
    q_tokens = set(tokens(query))
    if not q_tokens and not q_norm.strip():
        return []
    await ensure_starter(session)
    facts = await public_facts(session)
    arts = list((await session.execute(select(ShopKbArticle).where(ShopKbArticle.is_published.is_(True)).order_by(ShopKbArticle.position))).scalars())
    pages = list((await session.execute(select(CmsPage).where(CmsPage.is_published.is_(True)))).scalars())
    hits: list[Hit] = []
    for a in arts:
        score = 0.0
        for kw in a.keywords or []:
            k = normalize(str(kw))
            if k and f" {k} " in q_norm:
                score += 3 + 0.5 * (len(k.split()) - 1)
        title_t = set(tokens(render(a.title, facts)))
        score += 1.5 * len(q_tokens & title_t)
        score += min(1.5, 0.3 * len(q_tokens & set(tokens(a.body))))
        if score:
            hits.append(Hit(str(a.id), render(a.title, facts), render(a.body, facts), a.link, "article", score))
    for p in pages:
        title_t = set(tokens(p.title))
        score = 1.5 * len(q_tokens & title_t) + min(1.0, 0.2 * len(q_tokens & set(tokens(p.body))))
        if score:
            hits.append(Hit(f"page:{p.slug}", p.title, p.body[:1200], f"/pages/{p.slug}", "page", score))
    hits.sort(key=lambda h: (-h.score, h.source != "article"))
    return [h for h in hits if h.score >= min_score][:limit]


async def count_use(session: AsyncSession, hit_ids: list[str]) -> None:
    import uuid as _uuid

    ids = []
    for h in hit_ids:
        try:
            ids.append(_uuid.UUID(h))
        except ValueError:
            continue
    if ids:
        await session.execute(update(ShopKbArticle).where(ShopKbArticle.id.in_(ids)).values(uses=ShopKbArticle.uses + 1))
