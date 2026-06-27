# Drafts & content lifecycle

Article lifecycle for FRESH Insights. Each article is a folder with an `index.qmd`.

## Draft / brainstorm (not published)

Put in-progress pieces in this `_drafts/` folder. Quarto **ignores any folder
whose name starts with `_`**, so nothing here is rendered into `_site/` or
published — it stays in the repo for editing only.

- **To preview a draft locally:** render it explicitly, e.g.
  `quarto render _drafts/the-apple-that-maxed-out/index.qmd`
- **To publish a draft:** move the folder up to the repo root
  (`git mv _drafts/<slug> <slug>`). It is then picked up automatically by the
  Insights listing in `index.qmd`.

## Live (published, on the Insights index)

Article folders at the repo root. The listing in `index.qmd` includes every
`*/index.qmd` except the ones explicitly excluded there (Resources, Archive,
and any archived pieces).

## Archived (published, off the Insights index)

Superseded or older pieces that should stay live at their URL but no longer
appear on the main index. To archive a live article:

1. Add its `index.qmd` to the `contents:` list in `/archive.qmd`.
2. Add a `!<slug>/index.qmd` exclusion to the listing in `index.qmd`.

The page keeps its URL (no redirects needed); it just moves from the Insights
tab to the Archive tab.
