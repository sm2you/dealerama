# Dealerama

Chrome extension → Google Apps Script (Google Sheet + ImgBB) → Netlify storefront with Stripe checkout.

```
┌──────────────────┐   scrape    ┌──────────────────┐   POST JSON   ┌──────────────────────┐
│ Chrome extension │ ──────────► │  staging.html    │ ────────────► │ Apps Script (Code.gs)│
│ popup.js         │             │ review + images  │               │ Sheet1/Reviews/…     │
└──────────────────┘             └──────────────────┘               └──────────┬───────────┘
                                                                              │ images → ImgBB
┌──────────────────┐   GET/POST   ┌──────────────────┐   POST/GET    │
│ public/*.html    │ ───────────► │ netlify/functions│ ────────────► │
│ admin.html       │              │ api.js           │               │
└──────────────────┘              └──────────────────┘               └──────────────────────┘
```

## What was broken, and what changed

| Reported problem | Actual root cause | Fix |
| --- | --- | --- |
| `Error loading products: Unexpected token 'M', "Method Not Allowed"…` | `api.js` returned a **plain-text 405** for every non-POST request, but `index.html`, `product.html` and `account.html` called `fetch(API)` with **GET**, then `.json()` | `api.js` handles GET and always answers JSON; pages use the new `getData()` / `api()` helpers in `site.js`, which also retry the other route (`/api` ↔ `/.netlify/functions/api`) |
| Admin **Save** failed with the same message | same 405 path (the error text was the storefront's), plus `saveAll_` bailed out early when a review was added — silently skipping product deletions, and wrote one cell at a time | `api.js` + a rewritten `saveAll_`: batched row writes, deletions applied last, no early return, clear validation errors |
| **Variants: none** on Shopify/Woo | `chrome.scripting.executeScript({func})` runs in the **isolated world**, where `window.ShopifyAnalytics` does not exist — the branch could never run | variants are extracted twice (MAIN world + isolated world) and the richer result wins; 7 strategies: Shopify globals, inline JSON, `/products/x.js`, Woo variations, Amazon twister, JSON-LD, generic selects |
| Variants saved but **never selectable** | keys were stored as `"Red / M"` / `"Red | M"` while `product.html` compares `"Red|M"` | every writer normalises keys to `Colour|Size`; `vparse_` rewrites legacy rows on read; `api.js` does the same |
| Intermittent **Failed to fetch** | `/api` had no route (only `/.netlify/functions/api`), and the extension pointed at `PASTE_YOUR_GOOGLE_SCRIPT_URL_HERE` | `/api` redirect + `config.path`; staging has a persisted endpoint field with a **Test** button |
| Images silently missing | `images_` did `JSON.parse` on cells like `'["…"]'` (leading apostrophe from Sheets) | parser strips apostrophes/quotes, flattens nesting, falls back to a URL regex |
| Products published **sold out** | `saveProductAuto` wrote `qty = product.qty || 0` | imports start at stock 1 (0 only when variants carry their own stock) |

### Security bugs found while fixing the above

* **Admin auth bypass** — `if (d.secret !== prop_('SECRET_KEY'))` passes when the property is unset *and* no secret is sent (`undefined !== undefined` is false). Now a missing/empty secret can never authorise, and the compare is timing-safe.
* Getting `/api?action=…&secret=…` could write secrets into URLs and CDN caches. `api.js` now rejects every non-public action over GET.
* `getPublic` was verified to never include `SECRET_KEY` / `STRIPE_SECRET_KEY` / `IMGBB_API_KEY` (they live in Script Properties, not the sheet).

## Files

| Path | Role |
| --- | --- |
| `apps-script/Code.gs` | Backend: `setup`, `getPublic`, `saveAll`, `checkout`, `confirmOrder`, `syncPayments`, `submitReview`, `myOrders`, ImgBB upload, `importUrl`, variants normaliser. **Column order unchanged from v4.** |
| `apps-script/appsscript.json` | Manifest for `clasp` users (web app + scopes). |
| `netlify/functions/api.js` | Single `/api` endpoint: GET + POST, CORS, JSON everywhere, Apps Script POST→GET fallback, data normalisation. |
| `netlify.toml` | Publish dir, `/api` rewrite, security headers. |
| `extension/` | MV3 extension: `popup.js` scrapers, `staging.html/js` review + publish. |
| `public/` | Storefront (`index`, `product`, `account`), `admin.html`, shared `site.js`. |
| `scripts/` | `push.mjs` (creates the GitHub repo and pushes), `configure.mjs` (writes + verifies live settings), `probe.mjs` (which build is live, is `/api` up), `repair-data.mjs` (entity/placeholder cleanup, dry-run first). |
| `test/` | 73 assertions with an in-memory Apps Script emulator, a DOM stub and a fake GitHub API. |

## Publishing this repo to GitHub

```bash
cp .env.example .env.local     # fill GITHUB_TOKEN and GITHUB_OWNER, then:
node scripts/push.mjs --private
```

`push.mjs` verifies the token (`GET /user`), creates the repository if it does not exist,
adds a credential-free `origin`, pushes `main`, and prints the resulting commit SHA. The token is
passed to git as an ephemeral `Authorization` header and is never written to `.git/config`.

The token must be a **classic** PAT with `repo` + `workflow` (the repo contains
`.github/workflows/ci.yml`; a token without `workflow` is refused on push). Fine-grained tokens
cannot create repositories unless granted *Administration: write* on all repositories.

Already have a repo? `git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main`.

> The CI workflow lives at `ci/github-workflows-ci.yml` instead of `.github/workflows/`.
> GitHub rejects any push touching `.github/workflows/` unless the token has the **Workflows**
> permission; move the file into place (web UI or a token with that scope) to enable CI.

## Deploy

### 1. Google Apps Script

1. Open the Sheet → **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs`, save.
3. Run **`setup()`** once (authorise when asked). The execution log prints:
   `ADMIN SECRET (save it now…): xxxxxxxx`. This is your admin secret. Lost it? Run `newAdminSecret()`.
4. **Deploy → New deployment → Web app**
   * Execute as: **Me**
   * Who has access: **Anyone** ← required, otherwise Google answers with an HTML/405 page
   * Copy the **`/exec`** URL (not `/edit`).
5. Optional: run **`installTrigger()`** so paid Stripe orders apply every 5 minutes. Check with `selfTest()`.

### 2. Netlify

* Build command: none. Publish directory: `public` (already in `netlify.toml`).
* Environment variable: `APPS_SCRIPT_URL = https://script.google.com/macros/s/…/exec`
* Redeploy. Then open `https://your-site.netlify.app/api?action=health` — you should see
  `{"ok":true,"appsScriptConfigured":true,"appsScriptLooksValid":true,…}`.

### 3. First-run configuration (`/admin.html`)

Log in with the secret from step 1, then:

* **Settings → Store**: `site_url` (full https URL — Stripe redirects use it), `business_name`, `contact_email`, `google_client_id` (for customer sign-in).
* **Settings → Private keys** (written to Script Properties, never the sheet, never shown again):
  * `STRIPE_SECRET_KEY` — a **restricted** key with Checkout write access.
  * `IMGBB_API_KEY` — from api.imgbb.com. Without it, imports fall back to the original image URLs.
  * `SECRET_KEY` — only if you want to rotate the admin secret (12+ chars).
* Press **Save**.

#### Or do step 3 from the terminal

`scripts/configure.mjs` performs the same save through the API, then verifies the whole chain
(Web App → admin secret → keys → `/api` on Netlify → buyable products) and prints a PASS/FAIL checklist:

```bash
node scripts/configure.mjs \
  --url "https://script.google.com/macros/s/…/exec" \
  --secret "<admin secret from setup()>" \
  --site-url "https://dealerama.netlify.app" \
  --stripe "sk_live_…" --imgbb "…" \
  --business "Dealerama" --email "you@example.com"
```

Add `--verify-only` to check without writing, `--new-secret` to rotate, `--json` for machine output.
Every flag also reads from the environment: `APPS_SCRIPT_URL`, `ADMIN_SECRET`, `SITE_URL`,
`STRIPE_SECRET_KEY`, `IMGBB_API_KEY`. Secrets are masked in output and never printed raw.

To keep the secrets out of your shell history, put them in `.env.local` (git-ignored) and just run:

```bash
cp .env.example .env.local   # fill it in
npm run configure
```

### 4. Extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
2. On a product page, click the icon → **1. Scrape & review**. The popup reports title, price, image count and variant count.
3. In the staging tab: paste the **`/exec`** URL (the extension talks to Google directly, so a 15-image upload is not bound by Netlify's 10 s function limit), paste the secret, then **Publish**.
4. Products arrive as **draft**. Open the admin, set price/stock/variants, change status to **live**.

> Prefer instant publishing? Change `IMPORT_STATUS = 'draft'` to `'live'` at the top of `Code.gs`.

## Local checks

```bash
npm test        # 73 assertions: api.js, Code.gs (emulated Sheets), variant scrapers, scripts
npm run check   # parses every script + inline <script>, validates JSON and wiring
```

`test/code-gs.test.mjs` runs the real `Code.gs` against an in-memory Sheets/Stripe/ImgBB emulator, so it covers `setup()`, auth, `saveAll` (including deletions), stock movement, variants and reviews without credentials.
`test/configure.test.mjs` runs `scripts/configure.mjs` against a local fake Apps Script + fake Netlify.
`test/push.test.mjs` runs `scripts/push.mjs` against a fake GitHub API with a fake git runner (no
credentials, and it asserts the token is never written into the git remote).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/api` is 404 but `/api/health` works | The function declares `config.path` — a custom path replaces `/.netlify/functions/api` and `'/api/*'` does not match bare `/api`. Route it from `netlify.toml` instead (`node scripts/probe.mjs` diagnoses this). |
| `API returned an HTML page` | Web App access is not **Anyone**, or `APPS_SCRIPT_URL` is an `/edit` link. |
| `APPS_SCRIPT_URL is not set` | Netlify env var missing → redeploy after adding it. |
| `Wrong admin secret` | Use the secret printed by `setup()`; run `newAdminSecret()` to rotate. |
| Storefront shows no products | Products must be `live`/`upcoming`; drafts are hidden. `GET /api` returns what the sheet has. |
| Images missing after import | Set `IMGBB_API_KEY`. The sheet keeps the source URL as a fallback, so nothing is lost. |
| Variants still "none" | Reload the extension after editing it, and use the current page (Shopify's `.js` endpoint needs the product page, not a collection page). |
| Titles show `&#39;` | Entities stored from an old import: `node scripts/repair-data.mjs --fix-entities` (dry-run first). |
| Checkout says "not available" | Product status must be `live` (or `upcoming` + pre-order), price > 0, stock > 0. |
| Extension blocked on a custom domain | Add `https://your-domain/*` to `host_permissions` in `manifest.json` and reload. |
| Orders stuck on pending | `installTrigger()` not installed, or `STRIPE_SECRET_KEY` missing. Paid visits to `account.html` self-confirm via `confirmOrder`. |

## Notes / limits

* Stripe: CAD only (`checkout_` sets `currency: 'cad'`; shipping collected for `CA`). Adjust both in `Code.gs` if needed.
* Netlify syncing is capped at 15 pending orders per click (the 5-minute trigger handles 40) to stay inside the function timeout.
* Google sign-in (`google_client_id`) is optional; without it `myOrders` is disabled but guest checkout still works.
* Variant keys are `Colour|Size` — do not use `|` inside an option value (it is replaced with `/`).
