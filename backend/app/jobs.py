"""Background jobs. Each run takes a Postgres advisory lock so only one app instance does the work."""
from __future__ import annotations

import logging
from datetime import timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import delete, text, update

from app.core.deps import prune_rate_limits
from app.db import SessionLocal, engine, utcnow
from app.models import OtpChallenge
from app.services.delivery import IST
from app.services.ledger import PAYOUT_RUN_IST, create_payouts, is_payout_day
from app.services.notify import dispatch_pending, notify_seller
from app.services.orders import (
    cancel_unconfirmed,
    expire_unpaid_orders,
    pending_refund_ids,
    process_refund,
)
from app.services.platform_settings import get_settings

log = logging.getLogger("pixcart.jobs")

_LOCK_EXPIRE = 7_201_001
_LOCK_REFUNDS = 7_201_002
_LOCK_CLEANUP = 7_201_003
_LOCK_NOTIFY = 7_201_004
_LOCK_UNCONFIRMED = 7_201_005
_LOCK_PAYOUTS = 7_201_006
_LOCK_SUMMARIES = 7_201_007
_LOCK_LOWSTOCK = 7_201_008
_LOCK_DEALS = 7_201_009
_LOCK_ADS = 7_201_010
_LOCK_ALERTS = 7_201_011
_LOCK_DELIVERY_SWEEP = 7_201_012
_LOCK_DELIVERY_ALERTS = 7_201_013
_LOCK_DELIVERY_PAYOUTS = 7_201_014


