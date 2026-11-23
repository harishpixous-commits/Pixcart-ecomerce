"""Languages, currencies, regions and payment options (Admin → Languages and currencies).

Stored in ``platform_settings['regional']``. The books always stay in rupees (paise): prices, GST, commissions, payouts.
Other currencies are a view of those rupees at the admin's rate, and, when the admin chooses "charge in the shopper's
currency", Razorpay charges that currency (Razorpay international payments must be switched on for the account).

Rates are "units of the currency per one rupee" (USD 0.012 means ₹1 = $0.012). They are typed by the admin or kept up
to date from a free exchange-rate service (no key, no shopper data sent), refreshed at most once a day.
"""
from __future__ import annotations

import copy
import logging
import re
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import PlatformSetting

log = logging.getLogger("pixcart.regional")

KEY = "regional"
BASE = "INR"
RATES_URL = "https://open.er-api.com/v6/latest/INR"  # free, no key: "Rates by Exchange Rate API"

# ISO 4217 currencies whose smallest unit is not 1/100 (everything else has two decimals)
MINOR_DIGITS = {
    "BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
    "BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0, "PYG": 0, "RWF": 0, "UGX": 0,
    "UYI": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0,
}

# Shown first in the admin's "add a currency" list; any ISO code can be added.
POPULAR_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SAR", "QAR", "KWD", "OMR", "BHD", "SGD", "MYR", "THB", "IDR", "PHP",
                      "VND", "JPY", "CNY", "HKD", "KRW", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK", "PLN", "ZAR", "LKR",
                      "NPR", "BDT", "PKR", "MVR", "KES", "NGN", "EGP", "TRY", "BRL", "MXN", "RUB"]

# Languages offered in the admin's list (any BCP 47 code can be added); right-to-left ones are marked.
POPULAR_LANGUAGES = ["en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "pa", "or", "as", "ur", "ar", "fr", "de", "es", "pt",
                     "it", "nl", "ru", "tr", "zh", "ja", "ko", "id", "ms", "th", "vi", "fil", "si", "ne", "sw"]
RTL = {"ar", "ur", "fa", "he", "ps", "sd", "ug", "yi", "dv"}

PAY_METHODS = ("upi", "card", "netbanking", "wallet", "emi", "paylater")
CARD_NETWORKS = ("visa", "mastercard", "rupay", "amex", "diners", "maestro", "discover", "jcb")

DEFAULTS: dict[str, Any] = {
    # currencies: INR always on and the base; rate = units per rupee
    "currencies": [
        {"code": "INR", "rate": "1", "enabled": True, "auto": False},
        {"code": "USD", "rate": "0.012", "enabled": False, "auto": True},
        {"code": "EUR", "rate": "0.011", "enabled": False, "auto": True},
        {"code": "GBP", "rate": "0.0095", "enabled": False, "auto": True},
        {"code": "AED", "rate": "0.044", "enabled": False, "auto": True},
    ],
    "default_currency": "INR",
    "markup_bps": 0,            # added to converted prices (covers conversion costs), in basis points
    "charge_in": "base",        # "base": always charge rupees (other currencies are shown as an estimate) | "shopper"
    "auto_rates": True,         # refresh "auto" rates once a day
    "rates_updated_at": None,
    "rates_source": "",
    # languages: English is the site's own text; others are translated
    "languages": [
        {"code": "en", "enabled": True},
        {"code": "hi", "enabled": False},
        {"code": "ta", "enabled": False},
    ],
    "default_language": "en",
    "ai_translate": True,       # translate new text with the AI (Admin → AI providers); staff can correct any line
    "ai_translate_daily_max": 4000,
    "show_switcher": True,      # the language and currency picker in the shop's header and footer
    "detect_region": True,      # first visit: pick currency and language from the visitor's country
    "regions": [
        {"country": "IN", "currency": "INR", "language": "en"},
        {"country": "US", "currency": "USD", "language": "en"},
        {"country": "GB", "currency": "GBP", "language": "en"},
        {"country": "AE", "currency": "AED", "language": "en"},
    ],
    # payments (Razorpay): which ways to pay the payment window offers, card logos shown, saved cards
    "pay_methods": {m: True for m in PAY_METHODS},
    "card_networks": ["visa", "mastercard", "rupay", "amex", "diners"],
    "save_cards": True,
}

CODE = re.compile(r"^[A-Z]{3}$")
LANG = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$")
COUNTRY = re.compile(r"^[A-Z]{2}$")


def minor_digits(code: str) -> int:
    return MINOR_DIGITS.get(code, 2)


