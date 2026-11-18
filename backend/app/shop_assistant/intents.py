"""What does the customer want? Fast multilingual rules (English, Tanglish, Tamil, Hindi), no model needed.

Used to answer in guided mode (no AI model) and, in live mode, to prefetch the obvious lookup.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .kb import normalize, tokens

ORDER_RE = re.compile(r"\b(PC\d{6}[A-Z0-9]{6})(-\d{1,2})?\b", re.I)
TICKET_RE = re.compile(r"\b(TK\d{6}[0-9A-F]{4})\b", re.I)
PRICE_MAX_RE = re.compile(r"(?:under|below|less than|within|upto|up to|max(?:imum)?|budget|kulla|kammi|से कम|के अंदर|க்குள்)\s*(?:rs\.?|₹|inr|rupees)?\s*(\d[\d,]*)\s*(k)?", re.I)
PRICE_MAX_AFTER_RE = re.compile(r"(?:rs\.?|₹)?\s*(\d[\d,]*)\s*(k)?\s*(?:rs|rupees|₹)?\s*(?:kulla|ku kammi|ku keela|க்குள்|से कम|तक)", re.I)
PRICE_RANGE_RE = re.compile(r"between\s*(?:rs\.?|₹)?\s*(\d[\d,]*)\s*(?:and|to|-)\s*(?:rs\.?|₹)?\s*(\d[\d,]*)", re.I)
PRICE_MIN_RE = re.compile(r"(?:above|over|more than|min(?:imum)?)\s*(?:rs\.?|₹|inr)?\s*(\d[\d,]*)\s*(k)?", re.I)

KEYWORDS: dict[str, tuple[str, ...]] = {
    "grievance": ("grievance", "consumer court", "consumer forum", "escalate", "legal action", "புகார் அதிகாரி", "शिकायत अधिकारी"),
    "human": ("human", "agent", "customer care", "customer service", "talk to", "speak to", "call me", "representative", "real person",
              "support team", "contact support", "raise ticket", "raise a ticket", "create ticket", "open a ticket", "complaint", "complain",
              "executive", "connect me", "help desk", "manager", "யாராவது", "மனிதர்", "बात करनी", "कस्टमर केयर", "शिकायत"),
    "tickets": ("my tickets", "my ticket", "my requests", "my complaints", "ticket status", "request status", "complaint status", "ticket update"),
    "cancel": ("cancel", "venaam", "vendam", "vendaam", "dont want", "do not want", "ரத்து", "கேன்சல்", "வேண்டாம்", "रद्द", "कैंसल", "नहीं चाहिए"),
    "damaged": ("damaged", "broken", "defective", "not working", "doesnt work", "does not work", "wrong item", "different item", "wrong product",
                "wrong size", "fake", "missing item", "item missing", "torn", "udanji", "work aagala", "சேதம்", "உடைந்த", "வேலை செய்யல", "टूटा",
                "खराब", "गलत सामान"),
    "return": ("return", "replace", "replacement", "exchange", "send back", "thiruppi", "திருப்பி", "ரிட்டர்ன்", "மாற்ற", "वापस", "रिटर्न", "बदलना"),
    "refund": ("refund", "money back", "my money", "paisa", "panam", "பணம்", "ரீஃபண்ட்", "रिफंड", "पैसा वापस", "पैसे वापस"),
    "payment": ("payment failed", "payment fail", "payment issue", "money deducted", "amount deducted", "debited", "paid but", "transaction failed",
                "upi failed", "charged twice", "double payment", "payment pending", "पेमेंट फेल", "பணம் போச்சு", "panam pochu"),
    "track": ("track", "where is my", "order status", "status of my", "my order", "my orders", "my package", "when will", "when do i get",
              "not received", "not delivered", "still not", "delivery status", "late delivery", "delayed", "enga", "eppo varum", "eppo vara",
              "varala", "varalai", "kedaikala", "vandhuducha", "எங்கே", "எப்போ", "வரவில்லை", "வரல", "ஆர்டர்", "कहाँ है", "कब आएगा",
              "कब मिलेगा", "नहीं मिला", "मेरा ऑर्डर", "ऑर्डर"),
    "search": ("show me", "looking for", "look for", "find me", "find a", "search", "want to buy", "i want a", "i need a", "do you have",
               "do you sell", "price of", "recommend", "suggest", "best ", "cheap", "kaattu", "kaatu", "venum", "வாங்க", "காட்டு", "வேணும்",
               "दिखाओ", "चाहिए", "खरीदना"),
    "thanks": ("thanks", "thank you", "thank u", "thx", "nandri", "romba nandri", "நன்றி", "धन्यवाद", "shukriya"),
    "bye": ("bye", "goodbye", "that's all", "thats all", "no thanks", "nothing else", "போதும்", "बस"),
    "greet": ("hi", "hii", "hello", "hey", "vanakkam", "namaste", "namaskar", "good morning", "good afternoon", "good evening", "வணக்கம்", "नमस्ते"),
}

# Words that only name the intent; removed before a product search.
SEARCH_NOISE = set("show find search want buy need looking look have sell price recommend suggest best cheap good kaattu kaatu venum me some any one "
                   "products product items item options under below above within upto rs inr rupees budget".split())


@dataclass
class Intent:
    name: str
    lang: str = "en"
    order_number: str | None = None
    package_number: str | None = None
    ticket_number: str | None = None
    query: str = ""
    min_price: int | None = None  # paise
    max_price: int | None = None
    also: list[str] = field(default_factory=list)  # other intents seen

    def as_dict(self) -> dict:
        return asdict(self)


def language(text: str) -> str:
    if re.search(r"[஀-௿]", text):
        return "ta"
    if re.search(r"[ऀ-ॿ]", text):
        return "hi"
    return "en"


def _has(norm: str, phrase: str) -> bool:
    p = normalize(phrase)
    if not p:
        return False
    if re.search(r"[a-z]", p):
        # Short words must be whole words ("hi" is not "highlight"); longer ones also match their endings
        # ("cancel" → "cancelled", "return" → "returned", "varala" → "varalai").
        end = r"(?![a-z0-9])" if len(p) <= 3 else ""
        return re.search(rf"(?<![a-z0-9]){re.escape(p)}{end}", norm) is not None
    return p in norm


def _rupees(num: str, k: str | None) -> int:
    v = int(num.replace(",", ""))
    return v * 1000 * 100 if k else v * 100


def prices(text: str) -> tuple[int | None, int | None]:
    lo = hi = None
    m = PRICE_RANGE_RE.search(text)
    if m:
        a, b = int(m.group(1).replace(",", "")) * 100, int(m.group(2).replace(",", "")) * 100
        return min(a, b), max(a, b)
    m = PRICE_MAX_RE.search(text) or PRICE_MAX_AFTER_RE.search(text)
    if m:
        hi = _rupees(m.group(1), m.group(2))
    m = PRICE_MIN_RE.search(text)
    if m:
        lo = _rupees(m.group(1), m.group(2))
    return lo, hi


def search_terms(text: str) -> str:
    t = PRICE_RANGE_RE.sub(" ", text)
    t = PRICE_MAX_RE.sub(" ", t)
    t = PRICE_MAX_AFTER_RE.sub(" ", t)
    t = PRICE_MIN_RE.sub(" ", t)
    words = [w for w in tokens(t) if w not in SEARCH_NOISE and not w.isdigit()]
    return " ".join(words[:8])


def detect(text: str) -> Intent:
    norm = f" {normalize(text)} "
    lang = language(text)
    order = ORDER_RE.search(text)
    ticket = TICKET_RE.search(text)
    seen = [name for name, words in KEYWORDS.items() if any(_has(norm, w) for w in words)]
    lo, hi = prices(text)
    it = Intent(name="unknown", lang=lang, also=seen)
    if order:
        it.order_number = order.group(1).upper()
        it.package_number = (order.group(1) + order.group(2)).upper() if order.group(2) else None
    if ticket:
        it.ticket_number = ticket.group(1).upper()
    short = len(tokens(text)) <= 3

    if ticket and not any(x in seen for x in ("human", "grievance")):
        it.name = "ticket_status"
    elif "grievance" in seen:
        it.name = "grievance"
    elif "tickets" in seen:
        it.name = "tickets"
    elif "human" in seen:
        it.name = "human"
    elif "cancel" in seen:
        it.name = "cancel"
    elif "damaged" in seen:
        it.name = "damaged"
    elif "return" in seen:
        it.name = "return"
    elif "payment" in seen:
        it.name = "payment"
    elif "refund" in seen:
        it.name = "refund"
    elif "track" in seen or order:
        it.name = "track"
    elif "search" in seen or lo is not None or hi is not None:
        it.name = "search"
    elif "thanks" in seen and short:
        it.name = "thanks"
    elif "bye" in seen and short:
        it.name = "bye"
    elif "greet" in seen and short:
        it.name = "greet"
    if it.name in ("search", "unknown"):
        it.query = search_terms(text)
        it.min_price, it.max_price = lo, hi
    return it