async def _with_lock(lock_id: int, fn) -> None:
    # The advisory lock lives on one dedicated connection held for the whole run; the work itself
    # uses ordinary sessions (which may commit and return their connections to the pool).
    async with engine.connect() as lock_conn:
        got = (await lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": lock_id})).scalar()
        await lock_conn.commit()
        if not got:
            return
        try:
            async with SessionLocal() as session:
                try:
                    await fn(session)
                except Exception:
                    log.exception("job %s failed", lock_id)
                    await session.rollback()
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": lock_id})
            await lock_conn.commit()


async def expire_job() -> None:
    async def run(session):
        n = await expire_unpaid_orders(session)
        if n:
            log.info("cancelled %d unpaid order(s)", n)

    await _with_lock(_LOCK_EXPIRE, run)


async def refunds_job() -> None:
    async def run(session):
        for rid in await pending_refund_ids(session):
            async with SessionLocal() as s2:
                await process_refund(s2, rid)

    await _with_lock(_LOCK_REFUNDS, run)


async def cleanup_job() -> None:
    async def run(session):
        await prune_rate_limits(session)
        await session.execute(delete(OtpChallenge).where(OtpChallenge.created_at < utcnow() - timedelta(days=2)))
        # Files given to the AI assistant are kept for 7 days only; stale action proposals expire.
        from app.models import AssistantAction, AssistantUpload

        await session.execute(delete(AssistantUpload).where(AssistantUpload.expires_at < utcnow()))
        await session.execute(update(AssistantAction).where(AssistantAction.status == "pending", AssistantAction.created_at < utcnow() - timedelta(hours=1)).values(status="expired"))
        await session.commit()

    await _with_lock(_LOCK_CLEANUP, run)


async def notify_job() -> None:
    await _with_lock(_LOCK_NOTIFY, dispatch_pending)


async def unconfirmed_job() -> None:
    async def run(session):
        n = await cancel_unconfirmed(session)
        if n:
            log.info("auto-cancelled %d unconfirmed package(s)", n)

    await _with_lock(_LOCK_UNCONFIRMED, run)


async def payouts_job() -> None:
    """Runs every day; pays only on the payout day set in Admin → Settings (weekday, every one or two weeks)."""
    async def run(session):
        cfg = await get_settings(session)
        if cfg["auto_payouts"] and is_payout_day(cfg, utcnow().astimezone(IST).date()):
            created = await create_payouts(session, min_amount=cfg["payout_min_paise"])
            await session.commit()
            log.info("scheduled payout run created %d payout(s)", len(created))

    await _with_lock(_LOCK_PAYOUTS, run)


async def review_summary_job() -> None:
    from sqlalchemy import select

    from app.models import Product, Review

    async def run(session):
        from app.ai import service as ai_service

        # Summaries are published on product pages, so they are written only by the real model, never the sandbox.
        if await ai_service.mode() != "live" or not await ai_service.available(session, "review_summary"):
            return
        products = list(
            (await session.execute(select(Product).where(Product.rating_count >= 5, Product.rating_count - Product.review_summary_count >= 5).limit(20))).scalars()
        )
        for p in products:
            rows = (await session.execute(select(Review.rating, Review.body).where(Review.product_id == p.id, Review.status == "published", Review.body != "").order_by(Review.created_at.desc()).limit(60))).all()
            if len(rows) < 3:
                continue
            try:
                run, out = await ai_service.run(session, "review_summary", actor=None, inputs={}, subject_id=str(p.id))
                p.review_summary, p.review_summary_count = out["text"], p.rating_count
                run.status, run.final_text = "applied", out["text"]
            except Exception as exc:  # keep the old summary; try again next hour
                log.warning("review summary for %s failed: %s", p.id, exc)
        await session.commit()

    await _with_lock(_LOCK_SUMMARIES, run)


async def low_stock_job() -> None:
    from sqlalchemy import func, select

    from app.models import Product, Variant

    async def run(session):
        rows = (
            await session.execute(
                select(Variant.seller_id, func.count()).join(Product, Product.id == Variant.product_id)
                .where(Variant.is_active.is_(True), Variant.stock <= 5, Product.status == "approved").group_by(Variant.seller_id)
            )
        ).all()
        for seller_id, count in rows:
            await notify_seller(session, seller_id, "low_stock", {"count": count}, link="/seller/inventory?low_stock=1")
        await session.commit()

    await _with_lock(_LOCK_LOWSTOCK, run)


async def deals_job() -> None:
    """Starts and ends deals on time (the selling price switches to and from the deal price)."""
    from app.services import deals

    async def run(session):
        if await deals.sync(session, force=True):
            await session.commit()

    await _with_lock(_LOCK_DEALS, run)


async def ads_billing_job() -> None:
    """Posts each finished day's sponsored-product spend to the sellers' ledgers."""
    from app.services import ads

    async def run(session):
        n = await ads.bill(session)
        if n:
            log.info("billed sponsored products for %d seller-day(s)", n)

    await _with_lock(_LOCK_ADS, run)


async def alerts_job() -> None:
    """Back-in-stock and wishlist price-drop alerts."""
    from app.services import engagement

    async def run(session):
        n = await engagement.send_stock_alerts(session) + await engagement.send_price_drops(session)
        if n:
            log.info("sent %d shopper alert(s)", n)

    await _with_lock(_LOCK_ALERTS, run)


async def delivery_sweep_job() -> None:
    """Delivery requests whose accept time ran out move to the next partner (or the admin queue)."""
    from app.services import fleet

    async def run(session):
        if await fleet.sweep(session):
            await session.commit()

    await _with_lock(_LOCK_DELIVERY_SWEEP, run)


async def delivery_alerts_job() -> None:
    """Tells staff about deliveries stuck in one step and packages nobody took."""
    from app.services import fleet

    async def run(session):
        if await fleet.stuck_check(session):
            await session.commit()

    await _with_lock(_LOCK_DELIVERY_ALERTS, run)


async def delivery_payouts_job() -> None:
    """Every Monday: last week's earnings for each delivery partner, ready for staff to pay."""
    from datetime import datetime

    from app.services import fleet

    async def run(session):
        n = await fleet.generate_payouts(session, datetime.now(fleet.IST).date() - timedelta(days=7))
        await session.commit()
        if n:
            log.info("created %d delivery partner payout(s)", n)

    await _with_lock(_LOCK_DELIVERY_PAYOUTS, run)


def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(delivery_sweep_job, "interval", seconds=10, id="delivery_sweep", max_instances=1, coalesce=True)
    scheduler.add_job(delivery_alerts_job, "interval", minutes=1, id="delivery_alerts", max_instances=1, coalesce=True)
    scheduler.add_job(delivery_payouts_job, "cron", day_of_week="mon", hour=4, minute=45, id="delivery_payouts", max_instances=1, coalesce=True)  # 10:15 IST
    scheduler.add_job(expire_job, "interval", minutes=2, id="expire_unpaid", max_instances=1, coalesce=True)
    scheduler.add_job(refunds_job, "interval", minutes=5, id="retry_refunds", max_instances=1, coalesce=True)
    scheduler.add_job(cleanup_job, "interval", hours=6, id="cleanup", max_instances=1, coalesce=True)
    scheduler.add_job(notify_job, "interval", seconds=30, id="notify", max_instances=1, coalesce=True)
    scheduler.add_job(unconfirmed_job, "interval", minutes=30, id="unconfirmed", max_instances=1, coalesce=True)
    scheduler.add_job(payouts_job, "cron", hour=PAYOUT_RUN_IST.hour, minute=PAYOUT_RUN_IST.minute, timezone=IST, id="payouts", max_instances=1, coalesce=True)
    scheduler.add_job(review_summary_job, "interval", hours=1, id="review_summaries", max_instances=1, coalesce=True)
    scheduler.add_job(low_stock_job, "cron", hour=3, minute=0, id="low_stock", max_instances=1, coalesce=True)  # 08:30 IST
    scheduler.add_job(deals_job, "interval", minutes=1, id="deals", max_instances=1, coalesce=True)
    scheduler.add_job(ads_billing_job, "interval", hours=1, id="ads_billing", max_instances=1, coalesce=True)
    scheduler.add_job(alerts_job, "interval", minutes=10, id="alerts", max_instances=1, coalesce=True)
    scheduler.start()
    return scheduler
