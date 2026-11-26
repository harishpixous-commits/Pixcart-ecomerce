"""Export the integration branch to the company repositories, clean.

  python -I export_company.py web      -> C:\\Users\\haris\\Downloads\\Pix-ShopCart_Web
  python -I export_company.py mobile   -> C:\\Users\\haris\\Downloads\\Pix-ShopCart_Mobile

What it does:
  1. copies the product's tracked files from the integration worktree (code, product docs, the publish script);
     porting docs and tools are never copied, and files that no longer exist are removed from the target;
  2. cleans comments only (never code or strings): porting notes ("reference: ...", "Port of ....tsx", Python names,
     paths of the other codebase) are removed, the rest of each comment is kept;
  3. proves that only comments changed: every file's code with its comments stripped must be identical before and after;
  4. writes a report of everything it changed.
Building, testing, committing and pushing the target are separate steps (see the end of this file's output).
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys

SRC = pathlib.Path(r"C:\Users\haris\Downloads\PixCart-company")
TARGETS = {"web": pathlib.Path(r"C:\Users\haris\Downloads\Pix-ShopCart_Web"),
           "mobile": pathlib.Path(r"C:\Users\haris\Downloads\Pix-ShopCart_Mobile")}
WEB_DOCS = ["ADMIN_SPEC.md", "AI_ASSISTANT.md", "BUSINESS_RULES.md", "DELIVERY.md", "SHOP_ASSISTANT.md", "THEMES.md", "DEPLOY_WINDOWS_IIS.md"]
# files each company repository keeps as its own (never overwritten or removed by the export)
OWN = {"web": {"README.md", ".gitignore", ".github/workflows/ci.yml"},
       "mobile": {"README.md", ".github/workflows/ci.yml", ".github/workflows/release-apps.yml"}}
# development-only files of the integration branch that never go to a company repository
EXCLUDE = re.compile(r"^(PixCartWeb/tools/gen-routes\.py|PixCartMobile/tools/parity/.*)$")
# hand-written company versions of a few files (same relative path as in the target repository)
OVERRIDES = pathlib.Path(__file__).resolve().parent / "company-overrides"
# exact text fixes for files the comment cleaner does not handle (target path -> [(old, new), ...]); each must match once
FIXUPS = {
    "tools/build_fonts.py": [
        ('"""Builds the app fonts from the website\'s @fontsource files (same glyphs as the mobile website).',
         '"""Builds the app fonts from the @fontsource packages (the same fonts the website uses).'),
        ('    python tools/build_fonts.py "<path to frontend/node_modules/@fontsource>"',
         '    python tools/build_fonts.py "<path to node_modules/@fontsource>"'),
        ("    # family dir, file prefix, weights the website loads (app/layout.tsx), output name",
         "    # family dir, file prefix, weights the website loads, output name"),
    ],
}
# pattern fixes applied after the comment cleaning, to code text that only exists on the integration branch
# (placeholder pages that are still being built; ignore rules for excluded tools): (path regex, pattern, replacement)
REGEX_FIXUPS = [
    (r"^PixCartWeb/src/app/.*/pages/.*\.ts$", r'[ \t]*sub="Reference: frontend/src/app/[^"]*"', ""),
    (r"^PixCartWeb/src/app/.*/pages/.*\.ts$", r"This page is ported by its module\.(?: Reference: frontend/src/app/[^<]*)?",
     "This page is coming soon."),
    (r"^\.gitignore$", r"/tools/parity/node_modules/\r?\n", ""),
    # product docs: exact edits (Markdown is never cleaned line by line; the scan at the end checks what is left)
    (r"^docs/ADMIN_SPEC\.md$",
     r"(?s)\A# Admin panel — reference requirements\r?\n\r?\n> Source: .*?the status file says so and why\.\r?\n",
     "# Admin panel — requirements\r\n\r\n"
     "> Source: \"E-commerce Admin Panel — Complete Technical Specification\", supplied by the owner. PixCart treats it\r\n"
     "> as a checklist, not a contract. Where it does not fit PixCart (one marketplace per install, India only, INR in\r\n"
     "> paise), PixCart follows its own rules.\r\n"),
    (r"^docs/BUSINESS_RULES\.md$", r" \(`services/orders\.py: transition`\)", ""),
    (r"^docs/DEPLOY_WINDOWS_IIS\.md$", r" When moving data from the Python version, use the same key it used\.", ""),
    (r"^docs/DEPLOY_WINDOWS_IIS\.md$", r"(?s)\n+## 9\. Moving the data from the Python version.*\Z", "\n"),
]

