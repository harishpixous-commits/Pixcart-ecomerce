"""Product information beyond title and specifications: the Legal Metrology declarations an online
marketplace must show for packaged goods (generic name, net quantity, unit sale price, manufacturer /
packer / importer, consumer care, country of origin), food details (FSSAI licence, ingredients, shelf
life) and the "important information" customers look for (directions, safety, warranty, what's in the box).

Admins choose per category which of these a listing must have before it can be submitted
(``Category.required_details``; sub-categories inherit their parents' list).
"""
from __future__ import annotations

import re
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# unit -> (label shown after the quantity)
NET_UNITS: dict[str, str] = {"g": "g", "kg": "kg", "ml": "ml", "l": "l", "m": "m", "pcs": "pcs", "pair": "pair"}

# What a category can make compulsory. Order = order in the admin and seller screens.
REQUIRABLE: dict[str, str] = {
    "brand": "Brand",
    "net_quantity": "Net quantity (for the unit price)",
    "generic_name": "Generic name of the product",
    "manufacturer": "Manufacturer name and address",
    "packer": "Packer name and address",
    "importer": "Importer name and address (imported goods only)",
    "customer_care": "Consumer care details",
    "fssai_license": "FSSAI licence number",
    "ingredients": "Ingredients",
    "directions": "Directions for use",
    "safety_info": "Safety information",
    "shelf_life": "Best before / shelf life",
    "warranty": "Warranty",
    "dimensions": "Product dimensions",
    "in_the_box": "What's in the box",
}

_TEXT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _clean(v: str) -> str:
    return _TEXT.sub("", v or "").strip()


