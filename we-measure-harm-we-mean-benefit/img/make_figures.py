"""Generate the schematics for 'We Measure Harm, We Mean Benefit'.

Four figures, each carrying one idea the essay otherwise makes in prose alone.
A generator rather than hand-authored SVG so palette, type scale and footer
discipline stay identical and can be re-emitted when a number changes.

    python make_figures.py

HONESTY RULE. Three of the four are SCHEMATICS — they diagram a logical
structure and nothing in them is plotted from data. Only `claim-became-product`
carries real quantities, both cited in the essay. Every figure states which kind
it is in its own footer, because a diagram that looks like a chart is exactly
the failure this essay describes.

LAYOUT RULE, learned the hard way. Canvas height is COMPUTED from where the
content actually ends — never hardcoded, never scaled by a guess. An earlier
version narrowed the coordinate space and shrank canvas heights by a fixed
factor while the content kept its original height, so all four figures ran
straight through their own footers. Each builder now reports where its content
bottoms out and frame() sizes the canvas around that.

Type floor is 15 units in a 1150-wide space, so the smallest text renders at
~12.8px in the site's 980px body — above the 11px legibility floor.
"""
import html
import pathlib
import re

OUT = pathlib.Path(__file__).parent

INK, INK_SOFT = "#1a3a2a", "#2a5a3a"
MUTED, MUTED_SOFT = "#6b7b6b", "#9aaa9a"
PAPER, PAPER_DEEP, LINE = "#fffdf8", "#f5f2ed", "#eee8df"
GOLD, RUST = "#c9a227", "#b4532f"
FONT = "Source Sans 3, Segoe UI, Helvetica, Arial, sans-serif"

W = 1150
M = 44                    # left/right margin
TOP = 150                 # first content row, below the title block
FOOTER = 96               # rule + two footer lines + breathing room


def tw(s, size, bold=False):
    """Rough advance width, used to assert nothing runs past the frame."""
    return len(html.unescape(s)) * size * (0.55 if bold else 0.50)


def frame(title, subtitle, body, bottom, note, kind):
    h = int(bottom + FOOTER)
    for s, size, bold in ((title, 34, True), (subtitle, 17, False), (note, 15, False)):
        assert M + tw(s, size, bold) < W - 12, f"overflows frame: {s[:60]}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {h}" '
        f'width="{W}" height="{h}" font-family="{FONT}">'
        f'<rect width="{W}" height="{h}" fill="{PAPER}"/>'
        f'<text x="{M}" y="62" font-size="34" font-weight="700" fill="{INK}">{title}</text>'
        f'<text x="{M}" y="98" font-size="17" fill="{MUTED}">{subtitle}</text>'
        f'{body}'
        f'<line x1="{M}" y1="{h-64}" x2="{W-M}" y2="{h-64}" stroke="{LINE}" stroke-width="1"/>'
        f'<text x="{M}" y="{h-40}" font-size="15" fill="{MUTED}">{note}</text>'
        f'<text x="{M}" y="{h-16}" font-size="15" fill="{MUTED_SOFT}">'
        f'insights.freshfoodrecs.com &#183; {kind} &#183; August 2026</text>'
        f'</svg>')


# ---------------------------------------------------------------- 1. boundary
def boundary():
    reqs = [
        ("A diagnosis", "Someone has already crossed a threshold and been named.",
         "Excludes everyone below it &#8212; the whole positive-health gradient."),
        ("A dominant causal pathway", "The mechanism is single and agreed, so moving it means something.",
         "Excludes anything diffuse or contested."),
        ("A validated surrogate", "Somebody established that moving the measure moves the outcome.",
         "Excludes anything nobody qualified, and that queue is closed."),
    ]
    b, band_h, gap = [], 122, 26
    for i, (name, what, excl) in enumerate(reqs):
        y = TOP + i * (band_h + gap)
        bw = 690 - i * 92
        b += [f'<rect x="{M}" y="{y}" width="{bw}" height="{band_h}" rx="6" fill="{PAPER_DEEP}" stroke="{LINE}" stroke-width="1"/>',
              f'<rect x="{M}" y="{y}" width="6" height="{band_h}" rx="3" fill="{INK_SOFT}"/>',
              f'<text x="{M+26}" y="{y+40}" font-size="21" font-weight="700" fill="{INK}">{name}</text>',
              f'<text x="{M+26}" y="{y+72}" font-size="16" fill="{MUTED}">{what}</text>',
              f'<text x="{M+26}" y="{y+100}" font-size="15" fill="{RUST}">{excl}</text>',
              f'<line x1="{M+bw+16}" y1="{y+band_h/2}" x2="{M+bw+56}" y2="{y+band_h/2}" stroke="{RUST}" stroke-width="1.6" stroke-dasharray="5 4"/>',
              f'<text x="{M+bw+68}" y="{y+band_h/2+6}" font-size="15" fill="{MUTED_SOFT}">shed here</text>']
    y_out = TOP + 3 * (band_h + gap) + 14
    b += [f'<rect x="{M}" y="{y_out}" width="{W-2*M}" height="78" rx="6" fill="{PAPER}" stroke="{RUST}" stroke-width="1.6" stroke-dasharray="7 5"/>',
          f'<text x="{M+26}" y="{y_out+33}" font-size="19" font-weight="700" fill="{RUST}">Clear all three and medicine can tell you to stop.</text>',
          f'<text x="{M+26}" y="{y_out+61}" font-size="16" fill="{MUTED}">Miss any one and nothing in the apparatus can.</text>']
    return frame("Three conditions, and almost nobody clears them",
                 "What has to be true before a stopping rule can exist at all.",
                 "".join(b), y_out + 78,
                 "Schematic of the argument, not data. Band widths are illustrative.",
                 "schematic")


