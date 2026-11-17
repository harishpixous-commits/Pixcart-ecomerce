"""Indian identifier validation: mobile, PIN code, PAN, GSTIN (with checksum), IFSC, state codes."""
from __future__ import annotations

import re

STATES: dict[str, str] = {
    "01": "Jammu and Kashmir",
    "02": "Himachal Pradesh",
    "03": "Punjab",
    "04": "Chandigarh",
    "05": "Uttarakhand",
    "06": "Haryana",
    "07": "Delhi",
    "08": "Rajasthan",
    "09": "Uttar Pradesh",
    "10": "Bihar",
    "11": "Sikkim",
    "12": "Arunachal Pradesh",
    "13": "Nagaland",
    "14": "Manipur",
    "15": "Mizoram",
    "16": "Tripura",
    "17": "Meghalaya",
    "18": "Assam",
    "19": "West Bengal",
    "20": "Jharkhand",
    "21": "Odisha",
    "22": "Chhattisgarh",
    "23": "Madhya Pradesh",
    "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu",
    "27": "Maharashtra",
    "29": "Karnataka",
    "30": "Goa",
    "31": "Lakshadweep",
    "32": "Kerala",
    "33": "Tamil Nadu",
    "34": "Puducherry",
    "35": "Andaman and Nicobar Islands",
    "36": "Telangana",
    "37": "Andhra Pradesh",
    "38": "Ladakh",
}

_MOBILE = re.compile(r"^[6-9]\d{9}$")
_PIN = re.compile(r"^[1-9]\d{5}$")
_PAN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_GSTIN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
_ACCOUNT = re.compile(r"^\d{9,18}$")
_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def normalize_mobile(value: str) -> str:
    """Accepts '98765 43210', '+91-9876543210', '09876543210'; returns 10 digits or raises."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not _MOBILE.match(digits):
        raise ValueError("Enter a valid 10-digit Indian mobile number")
    return digits


def validate_pincode(value: str) -> str:
    v = (value or "").strip()
    if not _PIN.match(v):
        raise ValueError("Enter a valid 6-digit PIN code")
    return v


def validate_state_code(value: str) -> str:
    v = (value or "").strip().zfill(2)
    if v not in STATES:
        raise ValueError("Choose a valid state")
    return v


def validate_pan(value: str) -> str:
    v = (value or "").strip().upper()
    if not _PAN.match(v):
        raise ValueError("Enter a valid PAN (e.g. ABCDE1234F)")
    return v


def gstin_check_char(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        value = _GSTIN_CHARS.index(ch)
        product = value * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _GSTIN_CHARS[(36 - total % 36) % 36]


def validate_gstin(value: str) -> str:
    v = (value or "").strip().upper()
    if not _GSTIN.match(v):
        raise ValueError("Enter a valid 15-character GSTIN")
    if v[:2] not in STATES:
        raise ValueError("GSTIN state code is not valid")
    if gstin_check_char(v[:14]) != v[14]:
        raise ValueError("GSTIN check digit does not match; please re-check the number")
    return v


def validate_ifsc(value: str) -> str:
    v = (value or "").strip().upper()
    if not _IFSC.match(v):
        raise ValueError("Enter a valid IFSC (e.g. SBIN0001234)")
    return v


def validate_account_number(value: str) -> str:
    v = re.sub(r"\s", "", value or "")
    if not _ACCOUNT.match(v):
        raise ValueError("Bank account number must be 9 to 18 digits")
    return v


def slugify(value: str, max_len: int = 80) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return (s[:max_len].rstrip("-")) or "item"
