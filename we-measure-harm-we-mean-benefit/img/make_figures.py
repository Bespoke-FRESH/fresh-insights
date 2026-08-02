"""Generate the schematics for 'We Measure Harm, We Mean Benefit'.

Four figures, each carrying one idea the essay otherwise has to make in prose.
Written as a generator rather than hand-authored SVG so the palette, type scale
and footer discipline stay identical across all of them and can be re-emitted
when a number changes.

    python make_figures.py

HONESTY RULE, which is the whole reason this file has a docstring. Three of the
four are SCHEMATICS — they diagram a logical structure, and nothing in them is
plotted from data. Only `claim-became-product` carries real quantities, and both
are cited in the essay. Every figure states in its own footer which kind it is,
because a diagram that looks like a chart is exactly the failure this essay
spends 4,000 words describing.

Matches the idiom of measurement-gauge.svg: 1500-unit viewBox, paper ground,
insight in the title, muted subtitle, hairline rule above a two-line footer.
"""
import pathlib

OUT = pathlib.Path(__file__).parent

INK, INK_SOFT, INK_LINE = "#1a3a2a", "#2a5a3a", "#3a7a5a"
MUTED, MUTED_SOFT = "#6b7b6b", "#9aaa9a"
PAPER, PAPER_DEEP, LINE = "#fffdf8", "#f5f2ed", "#eee8df"
GOLD, RUST = "#c9a227", "#b4532f"
FONT = "Source Sans 3, Segoe UI, Helvetica, Arial, sans-serif"


SX = 1150 / 1500.0   # x-geometry scale; fonts deliberately NOT scaled