# --------------------------------------------------- 2. general vs enumerated
def general_vs_enumerated():
    panels = [
        (M, "Harm surveillance", "GENERAL", INK_SOFT,
         "FDA Sentinel &#183; WHO VigiBase &#183; Yellow Card",
         "&#8220;Did something go wrong?&#8221;", "One question, asked of anything.",
         ["any product", "any person", "no prior agreement needed"],
         "Scales to what nobody anticipated."),
        (M + 542, "Benefit surveillance", "ENUMERATED", GOLD,
         "National PROMs &#183; HEDIS &#183; ICHOM",
         "&#8220;Did this specific thing improve?&#8221;", "One agreed outcome, per named condition.",
         ["a named procedure", "a defined population", "an agreed definition of better"],
         "Built one condition at a time."),
    ]
    b, pw, ph = [], 520, 356
    for x, title, tag, hue, who, question, lede, needs, foot in panels:
        b += [f'<rect x="{x}" y="{TOP}" width="{pw}" height="{ph}" rx="8" fill="{PAPER_DEEP}" stroke="{LINE}" stroke-width="1"/>',
              f'<rect x="{x}" y="{TOP}" width="{pw}" height="7" rx="3" fill="{hue}"/>',
              f'<text x="{x+28}" y="{TOP+46}" font-size="22" font-weight="700" fill="{INK}">{title}</text>',
              f'<text x="{x+28}" y="{TOP+72}" font-size="15" font-weight="700" letter-spacing="1.4" fill="{hue}">{tag}</text>',
              f'<text x="{x+28}" y="{TOP+100}" font-size="15" fill="{MUTED_SOFT}">{who}</text>',
              f'<text x="{x+28}" y="{TOP+142}" font-size="19" font-weight="700" fill="{INK}">{question}</text>',
              f'<text x="{x+28}" y="{TOP+170}" font-size="16" fill="{MUTED}">{lede}</text>',
              f'<text x="{x+28}" y="{TOP+210}" font-size="15" font-weight="700" letter-spacing="1.3" fill="{MUTED_SOFT}">NEEDS FIRST</text>']
        for i, n in enumerate(needs):
            yy = TOP + 240 + i * 30
            b += [f'<circle cx="{x+34}" cy="{yy-5}" r="3.5" fill="{hue}"/>',
                  f'<text x="{x+50}" y="{yy}" font-size="16" fill="{INK}">{n}</text>']
        b.append(f'<text x="{x+28}" y="{TOP+ph-18}" font-size="16" font-style="italic" fill="{MUTED}">{foot}</text>')
    yl = TOP + ph + 44
    b.append(f'<text x="{M}" y="{yl}" font-size="19" font-weight="700" fill="{INK}">'
             f'Harm is legible without anyone having agreed what good looks like.</text>')
    return frame("Why one side scaled and the other didn&#8217;t",
                 "The same asymmetry as the diagnosis codes, one layer up in the apparatus.",
                 "".join(b), yl + 16,
                 "Schematic. The systems named are real and cited; nothing here is a count.",
                 "schematic")


