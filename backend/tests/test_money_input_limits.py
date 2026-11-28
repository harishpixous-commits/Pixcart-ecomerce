"""Money inputs on the staff screens: odd or huge values get a clear refusal, never a crash."""
import pytest
from tests.test_phase2_money import setup

ODD = [-1, 0, 10**12, 10**30, 2**63, 1.5, "abc", None, True, [], {}]


async def test_money_inputs_never_crash_and_huge_values_are_refused(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    bad = []
    base = {"code": "PROBE", "kind": "percent", "value": 10, "min_order_paise": 0, "show_on_checkout": False}
    for field in ("value", "min_order_paise", "max_discount_paise", "per_user_limit", "usage_limit"):
        for v in ODD:
            r = await admin.post("/api/admin/coupons", base | {"code": f"P{abs(hash((field, str(v)))) % 10**8}", field: v})
            if r.status_code >= 500:
                bad.append(("coupon", field, v, r.status_code))
    for kind in ("percent", "flat", "freeship", "x"):
        for v in (-5, 0, 101, 10**12, 9001):
            r = await admin.post("/api/admin/coupons", base | {"code": f"K{kind}{v}"[:20], "kind": kind, "value": v})
            if r.status_code >= 500 or (r.status_code == 201 and (v < 0 or v > 100_000_000 or (kind == "percent" and v > 9000))):
                bad.append(("coupon-kind", kind, v, r.status_code))
    for key in ("shipping_fee_paise", "free_shipping_threshold_paise", "cod_fee_paise", "max_qty_per_item", "shipping_per_kg_paise", "shipping_free_grams", "min_payout_paise"):
        for v in ODD:
            r = await admin.put("/api/admin/settings", {key: v})
            if r.status_code >= 500:
                bad.append(("settings", key, v, r.status_code))
            elif r.status_code == 200 and v in (-1, 10**12, 10**30, 2**63, "abc", [], {}):
                bad.append(("settings-accepted", key, v, 200))
    assert not bad, bad[:30]
