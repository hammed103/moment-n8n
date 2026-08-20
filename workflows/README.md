# n8n Workflows — Multi-Stage Routing Funnel

Four workflows implementing the architecture in `20260508 AI Triage and Deep Dive.pdf`.

All four call the UI server's REST API (`http://207.180.208.209:3456`) for the heavy lifting (Gemini prompts, Apify orchestration, image fetching, Sheets writes). n8n only handles trigger/loop/batch scheduling.

---

## Workflow 1 — `01_stage1_triage.json`

**Purpose:** Pull followers from each seed, run lightweight Gemini Flash triage on ~10 recent images per follower, route each into `Collector` / `Dealer` / `Watchless UHNWI` / `Low Rank`.

**Flow:**
1. Manual trigger → Read `Sheet1` (seeds)
2. Normalize + dedup usernames
3. For each seed:
   - Apify `datadoping~instagram-followers-scraper` (50 followers per seed)
   - Filter private accounts + replica keywords (belt-and-suspenders — server also rejects `is_private && no images`)
   - For each follower → POST `/api/stage1-classify` with body `{ username, seed_account }`
   - Server runs Stage 1 prompt on 10 most-recent posts and routes the row

**Routing rules** (applied server-side, all current):
- `replica_dealer` / `irrelevant` → **`Low Rank`**
- `collector` with `visible_watch_rank >= 6` → **`Collector`**
- `dealer` with `visible_watch_rank >= 6` → **`Dealer`**
- `hnw_no_watches` **AND** `net_worth_tier = "ultra-high"` → **`Watchless UHNWI`**
  *(both conditions required. The old rule also accepted ultra-high wealth on its own, which leaked low-rank profiles whose background luxury the AI read as wealth.)*
- Everything else → **`Low Rank`**

**Stage 1 output columns** (written into `Collector` / `Dealer` / `Watchless UHNWI`): username, full_name, classification, visible_watch_rank, net_worth_tier, priority_score, confidence, profile_url, follower_count, post_count, is_verified, **is_private** (new), business_category, bio, email_in_bio, phone_in_bio, external_url, seed_account, scrape_date, plus *preliminary* watch/wealth fields: watch_brands, specific_watches, visible_recent_collection_value, visible_wealth_tier, profession, business_sector, wealth_signals, ai_reasoning, vision_summary.

`seed_type` is **not** written into the triage sheets — it duplicates `classification`. It stays on `Sheet1` where it labels seed source (`auction_house`, `individual_collector`, `follower_loop`, etc.).

---

## Workflow 2 — `02_deep_dive_horology.json`

**Purpose:** Run Horology-only deep dive (Gemini 2.5 **Pro**, 50 images) on every `Collector` / `Dealer` profile with `visible_watch_rank >= 8`.

**Trigger:** `Collector` / `Dealer` rows where `visible_watch_rank >= 8` AND the username is not already in `Horology Data`.

**Flow:**
1. Manual trigger → Read `Collector` + `Dealer` + `Horology Data`
2. Build task list (skip already-done)
3. For each task → POST `/api/deep-dive` with `{ kind: "horology", username }`
4. UI server re-scrapes 50 most-recent posts via Apify, runs Gemini Pro, writes results to `Horology Data`

**Output columns** (`Horology Data`): watch_brands, specific_watches, watch_complications, **watch_complication_tier** (`Tier A` / `Tier B` / `Tier C` — A = most complicated like Minute Repeater / Tourbillon / Perpetual Calendar, C = basic), visible_recent_collection_value, deep_dive_date.

See `/Watch Complication Tier List.md` for the full tier definition.

---

## Workflow 3 — `03_deep_dive_wealth_lifestyle.json`

**Purpose:** Run Wealth + Lifestyle deep dives (Gemini Flash, 50 images each) on UHNWI candidates. Two AI calls per profile, sorted so Wealth runs before Lifestyle (Lifestyle is gated by the UHNWI check on Wealth output).

**Trigger:**
- `Collector` + `Dealer` `visible_watch_rank >= 8` AND not already in `Wealth Data`
- `Watchless UHNWI` — all entries not already in `Wealth Data`

**Flow:**
1. Manual trigger → Read `Collector` + `Dealer` + `Watchless UHNWI` + `Wealth Data` + `Lifestyle Data`
2. Build sorted task list (per user, Wealth before Lifestyle)
3. For each task → POST `/api/deep-dive` with `{ kind, username }`
4. UI server:
   - `kind: "wealth"` → writes to `Wealth Data`
   - `kind: "lifestyle"` → writes to `Lifestyle Data`
   - **UHNWI gate (Lifestyle only):** returns HTTP 412 if either `visible_wealth_tier` (from `Wealth Data`) or `net_worth_tier` (from Stage 1) isn't `Ultra-High`. The 412 is non-fatal — the row just doesn't get a Lifestyle entry.

**Output columns:**
- `Wealth Data`: visible_wealth_tier, profession, business_sector, wealth_signals, approach_suggestion, deep_dive_date.
- `Lifestyle Data`: inferred_lifestyle_value, hobbies, locations, dining_preferences, vision_summary, deep_dive_date.

