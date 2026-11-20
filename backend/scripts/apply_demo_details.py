"""Fill demo listings with the product information in scripts/demo_details.json (net quantity, manufacturer,
FSSAI licence, ingredients, specifications, highlights) and set what each demo category requires.

    python -m scripts.apply_demo_details            # update the database
    python -m scripts.apply_demo_details --dry-run  # only report what would change

seed --demo applies the same file to a fresh database. Listings are matched by exact title; everything
else is left alone. Sellers edit this information in the product editor, staff per category in
Admin → Categories (required product information).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal, engine
from app.models import Category, Product, Variant
from app.services.product_info import REQUIRABLE, ProductDetails

DETAILS_FILE = Path(__file__).with_name("demo_details.json")


def load() -> dict:
    return json.loads(DETAILS_FILE.read_text(encoding="utf-8"))


async def apply(session, *, dry_run: bool = False, verbose: bool = True) -> tuple[int, int]:
    data = load()
    cats = 0
    for name, required in data.get("categories", {}).items():
        bad = [k for k in required if k not in REQUIRABLE]
        if bad:
            raise SystemExit(f"{name}: unknown requirement {bad[0]}")
        for c in (await session.execute(select(Category).where(Category.name == name))).scalars():
            if not dry_run:
                c.required_details = [k for k in REQUIRABLE if k in required]
            cats += 1
    products = 0
    for title, info in data.get("products", {}).items():
        rows = (await session.execute(select(Product).where(Product.title == title))).scalars().all()
        if not rows and verbose:
            print(f"  no listing titled {title!r}")
        for p in rows:
            details = ProductDetails.model_validate(info.get("details", {})).model_dump()
            if not dry_run:
                p.details = details
                if info.get("specs"):
                    p.specs = info["specs"]
                if info.get("highlights"):
                    p.highlights = info["highlights"]
                if info.get("net_qty") is not None:
                    for v in (await session.execute(select(Variant).where(Variant.product_id == p.id))).scalars():
                        v.net_qty = info["net_qty"]
            products += 1
            if verbose:
                print(f"  {'would update' if dry_run else 'updated'} {title}")
    return cats, products


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if settings.environment == "production":
        sys.exit("Refusing to overwrite listings with demo information in production")
    async with SessionLocal() as session:
        cats, products = await apply(session, dry_run=args.dry_run)
        if not args.dry_run:
            await session.commit()
    await engine.dispose()
    print(f"{'Would set' if args.dry_run else 'Set'} requirements on {cats} categories and information on {products} listings")


if __name__ == "__main__":
    asyncio.run(main())
