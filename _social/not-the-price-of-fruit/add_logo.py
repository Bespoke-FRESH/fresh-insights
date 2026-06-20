"""Composite the transparent FRESH mark + wordmark as a TOP-RIGHT header
attribution onto the hero figure (balances the top-left title; standard
brand-in-corner placement). Idempotent: always re-reads the clean chart that
make_hero.R writes, so make_hero.R then this script reproduces the logo'd hero."""
from PIL import Image, ImageDraw, ImageFont

POST = r"C:/GitHub/linkedin_profile/substack_assets/posts/2026-06-18-its-not-the-price-of-fruit"
HERO = POST + "/hero_age_vs_income.png"
ICO  = r"C:/GitHub/fresh_ketones/R/www/fk_favicon.ico"

hero = Image.open(HERO).convert("RGBA")
W, H = hero.size
mark = Image.open(ICO).convert("RGBA")

# sample the logo's green for the wordmark (per-channel median of opaque px)
px = [p for p in mark.getdata() if p[3] > 200]
n = len(px)
green = tuple(sorted(c[i] for c in px)[n // 2] for i in range(3))

# --- top-right header: [ FRESH ] [mark] ---
logo_h = int(0.058 * H)
margin = int(0.018 * W)
mark_r = mark.resize((logo_h, logo_h), Image.LANCZOS)

try:
    font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", int(logo_h * 0.62))
except Exception:
    font = ImageFont.load_default()
word = "F.R.E.S.H"
draw = ImageDraw.Draw(hero)
tb = draw.textbbox((0, 0), word, font=font)
tw, th = tb[2] - tb[0], tb[3] - tb[1]

mark_x = W - margin - logo_h
mark_y = int(0.022 * H)                     # aligned with the title band
gap = int(0.30 * logo_h)
text_x = mark_x - gap - tw
text_y = mark_y + (logo_h - th) // 2 - tb[1]

draw.text((text_x, text_y), word, font=font, fill=green + (255,))
hero.alpha_composite(mark_r, (mark_x, mark_y))

hero.convert("RGB").save(HERO, "PNG")
print(f"composited FRESH top-right attribution (green={green}, logo_h={logo_h}px) onto {HERO}")
