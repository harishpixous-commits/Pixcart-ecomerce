"""Demo deals and sponsored-product campaigns, so Today's Deals, timers and "Sponsored" rails have something to show.

    python -m scripts.demo_promotions          # create them (skips what already exists)
    python -m scripts.demo_promotions --clear  # cancel the demo deals and end the demo campaigns

Listings are matched by title from the demo catalogue (scripts/seed.py). Deals are approved at once and start now
(one starts in 3 hours, to show "Upcoming"). Refuses to run in production.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import timedelta

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal, engine, utcnow
from app.models import AdCampaign, AdCampaignProduct, Deal, Product, Seller, Variant
from app.services import deals as deals_svc
from app.services.platform_settings import get_settings

# title, kind, % below the current price, hours (or days for "limited"), starts in hours
DEALS = [
    ("BassPods Wireless Earbuds with ANC", "lightning", 25, 6, 0),
    ("Stainless Steel Pressure Cooker 5 Litre", "deal_of_day", 20, 20, 0),
    ("Kanchipuram Art Silk Saree with Blouse Piece", "limited", 15, 7, 0),
    ("Cold Pressed Coconut Hair Oil 500ml", "limited", 15, 5, 0),
    ("FitPulse Smart Watch AMOLED Display", "limited", 20, 3, 0),
    ("20000mAh Power Bank 22.5W Fast Charge", "lightning", 30, 4, 0),
    ("Laptop Backpack 30L Water Resistant", "deal_of_day", 20, 18, 3),
]
# seller display name, campaign name, product titles, bid ₹, daily budget ₹, keywords
CAMPAIGNS = [
    ("Mumbai Home Store", "Kitchen essentials", ["Stainless Steel Pressure Cooker 5 Litre", "Non-Stick Cookware Set of 3 Induction Base", "Copper Water Bottle 1 Litre Leak Proof"], 4, 500, []),
    ("Bengaluru Gadget Hub", "Audio and accessories", ["BassPods Wireless Earbuds with ANC", "20000mAh Power Bank 22.5W Fast Charge", "Portable Bluetooth Speaker 20W Waterproof"], 6, 800,
     ["earbuds", "headphones", "power bank", "speaker", "charger"]),
    ("Chennai Silks & Co", "Festive wear", ["Kanchipuram Art Silk Saree with Blouse Piece", "Men's Cotton Kurta with Mandarin Collar"], 5, 400, ["saree", "kurta", "silk"]),
]


async def create(session) -> None:
    cfg = dict(await get_settings(session))
    cfg["deals_need_approval"] = False  # demo deals are approved at once
    cfg["feature_deals"] = True
    now = utcnow()
    made = 0
    for title, kind, pct, length, starts_in in DEALS:
        p = (await session.execute(select(Product).where(Product.title == title, Product.status == "approved"))).scalar_one_or_none()
        if p is None:
            print(f"  no live listing titled {title!r}")
            continue
        v = (await session.execute(select(Variant).where(Variant.product_id == p.id, Variant.is_active.is_(True), Variant.stock > 0)
                                   .order_by(Variant.price_paise))).scalars().first()
        if v is None:
            print(f"  {title}: out of stock, skipped")
            continue
        busy = (await session.execute(select(Deal.id).where(Deal.variant_id == v.id, Deal.status.in_(deals_svc.OPEN)))).first()
        if busy:
            continue
        seller = await session.get(Seller, p.seller_id)
        start = now + timedelta(hours=starts_in)
        end = start + (timedelta(days=length) if kind == "limited" else timedelta(hours=length))
        price = (v.price_paise * (100 - pct) // 100) // 100 * 100  # whole rupees
        qty = min(v.stock, 20) if kind == "lightning" else None
        await deals_svc.create(session, seller, cfg, variant_id=v.id, kind=kind, deal_price=price, starts_at=start, ends_at=end, qty_limit=qty)
        made += 1
    await deals_svc.sync(session, force=True)
    print(f"Deals created: {made}")

    camps = 0
    for seller_name, name, titles, bid, daily, keywords in CAMPAIGNS:
        seller = (await session.execute(select(Seller).where(Seller.display_name == seller_name))).scalar_one_or_none()
        if seller is None or (await session.execute(select(AdCampaign.id).where(AdCampaign.seller_id == seller.id, AdCampaign.name == name))).first():
            continue
        products = list((await session.execute(select(Product).where(Product.title.in_(titles), Product.seller_id == seller.id, Product.status == "approved"))).scalars())
        if not products:
            continue
        c = AdCampaign(seller_id=seller.id, name=name, status="active", placements=["search", "product", "home"], keywords=keywords,
                       bid_paise=bid * 100, daily_budget_paise=daily * 100, total_budget_paise=None, starts_at=now, ends_at=None, spend_paise=0, note="")
        session.add(c)
        await session.flush()
        for p in products:
            session.add(AdCampaignProduct(campaign_id=c.id, product_id=p.id))
        camps += 1
    print(f"Campaigns created: {camps}")


async def clear(session) -> None:
    titles = [t for t, *_ in DEALS]
    ids = list((await session.execute(select(Product.id).where(Product.title.in_(titles)))).scalars())
    for d in (await session.execute(select(Deal).where(Deal.product_id.in_(ids), Deal.status.in_(deals_svc.OPEN)))).scalars().all():
        await deals_svc.cancel(session, d, "Demo deal removed")
    for c in (await session.execute(select(AdCampaign).where(AdCampaign.name.in_([x[1] for x in CAMPAIGNS])))).scalars():
        c.status, c.note = "ended", "Demo campaign removed"
    print("Demo deals cancelled and campaigns ended")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clear", action="store_true")
    args = ap.parse_args()
    if settings.environment == "production":
        sys.exit("Refusing to create demo promotions in production")
    async with SessionLocal() as session:
        await (clear(session) if args.clear else create(session))
        await session.commit()
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
