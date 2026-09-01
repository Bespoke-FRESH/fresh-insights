# fresh-insights — agent entry point

Shared instructions for every coding agent (Claude Code reads this via `CLAUDE.md`).

## ⚠️ This repo is the public internet

**A push to `main` publishes.** `.github/workflows/publish.yml` re-renders the Quarto site and deploys
it to GitHub Pages at **insights.freshfoodrecs.com** on every push to `main`. There is no staging step
and no manual approval between `git push` and a live public page under Josh's name.

Therefore:
- **Never push to `main` without Josh's explicit go-ahead on that specific content.** Render locally,
  show him the output, and let him decide. Approval to draft is not approval to publish.
- **Never publish on your own initiative**, however finished a draft looks.
- Treat `_drafts/` as private. Moving something out of it is a publication decision, not a file move.

## What this is

The public-facing essay blog for FRESH — a Quarto website project. `index.qmd` is the listing page;
each essay is a directory with its `.qmd` plus figures; `_quarto.yml` holds site config; `styles.css`
is the house style (forest-green ink, cream paper, Lora display); `CNAME` pins the custom domain.

```bash
quarto preview      # live-reload locally — do this, not a push, to see changes
quarto render       # one-off build into _site/
```

## Disclosure boundaries — check every draft against these

- **Patent material is internal-only.** US App. 18/907,348 / Pub. US 2025/0029705 A1 — the spec,
  claims, Office Actions, and prosecution strategy must never be cited, quoted, paraphrased, or
  alluded to here. The hub's engine-definitional material (`fresh/hub/ENGINES.md` and the
  *Definition & Asset Inventory*) is attorney work-product and carries the same bar.
- **Undisclosed methodology stays undisclosed.** Data-driven outcome-specific NPS work (DSign,
  cognition, biological aging) has not been publicly disclosed. The IAFNS webinars covered
  **expert-rule NPS only**. Do not treat a private repo as a public artifact.
- **Verify citations before publishing, not after.** Use the `citation-verification` skill. A claim
  that a source does not actually support is the failure mode that matters most here.
- **Don't overclaim novelty.** Specifically: the carb-misalignment paper's new contribution is
  consumer belief elicitation + misperception/misalignment. Meta-NPS and expert uncertainty were the
  earlier OJ paper — do not write "first to quantify expert uncertainty."
- **Two nutrition literatures.** Diet-pattern/diet-quality and food-attribute/NPS evidence are
  different fields. A sentence that slides between them reads as sloppy to exactly the audience
  this site is for.

## Verify — before showing Josh a draft

1. `quarto render` completes clean (no unresolved refs, no broken figure paths).
2. Every citation checked with the `citation-verification` skill.
3. The draft passes the disclosure boundaries above.
4. Voice and framing per the `fresh-weekly-essay` skill — that skill owns the voice, sensitivity
   gates, and source discipline for anything published here.

## Interactive artifacts

Self-contained HTML artifacts are hosted here too — use the `artifact-share` skill, which covers the
self-containment check, the mobile rendition, the Quarto + iframe hub entry, unlisted-vs-public and
`noindex`, and the surgical promote → commit-only-your-files → push → verify flow. Don't improvise
that; a mis-scoped commit here publishes whatever else was in the tree.

`AGENT_MERGE_PROTOCOL.md` governs. Publication decisions are Class C by definition.

## Definition of done

- `quarto render` completes clean.
- Every citation checked with the `citation-verification` skill.
- The draft clears all four disclosure boundaries above.
- **Josh has seen the rendered output and said publish.** Until then it is not done, it is drafted.
