"""The AI task registry: every AI feature is declared here once.

Each task has frozen rules (the first, cached system block: safety and format, never editable from the
admin panel), a builder for the per-request message, a parser that validates the answer, and a sandbox
that produces an obviously-marked answer when no API key is set, so screens and tests work offline.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from app.core.errors import ApiError

TONES = ("friendly", "formal", "apologetic")
SANDBOX = "[Sandbox draft — connect an Anthropic API key for real AI text]"


@dataclass(frozen=True)
class Task:
    key: str
    label: str
    description: str
    audience: str  # "seller" | "admin" | "system"
    permission: str  # admin permission (ignored for sellers/system)
    output: str  # "json" | "text"
    rules: str
    build: Callable[[dict, dict], str]
    parse: Callable[[str], dict]
    sandbox: Callable[[dict, dict], str]
    max_tokens: int = 800
    subject: str = ""  # subject type the task works on, if any


def _json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ApiError("The AI answer could not be read. Try again.", "ai_bad_output", 502)
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as exc:
        raise ApiError("The AI answer could not be read. Try again.", "ai_bad_output", 502) from exc
    if not isinstance(data, dict):
        raise ApiError("The AI answer could not be read. Try again.", "ai_bad_output", 502)
    return data


def _clean(text: str, limit: int) -> str:
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text or "").strip()
    # Drop a leading "Here is a draft:" style preamble if the model adds one.
    text = re.sub(r"^(here('s| is)[^\n:]{0,60}:\s*)", "", text, flags=re.I)
    return text[:limit].strip()


def _text_parser(limit: int) -> Callable[[str], dict]:
    def parse(text: str) -> dict:
        body = _clean(text, limit)
        if not body:
            raise ApiError("The AI returned an empty answer. Try again.", "ai_empty", 502)
        return {"text": body}

    return parse


# ----------------------------------------------------------------------------- listing writer (sellers)

LISTING_RULES = (
    "You write product listings for an Indian online marketplace. Write in clear, simple English for Indian shoppers. "
    "Use only facts present in the seller's notes; never invent certifications, warranties, materials, sizes or claims. "
    "No superlatives such as 'best' or 'No. 1', no medical claims, no prices, no contact details, no mention of other marketplaces. "
    "Answer with JSON only: {\"title\": str (max 150 chars, brand + product type + key attribute), "
    "\"description\": str (80-200 words, plain paragraphs), \"highlights\": [3-6 short strings], "
    "\"specs\": {name: value} (only facts from the notes), \"missing\": [questions the seller should answer]}"
)


def _listing_parse(text: str) -> dict:
    out = _json(text)
    return {
        "title": str(out.get("title", ""))[:200],
        "description": str(out.get("description", ""))[:10000],
        "highlights": [str(h)[:200] for h in out.get("highlights", []) if str(h).strip()][:10],
        "specs": {str(k)[:60]: str(v)[:300] for k, v in (out.get("specs") or {}).items()} if isinstance(out.get("specs"), dict) else {},
        "missing": [str(q)[:200] for q in out.get("missing", [])][:8],
    }


def _listing_sandbox(i: dict, _: dict) -> str:
    notes = " ".join(i["notes"].split())
    return json.dumps({
        "title": f"{i.get('brand') or ''} {notes[:80]}".strip(),
        "description": f"{SANDBOX}\n\n{notes}",
        "highlights": [s.strip() for s in re.split(r"[,.;\n]", notes) if len(s.strip()) > 3][:5],
        "specs": {},
        "missing": ["What is the material?", "What sizes or quantities are available?"],
    })


# ----------------------------------------------------------------------------- listing check (moderators)

CHECK_RULES = (
    "You help a marketplace moderator in India review a product listing. Point out likely problems only: "
    "prohibited or regulated items (weapons, drugs, prescription medicines, tobacco, wildlife products, counterfeit brands), "
    "misleading health or safety claims, contact details or external links in the text, a title that does not match the "
    "description, an MRP that looks unrealistic, or a GST rate that looks wrong for the item. Do not invent problems. "
    "Answer with JSON only: {\"risk\": \"low\"|\"medium\"|\"high\", \"issues\": [short strings], \"suggested_reason\": str}"
)

BANNED = re.compile(r"\b(gun|pistol|ammunition|cannabis|ganja|tobacco|cigarette|vape|ivory|prescription|steroid|replica|first copy|7a quality)\b", re.I)
CONTACT = re.compile(r"(\+?91[\s-]?)?[6-9]\d{9}|[\w.]+@[\w-]+\.[a-z]{2,}|https?://|www\.", re.I)


def _check_parse(text: str) -> dict:
    out = _json(text)
    risk = out.get("risk") if out.get("risk") in ("low", "medium", "high") else "medium"
    return {"risk": risk, "issues": [str(x)[:200] for x in out.get("issues", [])][:10], "suggested_reason": str(out.get("suggested_reason", ""))[:500]}


def rule_check(listing: dict) -> dict:
    """Deterministic checks that run with or without AI."""
    text = " ".join([listing.get("title", ""), listing.get("description", ""), " ".join(listing.get("highlights", []))])
    issues = []
    if BANNED.search(text):
        issues.append(f"Mentions a restricted item: \"{BANNED.search(text).group(0)}\"")
    if CONTACT.search(text):
        issues.append("Contains a phone number, email or web link")
    for v in listing.get("variants", []):
        if v.get("mrp") and v.get("price") and v["mrp"] > 0 and v["price"] / v["mrp"] < 0.2:
            issues.append("Discount above 80% of MRP: check the MRP is real")
            break
    if len(listing.get("description", "")) < 60:
        issues.append("Description is very short")
    risk = "high" if any("restricted" in i for i in issues) else "medium" if issues else "low"
    return {"risk": risk, "issues": issues, "suggested_reason": issues[0] if issues else ""}


def _check_sandbox(_: dict, snap: dict) -> str:
    out = rule_check(snap)
    out["issues"] = [SANDBOX, *out["issues"]]
    return json.dumps(out)


# ----------------------------------------------------------------------------- review summary (system job)

SUMMARY_RULES = (
    "Summarise customer reviews of one product for other shoppers in 2-3 short sentences: what people like, and common "
    "complaints if any. Be neutral and factual, do not quote names, do not add information not in the reviews. Plain text only."
)


def _summary_sandbox(_: dict, snap: dict) -> str:
    n = len(snap.get("reviews", []))
    avg = sum(r for r, _ in snap.get("reviews", [])) / n if n else 0
    return f"{SANDBOX} Average rating {avg:.1f} from {n} reviews."


# ----------------------------------------------------------------------------- support reply (support desk)

SUPPORT_RULES = (
    "You draft replies for the customer support team of an Indian online marketplace. A staff member reviews and edits "
    "every draft before it is sent.\n"
    "Rules — never violate:\n"
    "- Output the reply body only: no preamble, no subject line, no markdown, no signature placeholder.\n"
    "- Use only facts from the ticket and order context. Never promise refunds, replacements, dates or compensation that "
    "the context does not already confirm; say the team will check instead.\n"
    "- Never ask for OTPs, passwords, card numbers or UPI PINs.\n"
    "- Keep it under 120 words, plain Indian English, address the customer by first name if known.\n"
    "- Match the requested tone: friendly, formal or apologetic."
)


def _support_build(i: dict, s: dict) -> str:
    convo = "\n".join(f"- {m['who']}: {m['body'][:600]}" for m in s.get("messages", [])[-8:])
    return (
        f"Ticket {s.get('number')}: {s.get('subject')}\nCategory: {s.get('category')}\nCustomer first name: {s.get('first_name') or 'unknown'}\n"
        f"Order: {s.get('order') or 'none linked'}\nConversation so far:\n{convo or '- (no messages)'}\n\n"
        f"Tone: {i['tone']}\nWhat the reply should do: {i.get('intent') or 'acknowledge and answer the latest message'}\n\nDraft the reply now."
    )


def _support_sandbox(i: dict, s: dict) -> str:
    name = s.get("first_name") or "there"
    return f"Hi {name}, thank you for writing to us about \"{s.get('subject', '')}\". {SANDBOX} We are checking this and will update you shortly."


# ----------------------------------------------------------------------------- customer message (orders)

MESSAGE_RULES = (
    "You draft a message from an Indian online marketplace to one customer about their order. A staff member reviews "
    "and sends it.\n"
    "Rules — never violate:\n"
    "- First line: 'Subject: ' followed by a short subject. Then a blank line, then the message body.\n"
    "- Use only facts from the order context; never invent dates, amounts, refunds or policies.\n"
    "- Never ask for OTPs, passwords, card numbers or UPI PINs. No links other than the order link given.\n"
    "- Under 150 words, plain Indian English, match the requested tone."
)


def _message_build(i: dict, s: dict) -> str:
    pkgs = "\n".join(f"- {p['number']} from {p['seller']}: {p['status']}" + (f", tracking {p['tracking']}" if p.get("tracking") else "") for p in s.get("packages", []))
    return (
        f"Customer first name: {s.get('first_name') or 'unknown'}\nOrder {s.get('number')} placed {s.get('placed')}, total {s.get('total')}, "
        f"payment {s.get('payment')}.\nPackages:\n{pkgs}\nOrder link: {s.get('link')}\n\nTone: {i['tone']}\nPurpose: {i['intent']}\n\nWrite the message now."
    )


def _message_parse(text: str) -> dict:
    body = _clean(text, 2000)
    subject, _, rest = body.partition("\n")
    if subject.lower().startswith("subject:"):
        return {"subject": subject[8:].strip()[:150] or "About your order", "text": rest.strip()[:1800]}
    return {"subject": "About your order", "text": body[:1800]}


def _message_sandbox(i: dict, s: dict) -> str:
    return f"Subject: About your order {s.get('number')}\n\nHi {s.get('first_name') or 'there'}, {SANDBOX} {i['intent']}"


# ----------------------------------------------------------------------------- review reply (sellers)

REVIEW_RULES = (
    "You draft a seller's public reply to a customer review on an Indian marketplace. The seller edits it before posting.\n"
    "Rules: thank the customer; for complaints, apologise once and offer help through the marketplace's help centre; "
    "never argue, never offer discounts or ask the customer to change the review, never share phone numbers or links. "
    "Under 60 words, plain text only."
)


def _review_build(i: dict, s: dict) -> str:
    return f"Product: {s.get('product')}\nRating: {s.get('rating')} of 5\nReview title: {s.get('title')}\nReview: {s.get('body', '')[:1500]}\nTone: {i['tone']}\n\nWrite the reply now."


def _review_sandbox(_: dict, s: dict) -> str:
    return f"Thank you for your review of {s.get('product')}. {SANDBOX}"


# ----------------------------------------------------------------------------- business brief (admin overview)

BRIEF_RULES = (
    "You write a short weekly business brief for the owner of an Indian online marketplace from the figures given.\n"
    "Rules: use only the numbers provided, never invent figures or causes; amounts in rupees; 3 short paragraphs "
    "(sales, operations, customers) and then 'Next steps:' with 3 practical bullet points starting with '- '. "
    "Plain text, no markdown headings, under 220 words."
)


def _brief_build(_: dict, s: dict) -> str:
    return "Figures for the period:\n" + "\n".join(f"- {k}: {v}" for k, v in s.items()) + "\n\nWrite the brief now."


def _brief_sandbox(_: dict, s: dict) -> str:
    return f"{SANDBOX}\nSales were {s.get('sales')} from {s.get('orders')} orders ({s.get('sales_change')} vs the previous period).\n\nNext steps:\n- Review cancelled packages\n- Reply to open tickets\n- Check low stock"


TASKS: dict[str, Task] = {t.key: t for t in [
    Task("listing_writer", "Listing writer", "Sellers turn rough notes into a title, description, highlights and specifications.", "seller", "",
         "json", LISTING_RULES, lambda i, s: f"Category: {i.get('category') or 'not given'}\nBrand: {i.get('brand') or 'not given'}\nSeller's notes:\n{i['notes'][:4000]}",
         _listing_parse, _listing_sandbox, 1200),
    Task("listing_check", "Listing check", "Flags likely policy problems for moderators. Rule-based checks always run; AI adds judgement.", "admin", "catalog",
         "json", CHECK_RULES, lambda i, s: json.dumps(s, ensure_ascii=False)[:6000], _check_parse, _check_sandbox, 600, "product"),
    Task("review_summary", "Review summaries", "A short neutral summary of what buyers say, shown on busy product pages. Refreshed hourly.", "system", "",
         "text", SUMMARY_RULES, lambda i, s: f"Product: {s.get('title')}\nReviews:\n" + "\n".join(f"- {r}★ {t[:500]}" for r, t in s.get("reviews", [])[:60]),
         _text_parser(800), _summary_sandbox, 300, "product"),
    Task("support_reply", "Support reply drafts", "Drafts a reply to a support ticket for staff to edit and send.", "admin", "support",
         "text", SUPPORT_RULES, _support_build, _text_parser(1500), _support_sandbox, 500, "ticket"),
    Task("customer_message", "Customer messages", "Drafts an email and in-app message to a customer about their order; staff approve and send.", "admin", "orders",
         "text", MESSAGE_RULES, _message_build, _message_parse, _message_sandbox, 600, "order"),
    Task("review_reply", "Review replies", "Sellers draft a polite public reply to a review.", "seller", "",
         "text", REVIEW_RULES, _review_build, _text_parser(600), _review_sandbox, 300, "review"),
    Task("business_brief", "Business brief", "A plain-language summary of the period's numbers with next steps, on the admin overview.", "admin", "dashboard",
         "text", BRIEF_RULES, _brief_build, _text_parser(2000), _brief_sandbox, 700, "kpis"),
]}

