# `_social/` — marketing derivatives (NOT published)

The `_` prefix means Quarto ignores this whole tree — nothing here renders into the
site. It's the per-post workshop for everything that *isn't* the published page.

**Structure:** `_social/<post-slug>/` mirrors the published post at `/<post-slug>/`.

Each post folder holds:
- `linkedin.md` — the LinkedIn post + comment thread (paste-ready), and the prior-thinking thread.
- figure / table build tooling (`make_hero.R`, `add_logo.py`, table-image scripts) that generated the post's published figures.
- any Substack-only assets (e.g. table PNGs Substack needed but the blog renders natively).

**Why here:** Insights is the central content hub — published essay *and* its marketing
derivatives live in one company-owned repo. Personal-brand *inputs* (the LinkedIn post
corpus, voice metaprofile, saved-posts trend DB) stay in the personal `linkedin_profile`
repo; this folder is for *outputs* of the FRESH content pipeline.