def frame(w, h, title, subtitle, body, note, kind):
    """Common chrome: ground, title block, footer rule, caveat, attribution."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'width="{w}" height="{h}" font-family="{FONT}">'
        f'<rect width="{w}" height="{h}" fill="{PAPER}"/>'
        f'<text x="56" y="60" font-size="33.0" font-weight="700" fill="{INK}">{title}</text>'
        f'<text x="44" y="98" font-size="17" fill="{MUTED}">{subtitle}</text>'
        f'{body}'
        f'<line x1="44" y1="{h-62}" x2="{w-44}" y2="{h-62}" stroke="{LINE}" stroke-width="1"/>'
        f'<text x="44" y="{h-40}" font-size="15" fill="{MUTED}">{note}</text>'
        f'<text x="44" y="{h-18}" font-size="15" fill="{MUTED_SOFT}">'
        f'insights.freshfoodrecs.com &#183; {kind} &#183; August 2026</text>'
        f'</svg>'
    )


# ---------------------------------------------------------------- 1. boundary
def boundary():
    w, h = 1150, 662
    b = []
    # three nested requirement bands, each narrowing, with who it excludes
    reqs = [
        ("A diagnosis", "Someone has already crossed a threshold and been named.",
         "Excludes everyone below it — the whole positive-health gradient."),
        ("A dominant causal pathway", "The mechanism is single and agreed, so moving it means something.",
         "Excludes anything diffuse or contested."),
        ("A validated surrogate", "Somebody established that moving the measure moves the outcome.",
         "Excludes anything nobody qualified — and the queue to qualify is closed."),
    ]
    x0, top, band_h, gap = 44, 150, 122, 30
    for i, (name, what, excl) in enumerate(reqs):
        y = top + i * (band_h + gap)
        bw = 690 - i * 92          # narrowing: each condition takes territory away
        b.append(f'<rect x="{x0}" y="{y}" width="{bw}" height="{band_h}" rx="6" '
                 f'fill="{PAPER_DEEP}" stroke="{LINE}" stroke-width="1"/>')
        b.append(f'<rect x="{x0}" y="{y}" width="6" height="{band_h}" rx="3" fill="{INK_SOFT}"/>')
        b.append(f'<text x="{x0+26}" y="{y+38}" font-size="21.0" font-weight="700" fill="{INK}">{name}</text>')
        b.append(f'<text x="{x0+26}" y="{y+68}" font-size="15.5" fill="{MUTED}">{what}</text>')
        b.append(f'<text x="{x0+26}" y="{y+96}" font-size="15.0" fill="{RUST}">{excl}</text>')
        # the population each condition sheds, to the right
        b.append(f'<line x1="{x0+bw+14}" y1="{y+band_h/2}" x2="{x0+bw+58}" y2="{y+band_h/2}" '
                 f'stroke="{RUST}" stroke-width="1.6" stroke-dasharray="5 4"/>')
        b.append(f'<text x="{x0+bw+68}" y="{y+band_h/2+6}" font-size="15.0" fill="{MUTED_SOFT}">shed here</text>')

    y_out = top + 3 * (band_h + gap) + 12
    b.append(f'<rect x="{x0}" y="{y_out}" width="{w-88}" height="74" rx="6" fill="{PAPER}" '
             f'stroke="{RUST}" stroke-width="1.6" stroke-dasharray="7 5"/>')
    b.append(f'<text x="{x0+26}" y="{y_out+31}" font-size="19.0" font-weight="700" fill="{RUST}">'
             f'Clear all three and medicine can tell you to stop.</text>')
    b.append(f'<text x="{x0+26}" y="{y_out+57}" font-size="15.5" fill="{MUTED}">'
             f'Below the threshold, off the approval pathway, chasing something no biomarker '
             f'was ever qualified for — nothing can.</text>')

    return frame(w, h, "Three conditions, and almost nobody clears them",
                 "What has to be true before a stopping rule can exist at all. "
                 "Each condition takes territory away from the one above it.",
                 "".join(b),
                 "Schematic of the argument, not data. Band widths are illustrative; "
                 "no population is being quantified here.",
                 "schematic")


# --------------------------------------------------- 2. general vs enumerated
def general_vs_enumerated():
    w, h = 1150, 588
    b = []
    panels = [
        (44, "Harm surveillance", "general", INK_SOFT,
         "FDA Sentinel &#183; WHO VigiBase &#183; MHRA Yellow Card",
         "One question, asked of anything.",
         "&#8220;Did something go wrong?&#8221;",
         ["any product", "any person", "no prior agreement needed"],
         "Scales to things nobody anticipated."),
        (596, "Benefit surveillance", "enumerated", GOLD,
         "National PROMs &#183; HEDIS &#183; ICHOM",
         "One agreed outcome, per named condition.",
         "&#8220;Did this specific thing improve?&#8221;",
         ["a named procedure", "a defined population", "someone already agreed what better means"],
         "Has to be built one condition at a time."),
    ]
    for x, title, tag, hue, who, lede, question, needs, foot in panels:
        pw = 510
        b.append(f'<rect x="{x}" y="150" width="{pw}" height="380" rx="8" fill="{PAPER_DEEP}" '
                 f'stroke="{LINE}" stroke-width="1"/>')
        b.append(f'<rect x="{x}" y="150" width="{pw}" height="7" rx="3" fill="{hue}"/>')
        b.append(f'<text x="{x+30}" y="196" font-size="23.0" font-weight="700" fill="{INK}">{title}</text>')
        b.append(f'<text x="{x+30}" y="224" font-size="15.0" font-weight="700" letter-spacing="1.4" '
                 f'fill="{hue}">{tag.upper()}</text>')
        b.append(f'<text x="{x+30}" y="256" font-size="15.0" fill="{MUTED_SOFT}">{who}</text>')
        b.append(f'<text x="{x+30}" y="300" font-size="19.0" font-weight="700" fill="{INK}">{question}</text>')
        b.append(f'<text x="{x+30}" y="328" font-size="15.5" fill="{MUTED}">{lede}</text>')
        b.append(f'<text x="{x+30}" y="372" font-size="15.0" font-weight="700" letter-spacing="1.3" '
                 f'fill="{MUTED_SOFT}">NEEDS FIRST</text>')
        for i, n in enumerate(needs):
            yy = 400 + i * 30
            b.append(f'<circle cx="{x+36}" cy="{yy-5}" r="3.5" fill="{hue}"/>')
            b.append(f'<text x="{x+52}" y="{yy}" font-size="16.0" fill="{INK}">{n}</text>')
        b.append(f'<text x="{x+30}" y="508" font-size="15.5" font-style="italic" fill="{MUTED}">{foot}</text>')

    b.append(f'<text x="44" y="576" font-size="19.0" font-weight="700" fill="{INK}">'
             f'Harm is legible without anyone having agreed what good looks like. Benefit is not.</text>')
    return frame(w, h, "Why one side scaled and the other didn&#8217;t",
                 "The same asymmetry as the diagnosis codes, one layer up in the apparatus.",
                 "".join(b),
                 "Schematic. Systems named are real and cited in the essay; "
                 "nothing here is a count or a comparison of size.",
                 "schematic")


# ------------------------------------------------- 3. the claim as the product
def claim_became_product():
    w, h = 1150, 515
    b = []
    # Real quantities, both cited. Area is not used to encode — length only.
    x0, ytop = 44, 190
    scale = 880 / 100000.0
    for label, n, yy, hue, note in [
        ("1994 &#183; DSHEA passes", 4000, ytop, MUTED_SOFT, "about 4,000 products"),
        ("Today", 100000, ytop + 130, INK_SOFT, "FDA estimate"),
    ]:
        bw = max(6, n * scale)
        b.append(f'<text x="{x0}" y="{yy-14}" font-size="17.0" font-weight="700" fill="{INK}">{label}</text>')
        b.append(f'<rect x="{x0}" y="{yy}" width="{bw}" height="46" rx="4" fill="{hue}"/>')
        b.append(f'<text x="{x0+bw+18}" y="{yy+30}" font-size="16.5" fill="{MUTED}">{note}</text>')

    b.append(f'<text x="{x0}" y="{ytop+232}" font-size="21.0" font-weight="700" fill="{INK}">'
             f'Twenty-five times the products, under a rule that never required anyone to show one works.</text>')
    b.append(f'<text x="{x0}" y="{ytop+266}" font-size="16.5" fill="{MUTED}">'
             f'A hundred thousand products still have to be told apart. Evidence is optional and mostly absent, '
             f'so it cannot do the sorting.</text>')
    b.append(f'<rect x="{x0}" y="{ytop+288}" width="{w-88}" height="58" rx="6" fill="{PAPER_DEEP}" '
             f'stroke="{LINE}" stroke-width="1"/>')
    b.append(f'<rect x="{x0}" y="{ytop+288}" width="6" height="58" rx="3" fill="{GOLD}"/>')
    b.append(f'<text x="{x0+26}" y="{ytop+324}" font-size="19.0" font-weight="700" fill="{INK}">'
             f'What is left to compete on is the claim. The noise is the regulation working as written.</text>')
    return frame(w, h, "When benefit need not be proven, the claim is the product",
                 "US dietary supplement products on the market, before and after the 1994 framework.",
                 "".join(b),
                 "Both figures are real and cited in the essay. Bar length encodes count; "
                 "no area or radius scaling is used.",
                 "1994 baseline and current FDA estimate")


# ------------------------------------------------ 4. compression of morbidity
def compression():
    w, h = 1150, 570
    b = []
    x0, ytop, bar_h, gap = 44, 175, 66, 46
    rows = [
        ("Baseline", 430, 200, MUTED_SOFT,
         "A life, and the unwell part of it."),
        ("Compression &#8212; what the field is selling", 540, 160, INK_SOFT,
         "Longer life, shorter sick span."),
        ("What was actually observed", 556, 254, RUST,
         "Not shorter. Possibly longer."),
    ]
    for i, (label, well, sick, hue, note) in enumerate(rows):
        y = ytop + i * (bar_h + gap)
        b.append(f'<text x="{x0}" y="{y-10}" font-size="17.0" font-weight="700" fill="{INK}">{label}</text>')
        b.append(f'<rect x="{x0}" y="{y}" width="{well}" height="{bar_h}" rx="4" fill="{PAPER_DEEP}" '
                 f'stroke="{LINE}" stroke-width="1"/>')
        b.append(f'<rect x="{x0+well}" y="{y}" width="{sick}" height="{bar_h}" rx="4" fill="{hue}"/>')
        b.append(f'<text x="{x0+16}" y="{y+38}" font-size="15.5" fill="{MUTED}">healthy</text>')
        b.append(f'<text x="{x0+well+16}" y="{y+38}" font-size="15.5" fill="{PAPER}">morbidity</text>')
        b.append(f'<text x="{x0+well+sick+20}" y="{y+38}" font-size="15.5" fill="{MUTED_SOFT}">{note}</text>')

    yq = ytop + 3 * (bar_h + gap) + 16
    b.append(f'<rect x="{x0}" y="{yq}" width="{w-88}" height="86" rx="6" fill="{PAPER}" '
             f'stroke="{RUST}" stroke-width="1.6" stroke-dasharray="7 5"/>')
    b.append(f'<text x="{x0+26}" y="{yq+34}" font-size="20.0" font-weight="700" fill="{RUST}">'
             f'The surrogate and the target moved in opposite directions.</text>')
    b.append(f'<text x="{x0+26}" y="{yq+64}" font-size="16.0" fill="{MUTED}">'
             f'Anyone optimising lifespan would think they were winning. '
             f'This is what a surrogate failing looks like while it is still being used.</text>')
    return frame(w, h, "Compression of morbidity, and what happened instead",
                 "Life extends left to right. The dark segment is the part spent unwell.",
                 "".join(b),
                 "Schematic of the concept and the reported direction of effect, from "
                 "life-extending interventions in mice. Segment lengths are illustrative.",
                 "schematic")


for name, fn in [("boundary-conditions", boundary),
                 ("general-vs-enumerated", general_vs_enumerated),
                 ("claim-became-product", claim_became_product),
                 ("compression-of-morbidity", compression)]:
    p = OUT / f"{name}.svg"
    p.write_text(fn(), encoding="utf-8")
    print(f"  wrote {p.name}  ({p.stat().st_size:,} bytes)")