---

## Workflow 4 — `04_seed_loop.json`

**Purpose:** Grow the Seeds tab by harvesting the *following* (not followers) of verified high-value profiles — i.e. the accounts they choose to follow, which are likely to be more high-net-worth.

**Trigger:** `Collector` + `Dealer` rank 8-10 + `Watchless UHNWI` (all) — minus accounts already in `Sheet1`.

**Flow:**
1. Manual trigger → Read `Collector` + `Dealer` + `Watchless UHNWI` + `Sheet1` (existing seeds)
2. Pick verified targets
3. For each target → Apify `datadoping~instagram-followings-scraper` (50 accounts they follow)
4. Dedup against existing seeds → append new rows with `seed_type = "follower_loop"`

**Result:** Next run of Workflow 1 picks up the new seeds and the cycle continues.

---

## Setup

### Required environment variables in n8n
- `APIFY_TOKEN` (set in n8n's Variables panel — do **not** commit)

### Google Sheets credentials
- Service account: `0kIjsxY1xNUQys1T` (n8n credential id)
- Spreadsheet ID: `15nZGf7Sk8dVrKllalK8Dk6tq7yK8Z6Dr_jPODFEtI84`

### UI server (production)
- Base URL: `http://207.180.208.209:3456`
- Required env vars on the VPS (via `systemd Environment=`):
  - `GEMINI_API_KEY`
  - `APIFY_TOKEN`
- Endpoints used:
  - `POST /api/stage1-classify` — body `{ username, seed_account }`
  - `POST /api/deep-dive` — body `{ kind: "horology" | "wealth" | "lifestyle", username }`

---

## Import + run order

Import:
1. `01_stage1_triage.json`
2. `02_deep_dive_horology.json`
3. `03_deep_dive_wealth_lifestyle.json`
4. `04_seed_loop.json`

Run (natural cadence):
1. **Stage 1** — fills `Collector` / `Dealer` / `Watchless UHNWI` / `Low Rank` from seeds
2. **Horology** — enriches `Collector` + `Dealer` rank≥8
3. **Wealth + Lifestyle** — enriches `Collector` + `Dealer` rank≥8 + all `Watchless UHNWI`
4. **Seed Loop** — harvests new seeds for the next round

Each workflow can also run independently — they're idempotent (dedup against the target sheet).

---

## Sheet structure (current spreadsheet `15nZGf7…`)

| Sheet | Purpose | Width | Populated by |
|---|---|---|---|
| `Sheet1` | Seeds | 3 cols (username, seed_type, original_url) | Manual + WF4 |
| `Collector` | Stage 1 data for collectors with rank ≥ 6 | ~29 cols | WF1 |
| `Dealer` | Stage 1 data for dealers with rank ≥ 6 | ~29 cols | WF1 |
| `Watchless UHNWI` | Stage 1 data for `hnw_no_watches` with ultra-high net worth | ~29 cols | WF1 |
| `Low Rank` | Slim record-keeping for irrelevant / replica / low-rank | 11 cols | WF1 |
| `Horology Data` | Horology deep-dive output (Tier A/B/C) | 11 cols | WF2 |
| `Wealth Data` | Wealth deep-dive output | 11 cols | WF3 (Wealth pass) |
| `Lifestyle Data` | Lifestyle deep-dive output (UHNWI-gated) | 11 cols | WF3 (Lifestyle pass) |

### Hidden / archived tabs
- `Profiles` — deprecated, replaced by the numbered triage sheets
- `Classified Leads (Legacy)`, `Relevant Leads (Legacy)` — pre-refactor data
- `Classified Leads (Backup 2026-05-11)`, `Relevant Leads (Backup 2026-05-11)` — snapshots
- `Copy of …` — Jason's colour-coded curation copies

---

## Stage 1 vs Stage 2 image-fetch sizing

| Stage | Posts pulled per profile | Model | Why |
|---|---|---|---|
| Stage 1 (Triage) | **10** | Gemini 2.5 Flash | Fast classification, lightweight Apify call |
| Stage 2 (Horology) | **50** | Gemini 2.5 **Pro** | Brand/complication identification needs reach |
| Stage 2 (Wealth) | **50** | Gemini 2.5 Flash | Wealth signals come from cars/jets/locations across many posts |
| Stage 2 (Lifestyle) | **50** | Gemini 2.5 Flash | Hobbies/locations/dining patterns need volume |

Stage 1 is ~10× cheaper than a Stage 2 call. The funnel is designed so only ~15–20% of Stage 1 hits cost Stage 2 budget.

---

## Legacy workflows

Previous single-stage workflows live in `/workflows/legacy/`:
- `Luxury Watch Lead Gen - Instagram Scraper.json`
- `Luxury Watch Lead Gen - AI Classifier.json`
- `milestone1_instagram_scraper.json`
- `milestone2_ai_classifier.json`

Kept for reference; not used by the current pipeline.
