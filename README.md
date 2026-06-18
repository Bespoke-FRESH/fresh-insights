# FRESH Insights

The public-facing essay blog for the **FRESH** usual-intake pipeline, served at
[insights.freshfoodrecs.com](https://insights.freshfoodrecs.com).

Built with [Quarto](https://quarto.org) (website project). Every push to `main`
re-renders the site and deploys it to GitHub Pages via
`.github/workflows/publish.yml`.

## Structure

| Path | What |
|---|---|
| `index.qmd` | Home / listing page |
| `not-the-price-of-fruit/` | Main essay + figures |
| `not-the-price-of-fruit-notes/` | Methods & robustness companion + figures |
| `_quarto.yml` | Site config (navbar, theme, custom domain resource) |
| `styles.css` | House style (forest-green ink, cream paper, Lora display) |
| `CNAME` | Custom-domain record for GitHub Pages |

## Local preview

```bash
quarto preview      # live-reload at localhost
quarto render       # one-off build into _site/
```

## Deploy

Automatic on push to `main`. Custom domain `insights.freshfoodrecs.com` requires
a DNS `CNAME` record pointing `insights` → `<org>.github.io`.
