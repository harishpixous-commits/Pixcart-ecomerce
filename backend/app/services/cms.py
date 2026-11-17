"""Storefront customisation: brand and theme, navigation, footer, announcement bar, SEO defaults, and the
home page built from ordered sections. Everything here is edited in Admin → Storefront."""
from __future__ import annotations

import re
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.validators import validate_gstin
from app.db import utcnow
from app.models import HomeSection, PlatformSetting

SITE_KEY = "site"

# Icons the storefront knows how to draw. "custom" uses an image from the media library instead.
SOCIAL_ICONS = ("instagram", "facebook", "x", "youtube", "linkedin", "whatsapp", "telegram", "pinterest", "threads", "website", "custom")
CONTACT_TYPES = ("email", "phone", "whatsapp", "address", "link", "text")
MAX_SOCIAL, MAX_CONTACT = 12, 10


def default_site() -> dict[str, Any]:
    """Defaults for a fresh install. Business and grievance details start from the environment, so an install
    configured through env vars shows correct details before anyone opens the admin panel."""
    brand = settings.app_name
    return {
        "brand_name": brand,
        "tagline": "Shop from verified sellers across India",
        "logo_url": "",
        "favicon_url": "",
        "colors": {"primary": "#0B5563", "primary_dark": "#073B45", "accent": "#F5A524", "buy": "#D7263D", "success": "#1E8E3E", "page": "#EEF2F4"},
        "radius": "rounded",  # rounded | soft | square
        "announcement": {"enabled": True, "text": "Free delivery on orders over {free_delivery_amount} from a seller", "link": "/search?sort=discount", "tone": "accent"},
        "header_links": [{"label": "Become a seller", "href": "/sell"}],
        "footer_columns": [
            {"title": "Help", "links": [{"label": "Track your order", "href": "/orders"}, {"label": "Returns and refunds", "href": "/pages/returns-policy"}, {"label": "Contact us", "href": "/contact"}, {"label": "Grievance redressal", "href": "/help/grievance"}]},
            {"title": "Policies", "links": [{"label": "Terms of use", "href": "/pages/terms"}, {"label": "Privacy policy", "href": "/pages/privacy"}, {"label": "Shipping policy", "href": "/pages/shipping-policy"}]},
            {"title": "Sell", "links": [{"label": "Become a seller", "href": "/sell"}, {"label": "Seller dashboard", "href": "/seller"}]},
        ],
        # Legal and contact details of the marketplace operator (Consumer Protection (E-Commerce) Rules 2020, rule 4).
        "business": {
            "legal_name": settings.platform_legal_name,
            "registered_address": "",
            "gstin": settings.platform_gstin,
            "cin": "",
            "grievance": {
                "name": settings.grievance_officer_name, "designation": "Grievance Officer",
                "email": settings.grievance_officer_email, "phone": settings.grievance_officer_phone, "hours": "Monday to Saturday, 10 am to 6 pm",
            },
        },
        "contact": {"enabled": True, "title": "Contact us", "items": []},
        "social": {"enabled": True, "title": "Follow us", "links": []},
        "footer": {
            "show_business": True, "show_contact": True, "show_social": True, "show_grievance": True, "show_gstin": True,
            "copyright": "© {year} {legal_name}. Products are sold by independent sellers; seller details are shown on every product page.",
        },
        "seo": {"title": f"{brand} — Shop from trusted Indian sellers", "description": "Electronics, fashion, home and everyday essentials from verified sellers across India. Cash on delivery and easy returns."},
        "analytics": {"google_analytics_id": "", "meta_pixel_id": ""},
    }


HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
SAFE_HREF = re.compile(r"^(/(?!/)[A-Za-z0-9\-_/?=&.%#]*|https://[^\s\"'<>]+)$")
HTTPS_URL = re.compile(r"^https://[A-Za-z0-9.\-]+(:\d+)?(/[^\s\"'<>]*)?$")
EMAIL = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}$")
PHONE = re.compile(r"^\+?[0-9][0-9 \-]{6,18}$")
ITEM_ID = re.compile(r"^[a-z0-9]{6,16}$")
CIN = re.compile(r"^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$")
COPYRIGHT_TOKENS = re.compile(r"\{(?!year\}|legal_name\}|brand\})[^}]*\}")


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            out[k] = _merge(base[k], v)
        elif k in base:
            out[k] = v
    return out


