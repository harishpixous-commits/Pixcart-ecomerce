"""Sitemap for search engines (Admin -> Growth -> Search engines). Same output in the .NET version."""
from __future__ import annotations

from xml.sax.saxutils import escape

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Category, Product, Seller
from app.services import growth


async def sitemap_xml(session: AsyncSession, base: str) -> str | None:
    """None when staff switched the sitemap off."""
    cfg = (await growth.get(session))["seo"]
    if not cfg["sitemap_enabled"]:
        return None
    base = base.rstrip("/")
    urls = [base + "/"]
    if cfg["sitemap_include_categories"]:
        urls += [f"{base}/c/{s}" for s in (await session.execute(select(Category.slug).where(Category.is_active.is_(True)).order_by(Category.slug))).scalars()]
    urls += [f"{base}/p/{s}" for s in (await session.execute(select(Product.slug).where(Product.status == "approved").order_by(Product.slug).limit(50000))).scalars()]
    if cfg["sitemap_include_sellers"]:
        urls += [f"{base}/store/{s}" for s in (await session.execute(select(Seller.slug).where(Seller.status == "approved").order_by(Seller.slug))).scalars()]
    body = "".join(f"<url><loc>{escape(u)}</loc></url>" for u in urls)
    return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + body + "</urlset>"
