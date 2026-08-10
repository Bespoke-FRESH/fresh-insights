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
    """A conjunction, not a funnel.

    The previous version stacked three narrowing bands. Two things went wrong.
    The bands' only quantitative channel (width) tapered 690->506 under a
    headline saying almost nobody clears them, which reads as three-quarters
    surviving. And "shed here" appeared three times while shedding a different
    unit each time, implying a nesting the argument never claimed. The three
    conditions are joint conditions on one triple: one person, one treatment,
    one outcome. So: a table of real cases, each cell either the concrete thing
    that fills the condition or an explicit blank. No channel encodes magnitude.
    """
    CASE_X, CASE_W = M, 248
    COLS_X, COL_W, COL_GAP, PAD = 304, 190, 22, 13
    VER_X = COLS_X + 3 * COL_W + 2 * COL_GAP + 18
    VER_W = W - M - VER_X

    conds = [
        ("A diagnosis", "someone crossed a named threshold"),
        ("A dominant causal pathway", "moving it moves the outcome"),
        ("A validated surrogate", "prior trials showed the marker carries through"),
    ]
    # case, triple, [(what fills it, filled?) x3], (clears all three?, verdict)
    rows = [
        ("Contrave", "for weight loss, in obesity",
         [("Obesity, at a defined BMI threshold", True),
          ("The drug acts through body weight", True),
          ("5% of baseline weight by week 12", True)],
         (True, "Discontinue at week 12. It is on the label.")),
        ("Treat-to-target", "for disease control, in rheumatoid arthritis",
         [("Rheumatoid arthritis, classified", True),
          ("Joint inflammation drives the damage", True),
          ("A disease activity score", True)],
         (True, "A target, a review date, an escalation rule.")),
        ("RECIST", "for tumour response, in a solid tumour",
         [("A staged solid tumour", True),
          ("Tumour burden drives the outcome", True),
          ("Tumour measurement", True)],
         (True, "Progressive disease, defined before you start.")),
        ("Time-limited trial", "for organ support, in critical illness",
         [("Critical illness, in front of you", True),
          ("Organ failure drives the outcome", True),
          ("The trajectory of organ failure", True)],
         (True, "A reassessment date, agreed with the family.")),
        ("Berberine", "for weight loss, sold as &#8220;nature&#8217;s Ozempic&#8221;",
         [("None required to buy it", False),
          ("No pathway anyone had to establish", False),
          ("Nothing to fail against", False)],
         (False, "No rule, and nothing that would produce one.")),
        ("A life-extending diet", "for healthspan, in the longevity field",
         [("Aging is not a diagnosis", False),
          ("Diffuse by construction", False),
          ("Lifespan was never qualified for healthspan", False)],
         (False, "Longer life, and the sick span did not shorten.")),
        ("You, most of the time", "for energy, sleep, aging well",
         [("Below the diagnostic threshold", False),
          ("No single pathway to move", False),
          ("No biomarker was ever qualified", False)],
         (False, "So the default is that you continue.")),
    ]

    def wrap(s, size, width, bold=False):
        """Greedy wrap on the same advance estimate frame() asserts with."""
        lines, cur = [], ""
        for word in s.split(" "):
            trial = f"{cur} {word}".strip()
            if cur and tw(trial, size, bold) > width:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        if cur:
            lines.append(cur)
        return lines

    def block(x, y, s, size, width, fill, bold=False, lh=20, maxlines=3):
        ls = wrap(s, size, width, bold)
        assert len(ls) <= maxlines, f"{len(ls)} lines (max {maxlines}): {s}"
        return ("".join(f'<text x="{x}" y="{y + i*lh}" font-size="{size}" '
                        f'font-weight="{700 if bold else 400}" fill="{fill}">'
                        f'{t}</text>' for i, t in enumerate(ls)),
                y + (len(ls) - 1) * lh)

    def cell_x(i):
        return COLS_X + i * (COL_W + COL_GAP)

    b = []
    # the conjunction, stated over the three condition columns
    span_l, span_r = cell_x(0), cell_x(2) + COL_W
    b += [f'<text x="{span_l}" y="{TOP-4}" font-size="15" font-weight="700" '
          f'letter-spacing="1.3" fill="{RUST}">ALL THREE, OF THE SAME PERSON, '
          f'TREATMENT AND OUTCOME</text>',
          f'<path d="M{span_l} {TOP+16} L{span_l} {TOP+6} L{span_r} {TOP+6} '
          f'L{span_r} {TOP+16}" fill="none" stroke="{RUST}" stroke-width="1.4"/>']

    hy = TOP + 40
    b += [f'<text x="{CASE_X}" y="{hy}" font-size="16" font-weight="700" '
          f'fill="{INK}">The case</text>',
          f'<text x="{CASE_X}" y="{hy+22}" font-size="15" fill="{MUTED_SOFT}">'
          f'person, treatment, outcome</text>']
    head_bottom = hy + 22
    for i, (name, gloss) in enumerate(conds):
        s, ny = block(cell_x(i), hy, name, 16, COL_W - 4, INK, bold=True, lh=21,
                      maxlines=2)
        b.append(s)
        s, yend = block(cell_x(i), ny + 22, gloss, 15, COL_W - 4, MUTED_SOFT,
                        lh=19, maxlines=2)
        b.append(s)
        head_bottom = max(head_bottom, yend)
    s, yend = block(VER_X, hy, "Can anything say stop?", 16, VER_W, INK,
                    bold=True, lh=21, maxlines=2)
    b.append(s)
    head_bottom = max(head_bottom, yend)

    y = head_bottom + 16
    b.append(f'<line x1="{M}" y1="{y}" x2="{W-M}" y2="{y}" stroke="{LINE}" '
             f'stroke-width="1"/>')
    y += 14

    ROW_GAP, table_top = 6, y
    for name, triple, cells, (ok, verdict) in rows:
        # Row height follows the tallest thing in the row rather than a fixed
        # guess, so no cell ever runs through its own bottom border.
        nlines = max([len(wrap(t, 15, COL_W - 2 * PAD)) for t, _ in cells]
                     + [len(wrap(verdict, 15, VER_W))])
        row_h = 42 + nlines * 19 + 6
        b.append(f'<rect x="{CASE_X}" y="{y}" width="4" height="{row_h}" rx="2" '
                 f'fill="{INK_SOFT if ok else RUST}"/>')
        s, _ = block(CASE_X + 16, y + 24, name, 18, CASE_W - 20, INK, bold=True,
                     maxlines=1)
        b.append(s)
        s, _ = block(CASE_X + 16, y + 44, triple, 15, CASE_W - 20, MUTED, lh=19,
                     maxlines=2)
        b.append(s)
        for i, (txt, filled) in enumerate(cells):
            x = cell_x(i)
            if filled:
                b += [f'<rect x="{x}" y="{y}" width="{COL_W}" height="{row_h}" '
                      f'rx="5" fill="{PAPER_DEEP}"/>',
                      f'<polyline points="{x+PAD},{y+22} {x+PAD+4.6},{y+27} '
                      f'{x+PAD+12},{y+16}" fill="none" stroke="{INK_SOFT}" '
                      f'stroke-width="2.4" stroke-linecap="round" '
                      f'stroke-linejoin="round"/>']
                hue = INK
            else:
                b += [f'<rect x="{x}" y="{y}" width="{COL_W}" height="{row_h}" '
                      f'rx="5" fill="{PAPER}" stroke="{RUST}" stroke-width="1.2" '
                      f'stroke-dasharray="5 4" opacity="0.85"/>',
                      f'<line x1="{x+PAD}" y1="{y+17}" x2="{x+PAD+12}" '
                      f'y2="{y+17}" stroke="{RUST}" stroke-width="2.2" '
                      f'stroke-linecap="round" opacity="0.8"/>']
                hue = MUTED
            s, _ = block(x + PAD, y + 42, txt, 15, COL_W - 2 * PAD, hue, lh=19)
            b.append(s)
        hue = INK_SOFT if ok else RUST
        b.append(f'<text x="{VER_X}" y="{y+22}" font-size="16" font-weight="700" '
                 f'fill="{hue}" letter-spacing="0.6">{"YES" if ok else "NO"}</text>')
        s, _ = block(VER_X, y + 42, verdict, 15, VER_W, MUTED, lh=19)
        b.append(s)
        for i in (1, 2):                       # the AND, drawn in the gutters
            b.append(f'<text x="{cell_x(i) - COL_GAP/2}" y="{y+27}" '
                     f'font-size="17" font-weight="700" fill="{RUST}" '
                     f'text-anchor="middle" opacity="0.75">+</text>')
        y += row_h + ROW_GAP

    # three inputs on the left of this line, the one answer they produce on the right
    b.append(f'<line x1="{VER_X-20}" y1="{table_top-14}" x2="{VER_X-20}" '
             f'y2="{y-ROW_GAP}" stroke="{LINE}" stroke-width="1"/>')

    y += 12
    b += [f'<rect x="{M}" y="{y}" width="{W-2*M}" height="78" rx="6" '
          f'fill="{PAPER}" stroke="{RUST}" stroke-width="1.6" '
          f'stroke-dasharray="7 5"/>',
          f'<text x="{M+26}" y="{y+33}" font-size="19" font-weight="700" '
          f'fill="{RUST}">One blank cell is enough. There is no partial credit '
          f'in this table.</text>',
          f'<text x="{M+26}" y="{y+61}" font-size="16" fill="{MUTED}">'
          f'Most people, most of the time, are reading the bottom three rows.</text>']

    return frame("It takes all three, or nothing can tell you to stop",
                 "Seven cases from the essay, and what fills each condition.",
                 "".join(b), y + 78,
                 "Schematic. Every case named is real and cited in the essay. "
                 "Nothing here encodes a quantity.",
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
          f'What is left to compete on is brand.</text>']
    return frame("When benefit need not be proven, the brand is the product",
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