PORT = re.compile(r"(?-i:\buse(?!Now\b|Polling\b|Range\b|Here\b|PathUrlStrategy\b)[A-Z][A-Za-z]*\(\))|\bNext's\b|(?-i:<Link\b)|\bFeedProvider\b"
                  r"|\breference\b|\bpython\b|pydantic|fastapi|sqlalchemy|asyncpg|alembic|uvicorn|starlette|next\.js|\bnextjs\b"
                  r"|\breact\b|\.tsx\b|\.jsx\b|\.py\b|frontend/|backend/|\brouters/|\bport of\b|\bported\b|\bporting\b"
                  r"|\bthe port\b|\bthis port\b|\bport-specific\b|\binstinct\b|(?-i:\bHANDOFF\b)|\bhandoff notes?\b|\bpytest\b"
                  r"|\bconftest\b|\bclaude code\b|gen-routes|tools/parity|\bparity\b|\bvercel\b|(?-i:\bNeon\b)|\bpostgres(ql)?\b"
                  r"|\bpsycopg|\bpg_|isoformat|json\.dumps|json\.loads|\bValueError\b|\bTypeError\b|\bKeyError\b"
                  r"|list\[dict\]|uuid\.UUID|secrets\.token|\bNoneType\b", re.I)
# product meanings of "reference" (payment / bank / UTR references) are not porting notes
PROTECT = [re.compile(p, re.I) for p in (
    r"\b(UTR|UPI|bank|payment|refund|transaction|deposit|payout|cash|courier|tracking)(\s*/\s*[A-Za-z]+)?\s+reference\b",
    r"\breference\s+(number|no\.?|id|code|of the refund)\b", r"\bmarked with a reference\b", r"\bUTR\s*/\s*reference\b",
    r"\bthe Reference field\b", r"`reference`", r"<c>reference</c>", r"<c>Reference</c>")]
MASK = "\u0002"


def protect(text):
    for p in PROTECT:
        text = p.sub(lambda m: m.group(0).replace("reference", "refer" + MASK + "nce").replace("Reference", "Refer" + MASK + "nce"), text)
    return text


def unprotect(text):
    return text.replace(MASK, "e")


NL = "\u0001"   # line break inside a joined comment block
CUT = "\u0003"  # where a porting note was removed (punctuation is tidied only next to it)
CAP = "\u0004"  # capitalize the letter that follows
# sentence separators: whitespace after . ! ? (not after e.g. / i.e. / etc. / vs.), a line break before a list item,
# or a line break before a blank line (paragraph end)
SENT = re.compile(r"((?<=[.!?])(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\betc\.)(?<!\bvs\.)[ \t" + NL + r"]+"
                  r"|[ \t]*" + NL + r"(?=[ \t]*(?:[-*•]|\d+[.)])[ \t])"
                  r"|[ \t]*" + NL + r"(?=[ \t]*" + NL + r")"
                  r"|[ \t" + NL + r"]*</?(?:summary|remarks|para|returns)>[ \t" + NL + r"]*)")


def drop_parentheticals(text):
    """Replaces (...) groups, one nesting level deep, whose content is a porting note, with CUT."""
    pat = re.compile(r"[ \t]*\((?:[^()]|\([^()]*\))*\)")
    return pat.sub(lambda m: CUT if PORT.search(m.group(0)) else m.group(0), text)


