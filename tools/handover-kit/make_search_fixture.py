"""Read-only: writes PixCartAPI/Tests/Fixtures/search-ranking.json from the local PostgreSQL seeded demo database, so a
unit test can prove that the .NET search reproduces PostgreSQL's text search exactly: every product's search vector
(title and brand weight A, description weight C, 'simple' configuration), and for a set of searches whether each
product matches, its ts_rank and the trigram word_similarity of the search text to the title. Besides the seeded
products it includes synthetic product texts with the tricky cases (decimals, hyphens, units, apostrophes, paths).

  python -I tools/handover-kit/make_search_fixture.py
"""
import json
import pathlib
import re
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = REPO / "PixCartAPI" / "Tests" / "Fixtures" / "search-ranking.json"
ENV = pathlib.Path(r"C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\backend\.env")
PSQL = r"C:\Users\haris\pixcart-tools\pgsql\bin\psql.exe"
DB = "pixcart_e2e_net"   # the seeded demo data (python -m scripts.seed --demo), untouched by test runs
SYNTHETIC = [
    ("20000mAh Power Bank 22.5W Fast Charge", "VoltLine", "Charges a phone 4 times. USB-C and USB-A ports, 5,000 cycles."),
    ("Men's Pure Cotton Slim Fit Casual Shirt", "Tamra", "100% cotton, BPA-free buttons; machine wash (30°C)."),
    ("Kids T-Shirt and Shorts Set (2-4 years)", "LittleOne", "Soft cotton t-shirt; 3-in-1 pack for kids aged 2-4."),
    ("Non-Stick Cookware Set of 3 Induction Base", "HomeChef", "Non-stick coating, 18/8 steel handles, Wi-Fi free!"),
    ("TV-43 Smart LED 4K 1080p", "ViewMax", "e.g. Netflix, YouTube; A-1 grade panel; -5 +7 tilt; 1/2 price."),
    ("Copper Water Bottle 1 Litre Leak Proof", "Tamra", "Pure copper, 1.5 Litre option, version 1.2.3 of the cap."),
    ("O'Neil Running Shoes", "Stride", "Mesh upper; mobile/tablet app; support@stride.example; www.stride.example"),
    ("Cotton Cotton Cotton", "", "cotton shirt cotton bedsheet cotton cotton"),
    ("Shirt", "Cotton", ""),
    ("", "", ""),
]
QUERIES = ["cotton", "cotton shirt", "men's cotton", "power", "power bank", "usb c", "usb-c cable", "silk saree", "water bottle",
           "earbuds", "kurta", "non stick", "non-stick cookware", "steel", "organic rice", "phone", "smart watch", "bag",
           "shirt", "kids", "t shirt", "coffee", "face serum", "laptop", "yoga mat", "bluetooth speaker", "22.5w",
           "copper", "pressure cooker", "brass", "handloom", "bedsheet", "running shoes", "saree", "book", "charger",
           "earbud", "cotan", "kurtha", "bottel", "speakr", "s", "a", "fast charge", "the", "3 in 1", "1 litre", "tv 43",
           "mobile", "18 8", "o neil", "5g"]

user, pw = re.search(r"^DATABASE_URL=\S+?://([^:]+):([^@]+)@", ENV.read_text(encoding="utf-8"), re.M).groups()


def psql(sql):
    # the SQL goes through a UTF-8 file: Windows passes command-line text in its own code page
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        path = f.name
    try:
        out = subprocess.run([PSQL, "-h", "localhost", "-p", "5433", "-U", user, "-d", DB, "-AtF", "\t", "-f", path],
                             capture_output=True, text=True, encoding="utf-8",
                             env={"PGPASSWORD": pw, "PGCLIENTENCODING": "UTF8", "SYSTEMROOT": r"C:\Windows"})
    finally:
        pathlib.Path(path).unlink(missing_ok=True)
    if out.returncode or out.stderr.strip():
        raise SystemExit(out.stderr)
    return out.stdout


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def prefix_query(q):
    tokens = [t for t in re.split(r"[^\w]+", q.lower()) if t][:8]
    return " & ".join(f"{t}:*" for t in tokens) if tokens else None


values = ", ".join(f"('s{i:02d}', {lit(t)}, {lit(b)}, {lit(d)})" for i, (t, b, d) in enumerate(SYNTHETIC))
SOURCE = (f"WITH src AS (SELECT id::text AS id, title, brand, description FROM products "
          f"UNION ALL SELECT * FROM (VALUES {values}) AS v(id, title, brand, description)), "
          "doc AS (SELECT id, title, brand, description, setweight(to_tsvector('simple', coalesce(title, '')), 'A') || "
          "setweight(to_tsvector('simple', coalesce(brand, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'C') AS v FROM src) ")

products = []
for line in psql(SOURCE + "SELECT id, json_build_object('title', title, 'brand', brand, 'description', description, 'vector', v::text)::text "
                          "FROM doc ORDER BY id").splitlines():
    pid, payload = line.split("\t", 1)
    item = json.loads(payload)
    item["id"] = pid
    products.append(item)

searches = []
for q in QUERIES:
    tsq = prefix_query(q)
    rank = f"ts_rank(v, to_tsquery('simple', {lit(tsq)}))::float8" if tsq else "0::float8"
    match = f"(v @@ to_tsquery('simple', {lit(tsq)}))" if tsq else "false"
    rows = {}
    for line in psql(SOURCE + f"SELECT id, {match}, {rank}, word_similarity({lit(q)}, title)::float8, ({lit(q)} <% title) FROM doc ORDER BY id").splitlines():
        pid, m, r, ws, fuzzy = line.split("\t")
        rows[pid] = {"match": m == "t", "rank": float(r), "word_similarity": float(ws), "fuzzy": fuzzy == "t"}
    searches.append({"query": q, "terms": tsq, "products": rows})

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"source": "Expected search vectors, matches, ranks and word similarities for the seeded demo products and synthetic texts",
                           "products": [{k: p[k] for k in ("id", "title", "brand", "description", "vector")} for p in products],
                           "searches": searches}, ensure_ascii=False, indent=0), encoding="utf-8")
print(f"{len(products)} products, {len(searches)} searches -> {OUT}")
