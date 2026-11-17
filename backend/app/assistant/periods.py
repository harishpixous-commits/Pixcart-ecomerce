"""Turns "today", "last month" or two dates into exact IST time ranges.

The model passes a preset name (or explicit dates); the server does the calendar arithmetic so the
assistant never miscounts days. Every answer echoes the resolved range so a person can check it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from app.services.reports import IST

PRESETS = (
    "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days",
    "last_90_days", "this_quarter", "this_year", "this_financial_year", "last_financial_year", "custom",
)
MAX_DAYS = 731


@dataclass(frozen=True)
class Period:
    start: datetime  # inclusive, IST midnight
    end: datetime  # exclusive, IST midnight
    first_day: date
    last_day: date
    label: str
    preset: str

    @property
    def days(self) -> int:
        return (self.last_day - self.first_day).days + 1

    def previous(self) -> Period:
        """The same-length period just before this one (for "vs previous" comparisons)."""
        if self.preset == "this_month" or self.preset == "last_month":
            last = self.first_day - timedelta(days=1)
            first = last.replace(day=1)
            # Compare like with like: month-to-date against the same days of the previous month.
            if self.preset == "this_month":
                last = min(last, first + timedelta(days=self.days - 1))
            return make(first, last, "previous period", "custom")
        last = self.first_day - timedelta(days=1)
        return make(last - timedelta(days=self.days - 1), last, "previous period", "custom")

    def as_dict(self) -> dict:
        return {"label": self.label, "from": self.first_day.isoformat(), "to": self.last_day.isoformat(), "days": self.days, "timezone": "IST (UTC+05:30)"}


def today() -> date:
    return datetime.now(IST).date()


def make(first: date, last: date, label: str, preset: str) -> Period:
    return Period(datetime.combine(first, time.min, IST), datetime.combine(last + timedelta(days=1), time.min, IST), first, last, label, preset)


def _fmt(d: date) -> str:
    return d.strftime("%d %b %Y").lstrip("0")


def resolve(preset: str | None = None, date_from: str | None = None, date_to: str | None = None) -> Period:
    """Raises ValueError with a message the model can relay."""
    t = today()
    p = (preset or ("custom" if date_from or date_to else "last_30_days")).strip().lower()
    if p not in PRESETS:
        raise ValueError(f"Unknown period '{preset}'. Use one of: {', '.join(PRESETS)}")
    if p == "custom":
        try:
            first = date.fromisoformat(date_from) if date_from else None
            last = date.fromisoformat(date_to) if date_to else None
        except ValueError:
            raise ValueError("Dates must look like 2026-11-17") from None
        if first is None and last is None:
            raise ValueError("Give date_from and/or date_to for a custom period")
        first = first or last
        last = last or t
        if first > last:
            first, last = last, first
        if last > t:
            last = t
        if (last - first).days >= MAX_DAYS:
            raise ValueError(f"Ask for at most {MAX_DAYS} days at a time")
        label = _fmt(first) if first == last else f"{_fmt(first)} to {_fmt(last)}"
        return make(first, last, label, p)
    if p == "today":
        return make(t, t, f"Today, {_fmt(t)}", p)
    if p == "yesterday":
        y = t - timedelta(days=1)
        return make(y, y, f"Yesterday, {_fmt(y)}", p)
    if p == "this_week":
        first = t - timedelta(days=t.weekday())
        return make(first, t, f"This week ({_fmt(first)} to {_fmt(t)})", p)
    if p == "last_week":
        last = t - timedelta(days=t.weekday() + 1)
        first = last - timedelta(days=6)
        return make(first, last, f"Last week ({_fmt(first)} to {_fmt(last)})", p)
    if p == "this_month":
        first = t.replace(day=1)
        return make(first, t, f"{t:%B %Y} so far", p)
    if p == "last_month":
        last = t.replace(day=1) - timedelta(days=1)
        return make(last.replace(day=1), last, f"{last:%B %Y}", p)
    if p.startswith("last_") and p.endswith("_days"):
        n = int(p.split("_")[1])
        first = t - timedelta(days=n - 1)
        return make(first, t, f"Last {n} days ({_fmt(first)} to {_fmt(t)})", p)
    if p == "this_quarter":
        q_month = 3 * ((t.month - 1) // 3) + 1
        first = t.replace(month=q_month, day=1)
        return make(first, t, f"This quarter ({_fmt(first)} to {_fmt(t)})", p)
    if p == "this_year":
        first = t.replace(month=1, day=1)
        return make(first, t, f"{t.year} so far", p)
    fy_start_year = t.year if t.month >= 4 else t.year - 1
    if p == "this_financial_year":
        first = date(fy_start_year, 4, 1)
        return make(first, t, f"FY {fy_start_year}-{str(fy_start_year + 1)[2:]} so far", p)
    # last_financial_year
    first, last = date(fy_start_year - 1, 4, 1), date(fy_start_year, 3, 31)
    return make(first, last, f"FY {fy_start_year - 1}-{str(fy_start_year)[2:]}", p)