IDENT = r"(?:[A-Z][\w.]*(?:\(\))?|_\w+|[a-z_]+\.[\w.]+(?:\(\))?)"
PHRASES = [re.compile(p, re.I) for p in (
    # ", like the reference's X" / ", as the reference API writes it" / ", like the reference ConnectionIn"
    r",?[ \t]+(?:exactly |just |the same )?(?:like|as|from) (?:in )?the reference"
    r"(?:(?: version| API| site| app| schema| catalog)?'s[ \t]+(?:" + IDENT + r"|\w+)"
    r"|(?: version| API| site| app| code| backend| page| schema| catalog| modals?| root layout)?(?:[ \t]+(?-i:" + IDENT + r"))?"
    r"(?: does| did| writes it| shows them| reads them| sends it| returns it| loads them per request)?)(?![\w'])",
    r",?[ \t]+the same as the reference\b",
    r"\bReference:(?:(?!\.[ \t]|" + NL + "|—).)*?[ \t]+" + "—" + r"[ \t]+",   # "Reference: x.py - what it does" keeps "what it does"
    r"(?:(?<=^)|(?<=" + NL + r"))[ \t]*(?:Port(?:ed)? (?:of|from)|Mirrors|Matches|Same as)[ \t]+[^\s]*?\.(?:tsx|ts|py|jsx)\b\)*"
    r"[ \t]*(?:[:" + "—–" + r"]|-(?= ))[ \t]*",                   # "Port of x.tsx: what it does" keeps "what it does"
)]
CODE_WORD = re.compile(r"[a-z]+(?=[\s,;:!?)]|$)")
MIDWORD = []


def capitalize_at(s, i):
    """Capitalizes the plain word starting at s[i] (not identifiers like npm, x.y, foo_bar, `code`)."""
    m = CODE_WORD.match(s, i)
    if m and m.group(0) not in ("npm", "ng", "dotnet", "git", "pwsh"):
        return s[:i] + s[i].upper() + s[i + 1:]
    return s


def scrub_text(text):
    """Comment text in, comment text out (may become empty). Text away from a removed note is never changed."""
    t = protect(text)
    t = drop_parentheticals(t)
    for p in PHRASES:
        t = p.sub(CUT, t)
    pieces = SENT.split(t)
    sents, seps = pieces[0::2], pieces[1::2] + [""]
    out, first_dropped = [], False
    for s, sep in zip(sents, seps):
        if PORT.search(s) and re.search(r";[ \t" + NL + "]", s):
            # a sentence of clauses: drop only the clauses that are porting notes
            parts = re.split(r"(;[ \t" + NL + r"]+)", s)
            clauses, cseps = parts[0::2], parts[1::2] + [""]
            keep = [(c, cs) for c, cs in zip(clauses, cseps) if not PORT.search(c)]
            if keep:
                end = re.search(r"[.!?]$", s.rstrip())
                rebuilt = "".join(c + cs for c, cs in keep[:-1]) + keep[-1][0]
                if end and not rebuilt.rstrip().endswith(end.group(0)):
                    rebuilt = rebuilt.rstrip() + end.group(0)
                s = (CUT if PORT.search(clauses[0]) else "") + rebuilt
        if CUT in s and len(re.findall(r"[A-Za-z]{2,}", re.sub(r"<[^>]+>", "", s.replace(CUT, "")))) < 3:
            s = s + " reference"  # too little left to read as a sentence: drop it
        if PORT.search(s):
            if "<" in sep:
                out.append(["", sep])  # an XML doc tag stays
            elif out and NL in sep and NL not in out[-1][1] and "<" not in out[-1][1]:
                out[-1][1] = sep  # keep the line break the dropped sentence ended with
            first_dropped = True
            continue
        if first_dropped and re.match(r"[A-Za-z]", s):
            s = CUT + s  # a capital letter if it now starts a sentence
        first_dropped = False
        out.append([s, sep])
    t = "".join(s + sep for s, sep in out)
    # tidy only around removed notes
    starts = r"(^|[.!?][ \t" + NL + r"]+|<summary>[ \t" + NL + r"]*|<remarks>[ \t" + NL + r"]*)"
    t = re.sub(starts + r"[ \t]*" + CUT + r"+[ \t]*([a-z])", lambda m: m.group(1) + CAP + m.group(2), t)
    t = re.sub(r"(^|" + NL + r")[ \t]*" + CUT + r"+[ \t]*", r"\1", t)                      # a note at a line start
    t = re.sub(r"[ \t]*" + CUT + r"+[ \t]*(?=[.,;:!?)]|$|" + NL + ")", "", t)              # before punctuation or a line end
    if CUT in t:
        MIDWORD.append(text)  # a note removed between two words: listed in the report for a read-through
    t = re.sub(r"[ \t]*" + CUT + r"+[ \t]*", " ", t)                                          # between words
    while CAP in t:
        i = t.index(CAP)
        t = capitalize_at(t[:i] + t[i + 1:], i)
    t = re.sub(r"[ \t]+(" + NL + r"|$)", r"\1", t)
    t = re.sub(r"[ \t]*" + NL + r"[ \t]*([.,;:])[ \t]*(?=" + NL + r"|$)", r"\1", t)   # a line left with only "."
    t = re.sub(r"(" + NL + r"[ \t]*){3,}", NL + NL, t).strip(" \t" + NL)
    return unprotect(t)


