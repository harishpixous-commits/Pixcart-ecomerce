"""Stitches a recorded plan (plan.json from rec.cjs) into one MP4: title cards + the recorded scenes, in order.

    python assemble.py <plan.json> <out.mp4> <logo.png> "<video title>" "<subtitle>"
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

FFMPEG = "ffmpeg"
NAVY, GREEN, WHITE, SOFT = (11, 51, 84), (125, 187, 66), (255, 255, 255), (200, 214, 228)
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_R = "C:/Windows/Fonts/segoeui.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def card(path, size, logo, title, sub, kind="chapter"):
    W, H = size
    img = Image.new("RGB", size, NAVY)
    d = ImageDraw.Draw(img)
    # soft green glow
    glow = Image.new("RGB", size, NAVY)
    gd = ImageDraw.Draw(glow)
    for r in range(int(W * 0.55), 0, -12):
        a = int(26 * (1 - r / (W * 0.55)))
        gd.ellipse([W * 0.85 - r, H * 0.15 - r, W * 0.85 + r, H * 0.15 + r], fill=(11 + a // 2, 51 + a * 2, 84 - a // 3))
    img = Image.blend(img, glow, 0.6)
    d = ImageDraw.Draw(img)
    scale = W / 1440
    if logo:
        lg = Image.open(logo).convert("RGBA")
        lw = int((360 if kind == "title" else 240) * scale * (1.6 if H > W else 1))
        lg = lg.resize((lw, int(lg.height * lw / lg.width)))
        pad = int(18 * scale * (1.6 if H > W else 1))
        box = Image.new("RGBA", (lg.width + pad * 2, lg.height + pad * 2), (255, 255, 255, 255))
        box.paste(lg, (pad, pad), lg)
        x = (W - box.width) // 2
        y = int(H * (0.2 if kind == "title" else 0.24))
        img.paste(box, (x, y))
        ty = y + box.height + int(60 * scale * (1.4 if H > W else 1))
    else:
        ty = int(H * 0.38)
    big = font(FONT_B, int((64 if kind == "title" else 54) * scale * (1.7 if H > W else 1)))
    small = font(FONT_R, int(28 * scale * (1.7 if H > W else 1)))
    maxw = int(W * 0.84)
    for line in wrap(d, title, big, maxw):
        tw = d.textlength(line, font=big)
        d.text(((W - tw) / 2, ty), line, font=big, fill=WHITE)
        ty += int(big.size * 1.22)
    ty += int(14 * scale)
    d.rectangle([W / 2 - 40 * scale, ty, W / 2 + 40 * scale, ty + 6 * scale], fill=GREEN)
    ty += int(34 * scale * (1.5 if H > W else 1))
    for line in wrap(d, sub, small, maxw):
        tw = d.textlength(line, font=small)
        d.text(((W - tw) / 2, ty), line, font=small, fill=SOFT)
        ty += int(small.size * 1.45)
    foot = font(FONT_R, int(20 * scale * (1.6 if H > W else 1)))
    ft = "AI Multivendor Shopping Cart  ·  Pixous Technologies"
    d.text(((W - d.textlength(ft, font=foot)) / 2, H - int(60 * scale * (1.6 if H > W else 1))), ft, font=foot, fill=(150, 170, 190))
    img.save(path)


def run(args):
    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])


def main():
    plan_file, out, logo, vtitle, vsub = sys.argv[1:6]
    plan = json.load(open(plan_file, encoding="utf-8"))
    mobile = plan["mobile"]
    size = (780, 1688) if mobile else (1440, 900)
    W, H = size
    enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30", "-an"]
    tmp = tempfile.mkdtemp(prefix="vid_")
    parts = []
    # opening title
    png = os.path.join(tmp, "title.png")
    card(png, size, logo, vtitle, vsub, kind="title")
    part = os.path.join(tmp, "p000.mp4")
    run(["-loop", "1", "-t", "4", "-i", png, "-vf", f"scale={W}:{H},fade=in:0:12", *enc, part])
    parts.append(part)
    for i, s in enumerate(plan["scenes"], 1):
        part = os.path.join(tmp, f"p{i:03d}.mp4")
        if s.get("card"):
            png = os.path.join(tmp, f"c{i:03d}.png")
            card(png, size, logo, s["title"], s.get("sub", ""))
            run(["-loop", "1", "-t", str(s.get("seconds", 3)), "-i", png, "-vf", f"scale={W}:{H}", *enc, part])
        else:
            dur = max(0.5, s["to"] - s["from"])
            # phone recordings inside a desktop video sit centred on a dark background
            if s.get("mobile") and not mobile:
                vf = f"scale=-2:{H - 40},pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0B3354"
            else:
                vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0B3354"
            run(["-ss", f"{s['from']:.2f}", "-t", f"{dur:.2f}", "-i", s["video"], "-vf", vf + ",setsar=1", *enc, part])
        parts.append(part)
    # closing card
    png = os.path.join(tmp, "end.png")
    card(png, size, logo, "AI Multivendor Shopping Cart", "Shopping website · Seller hub · Delivery partner app · AI admin panel", kind="title")
    part = os.path.join(tmp, "p999.mp4")
    run(["-loop", "1", "-t", "4", "-i", png, "-vf", f"scale={W}:{H},fade=out:st=3.4:d=0.6", *enc, part])
    parts.append(part)
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for p in parts:
            f.write(f"file '{p.replace(os.sep, '/')}'\n")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    run(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out])
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], capture_output=True, text=True).stdout.strip()
    print(f"{out}  ({float(probe or 0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
