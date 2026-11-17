"""Money and tax arithmetic. All amounts are integer paise; all rates are basis points.

Prices shown to customers are GST-inclusive (as required for B2C display in India), so tax is
extracted from the inclusive amount. Every function here is pure so it can be unit-tested.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal


def apply_bps(amount: int, bps: int) -> int:
    """amount * bps / 10000, rounded half-up to the nearest paisa."""
    return int((Decimal(amount) * Decimal(bps) / Decimal(10000)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


@dataclass(frozen=True)
class GstSplit:
    taxable: int
    cgst: int
    sgst: int
    igst: int

    @property
    def tax(self) -> int:
        return self.cgst + self.sgst + self.igst


def split_inclusive_gst(gross: int, gst_bps: int, *, interstate: bool) -> GstSplit:
    """Split a GST-inclusive amount into taxable value and CGST/SGST or IGST.

    Invariant: taxable + cgst + sgst + igst == gross (no paisa is created or lost).
    """
    if gross < 0:
        raise ValueError("gross must be non-negative")
    taxable = int((Decimal(gross) * Decimal(10000) / Decimal(10000 + gst_bps)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    tax = gross - taxable
    if interstate:
        return GstSplit(taxable, 0, 0, tax)
    cgst = tax // 2
    return GstSplit(taxable, cgst, tax - cgst, 0)


@dataclass(frozen=True)
class Settlement:
    commission: int
    commission_gst: int
    tcs: int
    tds: int
    payout: int


def compute_settlement(
    *,
    gross: int,
    taxable: int,
    commission: int,
    commission_gst_bps: int,
    tcs_bps: int,
    tds_bps: int,
) -> Settlement:
    """Seller payout for one sub-order.

    - commission GST: GST on the platform's service (18% by default).
    - TCS (CGST Act s.52): on the net taxable value of supplies.
    - TDS (Income-tax s.194-O / s.393 of the 2025 Act): on the gross amount.
    """
    commission_gst = apply_bps(commission, commission_gst_bps)
    tcs = apply_bps(taxable, tcs_bps)
    tds = apply_bps(gross, tds_bps)
    payout = gross - commission - commission_gst - tcs - tds
    return Settlement(commission, commission_gst, tcs, tds, payout)


def rupees(paise: int) -> str:
    sign = "-" if paise < 0 else ""
    paise = abs(paise)
    return f"{sign}₹{paise // 100:,}.{paise % 100:02d}"
