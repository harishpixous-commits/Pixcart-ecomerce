from app.services.search_synonyms import parse_groups, variants
from tests.conftest import make_live_product, make_seller
from tests.test_catalog import SHIRT_VARIANTS


def test_groups_and_variants():
    g = parse_groups("tee = T-Shirt = tshirt; sneakers = shoes;bad")
    assert g == [["tee", "t-shirt", "tshirt"], ["sneakers", "shoes"]]
    assert variants("blue tee", g) == ["blue tee", "blue t-shirt", "blue tshirt"]
    assert variants("socks", g) == ["socks"]
    assert len(variants("tee shoes", g)) <= 6


async def test_admin_synonyms_widen_the_search(client, admin, categories):
    seller = await make_seller(client, admin, "9600000071", name="Synonym Traders", pan="ABCDE1234G")
    await make_live_product(client, admin, seller, categories["shirts"], title="Cotton Casual Shirt for Men", variants=SHIRT_VARIANTS)
    assert (await client.get("/api/catalog/products?q=kurta")).json()["total"] == 0
    assert (await admin.put("/api/admin/settings", {"search_synonyms": "shirt"})).status_code == 400
    r = await admin.put("/api/admin/settings", {"search_synonyms": "shirt = kurta; shoes = sneakers"})
    assert r.status_code == 200 and r.json()["search_synonyms"] == "shirt = kurta; shoes = sneakers"
    assert (await client.get("/api/catalog/products?q=kurta")).json()["total"] == 1
    assert (await client.get("/api/catalog/products?q=kur")).json()["total"] == 0
    assert (await admin.put("/api/admin/settings", {"search_synonyms": ""})).status_code == 200
    assert (await client.get("/api/catalog/products?q=kurta")).json()["total"] == 0
