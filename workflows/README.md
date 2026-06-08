# n8n Workflows — Multi-Stage Routing Funnel

Four workflows that implement the architecture in `/20260508 AI Triage and Deep Dive.pdf`.

All four call the UI server's REST API (running at `http://207.180.208.209:3456`) for the heavy lifting (Gemini prompts, image fetching, Sheets writes). n8n handles orchestration and Apify scraping.

---

## Workflow 1 — `01_stage1_triage.json`

**Purpose:** Scrape followers from each seed, run lightweight Gemini Flash triage, route to Sheet A / B / C.

**Flow:**
1. Manual trigger → Read Seeds sheet
2. Normalize + dedup usernames
3. For each seed:
   - Apify `instagram-followers-scraper` (50 followers per seed)
   - Filter private accounts + replica keywords
   - For each follower → POST `/api/stage1-classify` (UI server runs Stage 1 prompt + routes to Sheet A/B/C)

**Output:** Sheet A (Collectors/Dealers Stage 1 data), Sheet B (Watchless UHNI), Sheet C (Low Rank).

---

## Workflow 2 — `02_deep_dive_horology.json`

**Purpose:** Run Horology-only deep dive on Sheet A rank 8-10 profiles.

**Trigger:** Sheet A profiles with `visible_watch_rank >= 8` that don't already have a `watch_complication_tier` populated in Sheet A - Deep Dive.

**Flow:**
1. Manual trigger → Read Sheet A + Sheet A - Deep Dive
2. Build task list (skip already-done)
3. For each task → POST `/api/deep-dive` with `{ kind: "horology", username }`
4. UI server writes results to **Sheet A - Deep Dive**

**Output columns:** watch_brands, specific_watches, watch_complications, watch_complication_tier, visible_recent_collection_value.

---

## Workflow 3 — `03_deep_dive_wealth_lifestyle.json`

**Purpose:** Run Wealth + Lifestyle deep dives on UHNWI candidates. Two AI calls per profile, run sequentially (Wealth first, Lifestyle second — Lifestyle is gated by UHNWI check on Wealth output).

**Trigger:**
- Sheet A `visible_watch_rank >= 8` AND not already done
- Sheet B (all entries) AND not already done

**Flow:**
1. Manual trigger → Read Sheet A + Sheet A - Deep Dive + Sheet B
2. Build sorted task list (Wealth runs before Lifestyle for each user)
3. For each task → POST `/api/deep-dive` with `{ kind, username }`
4. UI server:
   - **Sheet A profiles** → writes to **Sheet A - Deep Dive**
   - **Sheet B profiles** → patches the row in Sheet B
   - **UHNWI gate:** Lifestyle returns 412 if `visible_wealth_tier` and `net_worth_tier` aren't both "Ultra-High"
   - **Sheet B downgrade:** if Wealth deep dive shows non-UHNWI, row auto-moves to Sheet C

**Output columns:** visible_wealth_tier, profession, business_sector, wealth_signals, approach_suggestion, inferred_lifestyle_value, hobbies, locations, dining_preferences, vision_summary.

---

## Workflow 4 — `04_seed_loop.json`

**Purpose:** Auto-grow the Seeds sheet by scraping the *following* of verified high-value profiles.

**Trigger:**
- Sheet A rank 8-10 + Sheet B → scrape THEIR following (not followers — the accounts they choose to follow)
- Deduplicate against existing seeds
- Append new seeds with `seed_type = follower_loop`

**Flow:**
1. Manual trigger → Read Sheet A + Sheet B + existing Seeds
2. Pick verified targets (rank 8-10 collectors/dealers + UHNI)
3. For each target → Apify `instagram-followings-scraper` (50 accounts they follow)
4. Dedup against existing seeds → append new rows

**Result:** Next run of Workflow 1 picks up the new seeds and the cycle continues.

---

## Setup

### Required environment variables in n8n:
- `APIFY_TOKEN` = `REDACTED_APIFY_KEY`

### Required Google Sheets credentials:
- Service account: `0kIjsxY1xNUQys1T`
- Spreadsheet ID: `15nZGf7Sk8dVrKllalK8Dk6tq7yK8Z6Dr_jPODFEtI84`

### UI Server endpoint:
- Production: `http://207.180.208.209:3456`
- Endpoints used:
  - `POST /api/stage1-classify` — body `{ username, seed_account, seed_type }`
  - `POST /api/deep-dive` — body `{ kind: "horology"|"wealth"|"lifestyle", username }`

---

## Import order

1. `01_stage1_triage.json`
2. `02_deep_dive_horology.json`
3. `03_deep_dive_wealth_lifestyle.json`
4. `04_seed_loop.json`

### Recommended run order
- Stage 1 → Horology → Wealth + Lifestyle → Seed Loop
- Each workflow can run independently. Stage 1 → Deep Dives → Seed Loop is the natural cadence.

---

## Sheet structure

| Sheet | Purpose | Width | Populated by |
|---|---|---|---|
| Sheet1 | Seeds | 3 cols | Manual + Seed Loop |
| Sheet A - Collectors_Dealers | Stage 1 triage data for rank 6-10 collectors/dealers | 20 cols | Workflow 1 |
| **Sheet A - Deep Dive** | Full enrichment for rank 8-10 (Horology + Wealth + Lifestyle) | 37 cols | Workflows 2 + 3 (Sheet A path) |
| Sheet B - Watchless UHNI | Stage 1 triage data for hnw_no_watches + ultra-high | 20 cols | Workflow 1 |
| **Sheet B - Deep Dive** | Wealth + Lifestyle enrichment for UHNI | 32 cols | Workflow 3 (Sheet B path) |
| Sheet C - Low Rank | Minimal record-keeping (irrelevant, replica, rank 1-5) | 11 cols | Workflow 1 + auto-downgrade |

### Hidden (legacy/backup)
- `Profiles` — deprecated, replaced by Sheet A/B/C
- `Classified Leads (Legacy)` — pre-refactor data
- `Relevant Leads (Legacy)` — pre-refactor data
- `Classified Leads (Backup 2026-05-11)` — snapshot
- `Relevant Leads (Backup 2026-05-11)` — snapshot

---

## Legacy workflows

Previous single-stage workflows are archived in `/workflows/legacy/`:
- `Luxury Watch Lead Gen - Instagram Scraper.json`
- `Luxury Watch Lead Gen - AI Classifier.json`
- `milestone1_instagram_scraper.json`
- `milestone2_ai_classifier.json`
