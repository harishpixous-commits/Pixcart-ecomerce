"""Admin-editable marketplace settings with safe defaults.

Statutory rates are settings, not constants, because they change by notification:
GST TCS (s.52 CGST Act) is 0.5% since 10 July 2024 (it was 1%), and income-tax TDS on
e-commerce operators is 0.1% since 1 October 2024 (it was 1%). Confirm with a CA before launch.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

DEFAULTS: dict[str, Any] = {
    "shipping_fee_paise": 4000,
    "free_shipping_threshold_paise": 49900,
    "cod_enabled": True,
    "cod_fee_paise": 0,
    "cod_max_order_paise": 5_000_000,
    "tcs_bps": 50,
    "tds_bps": 10,
    "commission_gst_bps": 1800,
    "max_qty_per_item": 10,
    # features customers and sellers see
    "feature_wishlist": True,
    "feature_reviews": True,
    "feature_returns": True,
    "feature_coupons": True,
    "feature_support": True,
    "reviews_need_approval": False,
    "auto_approve_returns": False,
    # delivery estimate (days in transit, added to the seller's dispatch days)
    "transit_days_same_city": 1,
    "transit_days_same_state": 3,
    "transit_days_national": 6,
    # orders
    "auto_cancel_unconfirmed_hours": 72,  # 0 = off; placed orders the seller never confirms
    # payouts
    "auto_payouts": False,
    "payout_weekday": 0,      # automatic payouts run at 10:00 IST on this day: 0 = Monday ... 6 = Sunday
    "payout_every_weeks": 1,  # 1 = every week, 2 = every second week
    # product page gallery
    "gallery_zoom": True,  # magnify the photo on hover (desktop)
    "gallery_zoom_level": 25,  # zoom ×10: 25 = 2.5×
    "feature_product_videos": True,  # sellers may add videos; the gallery shows them
    "max_video_mb": 50,
    "max_videos_per_listing": 3,
    "payout_min_paise": 10000,
    # product page modules (Admin → Product page)
    "pdp_unit_price": True,           # ₹ per 100 g / kg / piece beside the price
    "pdp_bought_count": True,         # "200+ bought in the past month"
    "pdp_bought_min": 10,             # units sold in 30 days before the line appears
    "pdp_bestseller_badge": True,     # "#1 Best seller in <category>"
    "pdp_offers": True,               # coupons that apply to this product, with copy-code
    "pdp_offers_max": 4,
    "pdp_service_icons": True,        # free delivery, cash on delivery, returns, secure payment, GST invoice
    "pdp_key_specs": True,            # up to 6 key specifications beside the price
    "pdp_delivery_countdown": True,   # "Order within 2 hrs 10 mins" when the seller has a dispatch cut-off
    "pdp_seller_snapshot": True,      # seller ratings, orders, on-time dispatch and years on the store
    "top_seller_min_rating_x10": 40,  # "Top seller" badge: rating at least 4.0 ...
    "top_seller_min_orders": 20,      # ... and this many orders in the last 90 days
    "pdp_customer_media": True,       # customer photos and videos under the gallery
    "pdp_share": True,
    "pdp_report": True,               # "Report an issue with this product"
    "pdp_ask_assistant": True,        # "Ask a question" opens the shop assistant about this product
    "pdp_sticky_bar": True,           # phones: price and buttons stay at the bottom while scrolling
    "pdp_similar": True,
    "pdp_recently_viewed": True,
    "header_pincode": True,           # "Deliver to <PIN>" in the site header
    "page_loading_bar": True,         # thin progress bar while a page loads
    # deals (Admin -> Deals)
    "feature_deals": True,
    "deals_need_approval": True,      # sellers' deals wait for staff before they run
    "deal_min_discount_pct": 10,      # a deal must be at least this much below the current selling price
    "deal_max_hours_lightning": 12,
    "deal_max_hours_day": 24,
    "deal_max_days_limited": 14,
    # sponsored products (Admin -> Advertising)
    "feature_ads": True,
    "ads_need_approval": True,
    "ads_min_bid_paise": 300,          # lowest cost per click a seller can bid
    "ads_min_daily_budget_paise": 10000,
    "ads_search": True,                # placements
    "ads_product": True,
    "ads_home": True,
    "ads_per_search": 2,               # sponsored results at the top of search results (0 = only the rail below)
    "ads_per_rail": 8,                 # products in a "Sponsored" rail
    # discovery pages
    "new_release_days": 45,            # "Hot new releases" = approved within this many days
    # questions and answers, alerts, compare, bought together (Admin -> Product page)
    "feature_qa": True,                # shoppers ask questions on product pages
    "qa_need_approval": False,         # questions and answers wait for staff before they appear
    "qa_buyers_answer_only": False,    # only the seller and verified buyers may answer
    "qa_report_hide_at": 3,            # reports from this many different shoppers hide a post until staff check it; 0 = never
    "feature_stock_alerts": True,      # "Notify me when it is back"
    "feature_price_alerts": True,      # wishlist price-drop alerts
    "price_alert_min_drop_pct": 10,
    "feature_compare": True,           # compare up to 4 products side by side
    "feature_bought_together": True,   # "Frequently bought together" from real orders
}

# key -> (type, min, max)
LIMITS: dict[str, tuple[type, int, int]] = {
    "shipping_fee_paise": (int, 0, 100_000),
    "free_shipping_threshold_paise": (int, 0, 10_000_000),
    "cod_enabled": (bool, 0, 1),
    "cod_fee_paise": (int, 0, 10_000),
    "cod_max_order_paise": (int, 0, 100_000_000),
    "tcs_bps": (int, 0, 100),
    "tds_bps": (int, 0, 500),
    "commission_gst_bps": (int, 0, 2800),
    "max_qty_per_item": (int, 1, 10),
    "feature_wishlist": (bool, 0, 1),
    "feature_reviews": (bool, 0, 1),
    "feature_returns": (bool, 0, 1),
    "feature_coupons": (bool, 0, 1),
    "feature_support": (bool, 0, 1),
    "reviews_need_approval": (bool, 0, 1),
    "auto_approve_returns": (bool, 0, 1),
    "transit_days_same_city": (int, 0, 15),
    "transit_days_same_state": (int, 0, 20),
    "transit_days_national": (int, 0, 30),
    "auto_cancel_unconfirmed_hours": (int, 0, 720),
    "auto_payouts": (bool, 0, 1),
    "payout_weekday": (int, 0, 6),
    "payout_every_weeks": (int, 1, 2),
    "gallery_zoom": (bool, 0, 1),
    "gallery_zoom_level": (int, 15, 40),
    "feature_product_videos": (bool, 0, 1),
    "max_video_mb": (int, 5, 200),
    "max_videos_per_listing": (int, 0, 10),
    "payout_min_paise": (int, 100, 10_000_000),
    "pdp_unit_price": (bool, 0, 1),
    "pdp_bought_count": (bool, 0, 1),
    "pdp_bought_min": (int, 1, 100_000),
    "pdp_bestseller_badge": (bool, 0, 1),
    "pdp_offers": (bool, 0, 1),
    "pdp_offers_max": (int, 1, 10),
    "pdp_service_icons": (bool, 0, 1),
    "pdp_key_specs": (bool, 0, 1),
    "pdp_delivery_countdown": (bool, 0, 1),
    "pdp_seller_snapshot": (bool, 0, 1),
    "top_seller_min_rating_x10": (int, 30, 50),
    "top_seller_min_orders": (int, 1, 100_000),
    "pdp_customer_media": (bool, 0, 1),
    "pdp_share": (bool, 0, 1),
    "pdp_report": (bool, 0, 1),
    "pdp_ask_assistant": (bool, 0, 1),
    "pdp_sticky_bar": (bool, 0, 1),
    "pdp_similar": (bool, 0, 1),
    "pdp_recently_viewed": (bool, 0, 1),
    "header_pincode": (bool, 0, 1),
    "page_loading_bar": (bool, 0, 1),
    "feature_deals": (bool, 0, 1),
    "deals_need_approval": (bool, 0, 1),
    "deal_min_discount_pct": (int, 1, 90),
    "deal_max_hours_lightning": (int, 1, 24),
    "deal_max_hours_day": (int, 1, 48),
    "deal_max_days_limited": (int, 1, 60),
    "feature_ads": (bool, 0, 1),
    "ads_need_approval": (bool, 0, 1),
    "ads_min_bid_paise": (int, 100, 100_000),
    "ads_min_daily_budget_paise": (int, 1000, 10_000_000),
    "ads_search": (bool, 0, 1),
    "ads_product": (bool, 0, 1),
    "ads_home": (bool, 0, 1),
    "ads_per_search": (int, 0, 6),
    "ads_per_rail": (int, 4, 20),
    "new_release_days": (int, 7, 180),
    "feature_qa": (bool, 0, 1),
    "qa_need_approval": (bool, 0, 1),
    "qa_buyers_answer_only": (bool, 0, 1),
    "qa_report_hide_at": (int, 0, 50),
    "feature_stock_alerts": (bool, 0, 1),
    "feature_price_alerts": (bool, 0, 1),
    "price_alert_min_drop_pct": (int, 1, 90),
    "feature_compare": (bool, 0, 1),
    "feature_bought_together": (bool, 0, 1),
}

PRODUCT_REPORT_REASONS = {
    "wrong_info": "Wrong or missing product information",
    "counterfeit": "Fake or counterfeit product",
    "unsafe": "Unsafe, expired or harmful",
    "prohibited": "Not allowed to be sold",
    "offensive": "Offensive images or text",
    "price": "Lower price elsewhere / misleading price",
    "other": "Something else",
}

RETURN_REASONS = {
    "damaged": "Item arrived damaged",
    "defective": "Item does not work",
    "wrong_item": "Received a different item",
    "not_as_described": "Not as described or shown",
    "size_fit": "Size or fit is not right",
    "missing_parts": "Parts or accessories missing",
    "quality": "Quality is not as expected",
}

_ROW_KEY = "marketplace"


async def get_settings(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, _ROW_KEY)
    merged = dict(DEFAULTS)
    if row:
        merged.update({k: v for k, v in row.value.items() if k in DEFAULTS})
    return merged


def validate_updates(updates: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in updates.items():
        if key not in LIMITS:
            raise ValueError(f"Unknown setting: {key}")
        typ, lo, hi = LIMITS[key]
        if typ is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true or false")
        else:
            if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                raise ValueError(f"{key} must be a whole number between {lo} and {hi}")
        clean[key] = value
    return clean


async def update_settings(session: AsyncSession, updates: dict[str, Any]) -> dict[str, Any]:
    clean = validate_updates(updates)
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == _ROW_KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=_ROW_KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get_settings(session)
