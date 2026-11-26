"""Read-only: writes PixCartAPI/Tests/Fixtures/text-search-cases.json, a randomized corpus labelled by PostgreSQL itself
for the .NET text search tests (TextSearchCorpusTests):

  parser      texts built from hard pieces (URLs, e-mail, hosts, paths, versions, signed and scientific numbers, tags,
              entities, hyphen chains, units, apostrophes, Hindi) and their to_tsvector('simple', text)
  ranking     random product documents (title and brand weight A, description C) over a small vocabulary, so prefixes
              overlap and words repeat, and random AND / OR prefix queries: match (@@) and ts_rank
  similarity  search-like texts with typos against titles: word_similarity
  sort        lists of (name, count) with many equal counts, in a given order, and the order PostgreSQL's sort gives for
              ORDER BY count DESC with and without LIMIT (its quicksort and its bounded heap leave equal rows in a
              specific order, which the facets reproduce)

The texts are deterministic (fixed seed). Non-ASCII pieces are kept in a separate list, because how PostgreSQL classifies
non-ASCII characters depends on the server's locale.

  python -I tools/handover-kit/make_text_search_cases.py
"""
import json
import pathlib
import random
import re
import subprocess
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = REPO / "PixCartAPI" / "Tests" / "Fixtures" / "text-search-cases.json"
ENV = pathlib.Path(r"C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\backend\.env")
PSQL = r"C:\Users\haris\pixcart-tools\pgsql\bin\psql.exe"
DB = "pixcart_e2e_net"

ASCII_PIECES = [
    "cotton", "Men's", "USB-C", "3-in-1", "22.5W", "5,000mAh", "18/8", "e.g.", "www.pixcart.in", "https://shop.example.com/a/b?x=1&y=2",
    "support@stride.example", "v1.2.3", "1.2.3.4", "-5", "+7", "-1.5", "1e10", "2.5e-3", "1.5E+7", "<b>", "</b>", "<br/>", "&amp;",
    "&#169;", "&#x20AC;", "<!-- note -->", "/usr/local/bin", "./run.sh", "../up", "~/file.txt", "file.tar.gz", "Wi-Fi", "non-stick",
    "anti-dandruff-shampoo", "x-ray-1", "covid-19", "tv-43", "A-1", "3d", "4K", "1080p", "N95", "a_b", "foo_bar_baz", "100%",
    "(2-4 years)", "'quoted'", '"double"', ":", ";", ",", ".", "!", "?", "@", "#tag", "$", "^", "*", "=", "[x]", "{y}", "|", "\\",
    "localhost:8080", "192.168.0.1", "ftp://files.example.org/pub", "mailto:x@y.com", "http://", "a.b", "a.b.c", "a..b", "--", "-",
    "x-", "-y", "12-34", "12-ab", "ab-12", "ab-12-cd", "1-2-3", "2024-01-31", "10:30", "1/2", "3/4kg", "a/b/c", "test.", ".test",
    ".5", "5.", "0.5.1", "1,000,000", "1.000.000", "mixedCase", "UPPER", "x2", "2x", "o'neil", "rock'n'roll",
    "<script>alert(1)</script>", "<style>p{}</style>", "<p class='x'>para</p>", "&nbsp;", "&lt;tag&gt;", "e-mail", "re-enter",
    "self-care", "ultra-high-definition", "b2b", "mp3", "h2o", "4x4", "100ml", "1.5L", "500g", "2kg", "XL", "S/M/L", "co-op",
    "plug-and-play", "shop.example.com:443/path", "user.name@mail.example.co.in", "a@b", "x.y@z", "-1.2.3", "+3.14", "1.2e", "7e",
    "e7", "E-5", "0x1F", "#123", "&#;", "&foo", "<a href=\"x\">link</a>", "<?xml version='1.0'?>", "<!DOCTYPE html>", "<", ">",
    "<1>", "<_x>", "a-b-c-d-e", "a--b", "1--2", "-a-b", "a_1", "1_a", "_x", "x_", "__", "~", "~x", "./", "../../x", "/x/y.z",
    "x/y.z", "1.2/3", "a.1", "1.a", "www.x.com/a-b_c.d?e=f#g", "x.com/", "x.co", "x.c", "a1.b2.c3",
]
NON_ASCII_PIECES = ["café", "naïve", "साड़ी", "कुर्ता", "₹499", "30°C", "—", "–", "™", "®", "•", "…", "Ünïcödé-Wörd", "jalebi‐x"]
SEPARATORS = [" ", " ", " ", "", ", ", "-", "/", ".", "  ", "\n", "\t", "_", "'", ":"]
VOCAB = ["cotton", "cot", "cotta", "shirt", "shirts", "short", "shorts", "silk", "saree", "steel", "bottle", "bot", "power", "pow",
         "bank", "usb", "usb-c", "c", "men", "men's", "kids", "kid", "t-shirt", "t", "pure", "copper", "cop", "pack", "pak", "1",
         "2", "22.5w", "5g", "phone", "phones", "case", "cases", "s", "a"]