class ProductDetails(BaseModel):
    """Stored in ``Product.details``. Every field is optional unless the category requires it."""

    model_config = ConfigDict(extra="ignore")

    net_unit: Literal["", "g", "kg", "ml", "l", "m", "pcs", "pair"] = ""
    generic_name: str = Field(default="", max_length=120)
    model_number: str = Field(default="", max_length=60)
    manufacturer: str = Field(default="", max_length=400)
    packer: str = Field(default="", max_length=400)
    importer: str = Field(default="", max_length=400)
    customer_care: str = Field(default="", max_length=300)
    fssai_license: str = Field(default="", max_length=14)
    ingredients: str = Field(default="", max_length=2000)
    directions: str = Field(default="", max_length=2000)
    safety_info: str = Field(default="", max_length=2000)
    legal_disclaimer: str = Field(default="", max_length=1000)
    shelf_life: str = Field(default="", max_length=80)
    warranty: str = Field(default="", max_length=300)
    in_the_box: list[str] = Field(default_factory=list, max_length=20)
    length_cm: float | None = Field(default=None, gt=0, le=10_000)
    width_cm: float | None = Field(default=None, gt=0, le=10_000)
    height_cm: float | None = Field(default=None, gt=0, le=10_000)
    key_specs: list[str] = Field(default_factory=list, max_length=6)  # specification names shown beside the price

    @field_validator("generic_name", "model_number", "manufacturer", "packer", "importer", "customer_care", "ingredients",
                     "directions", "safety_info", "legal_disclaimer", "shelf_life", "warranty")
    @classmethod
    def _strip(cls, v: str) -> str:
        return _clean(v)

    @field_validator("fssai_license")
    @classmethod
    def _fssai(cls, v: str) -> str:
        v = re.sub(r"\s+", "", v or "")
        if v and not re.fullmatch(r"\d{14}", v):
            raise ValueError("An FSSAI licence or registration number has 14 digits")
        return v

    @field_validator("in_the_box", "key_specs")
    @classmethod
    def _items(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for x in v:
            x = _clean(str(x))[:120]
            if x and x not in out:
                out.append(x)
        return out


def details_of(raw: dict | None) -> ProductDetails:
    """Stored details (possibly from an older version) as a model; unknown keys are dropped."""
    try:
        return ProductDetails.model_validate(raw or {})
    except Exception:  # noqa: BLE001 - never break a product page over one bad stored value
        return ProductDetails()


def fmt_qty(qty: Decimal | float | None, unit: str) -> str:
    if qty is None or not unit:
        return ""
    return f"{format(Decimal(str(qty)).normalize(), 'f')} {NET_UNITS.get(unit, unit)}"


def unit_price(price_paise: int, qty: Decimal | float | None, unit: str) -> dict | None:
    """Unit sale price, e.g. ₹420 per 100 g for ₹210 / 50 g. Small packs are priced per 100 g / 100 ml,
    a kilogram or litre and above per kg / l, countable goods per piece or pair."""
    if not qty or not unit or price_paise <= 0:
        return None
    q = Decimal(str(qty))
    if q <= 0:
        return None
    if unit == "g":
        base, per = (Decimal(1000), "kg") if q >= 1000 else (Decimal(100), "100 g")
    elif unit == "ml":
        base, per = (Decimal(1000), "l") if q >= 1000 else (Decimal(100), "100 ml")
    elif unit in ("kg", "l", "m"):
        base, per = Decimal(1), unit
    elif unit in ("pcs", "pair"):
        base, per = Decimal(1), "piece" if unit == "pcs" else "pair"
    else:
        return None
    return {"paise": int((Decimal(price_paise) * base / q).quantize(Decimal(1))), "per": per}


def effective_required(categories: list[Any]) -> list[str]:
    """The union of the required lists of a category and its parents (pass the chain, any order)."""
    out: list[str] = []
    for c in categories:
        for k in c.required_details or []:
            if k in REQUIRABLE and k not in out:
                out.append(k)
    return [k for k in REQUIRABLE if k in out]


def missing_required(required: list[str], *, brand: str, country_of_origin: str, details: ProductDetails,
                     net_qtys: list[Any]) -> list[str]:
    """Labels of the required items this listing does not have yet."""
    missing = []
    for key in required:
        if key == "brand":
            ok = bool(brand.strip())
        elif key == "net_quantity":
            ok = bool(details.net_unit) and bool(net_qtys) and all(q is not None and Decimal(str(q)) > 0 for q in net_qtys)
        elif key == "importer":
            ok = country_of_origin.strip().lower() == "india" or bool(details.importer)
        elif key == "dimensions":
            ok = all(x is not None for x in (details.length_cm, details.width_cm, details.height_cm))
        elif key == "in_the_box":
            ok = bool(details.in_the_box)
        else:
            ok = bool(str(getattr(details, key, "")).strip())
        if not ok:
            missing.append(REQUIRABLE[key])
    return missing


def info_rows(details: ProductDetails, *, brand: str, country_of_origin: str) -> list[dict]:
    """Rows for the product page's "Product information" table (net quantity is per variant, added there)."""
    rows: list[tuple[str, str]] = [
        ("Brand", brand),
        ("Generic name", details.generic_name),
        ("Model number", details.model_number),
    ]
    if all(x is not None for x in (details.length_cm, details.width_cm, details.height_cm)):
        dims = " × ".join(f"{x:g}" for x in (details.length_cm, details.width_cm, details.height_cm))
        rows.append(("Dimensions (L × W × H)", f"{dims} cm"))
    rows += [
        ("Country of origin", country_of_origin),
        ("Manufacturer", details.manufacturer),
        ("Packer", details.packer),
        ("Importer", details.importer),
        ("Consumer care", details.customer_care),
        ("FSSAI licence", details.fssai_license),
        ("Best before", details.shelf_life),
        ("Warranty", details.warranty),
        ("In the box", ", ".join(details.in_the_box)),
    ]
    return [{"label": k, "value": v} for k, v in rows if v]


def important_info(details: ProductDetails) -> list[dict]:
    items = [("Ingredients", details.ingredients), ("Directions for use", details.directions),
             ("Safety information", details.safety_info), ("Legal disclaimer", details.legal_disclaimer)]
    return [{"title": t, "text": x} for t, x in items if x]
