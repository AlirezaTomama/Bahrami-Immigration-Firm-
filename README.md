# Bahrami Immigration — Advisory Platform (Prototype)

Single-file bilingual (EN/FA) prototype of the immigration-visa.ca redesign.
Rules & CRS grid verified Sep 2026 (job-offer points removed, SUV closed, BC PNP 2026 pivot, Apr 2026 fees).

## Deploy on GitHub Pages
1. Put `index.html` in the repo root (branch `main`).
2. Repo **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
3. Site goes live at `https://<username>.github.io/<repo>/` within ~1 minute.

## Notes
- Hash routing (`#/assess`, `#/programs`, …) — works on static hosting, no server config needed.
- **AI Guide:** the in-page call to the Anthropic API only works inside Claude's artifact environment. On GitHub Pages it shows a graceful error; production needs a small backend proxy holding the API key.
- Payment, calendar sync, auth and document storage are labeled stubs — front-end spec for the real build.
- All sample figures are marked; processing times are illustrative.
