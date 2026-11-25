"""Builds the app fonts from the website's @fontsource files (same glyphs as the mobile website).

@fontsource ships each weight as unicode-range subsets (latin, latin-ext, devanagari) in WOFF; Flutter needs one
TTF per weight, so the subsets are decompressed and merged with fontTools. Run once after a font change:
    python tools/build_fonts.py "<path to frontend/node_modules/@fontsource>"
"""
import os
import sys
import tempfile

from fontTools.merge import Merger, Options
from fontTools.ttLib import TTFont

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "..", "packages", "pixcart_ui", "fonts")
FONTS = {
    # family dir, file prefix, weights the website loads (app/layout.tsx), output name
    "mukta": ("mukta", [400, 500, 600], "Mukta"),
    "baloo-2": ("baloo-2", [500, 600, 700], "Baloo2"),
}
SUBSETS = ["latin", "latin-ext", "devanagari"]

for key, (prefix, weights, name) in FONTS.items():
    for w in weights:
        parts = []
        tmp = tempfile.mkdtemp()
        for sub in SUBSETS:
            woff = os.path.join(SRC, key, "files", f"{prefix}-{sub}-{w}-normal.woff")
            if not os.path.exists(woff):
                continue
            f = TTFont(woff)
            f.flavor = None
            # the merger needs the same tables in every part
            for t in ("GSUB", "GPOS", "GDEF", "kern"):
                if t in f and sub != "latin":
                    del f[t]
            p = os.path.join(tmp, f"{sub}.ttf")
            f.save(p)
            parts.append(p)
        try:
            merged = Merger(options=Options(drop_tables=["vmtx", "vhea"])).merge(parts)
        except Exception as exc:  # fall back to the latin subset with the rupee sign from devanagari
            print("merge failed", name, w, exc)
            merged = TTFont(parts[0])
        out = os.path.join(OUT, f"{name}-{w}.ttf")
        merged.save(out)
        cmap = merged.getBestCmap()
        print(out, "glyphs", len(merged.getGlyphOrder()), "rupee", 0x20B9 in cmap)
