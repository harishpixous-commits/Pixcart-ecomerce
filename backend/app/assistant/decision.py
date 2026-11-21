"""Decision layer: a fast first look at each message, before the language model is called.

It decides three things in a few milliseconds:

1. **Which areas** the message is about (sales, orders, stock, …) → only those tools are offered to the
   model, so the request is smaller and the model picks the right tool first time.
2. **Which period** it means ("today", "நேற்று", "pichle hafte", "last month") → resolved on the server.
3. **What to fetch straight away** for common questions ("how much did we sell today?") → the lookup runs
   before the model is called and its result is included, which saves a whole model round trip.
   This matters most in voice mode.

Providers (Admin → AI assistant → Decision layer):

- ``rules`` (default, built in): keyword and pattern matching in English, Tamil, Hindi and Tanglish.
- ``laya``: the open-weight Laya System 1 decision model (Apache-2.0) served by ``laya-serve``
  (``pip install "laya[serve]"``). Its calibrated choice + confidence decides intent and area; the
  rules still extract dates. If Laya is slow or down, the rules answer instead.
- ``off``: every tool is offered and nothing is prefetched.

If confidence is below the configured threshold, every tool the person may use is offered — the layer
can only speed things up, never hide a capability.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.assistant.settings import laya_allowed

log = logging.getLogger("pixcart.assistant")

# Tests replace this with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None

INTENTS = ("data_question", "change_request", "export_request", "file_analysis", "how_to", "small_talk")
DOMAINS = ("sales", "orders", "customers", "catalog", "sellers", "returns", "support", "payouts", "marketing", "reports", "settings", "overview")

# area -> words (lower-case; Tamil/Hindi script and Tanglish/Hinglish included)
LEXICON: dict[str, tuple[str, ...]] = {
    "sales": ("sale", "sales", "sell", "sold", "selling", "how much did we", "revenue", "gmv", "turnover", "earning", "income", "business", "aov", "average order", "commission", "profit",
              "விற்பனை", "வருமானம்", "வியாபாரம்", "sales evlo", "evlo sales", "vitpanai", "vyaparam", "बिक्री", "सेल", "कमाई", "बिजनेस", "kitna becha", "bikri"),
    "orders": ("order", "orders", "package", "packages", "shipment", "awb", "courier", "deliver", "shipped", "dispatch", "cancel", "pending order",
               "ஆர்டர்", "டெலிவரி", "அனுப்பு", "ஆர்டர்கள்", "ऑर्डर", "डिलीवरी", "भेजा"),
    "customers": ("customer", "customers", "buyer", "shopper", "user", "phone number", "mobile", "email",
                  "வாடிக்கையாளர்", "கஸ்டமர்", "ग्राहक", "कस्टमर"),
    "catalog": ("product", "products", "listing", "listings", "sku", "stock", "inventory", "out of stock", "low stock", "price", "mrp", "category", "review", "rating",
                "பொருள்", "ஸ்டாக்", "இருப்பு", "விலை", "प्रोडक्ट", "स्टॉक", "माल", "दाम"),
    "sellers": ("seller", "sellers", "vendor", "store", "shop", "merchant", "gstin", "kyc", "விற்பனையாளர்", "கடை", "सेलर", "विक्रेता", "दुकान"),
    "returns": ("return", "returns", "refund", "refunds", "rto", "credit note", "ரிட்டர்ன்", "திருப்பி", "பணம் திரும்ப", "रिटर्न", "रिफंड", "वापसी"),
    "support": ("ticket", "tickets", "complaint", "grievance", "support", "query", "helpdesk", "புகார்", "டிக்கெட்", "शिकायत", "टिकट"),
    "payouts": ("payout", "payouts", "settlement", "utr", "bank transfer", "pay seller", "seller payment", "செட்டில்மென்ட்", "पेआउट", "भुगतान"),
    "marketing": ("coupon", "coupons", "discount code", "offer", "promo", "announcement", "banner", "கூப்பன்", "ஆஃபர்", "कूपन", "ऑफर"),
    "reports": ("tcs", "gst", "gstr", "tds", "tax report", "invoice", "வரி", "जीएसटी", "टैक्स"),
    "settings": ("setting", "settings", "fee", "cod limit", "integration", "razorpay", "msg91", "api key", "go live", "go-live", "launch", "அமைப்பு", "सेटिंग"),
    "overview": ("attention", "pending", "todo", "to do", "what's waiting", "whats waiting", "summary", "status", "how are we doing", "dashboard",
                 "கவனிக்க", "நிலவரம்", "என்ன பண்ணணும்", "क्या बाकी", "स्थिति"),
}
CHANGE_WORDS = ("approve", "reject", "cancel", "block", "unblock", "suspend", "create", "make a coupon", "switch on", "switch off", "turn on", "turn off",
                "change", "update", "set ", "reply", "refund it", "mark ", "run payout", "hide", "publish", "delete",
                "அனுமதி", "ரத்து", "மாற்று", "உருவாக்கு", "நிறுத்து", "मंजूर", "रद्द", "बदल", "बनाओ", "बंद करो")
EXPORT_WORDS = ("export", "download", "excel", "xlsx", "csv", "pdf", "spreadsheet", "sheet", "report file", "டவுன்லோட்", "எக்செல்", "डाउनलोड", "एक्सेल")
HOWTO_WORDS = ("how do i", "how to", "how can i", "where do i", "where is", "what is", "explain", "help me", "எப்படி", "எங்க", "என்றால் என்ன", "कैसे", "कहाँ", "क्या है")
SMALLTALK = ("hi", "hello", "hey", "thanks", "thank you", "good morning", "vanakkam", "வணக்கம்", "நன்றி", "नमस्ते", "धन्यवाद", "ok", "okay")

PERIOD_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("yesterday", ("yesterday", "நேற்று", "nethu", "netru", "कल का", "बीता कल", "kal ka")),
    ("today", ("today", "todays", "today's", "so far today", "இன்று", "இன்னைக்கு", "இன்னிக்கு", "inniku", "innaiku", "indru", "आज", "aaj")),
    ("last_week", ("last week", "previous week", "போன வாரம்", "கடந்த வாரம்", "pona vaaram", "पिछले हफ्ते", "पिछले सप्ताह", "pichle hafte")),
    ("this_week", ("this week", "இந்த வாரம்", "intha vaaram", "इस हफ्ते", "is hafte")),
    ("last_month", ("last month", "previous month", "போன மாசம்", "கடந்த மாதம்", "pona maasam", "पिछले महीने", "pichle mahine")),
    ("this_month", ("this month", "month to date", "mtd", "இந்த மாசம்", "இந்த மாதம்", "intha maasam", "इस महीने", "is mahine")),
    ("this_year", ("this year", "ytd", "இந்த வருடம்", "இந்த வருஷம்", "इस साल")),
    ("this_financial_year", ("this fy", "financial year", "this financial year", "நிதியாண்டு", "वित्त वर्ष")),
    ("last_7_days", ("last 7 days", "past 7 days", "last seven days", "past week")),
    ("last_30_days", ("last 30 days", "past 30 days", "last thirty days", "past month")),
    ("last_90_days", ("last 90 days", "past 90 days", "last 3 months", "last three months", "this quarter")),
]
DOMAIN_TOOLS: dict[str, tuple[str, ...]] = {
    "sales": ("business_overview", "sales_breakdown"),
    "overview": ("work_queue", "business_overview"),
    "orders": ("find_orders", "order_details", "business_overview"),
    "customers": ("find_customers", "customer_profile"),
    "catalog": ("find_products", "stock_alerts"),
    "sellers": ("find_sellers", "seller_profile", "stock_alerts"),
    "returns": ("returns_report", "refunds_report"),
    "support": ("support_tickets",),
    "payouts": ("payouts_report",),
    "marketing": ("coupons",),
    "reports": ("gst_tcs_report",),
    "settings": ("marketplace_settings",),
}
ALWAYS = ("open_page", "remember", "prepare_export")
ORDER_NO = re.compile(r"\b(PC[0-9A-Z]{6,}(?:-\d+)?)\b", re.I)
PHONE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
ISO_DATE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")


@dataclass
class Decision:
    intent: str
    domains: list[str]
    period: str | None
    confidence: float
    source: str
    ms: float
    tools: list[str] | None  # None = offer every permitted tool
    prefetch: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    voice_fast: bool = False  # short factual question: the fast route is enough
    entities: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"intent": self.intent, "areas": self.domains, "period": self.period, "confidence": round(self.confidence, 2), "source": self.source,
                "ms": round(self.ms, 1), "tools": self.tools, "prefetch": [n for n, _ in self.prefetch]}


def _has(text: str, words: tuple[str, ...]) -> int:
    hits = 0
    for w in words:
        if (re.search(rf"(?<![\w]){re.escape(w)}(?![\w])", text) if w.isascii() else w in text):
            hits += 1
    return hits


def detect_period(text: str) -> str | None:
    t = text.lower()
    for preset, words in PERIOD_WORDS:
        if _has(t, words):
            return preset
    return None


def rules(text: str, *, has_upload: bool = False) -> Decision:
    started = time.perf_counter()
    t = " ".join(text.lower().split())
    scores = {d: _has(t, LEXICON[d]) for d in DOMAINS}
    entities: dict[str, str] = {}
    if m := ORDER_NO.search(text):
        entities["order"] = m.group(1).upper()
        scores["orders"] += 2
    if m := PHONE.search(text):
        entities["phone"] = m.group(1)
        scores["customers"] += 2
    if m := EMAIL.search(text):
        entities["email"] = m.group(0)
        scores["customers"] += 2
    if ISO_DATE.search(text):
        entities["date"] = ISO_DATE.search(text).group(1)
    if _has(t, ("stock", "out of stock", "low stock", "inventory", "ஸ்டாக்", "இருப்பு", "स्टॉक", "माल")):
        entities["stock"] = "1"
    period = detect_period(t)
    domains = [d for d, s in sorted(scores.items(), key=lambda x: -x[1]) if s > 0]
    if has_upload:
        intent = "file_analysis"
    elif _has(t, CHANGE_WORDS):
        intent = "change_request"
    elif _has(t, EXPORT_WORDS):
        intent = "export_request"
    elif _has(t, HOWTO_WORDS) and not period:
        intent = "how_to"
    elif not domains and (t.strip(" !.?") in SMALLTALK or len(t) <= 3):
        intent = "small_talk"
    else:
        intent = "data_question"
    top = scores[domains[0]] if domains else 0
    confidence = 0.95 if intent == "small_talk" else min(0.95, 0.45 + 0.2 * top + (0.1 if period else 0) + (0.1 if entities else 0))
    if intent == "file_analysis":
        confidence = max(confidence, 0.8)
    if intent == "how_to" and not domains:
        confidence = 0.7
    d = Decision(intent, domains[:3], period, confidence, "rules", 0.0, None, entities=entities)
    d.ms = (time.perf_counter() - started) * 1000
    return d


def plan(d: Decision, *, min_confidence: float, prefetch: bool, available: set[str]) -> Decision:
    """Chooses tools and the prefetch from a decision. Low confidence → every tool."""
    if d.confidence < min_confidence or d.intent in ("change_request",) and not d.domains:
        d.tools = None
    else:
        names: list[str] = list(ALWAYS)
        for dom in d.domains or ["overview"]:
            names += DOMAIN_TOOLS.get(dom, ())
        if d.intent == "file_analysis":
            names += ["file_overview", "file_query", "file_compare"]
            for dom in ("orders", "catalog"):
                names += DOMAIN_TOOLS[dom]
        if d.intent == "change_request":
            names.append("propose_action")
        if d.intent == "how_to":
            names.append("marketplace_settings")
        d.tools = [n for n in dict.fromkeys(names) if n in available]
    if prefetch and d.intent == "data_question" and d.confidence >= min_confidence and d.domains:
        top = d.domains[0]
        args: dict[str, Any] = {"period": d.period} if d.period else {}
        if top == "sales" and "business_overview" in available:
            d.prefetch.append(("business_overview", {"period": d.period or "today"}))
        elif top == "overview" and "work_queue" in available:
            d.prefetch.append(("work_queue", {}))
        elif top == "orders" and d.entities.get("order") and "order_details" in available:
            d.prefetch.append(("order_details", {"reference": d.entities["order"]}))
        elif top == "orders" and d.period and "business_overview" in available:
            d.prefetch.append(("business_overview", {"period": d.period}))  # "how many orders today"
        elif top == "customers" and (d.entities.get("phone") or d.entities.get("email")) and "customer_profile" in available:
            d.prefetch.append(("customer_profile", {"reference": d.entities.get("phone") or d.entities.get("email")}))
        elif top == "catalog" and d.entities.get("stock") and "stock_alerts" in available:
            d.prefetch.append(("stock_alerts", {}))
        elif top == "payouts" and "payouts_report" in available:
            d.prefetch.append(("payouts_report", {}))
        elif top == "support" and "support_tickets" in available:
            d.prefetch.append(("support_tickets", {"status": "open"}))
        elif top == "returns" and "returns_report" in available:
            d.prefetch.append(("returns_report", args or {"period": "last_30_days"}))
    d.voice_fast = d.intent in ("data_question", "small_talk") and d.confidence >= 0.75
    return d


# ----------------------------------------------------------------------------- Laya


LAYA_QUESTIONS = {
    "intent": {"type": "choice", "instructions": "What does the marketplace admin want?",
               "criteria": {"data_question": "a number, list, status or comparison from the shop's data",
                            "change_request": "change something: approve, reject, cancel, block, create, update, reply",
                            "export_request": "download a report or spreadsheet", "file_analysis": "analyse an uploaded file",
                            "how_to": "how to do something in the admin panel", "small_talk": "greeting or thanks"}},
    "area": {"type": "choice", "instructions": "Which part of the marketplace is it about?",
             "criteria": {"sales": "sales, revenue, money earned", "orders": "orders, deliveries, cancellations", "customers": "customers and buyers",
                          "catalog": "products, stock, prices, reviews", "sellers": "sellers and stores", "returns": "returns and refunds",
                          "support": "support tickets and complaints", "payouts": "payments to sellers", "marketing": "coupons, offers, announcements",
                          "reports": "GST, TCS and tax reports", "settings": "settings, integrations, launch", "overview": "what needs attention overall"}},
}


async def laya(text: str, cfg: dict[str, Any]) -> Decision | None:
    if not laya_allowed(cfg.get("laya_url", "")):
        return None  # not a public https address (saved before that rule): staff questions never go there
    started = time.perf_counter()
    url = cfg.get("laya_url", "").rstrip("/") + (cfg.get("laya_path") or "/predict")
    headers = {"content-type": "application/json"}
    if cfg.get("laya_key"):
        headers["Authorization"] = f"Bearer {cfg['laya_key']}"
    try:
        async with httpx.AsyncClient(timeout=cfg.get("laya_timeout_ms", 600) / 1000, transport=transport) as c:
            r = await c.post(url, json={"state": text[:4000], "questions": LAYA_QUESTIONS}, headers=headers)
        r.raise_for_status()
        answers = (r.json() or {}).get("answers") or {}
        intent = answers.get("intent") or {}
        area = answers.get("area") or {}
        if intent.get("choice") not in INTENTS or area.get("choice") not in DOMAINS:
            return None
        conf = float(min(intent.get("confidence", 0), area.get("confidence", 0)))
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        log.info("laya decision unavailable (%s); using rules", type(exc).__name__)
        return None
    base = rules(text)
    domains = [area["choice"]] + [x for x in base.domains if x != area["choice"]]
    return Decision(intent["choice"], domains[:3], base.period, conf, "laya", (time.perf_counter() - started) * 1000, None, entities=base.entities)


async def decide(text: str, cfg: dict[str, Any], *, available: set[str], has_upload: bool) -> Decision:
    provider = cfg.get("provider", "rules")
    if provider == "off":
        return Decision("data_question", [], detect_period(text.lower()), 0.0, "off", 0.0, None)
    d: Decision | None = None
    if provider == "laya" and cfg.get("laya_url") and not has_upload:
        d = await laya(text, cfg)
    if d is None:
        d = rules(text, has_upload=has_upload)
    return plan(d, min_confidence=float(cfg.get("min_confidence", 0.55)), prefetch=bool(cfg.get("prefetch", True)), available=available)
