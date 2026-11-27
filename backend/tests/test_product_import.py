"""Bulk listing upload: template, dry run with row-level errors, then creation of valid drafts only."""
from __future__ import annotations

import csv
import io

from tests.conftest import make_seller

HEAD = ["product_key", "title", "category", "brand", "description", "highlights", "hsn_code", "gst_rate", "return_window_days",
        "country_of_origin", "sku", "option_1_name", "option_1_value", "option_2_name", "option_2_value", "mrp", "price", "stock", "weight_grams"]


def make_csv(rows: list[list[str]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(HEAD)
    w.writerows(rows)
    return ("﻿" + buf.getvalue()).encode()


async def upload(seller, data: bytes, dry_run: bool):
    return await seller.c.post(f"/api/seller/products/import?dry_run={'true' if dry_run else 'false'}", headers=seller.h(),
                               files={"file": ("listings.csv", data, "text/csv")})


GOOD = [
    ["SHIRT-1", "Kovai Men's Cotton Formal Shirt White", "Men's Shirts", "Kovai", "Crisp white cotton shirt for office wear, regular fit.", "100% cotton|Regular fit", "6205", "5", "7", "India",
     "KS-W-M", "Size", "M", "", "", "1,299", "799", "20", "250"],
    ["SHIRT-1", "", "", "", "", "", "", "", "", "", "KS-W-L", "Size", "L", "", "", "1299", "799", "15", "260"],
]
BAD = [
    ["PHONE-1", "Feature phone", "Nowhere category", "", "", "", "8517", "", "", "", "FP-1", "", "", "", "", "999", "1200", "5", ""],  # unknown category; short title; price > MRP
    ["SHIRT-2", "Kovai Men's Linen Casual Shirt Beige", "mens-shirts", "", "Linen shirt.", "", "62", "5", "", "", "KS-W-M", "", "", "", "", "abc", "500", "x", ""],  # SKU clash, bad numbers, bad HSN
]


async def test_template_and_dry_run_then_import(client, admin, categories):
    seller = await make_seller(client, admin, "9620000001", name="Bulk Shop", pan="BULKS1234B")
    t = await seller.get("/api/seller/products/import-template.csv")
    assert t.status_code == 200 and t.content.decode("utf-8-sig").startswith("product_key,title,category")

    r = await upload(seller, make_csv(GOOD + BAD), dry_run=True)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["valid"] == 1 and d["invalid"] == 2 and d["created"] == []
    by_key = {p["key"]: p for p in d["products"]}
    assert by_key["SHIRT-1"]["variants"] == 2 and by_key["SHIRT-1"]["errors"] == []
    assert any("not found" in e for e in by_key["PHONE-1"]["errors"])
    shirt2 = " ".join(by_key["SHIRT-2"]["errors"])
    assert "mrp must be a number" in shirt2 and "HSN code must be 4, 6 or 8 digits" in shirt2 and "List should" not in shirt2
    clash = (await upload(seller, make_csv(GOOD + [["SHIRT-3", "Kovai Men's Linen Casual Shirt Beige", "Men's Shirts", "", "Linen shirt for summer days.", "", "6205", "5", "", "",
                                                   "KS-W-M", "", "", "", "", "999", "699", "4", ""]]), dry_run=True)).json()
    assert any("also used by product SHIRT-1" in e for e in clash["products"][1]["errors"])
    assert (await seller.get("/api/seller/products")).json()["total"] == 0  # dry run saves nothing

    r = await upload(seller, make_csv(GOOD + BAD), dry_run=False)
    d = r.json()
    assert len(d["created"]) == 1
    listing = (await seller.get("/api/seller/products?status=draft")).json()
    assert listing["total"] == 1
    product = (await seller.get(f"/api/seller/products/{d['created'][0]['id']}")).json()
    assert product["status"] == "draft" and {v["sku"] for v in product["variants"]} == {"KS-W-M", "KS-W-L"}
    assert product["variants"][0]["mrp_paise"] == 129900 and product["gst_bps"] == 500 and product["highlights"] == ["100% cotton", "Regular fit"]
    # Uploading the same file again: those SKUs now exist, so nothing is duplicated.
    again = (await upload(seller, make_csv(GOOD), dry_run=False)).json()
    assert again["created"] == [] and "already exists" in again["products"][0]["errors"][0]


async def test_bad_files_are_refused_clearly(client, admin, categories):
    seller = await make_seller(client, admin, "9620000002", name="Bulk Two", pan="BULKT1234T")
    r = (await upload(seller, b"title,price\nShirt,100\n", dry_run=True)).json()
    assert "Missing columns" in r["file_errors"][0]["error"]
    r = (await upload(seller, "product_key,title\n".encode("utf-16"), dry_run=True)).json()
    assert r["file_errors"]
    r = (await upload(seller, b"x" * (2 * 1024 * 1024 + 10), dry_run=True)).json()
    assert "larger than 2 MB" in r["file_errors"][0]["error"]


async def test_nan_and_infinity_prices_are_row_errors_not_crashes(client, admin, categories):
    seller = await make_seller(client, admin, "9620000003", name="Bulk Three", pan="BULKT3234T")
    row = ["SHIRT-9", "Kovai Men's Cotton Formal Shirt Grey", "Men's Shirts", "Kovai", "Crisp grey cotton shirt for office wear, regular fit.", "100% cotton", "6205", "5", "7", "India",
           "KS-G-M", "Size", "M", "", "", "NaN", "Infinity", "20", "250"]
    huge = row[:10] + ["KS-G-L", "Size", "L", "", "", "1e999999", "1e999999", "20", "250"]
    r = await upload(seller, make_csv([row, huge]), dry_run=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "must be more than 0" in str(body)
