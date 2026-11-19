"""Seed the category tree (safe to re-run) and, with --demo, demo sellers, products and a customer.

    python -m scripts.seed            # categories only (production)
    python -m scripts.seed --demo     # + demo data for local testing (NEVER in production)

Commission and GST defaults are starting points that sellers/admins can change per listing;
confirm GST rates for your goods with a CA (rates were restructured on 22 September 2025).
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import random
import sys
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import select

from app.config import settings
from app.core.security import encrypt_field
from app.core.validators import gstin_check_char, slugify
from app.db import SessionLocal, engine, utcnow
from app.models import (
    Category,
    Coupon,
    HomeSection,
    MediaAsset,
    Product,
    ProductImage,
    Seller,
    User,
    Variant,
)
from app.services import inventory, storage
from app.services.catalog import refresh_product_aggregates
from app.services.cms import ensure_default_sections

# name -> (commission_bps, default_gst_bps, children)
TREE: dict[str, tuple[int, int, dict]] = {
    "Mobiles & Electronics": (800, 1800, {
        "Mobiles": (500, 1800, {}),
        "Mobile Accessories": (1500, 1800, {}),
        "Laptops": (600, 1800, {}),
        "Headphones & Speakers": (1200, 1800, {}),
        "Smart Watches": (1200, 1800, {}),
    }),
    "Fashion": (1500, 500, {
        "Men's Clothing": (1500, 500, {}),
        "Women's Clothing": (1700, 500, {}),
        "Kids' Clothing": (1500, 500, {}),
        "Footwear": (1500, 500, {}),
        "Bags & Accessories": (1500, 1800, {}),
    }),
    "Home & Kitchen": (1200, 1800, {
        "Kitchen & Dining": (1200, 1800, {}),
        "Home Decor": (1500, 1800, {}),
        "Home Furnishing": (1300, 500, {}),
    }),
    "Beauty & Personal Care": (1200, 1800, {
        "Skincare": (1200, 1800, {}),
        "Haircare": (1200, 500, {}),
        "Fragrances": (1400, 1800, {}),
    }),
    "Grocery": (600, 500, {
        "Staples": (500, 500, {}),
        "Snacks & Beverages": (800, 500, {}),
    }),
    "Books": (800, 0, {}),
    "Toys & Baby": (1200, 500, {}),
    "Sports & Fitness": (1200, 1800, {}),
}


async def seed_categories(session) -> dict[str, Category]:
    out: dict[str, Category] = {}

    async def upsert(name: str, parent: Category | None, bps: int, gst: int, pos: int) -> Category:
        slug = slugify(name)
        cat = (await session.execute(select(Category).where(Category.slug == slug))).scalar_one_or_none()
        if cat is None:
            cat = Category(name=name, slug=slug, parent_id=parent.id if parent else None, commission_bps=bps, default_gst_bps=gst, position=pos)
            session.add(cat)
            await session.flush()
        out[name] = cat
        return cat

    for i, (name, (bps, gst, children)) in enumerate(TREE.items()):
        parent = await upsert(name, None, bps, gst, i)
        for j, (cname, (cbps, cgst, _)) in enumerate(children.items()):
            await upsert(cname, parent, cbps, cgst, j)
    await session.commit()
    return out


DEMO_IMAGES_DIR = Path(__file__).parent / "demo_images"


def demo_photos(title: str) -> list[bytes]:
    """Real product photos for a demo listing, from demo_images/manifest.json (keyed by title).

    Each entry has a `file` in demo_images/ and optionally a `url`: when the file is missing and a
    url is given, the photo is downloaded and saved as that file, so swapping a photo is a one-line
    edit. Returns [] when the title has no entry (the caller then draws a placeholder)."""
    manifest = DEMO_IMAGES_DIR / "manifest.json"
    if not manifest.exists():
        return []
    entries = json.loads(manifest.read_text(encoding="utf-8")).get("products", {}).get(title, [])
    out = []
    for e in entries:
        path = DEMO_IMAGES_DIR / e["file"]
        if not path.exists() and e.get("url"):
            r = httpx.get(e["url"], follow_redirects=True, timeout=60, headers={"User-Agent": "PixCartDemoImageSeeder/1.0"})
            r.raise_for_status()
            path.write_bytes(r.content)
        if path.exists():
            out.append(path.read_bytes())
        else:
            print(f"  missing demo photo {e['file']} for {title!r}; skipped")
    return out


PALETTE = [(37, 99, 235), (219, 39, 119), (5, 150, 105), (217, 119, 6), (124, 58, 237), (14, 116, 144), (190, 18, 60), (71, 85, 105)]


def demo_image(title: str, color: tuple[int, int, int], variant: int = 0) -> bytes:
    w = h = 800
    img = Image.new("RGB", (w, h), (248, 250, 252))
    d = ImageDraw.Draw(img)
    light = tuple(min(255, c + 150) for c in color)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(light[i] * (1 - t) + 255 * t) for i in range(3)))
    shape = (variant + len(title)) % 3
    box = (200, 170, 600, 570)
    if shape == 0:
        d.rounded_rectangle(box, radius=60, fill=color)
    elif shape == 1:
        d.ellipse(box, fill=color)
    else:
        d.polygon([(400, 160), (610, 560), (190, 560)], fill=color)
    try:
        font = ImageFont.load_default(size=44)
    except TypeError:
        font = ImageFont.load_default()
    words = title.split()
    line1, line2 = " ".join(words[:3]), " ".join(words[3:6])
    for i, line in enumerate((line1, line2)):
        if line:
            tw = d.textlength(line, font=font)
            d.text(((w - tw) / 2, 620 + i * 56), line, fill=(30, 41, 59), font=font)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


DEMO_SELLERS = [
    ("Chennai Silks & Co", "CSILK4321C", "33", "Chennai", "600017"),
    ("Bengaluru Gadget Hub", "BGHUB4321B", "29", "Bengaluru", "560095"),
    ("Mumbai Home Store", "MHOME4321M", "27", "Mumbai", "400050"),
]

DEMO_PRODUCTS = [
    # seller idx, category, title, brand, mrp, price, gst, options
    (1, "Mobiles", "Nova X5 5G Smartphone 8GB RAM 128GB", "Nova", 2499900, 1899900, 1800, {"Colour": ["Midnight Black", "Ocean Blue"]}),
    (1, "Mobiles", "Pixelon P3 Pro 5G 12GB RAM 256GB", "Pixelon", 3999900, 3249900, 1800, {"Colour": ["Graphite", "Silver"]}),
    (1, "Mobile Accessories", "Braided USB-C Fast Charging Cable 1.5m", "VoltLine", 79900, 29900, 1800, {}),
    (1, "Mobile Accessories", "20000mAh Power Bank 22.5W Fast Charge", "VoltLine", 249900, 139900, 1800, {}),
    (1, "Headphones & Speakers", "BassPods Wireless Earbuds with ANC", "SoundCraft", 499900, 199900, 1800, {"Colour": ["Black", "White"]}),
    (1, "Headphones & Speakers", "Portable Bluetooth Speaker 20W Waterproof", "SoundCraft", 399900, 249900, 1800, {}),
    (1, "Smart Watches", "FitPulse Smart Watch AMOLED Display", "FitPulse", 699900, 299900, 1800, {"Strap": ["Black", "Olive"]}),
    (1, "Laptops", "AirBook 14 Laptop Ryzen 5 16GB 512GB SSD", "AirBook", 7499900, 5699900, 1800, {}),
    (0, "Men's Clothing", "Men's Pure Cotton Slim Fit Casual Shirt", "Kavi", 149900, 69900, 500, {"Size": ["S", "M", "L", "XL"]}),
    (0, "Men's Clothing", "Men's Cotton Kurta with Mandarin Collar", "Kavi", 199900, 99900, 500, {"Size": ["M", "L", "XL"]}),
    (0, "Women's Clothing", "Kanchipuram Art Silk Saree with Blouse Piece", "Chennai Silks", 699900, 289900, 500, {"Colour": ["Maroon", "Teal", "Mustard"]}),
    (0, "Women's Clothing", "Women's Rayon Printed Straight Kurta", "Aadhya", 129900, 54900, 500, {"Size": ["S", "M", "L", "XL"]}),
    (0, "Kids' Clothing", "Kids Cotton T-Shirt and Shorts Set", "LittleOne", 89900, 44900, 500, {"Age": ["2-3Y", "4-5Y", "6-7Y"]}),
    (0, "Footwear", "Men's Running Shoes Lightweight Mesh", "Stride", 299900, 129900, 500, {"Size": ["7", "8", "9", "10"]}),
    (0, "Bags & Accessories", "Laptop Backpack 30L Water Resistant", "Carryall", 249900, 99900, 1800, {}),
    (2, "Kitchen & Dining", "Stainless Steel Pressure Cooker 5 Litre", "HomeChef", 349900, 219900, 1800, {}),
    (2, "Kitchen & Dining", "Non-Stick Cookware Set of 3 Induction Base", "HomeChef", 299900, 149900, 1800, {}),
    (2, "Kitchen & Dining", "Copper Water Bottle 1 Litre Leak Proof", "Tamra", 99900, 59900, 1800, {}),
    (2, "Home Decor", "Handcrafted Brass Diya Set of 4", "Utsav", 129900, 64900, 1800, {}),
    (2, "Home Furnishing", "Cotton Double Bedsheet with 2 Pillow Covers", "SleepWell", 179900, 79900, 500, {"Colour": ["Blue", "Beige"]}),
    (2, "Skincare", "Vitamin C Face Serum 30ml", "Glowveda", 69900, 44900, 1800, {}),
    (2, "Haircare", "Cold Pressed Coconut Hair Oil 500ml", "Kerala Naturals", 39900, 29900, 500, {}),
    (2, "Staples", "Organic Ponni Raw Rice 5kg", "FarmFresh", 59900, 47900, 500, {}),
    (2, "Snacks & Beverages", "Filter Coffee Powder 500g 80:20", "Kumbakonam Brew", 39900, 32900, 500, {}),
    (1, "Sports & Fitness", "Anti-Skid Yoga Mat 6mm with Strap", "FlexFit", 149900, 59900, 1800, {"Colour": ["Purple", "Green"]}),
    (2, "Books", "The Complete Guide to Indian Cooking", "Penmark", 59900, 44900, 0, {}),
]


def _combos(options: dict[str, list[str]]) -> list[dict[str, str]]:
    combos: list[dict[str, str]] = [{}]
    for k, vals in options.items():
        combos = [{**c, k: v} for c in combos for v in vals]
    return combos


async def seed_demo(session, cats: dict[str, Category]) -> None:
    rnd = random.Random(7)
    if (await session.execute(select(Seller).limit(1))).first():
        print("Demo data already present; skipping")
        return
    sellers = []
    for i, (name, pan, state, city, pin) in enumerate(DEMO_SELLERS):
        phone = f"90000000{i + 1:02d}"
        user = User(phone=phone, name=f"{name} Owner")
        session.add(user)
        await session.flush()
        first = f"{state}{pan}1Z"
        s = Seller(
            user_id=user.id,
            status="approved",
            display_name=name,
            slug=slugify(name),
            description=f"{name} — trusted seller on PixCart.",
            legal_name=f"{name} Pvt Ltd",
            business_type="private_limited",
            gstin=first + gstin_check_char(first),
            pan_enc=encrypt_field(pan),
            pan_last4=pan[-4:],
            contact_email=f"seller{i + 1}@pixcart-demo.in",
            contact_phone=phone,
            pickup_line1="Plot 12, Industrial Estate",
            pickup_city=city,
            pickup_state_code=state,
            pickup_pincode=pin,
            bank_holder_name=f"{name} Pvt Ltd",
            bank_account_enc=encrypt_field("50100012345678"),
            bank_account_last4="5678",
            bank_ifsc="HDFC0000123",
            grievance_name="Grievance Desk",
            grievance_email=f"grievance{i + 1}@pixcart-demo.in",
            grievance_phone=phone,
            submitted_at=utcnow(),
            approved_at=utcnow(),
        )
        session.add(s)
        sellers.append(s)
    await session.flush()

    for n, (si, cat_name, title, brand, mrp, price, gst, options) in enumerate(DEMO_PRODUCTS):
        seller = sellers[si]
        color = PALETTE[n % len(PALETTE)]
        p = Product(
            seller_id=seller.id,
            category_id=cats[cat_name].id,
            title=title,
            slug=slugify(title, 200),
            brand=brand,
            description=f"{title}. Carefully made by {brand}, sold by {seller.display_name}. "
            "Covered by easy returns within the return window and secure payments.",
            highlights=["Top quality materials", "Fast dispatch within 24 hours", "Easy returns"],
            specs={"Brand": brand, "Country of origin": "India"},
            hsn_code="8517" if gst == 1800 else "6205",
            gst_bps=gst,
            status="approved",
            submitted_at=utcnow(),
            approved_at=utcnow(),
            rating_avg=round(rnd.uniform(3.6, 4.8), 1),
            rating_count=rnd.randint(12, 2400),
            sold_count=rnd.randint(5, 900),
        )
        session.add(p)
        await session.flush()
        photos = demo_photos(title) or [demo_image(title, color, k) for k in range(2)]
        for k, data in enumerate(photos):
            url = await storage.save_image(data, "products")
            session.add(ProductImage(product_id=p.id, url=url, position=k))
        for j, combo in enumerate(_combos(options)):
            v = Variant(product_id=p.id, seller_id=seller.id, sku=f"P{n:02d}-{j:02d}", options=combo, mrp_paise=mrp, price_paise=price, stock=0)
            session.add(v)
            await session.flush()
            await inventory.set_total_via_default(session, seller, v, rnd.choice([0, 3, 15, 40, 120]) if j else rnd.choice([3, 25, 80]))
        await refresh_product_aggregates(session, p)
    session.add(User(phone="9999900001", name="Demo Customer"))
    session.add(Coupon(code="WELCOME10", description="10% off your first order, up to ₹200", kind="percent", value=1000, max_discount_paise=20000, first_order_only=True))
    session.add(Coupon(code="FESTIVE250", description="₹250 off on orders above ₹2,499", kind="flat", value=25000, min_order_paise=249900))
    await seed_storefront(session)
    await session.flush()
    from scripts.apply_demo_details import apply as apply_details  # product information and category requirements

    await apply_details(session, verbose=False)
    await session.flush()
    from scripts.demo_promotions import create as demo_promotions  # running deals and sponsored campaigns

    await demo_promotions(session)
    await session.commit()
    print(f"Demo: {len(sellers)} sellers (phones 9000000001-3), {len(DEMO_PRODUCTS)} products, customer 9999900001")


def banner_image(color: tuple[int, int, int]) -> bytes:
    """A plain patterned background; the heading is rendered as real text by the storefront."""
    w, h = 1600, 500
    img = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(img)
    light = tuple(min(255, c + 45) for c in color)
    for i in range(0, w + 200, 160):
        d.ellipse((900 + (i % 640), -120 + (i // 640) * 260, 1180 + (i % 640), 160 + (i // 640) * 260), outline=light, width=10)
    for i in range(0, w, 48):
        d.ellipse((i, h - 40, i + 48, h + 8), fill=light)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


async def seed_storefront(session) -> None:
    """Demo hero slides on top of the default home sections."""
    await ensure_default_sections(session)
    slides = []
    for title, sub, color, link in (
        ("Festive Silk Week", "Kanchipuram and art silk sarees from Tamil Nadu weavers", (124, 30, 60), "/c/women-s-clothing"),
        ("Phones and gadgets", "Up to 40% off from verified electronics sellers", (11, 85, 99), "/c/mobiles-electronics"),
        ("Kitchen essentials", "Pressure cookers, cookware and copper bottles", (150, 90, 10), "/c/kitchen-dining"),
    ):
        url = await storage.save_image(banner_image(color), "products")
        session.add(MediaAsset(url=url, label=title, created_at=utcnow()))
        slides.append({"image": url, "link": link, "heading": title, "text": sub, "cta": "Shop now"})
    slides[0] |= {"offer": "10% off your first order with code WELCOME10", "note": "T&C apply"}
    session.add(HomeSection(kind="hero", title="", config={"slides": slides, "autoplay": True, "interval": 5, "style": "fade"},
                            position=-10))  # above the default sections, which start at 0


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    if args.demo and settings.environment == "production":
        sys.exit("Refusing to load demo data in production")
    async with SessionLocal() as session:
        cats = await seed_categories(session)
        print(f"Categories: {len(cats)}")
        if args.demo:
            await seed_demo(session, cats)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