def capital_first(text):
    return text  # scrub_text capitalizes where a removal starts a sentence


def meaningful(text):
    return bool(re.sub(r"<[^>]+>|[\s" + NL + r".,;:—\-*/]", "", text))


# ------------------------------------------------------------------------------------------------- C-style languages
LINE_CMT = re.compile(r"^(\s*)(///|//)( ?)(.*)$")


def code_split(line):
    """(text before the // marker, comment text) for a trailing // comment outside quotes, else None. Conservative: an
    odd number of quotes before the marker, a URL, or nothing before it means 'not a trailing comment'."""
    i = line.find("//")
    while i != -1:
        before = line[:i]
        if before.strip() and before.count('"') % 2 == 0 and before.count("'") % 2 == 0 and before.count("`") % 2 == 0 \
                and not before.rstrip().endswith(":") and "http" not in before[-8:]:
            return line[:i], line[i + 2:]
        i = line.find("//", i + 2)
    return None


def scrub_c(src, report, name):
    lines = src.split("\n")
    out, i, n = [], 0, len(lines)
    in_raw = False  # inside a multi-line string (C# raw """, Dart ''' / """, JS template literal)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        # track multi-line strings by their delimiters on code lines (comments do not count)
        if not stripped.startswith(("//", "/*", "*")):
            for delim in ('"""', "'''"):
                if line.count(delim) % 2 == 1:
                    in_raw = not in_raw
            code_only = re.sub(r'"(\\.|[^"\\])*"|\'(\\.|[^\'\\])*\'', "", line)
            if code_only.count("`") % 2 == 1:
                in_raw = not in_raw
        if in_raw:
            out.append(line)
            i += 1
            continue
        m = LINE_CMT.match(line)
        if m:  # a block of full-line comments with the same marker and indent
            indent, marker = m.group(1), m.group(2)
            raw, block = [], []
            while i < n:
                mm = LINE_CMT.match(lines[i])
                if not mm or mm.group(1) != indent or mm.group(2) != marker:
                    break
                raw.append(lines[i])
                block.append(mm.group(4))
                i += 1
            joined = NL.join(block)
            if not PORT.search(protect(joined)):
                out.extend(raw)  # untouched comments stay exactly as they were
                continue
            new = scrub_text(joined)
            if marker == "///":
                new = re.sub(r"<summary>[\s" + NL + r"]*</summary>", "", new)
                new = re.sub(r"<remarks>[\s" + NL + r"]*</remarks>", "", new)
                new = new.strip(" \t" + NL)
            kept = [s.rstrip() for s in new.split(NL)] if meaningful(new) else []
            report.append({"file": name, "kind": marker, "before": raw, "after": kept})
            out.extend(f"{indent}{marker} {s}" if s else f"{indent}{marker}" for s in kept)
            continue
        if stripped.startswith("/*"):  # a block comment starting the line
            block_lines = [line]
            while "*/" not in lines[i] and i + 1 < n:
                i += 1
                block_lines.append(lines[i])
            i += 1
            text = "\n".join(block_lines)
            after_close = text[text.find("*/") + 2:] if "*/" in text else ""
            if not PORT.search(protect(text)) or after_close.strip():
                out.extend(block_lines)
                continue
            first = block_lines[0]
            indent, opener, first_text = re.match(r"^(\s*)(/\*\*?)[ \t]?(.*)$", first).groups()
            closer_alone = len(block_lines) > 1 and block_lines[-1].strip() == "*/"
            body_lines = block_lines[1:-1] if closer_alone else block_lines[1:]
            cont = re.match(r"^(\s*\*?[ \t]?)", body_lines[0]).group(1) if body_lines else indent + " * "
            texts = [first_text] + [l[len(re.match(r"^\s*\*?[ \t]?", l).group(0)):] for l in body_lines]
            texts[-1] = re.sub(r"[ \t]*\*/[ \t]*$", "", texts[-1]) if not closer_alone else texts[-1]
            starts_empty = texts[0].strip() == ""
            if starts_empty:
                texts = texts[1:]
            new = scrub_text(NL.join(texts))
            kept = [s.rstrip() for s in new.split(NL)] if meaningful(new) else []
            report.append({"file": name, "kind": "/* */", "before": block_lines, "after": kept})
            if not kept:
                continue
            if len(block_lines) == 1:
                out.append(f"{indent}{opener} {kept[0]} */" if len(kept) == 1 else f"{indent}{opener} {' '.join(kept)} */")
                continue
            body = kept if starts_empty else kept[1:]
            res = [f"{indent}{opener}" if starts_empty else f"{indent}{opener} {kept[0]}"]
            res += [(cont + s).rstrip() if s else cont.rstrip() for s in body]
            if closer_alone:
                res.append(block_lines[-1])
            else:
                res[-1] = res[-1] + " */"
            out.extend(res)
            continue
        cut = code_split(line)
        if cut is not None and PORT.search(protect(cut[1])):
            pre, cmt = cut
            new = scrub_text(cmt.strip())
            report.append({"file": name, "kind": "trailing", "before": [line], "after": [new]})
            out.append(f"{pre}// {new}" if meaningful(new) else pre.rstrip())
        else:
            out.append(line)
        i += 1
    return "\n".join(out)


