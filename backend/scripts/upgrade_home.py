"""Adds the newer home page blocks to a store whose home page was set up by an earlier version.

    python -m scripts.upgrade_home            # add what is missing
    python -m scripts.upgrade_home --dry-run  # only list what would be added

It never removes or edits blocks an admin made, except to switch the first hero to the full-width "fade" style when it
has no style yet (the card row then rides up over it, as on large marketplaces). Everything stays editable in
Admin → Storefront → Home page.
"""
from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import func, select

from app.db import SessionLocal, engine
from app.models import HomeSection
from app.services.cms import validate_section

CARDS = {"cards": [
    {"title": "Keep shopping for", "link": "", "link_text": "View your browsing history", "mode": "recent"},
    {"title": "Today's top deals", "link": "/deals", "link_text": "See all deals", "mode": "products", "source": "deals_live"},
    {"title": "Bestsellers", "link": "/bestsellers", "link_text": "See more", "mode": "products", "source": "bestsellers"},
    {"title": "New on the store", "link": "/new-releases", "link_text": "Explore new arrivals", "mode": "products", "source": "new"},
]}

# kind, title, config, where it goes (position)
BLOCKS = [
    ("cards", "", CARDS, -5),
    ("deals", "Today's deals", {"limit": 12, "kind": ""}, 5),
    ("sponsored", "Sponsored products", {"limit": 10}, 25),
    ("inspired", "Inspired by your browsing history", {"limit": 12}, 35),
    ("buy_again", "Buy it again", {"limit": 12}, 36),
    ("signin", "", {"heading": "See personalised recommendations", "text": ""}, 1000),
]


async def upgrade(session, *, dry_run: bool = False) -> list[str]:
    done = []
    hero = (await session.execute(select(HomeSection).where(HomeSection.kind == "hero").order_by(HomeSection.position).limit(1))).scalar_one_or_none()
    if hero is not None and "style" not in (hero.config or {}):
        cfg = dict(hero.config)
        slides = [dict(s) for s in cfg.get("slides", [])]
        if slides and not slides[0].get("offer"):
            slides[0] |= {"offer": "10% off your first order with code WELCOME10", "note": "T&C apply"}
        cfg |= {"slides": slides, "style": "fade", "interval": 5}
        if not dry_run:
            hero.config = validate_section("hero", cfg)
        done.append("hero: full-width fade style")
    for kind, title, cfg, position in BLOCKS:
        exists = (await session.execute(select(func.count()).select_from(HomeSection).where(HomeSection.kind == kind))).scalar_one()
        if exists:
            continue
        if not dry_run:
            session.add(HomeSection(kind=kind, title=title, config=validate_section(kind, cfg), position=position, is_active=True, device="all"))
        done.append(f"added {kind}")
    return done


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    async with SessionLocal() as session:
        done = await upgrade(session, dry_run=args.dry_run)
        if not args.dry_run:
            await session.commit()
    await engine.dispose()
    print("\n".join(done) if done else "The home page already has every block")


if __name__ == "__main__":
    asyncio.run(main())