def psql_rows(sql):
    user, pw = re.search(r"^DATABASE_URL=\S+?://([^:]+):([^@]+)@", ENV.read_text(encoding="utf-8"), re.M).groups()
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        path = f.name
    try:
        out = subprocess.run([PSQL, "-h", "localhost", "-p", "5433", "-U", user, "-d", DB, "-At", "-f", path],
                             capture_output=True, text=True, encoding="utf-8",
                             env={"PGPASSWORD": pw, "PGCLIENTENCODING": "UTF8", "SYSTEMROOT": r"C:\Windows"})
    finally:
        pathlib.Path(path).unlink(missing_ok=True)
    if out.returncode or "ERROR" in out.stderr:
        raise SystemExit(out.stderr)
    return [json.loads(line) for line in out.stdout.splitlines() if line.strip()]


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def texts(rng, pieces, n):
    outp = []
    for _ in range(n):
        k = rng.randint(1, 7)
        parts = []
        for i in range(k):
            parts.append(rng.choice(pieces))
            if i < k - 1:
                parts.append(rng.choice(SEPARATORS))
        outp.append("".join(parts))
    return outp


def prefix_query(words, op):
    tokens = [t for w in words for t in re.split(r"[^\w]+", w.lower()) if t][:8]
    return f" {op} ".join(f"{t}:*" for t in tokens) if tokens else None


rng = random.Random(20261126)
ascii_texts = sorted(set(ASCII_PIECES + texts(rng, ASCII_PIECES, 1800)))
non_ascii_texts = sorted(set(NON_ASCII_PIECES + texts(rng, ASCII_PIECES[:40] + NON_ASCII_PIECES, 300)))


def vectors(items):
    values = ", ".join(f"({i}, {lit(t)})" for i, t in enumerate(items))
    rows = psql_rows(f"SELECT json_build_array(i, to_tsvector('simple', t)::text) FROM (VALUES {values}) v(i, t) ORDER BY i")
    return [{"text": items[i], "vector": v} for i, v in rows]


parser = vectors(ascii_texts)
parser_non_ascii = vectors(non_ascii_texts)

docs = []
for i in range(140):
    title = " ".join(rng.choice(VOCAB) for _ in range(rng.randint(1, 6)))
    brand = rng.choice(["", "", "Tamra", "Cotton King", "USB-Pro", "S", "Bot"])
    descr = " ".join(rng.choice(VOCAB) for _ in range(rng.randint(0, 40)))
    docs.append({"title": title, "brand": brand, "description": descr})
queries = []
for j in range(45):
    words = [rng.choice(VOCAB + ["cott", "sh", "ba", "x", "zzz", "usb_c", "t_shirt"]) for _ in range(rng.randint(1, 4))]
    op = "|" if j % 4 == 3 else "&"
    q = prefix_query(words, op)
    if q:
        queries.append({"words": words, "any": op == "|", "terms": q})
doc_values = ", ".join(f"({i}, {lit(d['title'])}, {lit(d['brand'])}, {lit(d['description'])})" for i, d in enumerate(docs))
q_values = ", ".join(f"({j}, {lit(q['terms'])})" for j, q in enumerate(queries))
rows = psql_rows(
    f"WITH d AS (SELECT i, setweight(to_tsvector('simple', t), 'A') || setweight(to_tsvector('simple', b), 'A') || "
    f"setweight(to_tsvector('simple', s), 'C') AS v FROM (VALUES {doc_values}) x(i, t, b, s)), "
    f"q AS (SELECT j, to_tsquery('simple', s) AS q FROM (VALUES {q_values}) y(j, s)) "
    "SELECT json_build_array(i, j, v @@ q, ts_rank(v, q)::float8) FROM d CROSS JOIN q ORDER BY i, j")
for q in queries:
    q["results"] = []
for i, j, match, rank in rows:
    queries[j]["results"].append([i, match, rank])

titles = sorted({d["title"] for d in docs} | {"Pure Cotton Slim Fit Shirt", "Copper Water Bottle 1 Litre", "20000mAh Power Bank 22.5W"})
searches = sorted({rng.choice(VOCAB) for _ in range(30)} | {"cotan", "cottn", "botle", "powr bank", "shrt", "coper botle", "silk sare"})
pairs = [(s, t) for s in searches for t in titles[:60]]
pair_values = ", ".join(f"({k}, {lit(a)}, {lit(b)})" for k, (a, b) in enumerate(pairs))
similarity = [{"search": pairs[k][0], "title": pairs[k][1], "word_similarity": ws}
              for k, ws in psql_rows(f"SELECT json_build_array(k, word_similarity(a, b)::float8) FROM (VALUES {pair_values}) v(k, a, b) ORDER BY k")]

sorts = []
for k in range(220):
    n = rng.choice([1, 2, 3, 5, 6, 7, 8, 9, 12, 16, 17, 20, 33, 40, 41, 45, 60, 80, 120])
    counts = [rng.choice([1, 1, 1, 2, 2, 3, 5]) if k % 3 else rng.randint(1, 4) for _ in range(n)]
    limit = rng.choice([None, None, 1, 3, 5, 8, 8, 10, 20, 30])
    values = ", ".join(f"({i}, {c})" for i, c in enumerate(counts))
    order = [r[0] for r in psql_rows(f"SELECT json_build_array(i) FROM (VALUES {values}) v(i, n) ORDER BY n DESC"
                                     + (f" LIMIT {limit}" if limit else ""))]
    sorts.append({"counts": counts, "limit": limit, "order": order})

OUT.write_text(json.dumps({"source": "Expected tokens, vectors, matches, ranks, word similarities and result orders for randomized cases",
                           "parser": parser, "parser_non_ascii": parser_non_ascii,
                           "ranking": {"documents": docs, "queries": queries}, "similarity": similarity, "sort": sorts},
                          ensure_ascii=False, indent=0), encoding="utf-8")
print(f"parser {len(parser)} (+{len(parser_non_ascii)} non-ASCII), ranking {len(docs)} x {len(queries)}, similarity {len(similarity)}, sort {len(sorts)} -> {OUT}")