def scrub_hash(src, report, name):
    out = []
    for line in src.split("\n"):
        m = re.match(r"^(\s*)#( ?)(.*)$", line)
        if m and not line.strip().startswith("#!") and PORT.search(protect(m.group(3))):
            new = capital_first(scrub_text(m.group(3)))
            report.append({"file": name, "kind": "#", "before": [line], "after": [new]})
            if meaningful(new):
                out.append(f"{m.group(1)}# {new}")
            continue
        out.append(line)
    return "\n".join(out)


def scrub_sql(src, report, name):
    out = []
    for line in src.split("\n"):
        m = re.match(r"^(\s*)--( ?)(.*)$", line)
        if m and PORT.search(protect(m.group(3))):
            new = capital_first(scrub_text(m.group(3)))
            report.append({"file": name, "kind": "--", "before": [line], "after": [new]})
            if meaningful(new):
                out.append(f"{m.group(1)}-- {new}")
            continue
        out.append(line)
    return "\n".join(out)


def scrub_xml(src, report, name):
    def fix(m):
        text = m.group(1)
        if not PORT.search(protect(text)):
            return m.group(0)
        new = scrub_text(text.strip())
        report.append({"file": name, "kind": "<!-- -->", "before": [m.group(0)], "after": [new]})
        return f"<!-- {new} -->" if meaningful(new) else ""
    out = re.sub(r"<!--(.*?)-->", fix, src, flags=re.S)
    return re.sub(r"\n[ \t]+\n", "\n\n", out)


def scrub_md(src, report, name):
    out, fence, skip_level = [], False, None
    for line in src.split("\n"):
        if line.strip().startswith("```"):
            fence = not fence
        h = re.match(r"^(#+)\s", line)
        if not fence and h:
            if skip_level is not None and len(h.group(1)) <= skip_level:
                skip_level = None
            if skip_level is None and PORT.search(protect(line)):
                skip_level = len(h.group(1))  # a whole section about the other codebase
                report.append({"file": name, "kind": "md section", "before": [line], "after": []})
                continue
        if skip_level is not None:
            continue
        if not fence and PORT.search(protect(line)):
            prefix = re.match(r"^(\s*([-*]|\d+\.)\s+|\s*\|?\s*)", line).group(0)
            new = scrub_text(line[len(prefix):])
            report.append({"file": name, "kind": "md", "before": [line], "after": [new]})
            if meaningful(new):
                out.append(prefix + capital_first(new))
            continue
        out.append(line)
    return "\n".join(out)


