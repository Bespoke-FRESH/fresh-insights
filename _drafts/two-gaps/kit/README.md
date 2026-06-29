# FRESH house icon kit

The genuine concept-art icons from `D:\01_Bespoke Analytics\FRESH_overview_webinar.pptx`,
extracted from the deck and normalized for reuse in interactive reveals.

These are the real Microsoft-365 flat icons Josh composed the webinar slides from —
**not redraws, and never to be replaced by Twemoji or other stock emoji.** When a reveal
must match the deck's look, this is the source of truth.

## Provenance

A `.pptx` is a zip. The icons live in `ppt/media/*.svg`. Extraction:

```bash
cp "FRESH_overview_webinar.pptx" deck.zip && unzip -q deck.zip -d unz
# normalize each to recolor at use-time:
sed -E '0,/<svg /{s/<svg /<svg fill="currentColor" /}' unz/ppt/media/imageNN.svg > svg/name.svg
```

The 52 PNGs + 12 JPEGs in the same dir hold the *colored composites* (the orange arms-up
"uncertain person", the rating tiles, the expert discussion-circle). Pull those the same
way if a beat needs them.

## Recolor convention

Every icon is single-path, `viewBox="0 0 96 96"`, and carries `fill="currentColor"`, so it
takes the colour of its container — no editing the file:

```html
<span style="color:#2f7d54"><!-- forest green -->  ...icon... </span>
<span style="color:#c69a3a"><!-- gold = emphasis --> ...icon... </span>
```

Colour binds word to mark (storytelling principle #6): an icon emphasised in a beat takes
the gold of the caption phrase that names it.

## Semantic map

| File | Role in the story | deck source |
|---|---|---|
| `user.svg` | the person asking | image24 |
| `question.svg` | the query / "is it healthy?" | image26 (thought bubble) |
| `expert-panel.svg` | the rating systems as a panel | image63 (group) |
| `model-driven.svg` | model-based scoring | image61 (brain-in-head) |
| `uncertain.svg` / `question-mark.svg` | no consensus | image51 / image57 |
| `healthy.svg` / `unhealthy.svg` | the rating poles | image55 / derived flip |
| `rating-screen.svg` | the scoring output | image40 (monitor) |
| `health.svg` | health outcome | image59 (heart-pulse) |
| `outcome.svg` | improvement over time | image80 (upward trend) |
| `process.svg` | flow between steps | image43 (chevrons) |
| `evaluate.svg` | inspect / assess | image46 (magnifier) |
| `aging` `activity` `balance` `clinical` `lab` | domain endpoints | image66/70/72/74/76 |

Originals retained as `imageNN.svg` alongside the semantic copies. Preview: `index.html`.