def _upgrade(raw: dict) -> dict:
    """Converts settings saved by earlier versions (fixed social/contact fields) to the list-based modules."""
    data = dict(raw or {})
    social = data.get("social")
    if isinstance(social, dict) and "links" not in social:
        data["social"] = {"enabled": True, "title": "Follow us", "links": [
            {"id": secrets.token_hex(4), "icon": k, "label": {"x": "X"}.get(k, k.capitalize()), "url": v, "icon_url": "", "enabled": True}
            for k, v in social.items() if v
        ]}
    contact = data.get("contact")
    if isinstance(contact, dict) and "items" not in contact:
        items = [{"id": secrets.token_hex(4), "type": t, "label": label, "value": contact.get(t, ""), "enabled": True}
                 for t, label in (("email", "Email"), ("phone", "Phone")) if contact.get(t)]
        data["contact"] = {"enabled": True, "title": "Contact us", "items": items}
        if contact.get("address"):
            data.setdefault("business", {})["registered_address"] = contact["address"]
    return data


async def get_site(session: AsyncSession) -> dict:
    row = await session.get(PlatformSetting, SITE_KEY)
    return _merge(default_site(), _upgrade(row.value if row else {}))


def _links(items: Any, limit: int = 12) -> list[dict]:
    out = []
    for it in (items or [])[:limit]:
        label, href = str(it.get("label", "")).strip()[:40], str(it.get("href", "")).strip()[:300]
        if label and SAFE_HREF.match(href):
            out.append({"label": label, "href": href})
    return out


def _text(value: Any, limit: int) -> str:
    # Plain text only: strip control characters; React escapes the rest when rendering.
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(value or "")).strip()[:limit]


def _item_id(value: Any) -> str:
    v = str(value or "")
    return v if ITEM_ID.match(v) else secrets.token_hex(4)


def _social(data: Any) -> dict:
    data = data if isinstance(data, dict) else {}
    links = []
    for it in (data.get("links") or [])[: MAX_SOCIAL + 1]:
        if not isinstance(it, dict):
            continue
        label, url = _text(it.get("label"), 40), str(it.get("url", "")).strip()[:300]
        icon, icon_url = str(it.get("icon", "website")), str(it.get("icon_url", "")).strip()[:400]
        if not label:
            raise ValueError("Every social link needs a name")
        if not HTTPS_URL.match(url):
            raise ValueError(f"The link for {label} must be a full address starting with https://")
        if icon not in SOCIAL_ICONS:
            raise ValueError(f"Choose an icon for {label}")
        if icon == "custom" and not (icon_url and SAFE_HREF.match(icon_url)):
            raise ValueError(f"Upload an icon image for {label} through the media library")
        links.append({"id": _item_id(it.get("id")), "label": label, "url": url, "icon": icon, "icon_url": icon_url if icon == "custom" else "", "enabled": bool(it.get("enabled", True))})
    if len(links) > MAX_SOCIAL:
        raise ValueError(f"Add at most {MAX_SOCIAL} social links")
    return {"enabled": bool(data.get("enabled", True)), "title": _text(data.get("title"), 40), "links": links}


def _contact(data: Any) -> dict:
    data = data if isinstance(data, dict) else {}
    items = []
    for it in (data.get("items") or [])[: MAX_CONTACT + 1]:
        if not isinstance(it, dict):
            continue
        kind, label = str(it.get("type", "")), _text(it.get("label"), 40)
        value = _text(it.get("value"), 300)
        if kind not in CONTACT_TYPES:
            raise ValueError("Choose what kind of contact detail this is")
        if not label or not value:
            raise ValueError("Every contact detail needs a label and a value")
        if kind == "email" and not EMAIL.match(value):
            raise ValueError(f"{label}: enter a valid email address")
        if kind in ("phone", "whatsapp") and not PHONE.match(value):
            raise ValueError(f"{label}: enter a phone number with digits only, e.g. +91 98765 43210")
        if kind == "link" and not SAFE_HREF.match(value):
            raise ValueError(f"{label}: links must start with / or https://")
        items.append({"id": _item_id(it.get("id")), "type": kind, "label": label, "value": value, "enabled": bool(it.get("enabled", True))})
    if len(items) > MAX_CONTACT:
        raise ValueError(f"Add at most {MAX_CONTACT} contact details")
    return {"enabled": bool(data.get("enabled", True)), "title": _text(data.get("title"), 40), "items": items}


def _business(data: dict) -> dict:
    g = data.get("grievance") or {}
    out = {
        "legal_name": _text(data.get("legal_name"), 120),
        "registered_address": _text(data.get("registered_address"), 400),
        "gstin": str(data.get("gstin") or "").strip().upper(),
        "cin": str(data.get("cin") or "").strip().upper(),
        "grievance": {
            "name": _text(g.get("name"), 80), "designation": _text(g.get("designation"), 60),
            "email": str(g.get("email") or "").strip()[:254], "phone": _text(g.get("phone"), 20), "hours": _text(g.get("hours"), 80),
        },
    }
    if out["gstin"]:
        out["gstin"] = validate_gstin(out["gstin"])
    if out["cin"] and not CIN.match(out["cin"]):
        raise ValueError("CIN looks like U12345TN2024PTC123456")
    if out["grievance"]["email"] and not EMAIL.match(out["grievance"]["email"]):
        raise ValueError("Enter a valid grievance officer email")
    if out["grievance"]["phone"] and not PHONE.match(out["grievance"]["phone"]):
        raise ValueError("Enter a valid grievance officer phone number")
    return out


