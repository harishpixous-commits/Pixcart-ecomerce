"""Delivery estimates without a courier API: seller dispatch days + transit days by zone.

The zone comes from the PIN codes of the warehouse and the customer: same first three digits (same
sorting district) is 'city', same state is 'state', otherwise 'national'. The PIN → state table follows
the India Post circle allocation; it is used only for estimates, never for tax.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

# first two digits → state code; three-digit exceptions below override
_PIN2 = {
    "11": "07", "12": "06", "13": "06", "14": "03", "15": "03", "16": "03", "17": "02", "18": "01", "19": "01",
    "20": "09", "21": "09", "22": "09", "23": "09", "24": "09", "25": "09", "26": "09", "27": "09", "28": "09",
    "30": "08", "31": "08", "32": "08", "33": "08", "34": "08", "36": "24", "37": "24", "38": "24", "39": "24",
    "40": "27", "41": "27", "42": "27", "43": "27", "44": "27", "45": "23", "46": "23", "47": "23", "48": "23", "49": "22",
    "50": "36", "51": "37", "52": "37", "53": "37", "56": "29", "57": "29", "58": "29", "59": "29",
    "60": "33", "61": "33", "62": "33", "63": "33", "64": "33", "67": "32", "68": "32", "69": "32",
    "70": "19", "71": "19", "72": "19", "73": "19", "74": "19", "75": "21", "76": "21", "77": "21", "78": "18", "79": "18",
    "80": "10", "81": "10", "82": "10", "83": "20", "84": "10", "85": "10",
}
_PIN3 = {
    "160": "04", "194": "38", "246": "05", "247": "05", "248": "05", "249": "05", "262": "05", "263": "05",
    "396": "26", "403": "30", "605": "34", "607": "34", "609": "34", "673": "32", "682": "32", "737": "11", "744": "35",
    "790": "12", "791": "12", "792": "12", "793": "17", "794": "17", "795": "14", "796": "15", "797": "13", "798": "13", "799": "16",
    "813": "20", "814": "20", "815": "20", "816": "20", "820": "20", "821": "20", "822": "20", "825": "20", "826": "20",
    "827": "20", "828": "20", "829": "20", "831": "20", "832": "20", "833": "20", "834": "20", "835": "20", "490": "22", "491": "22",
    "492": "22", "493": "22", "494": "22", "495": "22", "496": "22", "497": "22",
}


def state_for_pin(pin: str) -> str | None:
    if len(pin) != 6 or not pin.isdigit():
        return None
    return _PIN3.get(pin[:3]) or _PIN2.get(pin[:2])


def zone(origin_pin: str, dest_pin: str, origin_state: str) -> str:
    if origin_pin[:3] == dest_pin[:3]:
        return "city"
    dest_state = state_for_pin(dest_pin)
    if dest_state and dest_state == origin_state:
        return "state"
    return "national"


def _add_working_days(start: datetime, days: int) -> datetime:
    d = start
    added = 0
    while added < days:
        d += timedelta(days=1)
        if d.weekday() != 6:  # couriers do not deliver on Sundays
            added += 1
    return d


def cutoff_minutes_left(cutoff: str, now: datetime) -> int | None:
    """Minutes until the seller's daily dispatch cut-off ("HH:MM" IST), or None when it has passed, it is
    Sunday or no cut-off is set."""
    if not cutoff:
        return None
    try:
        hh, mm = (int(x) for x in cutoff.split(":"))
    except ValueError:
        return None
    local = now.astimezone(IST)
    if local.weekday() == 6:
        return None
    left = (hh * 60 + mm) - (local.hour * 60 + local.minute)
    return left if left > 0 else None


def estimate(cfg: dict, dispatch_days: int, origin_pin: str, origin_state: str, dest_pin: str, now: datetime | None = None,
             cutoff: str = "") -> dict:
    """Expected delivery window. With a dispatch cut-off, an order placed after it (or on a Sunday) is
    packed a day later, and before it the customer sees how long is left to get the earlier date."""
    z = zone(origin_pin, dest_pin, origin_state)
    transit = {"city": cfg["transit_days_same_city"], "state": cfg["transit_days_same_state"], "national": cfg["transit_days_national"]}[z]
    start = (now or datetime.now(IST)).astimezone(IST)
    left = cutoff_minutes_left(cutoff, start)
    days = dispatch_days + transit + (1 if cutoff and left is None else 0)
    earliest = _add_working_days(start, days)
    latest = _add_working_days(start, days + (1 if z == "city" else 2))
    return {"zone": z, "min_date": earliest.date().isoformat(), "max_date": latest.date().isoformat(), "days_min": days,
            "order_within_min": left}