# ------------------------------------------------- 3. the claim as the product
def claim_became_product():
    b, scale, bar_h = [], 860 / 100000.0, 48
    y = TOP
    for label, n, hue, note in [("1994 &#183; DSHEA passes", 4000, MUTED_SOFT, "about 4,000 products"),
                                ("Today", 100000, INK_SOFT, "FDA estimates more than 100,000")]:
        bw = max(6, n * scale)
        b += [f'<text x="{M}" y="{y-12}" font-size="17" font-weight="700" fill="{INK}">{label}</text>',
              f'<rect x="{M}" y="{y}" width="{bw}" height="{bar_h}" rx="4" fill="{hue}"/>']
        # A note that would run past the frame goes inside the bar instead of
        # after it — the long bar leaves no room to its right by construction.
        if M + bw + 16 + tw(note, 16) > W - 12:
            b.append(f'<text x="{M+16}" y="{y+31}" font-size="16" fill="{PAPER}">{note}</text>')
        else:
            b.append(f'<text x="{M+bw+16}" y="{y+31}" font-size="16" fill="{MUTED}">{note}</text>')
        y += 128
    y += 12
    b.append(f'<text x="{M}" y="{y}" font-size="21" font-weight="700" fill="{INK}">'
             f'Twenty-five times the products, under a rule that never required proof.</text>')
    y += 34
    b.append(f'<text x="{M}" y="{y}" font-size="16" fill="{MUTED}">'
             f'A hundred thousand products still have to be told apart, and evidence cannot do the sorting.</text>')
    y += 26
    b += [f'<rect x="{M}" y="{y}" width="{W-2*M}" height="62" rx="6" fill="{PAPER_DEEP}" stroke="{LINE}" stroke-width="1"/>',
          f'<rect x="{M}" y="{y}" width="6" height="62" rx="3" fill="{GOLD}"/>',
          f'<text x="{M+26}" y="{y+38}" font-size="19" font-weight="700" fill="{INK}">'
          f'What is left to compete on is the claim.</text>']
    return frame("When benefit need not be proven, the claim is the product",
                 "US dietary supplement products, before and after the 1994 framework.",
                 "".join(b), y + 62,
                 "Both figures are real and cited. Bar length encodes count; no area scaling.",
                 "1994 baseline and current FDA estimate")


# ------------------------------------------------ 4. compression of morbidity
def compression():
    rows = [("Baseline", 430, 200, MUTED_SOFT, "A life, and the unwell part of it."),
            ("Compression &#8212; what is being sold", 540, 160, INK_SOFT, "Longer life, shorter sick span."),
            ("What was observed", 556, 254, RUST, "Not shorter. Possibly longer.")]
    b, bar_h, gap = [], 64, 48
    for i, (label, well, sick, hue, note) in enumerate(rows):
        y = TOP + i * (bar_h + gap)
        b += [f'<text x="{M}" y="{y-12}" font-size="17" font-weight="700" fill="{INK}">{label}</text>',
              f'<rect x="{M}" y="{y}" width="{well}" height="{bar_h}" rx="4" fill="{PAPER_DEEP}" stroke="{LINE}" stroke-width="1"/>',
              f'<rect x="{M+well}" y="{y}" width="{sick}" height="{bar_h}" rx="4" fill="{hue}"/>',
              f'<text x="{M+14}" y="{y+39}" font-size="15" fill="{MUTED}">healthy</text>',
              f'<text x="{M+well+14}" y="{y+39}" font-size="15" fill="{PAPER}">morbidity</text>',
              f'<text x="{M+well+sick+18}" y="{y+39}" font-size="15" fill="{MUTED_SOFT}">{note}</text>']
    yq = TOP + 3 * (bar_h + gap) + 8
    b += [f'<rect x="{M}" y="{yq}" width="{W-2*M}" height="78" rx="6" fill="{PAPER}" stroke="{RUST}" stroke-width="1.6" stroke-dasharray="7 5"/>',
          f'<text x="{M+26}" y="{yq+33}" font-size="19" font-weight="700" fill="{RUST}">'
          f'Lifespan is not a validated stand-in for healthspan.</text>',
          f'<text x="{M+26}" y="{yq+61}" font-size="16" fill="{MUTED}">'
          f'It is only what can be counted, and the assumption was not tested until now.</text>']
    return frame("Compression of morbidity, and what happened instead",
                 "Life extends left to right. The dark segment is the part spent unwell.",
                 "".join(b), yq + 78,
                 "Schematic of the concept and the reported direction of effect in mice.",
                 "schematic")


for name, fn in [("boundary-conditions", boundary),
                 ("general-vs-enumerated", general_vs_enumerated),
                 ("claim-became-product", claim_became_product),
                 ("compression-of-morbidity", compression)]:
    svg = fn()
    (OUT / f"{name}.svg").write_text(svg, encoding="utf-8")
    print(f"  {name:28s} {W}x{re.search(r'viewBox=.0 0 \d+ (\d+).', svg).group(1)}")
