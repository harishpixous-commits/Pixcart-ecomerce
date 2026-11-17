"""Replace the photos of existing demo listings with the ones in scripts/demo_images/manifest.json.

    python -m scripts.apply_demo_images            # every product named in the manifest
    python -m scripts.apply_demo_images --dry-run  # only report what would change

Use it after editing the manifest (swap a `file`, or add a `url` to download a new photo) to update a
database that was seeded earlier, without re-seeding. Listings are matched by exact title; products
not in the manifest are left alone. Photos can also be changed one listing at a time in the admin
panel (Products, open a listing, Photos) or by the seller in the seller panel.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

from sqlalchemy import delete, select

from app.config import settings
from app.db import SessionLocal, engine
from app.models import Product, ProductImage
from app.services import storage
from scripts.seed import DEMO_IMAGES_DIR, demo_photos


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if settings.environment == "production":
        sys.exit("Refusing to replace listing photos with demo photos in production")
    titles = json.loads((DEMO_IMAGES_DIR / "manifest.json").read_text(encoding="utf-8")).get("products", {})
    updated = missing = 0
    async with SessionLocal() as session:
        for title in titles:
            products = (await session.execute(select(Product).where(Product.title == title))).scalars().all()
            if not products:
                missing += 1
                print(f"  no listing titled {title!r}")
                continue
            photos = demo_photos(title)
            if not photos:
                continue
            for p in products:
                print(f"  {title}: {len(photos)} photos")
                if args.dry_run:
                    continue
                await session.execute(delete(ProductImage).where(ProductImage.product_id == p.id))
                for k, data in enumerate(photos):
                    url = await storage.save_image(data, "products")
                    session.add(ProductImage(product_id=p.id, url=url, position=k))
                updated += 1
        if not args.dry_run:
            await session.commit()
    await engine.dispose()
    print(f"{'Would update' if args.dry_run else 'Updated'} {updated} listings; {missing} manifest titles had no listing")


if __name__ == "__main__":
    asyncio.run(main())
