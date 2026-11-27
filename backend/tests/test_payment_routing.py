"""Payment gateway routing rules (docs/PAYMENT_GATEWAYS.md sections 2 and 3)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.db import SessionLocal
from app.services import payment_routing as pr

NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
CFG = dict(pr.DEFAULTS)


def ev(g: str, ok: bool, secs_ago: int) -> pr.Event:
    return pr.Event(g, ok, NOW - timedelta(seconds=secs_ago))


def test_priority_order_skips_disabled_and_unsupported_currency():
    enabled = {"razorpay", "cashfree", "stripe"}
    assert pr.eligible(CFG, enabled, "INR", [], NOW) == ["razorpay", "cashfree", "stripe"]
    assert pr.eligible(CFG, enabled, "USD", [], NOW) == ["razorpay", "stripe"]  # cashfree charges INR only
    assert pr.eligible({**CFG, "order": ["stripe", "razorpay"]}, enabled, "INR", [], NOW) == ["stripe", "razorpay", "cashfree"]
    assert pr.eligible(CFG, set(), "INR", [], NOW) == []


def test_circuit_opens_after_n_failures_half_opens_after_cooldown_and_closes_on_success():
    three_fails = [ev("razorpay", False, s) for s in (10, 20, 30)]
    assert pr.circuit_state(three_fails, CFG, NOW) == "open"
    assert pr.eligible(CFG, {"razorpay", "payu"}, "INR", three_fails, NOW) == ["payu"]
    old = [ev("razorpay", False, s) for s in (200, 210, 220)]  # newest is older than the 120 s cool-down
    assert pr.circuit_state(old, CFG, NOW) == "half_open"
    assert pr.eligible(CFG, {"razorpay"}, "INR", old, NOW) == ["razorpay"]  # one attempt goes through
    assert pr.circuit_state(old + [ev("razorpay", True, 5)], CFG, NOW) == "closed"
    assert pr.circuit_state([ev("razorpay", False, 5), ev("razorpay", False, 6)], CFG, NOW) == "closed"  # fewer than 3 events


def test_success_rate_strategy_with_optimistic_default():
    cfg = {**CFG, "strategy": "success_rate", "min_samples": 5}
    events = [ev("razorpay", i % 2 == 0, 60 + i) for i in range(10)]  # 50 percent
    events += [ev("cashfree", True, 60 + i) for i in range(10)]  # 100 percent
    events += [ev("payu", False, 30), ev("payu", False, 31)]  # fewer than min_samples: counts as 1.0
    assert pr.eligible(cfg, {"razorpay", "cashfree", "payu"}, "INR", events, NOW) == ["cashfree", "payu", "razorpay"]
    assert pr.eligible({**cfg, "strategy": "priority"}, {"razorpay", "cashfree", "payu"}, "INR", events, NOW) == ["razorpay", "cashfree", "payu"]


def test_failover_off_tries_only_the_first():
    assert pr.to_try(CFG, ["razorpay", "payu"]) == ["razorpay", "payu"]
    assert pr.to_try({**CFG, "failover": False}, ["razorpay", "payu"]) == ["razorpay"]
    assert pr.to_try({**CFG, "failover": False}, []) == []


async def test_settings_validate_and_events_are_kept_and_pruned(client):
    async with SessionLocal() as s:
        assert (await pr.get(s)) == pr.DEFAULTS
        cfg = await pr.update(s, {"order": ["payu", "stripe"], "strategy": "success_rate", "timeout_seconds": 10})
        assert cfg["order"] == ["payu", "stripe"] and cfg["strategy"] == "success_rate" and cfg["timeout_seconds"] == 10
        for bad in ({"timeout_seconds": 2}, {"order": ["razorpay", "razorpay"]}, {"order": ["nope"]}, {"strategy": "x"}, {"failover": 1}, {"x": 1}):
            with pytest.raises(pr.RoutingError):
                await pr.update(s, bad)
        await pr.record(s, "razorpay", False, 8001, "x" * 400)
        evs = await pr.recent_events(s)
        assert len(evs) == 1 and evs[0].gateway == "razorpay" and not evs[0].ok
        await s.commit()