def validate_site(data: dict) -> dict:
    site = _merge(default_site(), _upgrade(data))
    for k, v in site["colors"].items():
        if not HEX.match(str(v)):
            raise ValueError(f"Colour '{k}' must be a hex value like #0B5563")
    if site["radius"] not in ("rounded", "soft", "square"):
        raise ValueError("Corner style must be rounded, soft or square")
    for k in ("logo_url", "favicon_url"):
        if site[k] and not SAFE_HREF.match(site[k]):
            raise ValueError("Upload the logo through the media library")
    site["brand_name"] = _text(site["brand_name"], 40) or settings.app_name
    site["tagline"] = _text(site["tagline"], 120)
    site["header_links"] = _links(site["header_links"], 6)
    site["footer_columns"] = [{"title": _text(c.get("title"), 40), "links": _links(c.get("links"), 10)} for c in site["footer_columns"][:5]]
    a = site["announcement"]
    if a.get("link") and not SAFE_HREF.match(a["link"]):
        raise ValueError("Announcement link must start with / or https://")
    a["enabled"] = bool(a.get("enabled"))
    a["text"] = _text(a.get("text"), 160)
    if a.get("tone") not in ("accent", "primary", "dark"):
        a["tone"] = "accent"
    site["business"] = _business(site["business"])
    site["contact"] = _contact(site["contact"])
    site["social"] = _social(site["social"])
    f = site["footer"]
    copyright_text = _text(f.get("copyright"), 240)
    if COPYRIGHT_TOKENS.search(copyright_text):
        raise ValueError("The copyright line can use {year}, {legal_name} and {brand} only")
    site["footer"] = {k: bool(f.get(k, True)) for k in ("show_business", "show_contact", "show_social", "show_grievance", "show_gstin")} | {"copyright": copyright_text}
    ga = site["analytics"]["google_analytics_id"]
    if ga and not re.match(r"^G-[A-Z0-9]{4,12}$", ga):
        raise ValueError("Google Analytics ID looks like G-XXXXXXX")
    px = site["analytics"]["meta_pixel_id"]
    if px and not re.match(r"^\d{6,20}$", px):
        raise ValueError("Meta Pixel ID is a number")
    site["seo"] = {"title": _text(site["seo"]["title"], 70), "description": _text(site["seo"]["description"], 170)}
    return site


async def save_site(session: AsyncSession, data: dict) -> dict:
    site = validate_site(data)
    row = await session.get(PlatformSetting, SITE_KEY)
    if row is None:
        session.add(PlatformSetting(key=SITE_KEY, value=site, updated_at=utcnow()))
    else:
        row.value, row.updated_at = site, utcnow()
    return site


def public_business(site: dict) -> dict:
    """The operator details other modules need (invoices, emails, grievance page, structured data)."""
    b = site["business"]
    return {"brand": site["brand_name"], "legal_name": b["legal_name"] or site["brand_name"], "gstin": b["gstin"], "cin": b["cin"],
            "registered_address": b["registered_address"], "grievance": b["grievance"],
            "support_email": next((i["value"] for i in site["contact"]["items"] if i["type"] == "email" and i["enabled"]), ""),
            "support_phone": next((i["value"] for i in site["contact"]["items"] if i["type"] == "phone" and i["enabled"]), "")}


# ----------------------------------------------------------------------------- home sections

SECTION_KINDS = {
    "hero": "Hero slides",
    "categories": "Category tiles",
    "products": "Product row",
    "banner": "Single banner",
    "banner_grid": "Banner grid",
    "text": "Text block",
    "usp": "Promise strip",
    "recent": "Recently viewed",
}
PRODUCT_SOURCES = ("deals", "bestsellers", "new", "top_rated", "category", "manual")