async def get_regional(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    out = copy.deepcopy(DEFAULTS)
    if row and isinstance(row.value, dict):
        out.update({k: v for k, v in row.value.items() if k in DEFAULTS})
        out["pay_methods"] = {**DEFAULTS["pay_methods"], **(row.value.get("pay_methods") or {})}
    return out


async def _save(session: AsyncSession, value: dict[str, Any]) -> None:
    row = await session.get(PlatformSetting, KEY)
    if row is None:
        session.add(PlatformSetting(key=KEY, value=value, updated_at=utcnow()))
    else:
        row.value = value
        row.updated_at = utcnow()


def _rate(v: Any) -> Decimal:
    try:
        d = Decimal(str(v))
    except Exception as exc:  # noqa: BLE001
        raise ApiError("Enter the exchange rate as a number, like 0.012", "invalid_rate") from exc
    if not d.is_finite() or d <= 0 or d > Decimal("1000000"):
        raise ApiError("The exchange rate must be more than 0", "invalid_rate")
    return d


def clean(body: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Checks what the admin sent; keeps the base currency and English on."""
    out = copy.deepcopy(current)
    if "currencies" in body:
        seen: dict[str, dict] = {}
        for c in body["currencies"] or []:
            code = str(c.get("code", "")).upper().strip()
            if not CODE.match(code):
                raise ApiError(f"{code or 'A currency'} is not a 3-letter currency code (like USD)", "invalid_currency")
            rate = Decimal(1) if code == BASE else _rate(c.get("rate"))
            seen[code] = {"code": code, "rate": format(rate.normalize(), "f"), "enabled": True if code == BASE else bool(c.get("enabled")),
                          "auto": False if code == BASE else bool(c.get("auto"))}
        seen.setdefault(BASE, {"code": BASE, "rate": "1", "enabled": True, "auto": False})
        out["currencies"] = [seen[BASE]] + [v for k, v in seen.items() if k != BASE]
    if "languages" in body:
        langs: dict[str, dict] = {}
        for item in body["languages"] or []:
            code = str(item.get("code", "")).strip()
            if not LANG.match(code):
                raise ApiError(f"{code or 'A language'} is not a language code (like ta or pt-BR)", "invalid_language")
            langs[code] = {"code": code, "enabled": True if code == "en" else bool(item.get("enabled"))}
        langs.setdefault("en", {"code": "en", "enabled": True})
        out["languages"] = [langs["en"]] + [v for k, v in langs.items() if k != "en"]
    for key in ("charge_in",):
        if key in body:
            if body[key] not in ("base", "shopper"):
                raise ApiError("Choose how to charge", "invalid_choice")
            out[key] = body[key]
    for key in ("auto_rates", "ai_translate", "show_switcher", "detect_region", "save_cards"):
        if key in body:
            out[key] = bool(body[key])
    if "markup_bps" in body:
        bps = int(body["markup_bps"] or 0)
        if not 0 <= bps <= 1000:
            raise ApiError("The conversion charge must be between 0% and 10%", "invalid_markup")
        out["markup_bps"] = bps
    if "ai_translate_daily_max" in body:
        n = int(body["ai_translate_daily_max"] or 0)
        if not 0 <= n <= 100000:
            raise ApiError("Daily translations must be between 0 and 100000", "invalid_number")
        out["ai_translate_daily_max"] = n
    if "pay_methods" in body:
        pm = {m: bool((body["pay_methods"] or {}).get(m, out["pay_methods"].get(m, True))) for m in PAY_METHODS}
        if not any(pm.values()):
            raise ApiError("Keep at least one way to pay online", "no_pay_method")
        out["pay_methods"] = pm
    if "card_networks" in body:
        out["card_networks"] = [n for n in CARD_NETWORKS if n in (body["card_networks"] or [])]
    enabled_cur = {c["code"] for c in out["currencies"] if c["enabled"]}
    enabled_lang = {lang["code"] for lang in out["languages"] if lang["enabled"]}
    if "default_currency" in body:
        out["default_currency"] = str(body["default_currency"] or BASE).upper()
    if "default_language" in body:
        out["default_language"] = str(body["default_language"] or "en")
    if out["default_currency"] not in enabled_cur:
        raise ApiError("The default currency must be switched on", "invalid_default")
    if out["default_language"] not in enabled_lang:
        raise ApiError("The default language must be switched on", "invalid_default")
    if "regions" in body:
        regions, seen_c = [], set()
        for r in body["regions"] or []:
            country = str(r.get("country", "")).upper().strip()
            if not COUNTRY.match(country):
                raise ApiError(f"{country or 'A region'} is not a 2-letter country code (like US)", "invalid_country")
            if country in seen_c:
                continue
            seen_c.add(country)
            cur, lang = str(r.get("currency", "")).upper(), str(r.get("language", ""))
            if cur not in {c["code"] for c in out["currencies"]}:
                raise ApiError(f"Add {cur} to the currencies first", "invalid_currency")
            if lang not in {x["code"] for x in out["languages"]}:
                raise ApiError(f"Add the language {lang} first", "invalid_language")
            regions.append({"country": country, "currency": cur, "language": lang})
        out["regions"] = regions
    return out


async def update(session: AsyncSession, body: dict[str, Any]) -> dict[str, Any]:
    out = clean(body, await get_regional(session))
    await _save(session, out)
    return out


async def refresh_rates(session: AsyncSession, *, force: bool = False) -> tuple[bool, str]:
    """Updates every "auto" rate from the exchange-rate service. Returns (changed, message)."""
    cfg = await get_regional(session)
    auto = [c for c in cfg["currencies"] if c.get("auto") and c["code"] != BASE]
    if not auto:
        return False, "No currency is set to update automatically"
    last = cfg.get("rates_updated_at")
    if not force and last:
        from datetime import datetime

        try:
            if utcnow() - datetime.fromisoformat(last) < timedelta(hours=20):
                return False, "Rates are up to date"
        except ValueError:
            pass
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=3.0)) as c:
            resp = await c.get(RATES_URL)
        data = resp.json()
        rates = data.get("rates") or {}
        if resp.status_code != 200 or data.get("result") != "success" or not rates:
            raise ValueError(data.get("error-type") or resp.status_code)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("exchange rates not refreshed: %s", exc)
        return False, "Could not reach the exchange-rate service. The current rates stay in use."
    missing = []
    for c in cfg["currencies"]:
        if c.get("auto") and c["code"] != BASE:
            if c["code"] in rates:
                c["rate"] = format(Decimal(str(rates[c["code"]])).normalize(), "f")
            else:
                missing.append(c["code"])
    cfg["rates_updated_at"] = utcnow().isoformat()
    cfg["rates_source"] = "Exchange Rate API (open.er-api.com)"
    await _save(session, cfg)
    msg = "Exchange rates updated" + (f". No rate for {', '.join(missing)}: set it by hand." if missing else "")
    return True, msg


def currency_rate(cfg: dict[str, Any], code: str) -> Decimal | None:
    """Units of the currency per rupee, with the admin's conversion charge; None if the currency is not switched on."""
    for c in cfg["currencies"]:
        if c["code"] == code and c["enabled"]:
            rate = Decimal(str(c["rate"]))
            if code != BASE and cfg.get("markup_bps"):
                rate = rate * (Decimal(1) + Decimal(cfg["markup_bps"]) / Decimal(10000))
            return rate
    return None


def convert_minor(paise: int, rate: Decimal, code: str) -> int:
    """Paise to the smallest unit of the currency (cents, fils...), rounded half up."""
    units = Decimal(paise) / Decimal(100) * rate
    return int((units * (Decimal(10) ** minor_digits(code))).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def charge_plan(cfg: dict[str, Any], currency: str | None, grand_total_paise: int) -> tuple[str, Decimal, int | None]:
    """What Razorpay charges for an online order: (currency, rate, amount in its smallest unit or None for rupees)."""
    code = (currency or BASE).upper()
    if cfg.get("charge_in") != "shopper" or code == BASE:
        return BASE, Decimal(1), None
    rate = currency_rate(cfg, code)
    if rate is None:
        return BASE, Decimal(1), None
    amount = convert_minor(grand_total_paise, rate, code)
    if amount <= 0:
        return BASE, Decimal(1), None
    return code, rate, amount


def public(cfg: dict[str, Any], country: str = "") -> dict[str, Any]:
    """What every page needs: the currencies and languages shoppers can pick, and the visitor's suggested choice."""
    currencies = []
    for c in cfg["currencies"]:
        if c["enabled"]:
            rate = currency_rate(cfg, c["code"]) or Decimal(1)
            currencies.append({"code": c["code"], "rate": float(rate), "digits": minor_digits(c["code"])})
    languages = [{"code": x["code"], "rtl": x["code"].split("-")[0] in RTL} for x in cfg["languages"] if x["enabled"]]
    suggest = {"currency": cfg["default_currency"], "language": cfg["default_language"]}
    country = (country or "").upper()
    if cfg.get("detect_region") and country:
        enabled_c = {c["code"] for c in currencies}
        enabled_l = {x["code"] for x in languages}
        for r in cfg["regions"]:
            if r["country"] == country:
                if r["currency"] in enabled_c:
                    suggest["currency"] = r["currency"]
                if r["language"] in enabled_l:
                    suggest["language"] = r["language"]
                break
    return {
        "base": BASE,
        "currencies": currencies,
        "languages": languages,
        "default_currency": cfg["default_currency"],
        "default_language": cfg["default_language"],
        "charge_in": cfg["charge_in"],
        "show_switcher": cfg["show_switcher"],
        "country": country,
        "suggest": suggest,
        "card_networks": cfg["card_networks"],
        "pay_methods": cfg["pay_methods"],
        "rates_updated_at": cfg.get("rates_updated_at"),
    }