def lex_strip(src, lang):
    """An independent, character-level lexer: the source with comments removed and all whitespace dropped. Strings
    (regular, verbatim, raw, interpolated, template, triple-quoted, char literals) are kept as they are. Used only to
    prove that the line-based comment cleaner above never touched code or strings."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        two = src[i:i + 2]
        if two == "//":
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        if two == "/*":
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        # C# raw strings ("""...""" with 3+ quotes, optionally $-prefixed) and Dart triple-quoted strings
        m = re.match(r'(\$*)("{3,}|\'{3})', src[i:i + 12]) if c in "$\"'" else None
        if m and (lang != "cs" or m.group(2)[0] == '"'):
            q = m.group(2)
            j = src.find(q, i + len(m.group(0)))
            j = n if j == -1 else j + len(q)
            while j < n and src[j] == q[0]:  # a longer closing run belongs to the string
                j += 1
            out.append(src[i:j])
            i = j
            continue
        if lang == "cs" and (src.startswith('@"', i) or src.startswith('$@"', i) or src.startswith('@$"', i)):
            j = src.find('"', i) + 1
            while j < n:
                if src[j] == '"' and src[j + 1:j + 2] == '"':
                    j += 2
                    continue
                if src[j] == '"':
                    j += 1
                    break
                j += 1
            out.append(src[i:j])
            i = j
            continue
        if lang == "dart" and c == "r" and src[i + 1:i + 2] in ("'", '"') and (i == 0 or not (src[i - 1].isalnum() or src[i - 1] == "_")):
            q = src[i + 1]
            j = src.find(q, i + 2)
            j = n if j == -1 else j + 1
            out.append(src[i:j])
            i = j
            continue
        if c in "\"'`":
            if c == "'" and lang == "cs" and not re.match(r"'(\\.[^']*|[^\\'\n])'", src[i:i + 12]):
                out.append(c)
                i += 1
                continue
            j = i + 1
            depth = 0
            while j < n:
                d = src[j]
                if d == "\\":
                    j += 2
                    continue
                if c == "`" and src.startswith("${", j):
                    depth += 1
                    j += 2
                    continue
                if c == "`" and depth and d == "}":
                    depth -= 1
                    j += 1
                    continue
                if d == c and not depth:
                    j += 1
                    break
                if d == "\n" and c != "`":
                    break  # an unterminated quote (an apostrophe in SCSS text, say): stop at the line end
                j += 1
            out.append(src[i:j])
            i = j
            continue
        out.append(c)
        i += 1
    return re.sub(r"\s+", "", "".join(out))


def apply_fixups(path, rel):
    fixes = FIXUPS.get(rel)
    if not fixes:
        return
    text = path.read_bytes().decode("utf-8")
    for old, new in fixes:
        if text.replace("\r\n", "\n").count(old) != 1:
            raise SystemExit(f"STOP: fixup text not found exactly once in {rel}: {old[:60]}")
        text = text.replace(old, new).replace(old.replace("\n", "\r\n"), new.replace("\n", "\r\n"))
    path.write_bytes(text.encode("utf-8"))


def scrub_file(path, rel, report):
    ext = path.suffix.lower()
    raw = path.read_bytes()
    try:
        src = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    crlf = "\r\n" in src
    text = src.replace("\r\n", "\n")
    if ext in (".cs", ".ts", ".js", ".mjs", ".cjs", ".dart", ".scss", ".css", ".kts", ".gradle", ".java", ".kt", ".swift"):
        new = scrub_c(text, report, rel)
        lang = {".cs": "cs", ".dart": "dart"}.get(ext, "ts")
        if lex_strip(new, lang) != lex_strip(text, lang):
            raise SystemExit(f"STOP: code changed while cleaning comments in {rel}")
    elif ext in (".ps1", ".yml", ".yaml", ".sh", ".properties", ".toml"):
        new = scrub_hash(text, report, rel)
    elif ext == ".sql":
        new = scrub_sql(text, report, rel)
    elif ext in (".csproj", ".xml", ".html", ".config", ".plist", ".props", ".targets", ".sln"):
        new = scrub_xml(text, report, rel)
    elif ext == ".md":
        return None  # Markdown: hand-written company versions and exact fixes only
    else:
        return None
    if new != text:
        path.write_bytes((new.replace("\n", "\r\n") if crlf else new).encode("utf-8"))
        return True
    return False


# ------------------------------------------------------------------------------------------------- export
def tracked(prefixes):
    out = subprocess.run(["git", "-C", str(SRC), "ls-files", *prefixes], capture_output=True, text=True, check=True).stdout
    return [l for l in out.splitlines() if l]


def main():
    which = sys.argv[1]
    target = TARGETS[which]
    if which == "web":
        files = tracked(["PixCartAPI", "PixCartWeb"]) + ["tools/publish-windows.ps1"] + [f"docs/{d}" for d in WEB_DOCS]
        mapping = {f: f for f in files if not EXCLUDE.match(f)}
    else:
        files = tracked(["PixCartMobile"])
        mapping = {f: f[len("PixCartMobile/"):] for f in files if not EXCLUDE.match(f)}
    override_root = OVERRIDES / which
    overrides = {p.relative_to(override_root).as_posix(): p for p in override_root.rglob("*") if p.is_file()} if override_root.exists() else {}
    wanted = set(mapping.values()) | set(overrides)
    own = OWN[which]
    # remove target files that the export no longer has (renamed or deleted), never the repository's own files
    existing = subprocess.run(["git", "-C", str(target), "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines()
    removed = [f for f in existing if f not in wanted and f not in own]
    for f in removed:
        (target / f).unlink(missing_ok=True)
    for src_rel, dst_rel in mapping.items():
        dst = target / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SRC / src_rel, dst)
    for dst_rel, src in overrides.items():
        dst = target / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    for dst_rel in FIXUPS:
        if dst_rel in wanted:
            apply_fixups(target / dst_rel, dst_rel)
    if which == "web":
        # the company copy's development proxy points at its own API (the .NET API's default address)
        proxy = target / "PixCartWeb" / "proxy.conf.json"
        cfg = json.loads(proxy.read_text(encoding="utf-8"))
        for v in cfg.values():
            v["target"] = "http://localhost:5080"
        proxy.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    report, changed = [], []
    for dst_rel in sorted(wanted):
        if dst_rel in overrides:
            continue  # hand-written company files are already clean
        if scrub_file(target / dst_rel, dst_rel, report):
            changed.append(dst_rel)
    fixed = []
    for path_re, pat, rep_text in REGEX_FIXUPS:
        for dst_rel in sorted(wanted):
            if not re.match(path_re, dst_rel):
                continue
            p = target / dst_rel
            t = p.read_bytes().decode("utf-8")
            new, n = re.subn(pat, rep_text, t)
            if n:
                p.write_bytes(new.encode("utf-8"))
                fixed.append(f"{dst_rel}: {n} x {pat[:50]}")
    # anything left that still reads as a porting note (comments or text), for review
    left = []
    for dst_rel in sorted(wanted):
        p = target / dst_rel
        try:
            t = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for no, line in enumerate(t.splitlines(), 1):
            if PORT.search(protect(line)):
                left.append(f"{dst_rel}:{no}: {line.strip()[:160]}")
    rep = pathlib.Path(r"C:\Users\haris\pixcart-tools\parity-kit") / f"export-{which}-report.json"
    rep.write_text(json.dumps({"copied": len(mapping), "removed": removed, "cleaned_files": changed, "pattern_fixes": fixed,
                               "mid_sentence_removals": [m.replace(NL, " | ") for m in MIDWORD],
                               "changes": report, "left_for_review": left}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{which}: copied {len(mapping)} files, removed {len(removed)}, cleaned comments in {len(changed)} files "
          f"({len(report)} comments); still mentioning porting terms: {len(left)} lines -> {rep}")


if __name__ == "__main__":
    main()