def validate_section(kind: str, config: dict) -> dict:
    if kind not in SECTION_KINDS:
        raise ValueError("Unknown section type")
    c = dict(config or {})

    def img_link(x: dict) -> dict:
        img, link = str(x.get("image", ""))[:400], str(x.get("link", ""))[:300]
        if img and not SAFE_HREF.match(img):
            raise ValueError("Images must be uploaded through the media library")
        if link and not SAFE_HREF.match(link):
            raise ValueError("Links must start with / or https://")
        return {"image": img, "link": link, "heading": str(x.get("heading", ""))[:80], "text": str(x.get("text", ""))[:160], "cta": str(x.get("cta", ""))[:30]}

    if kind == "hero":
        slides = [img_link(s) for s in c.get("slides", [])][:8]
        if not slides:
            raise ValueError("Add at least one slide")
        return {"slides": slides, "autoplay": bool(c.get("autoplay", True))}
    if kind == "banner":
        return img_link(c)
    if kind == "banner_grid":
        items = [img_link(s) for s in c.get("items", [])][:4]
        if len(items) < 2:
            raise ValueError("A banner grid needs 2 to 4 banners")
        return {"items": items}
    if kind == "products":
        source = c.get("source", "deals")
        if source not in PRODUCT_SOURCES:
            raise ValueError("Choose where the products come from")
        out = {"source": source, "limit": max(4, min(24, int(c.get("limit", 12)))), "layout": "grid" if c.get("layout") == "grid" else "row"}
        if source == "category":
            out["category_slug"] = str(c.get("category_slug", ""))[:90]
            if not out["category_slug"]:
                raise ValueError("Choose a category")
        if source == "manual":
            out["product_ids"] = [str(x) for x in c.get("product_ids", [])][:24]
        return out
    if kind == "categories":
        return {"slugs": [str(x)[:90] for x in c.get("slugs", [])][:16], "style": "chips" if c.get("style") == "chips" else "tiles"}
    if kind == "text":
        return {"markdown": str(c.get("markdown", ""))[:8000], "align": "center" if c.get("align") == "center" else "left"}
    if kind == "usp":
        return {"items": [{"icon": str(i.get("icon", "check"))[:20], "text": str(i.get("text", ""))[:80]} for i in c.get("items", [])][:6]}
    return {}


DEFAULT_SECTIONS = [
    ("categories", "Shop by category", {"slugs": [], "style": "tiles"}),
    ("products", "Deals of the day", {"source": "deals", "limit": 12, "layout": "row"}),
    ("usp", "", {"items": [{"icon": "badge", "text": "Every seller is KYC-verified"}, {"icon": "wallet", "text": "Cash on delivery available"}, {"icon": "truck", "text": "Free delivery over {free_delivery_amount} per seller"}, {"icon": "return", "text": "Easy returns"}]}),
    ("products", "Bestsellers", {"source": "bestsellers", "limit": 12, "layout": "row"}),
    ("recent", "Recently viewed", {}),
    ("products", "Top rated", {"source": "top_rated", "limit": 12, "layout": "row"}),
    ("products", "New arrivals", {"source": "new", "limit": 10, "layout": "grid"}),
]


async def ensure_default_sections(session: AsyncSession) -> None:
    if (await session.execute(select(HomeSection.id).limit(1))).first():
        return
    for i, (kind, title, cfg) in enumerate(DEFAULT_SECTIONS):
        session.add(HomeSection(kind=kind, title=title, config=cfg, position=i * 10))
    await session.flush()


def section_out(s: HomeSection) -> dict:
    return {
        "id": str(s.id), "kind": s.kind, "kind_label": SECTION_KINDS.get(s.kind, s.kind), "title": s.title, "config": s.config,
        "position": s.position, "is_active": s.is_active, "device": s.device,
        "starts_at": s.starts_at.isoformat() if s.starts_at else None, "ends_at": s.ends_at.isoformat() if s.ends_at else None,
    }


DEFAULT_PAGES = {
    "terms": ("Terms of use", "These terms are a placeholder. Ask your lawyer to write the terms of use for your marketplace and paste them here from Admin → Storefront → Pages."),
    "privacy": ("Privacy policy", "This privacy notice is a placeholder. Under the Digital Personal Data Protection Act, 2023 your notice must list the personal data you collect, why, how a person can withdraw consent or ask for erasure, and your grievance contact. Replace this text from Admin → Storefront → Pages."),
    "returns-policy": ("Returns and refunds", "Every product page shows its return window, which starts on the delivery day.\n\n## Cancelling before shipping\nOpen the order and choose **Cancel this package**. Online payments are refunded at once to the original method (5 to 7 working days).\n\n## Returns after delivery\nOpen the order and choose **Return items** while the window is open. Once the seller receives the item, we refund you. Cash-on-delivery refunds are sent to the UPI ID you give us."),
    "shipping-policy": ("Shipping policy", "Sellers ship from their own warehouses. Delivery time is shown on each product page for your PIN code. Delivery is free when a seller's items in your order reach the free-delivery amount."),
    "about": ("About us", "Tell your customers who you are. Edit this page from Admin → Storefront → Pages."),
}
