const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3456;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_API_KEY) console.warn("[warn] GEMINI_API_KEY not set — set the env var before classification calls.");
const PROMPT_FILE = path.join(__dirname, "prompt_stage1.txt");
const PROMPT_FILE_LEGACY = path.join(__dirname, "prompt.txt"); // kept for fallback / Phase 2 deep-dive
// Stage 1 triage sheets (routing destinations)
const SHEET_A = "1. Triage - Collectors & Dealers";
const SHEET_B = "2. Triage - Watchless UHNI";
const SHEET_C = "3. Triage - Low Rank";
// Stage 2 deep-dive sheets (one per dataset, independent)
const SHEET_HOROLOGY = "4. Horology Data";
const SHEET_WEALTH = "5. Wealth Data";
const SHEET_LIFESTYLE = "6. Lifestyle Data";
// CREDS lookup order (first hit wins):
//   1. GOOGLE_CREDENTIALS_JSON env var (Railway/Docker style)
//   2. /opt/moment-ui/google-creds.json (production VPS path)
//   3. ../peak-lattice-398418-eeb02e45c896.json (local dev fallback)
const CREDS = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : (() => { try { return require("/opt/moment-ui/google-creds.json"); } catch {} ;
              try { return require(path.join(__dirname, "..", "peak-lattice-398418-eeb02e45c896.json")); } catch {} ;
              return null; })();
const SHEET_ID = process.env.SHEET_ID || "15nZGf7Sk8dVrKllalK8Dk6tq7yK8Z6Dr_jPODFEtI84";
const SEEDS_SHEET = "Sheet1";
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
if (!APIFY_TOKEN) console.warn("[warn] APIFY_TOKEN not set — Instagram scrapes will fail until it is.");

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- API: Get prompt ---
app.get("/api/prompt", (req, res) => {
  const prompt = fs.readFileSync(PROMPT_FILE, "utf-8");
  res.json({ prompt });
});

// --- API: Save prompt ---
app.post("/api/prompt", (req, res) => {
  fs.writeFileSync(PROMPT_FILE, req.body.prompt, "utf-8");
  res.json({ ok: true });
});

// --- API: Fetch Instagram profile ---
// ?postLimit=N (default 10 for Stage 1, 50 for Stage 2 deep dive)
app.get("/api/instagram/:username", async (req, res) => {
  const { username } = req.params;
  const postLimit = parseInt(req.query.postLimit) || 10;

  // Try direct Instagram API first (works locally, blocked on VPS)
  try {
    const data = await fetchJSON(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
      {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
      }
    );
    const user = data?.data?.user;
    if (user) {
      const edges = user.edge_owner_to_timeline_media?.edges || [];
      const image_urls = [];
      const captions = [];
      // Direct Instagram API caps at ~12 posts. For deep dive (postLimit=50),
      // we always force Apify fallback below.
      if (postLimit > 12) throw new Error("Need Apify for postLimit > 12");
      for (const edge of edges.slice(0, postLimit)) {
        const node = edge.node || {};
        if (node.display_url) image_urls.push(node.display_url);
        const capEdges = node.edge_media_to_caption?.edges || [];
        if (capEdges.length) captions.push(capEdges[0]?.node?.text || "");
      }
      return res.json({
        username,
        full_name: user.full_name || "",
        bio: user.biography || "",
        follower_count: user.edge_followed_by?.count || 0,
        following_count: user.edge_follow?.count || 0,
        post_count: user.edge_owner_to_timeline_media?.count || 0,
        is_verified: user.is_verified || false,
        is_business: user.is_business_account || false,
        is_private: user.is_private || false,
        business_category: user.category_name || "",
        external_url: user.external_url || "",
        profile_pic: user.profile_pic_url_hd || "",
        image_urls,
        recent_captions: captions.slice(0, postLimit).join("\n---\n"),
      });
    }
  } catch (e) {
    // Direct API failed (or postLimit > 12), fall through to Apify
  }

  // Apify path:
  //   - postLimit <= 12: use `instagram-profile-scraper` (gets profile metadata + ~12 latest posts)
  //   - postLimit > 12: use BOTH — profile-scraper for metadata, post-scraper for the N posts
  try {
    // Always fetch profile metadata (bio, follower count, etc.)
    const profileRunUrl = `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs?token=${APIFY_TOKEN}&waitForFinish=300`;
    const profileRun = await postJSON(profileRunUrl, JSON.stringify({
      usernames: [username],
      resultsLimit: Math.min(postLimit, 12),
    }));

    if (!profileRun?.data?.defaultDatasetId) {
      return res.status(404).json({ error: "Could not fetch profile via Apify" });
    }

    const profiles = await fetchJSONFromURL(`https://api.apify.com/v2/datasets/${profileRun.data.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json`);
    if (!Array.isArray(profiles) || !profiles.length) {
      return res.status(404).json({ error: "No profile data returned from Apify" });
    }
    const p = profiles[0];
    const videoRx = /\.(mp4|mov|avi|webm|mkv|flv|wmv|m4v)/i;
    const image_urls = [];
    const captions = [];

    // Use profile-scraper's latestPosts for the first ~12
    for (const post of (p.latestPosts || []).slice(0, postLimit)) {
      if (post.displayUrl && !videoRx.test(post.displayUrl)) image_urls.push(post.displayUrl);
      const cap = post.caption || "";
      if (cap) captions.push(cap.slice(0, 300));
    }

    // For deep dive (postLimit > 12), do an extra Apify call to get more posts
    if (postLimit > 12) {
      try {
        const postRunUrl = `https://api.apify.com/v2/acts/apify~instagram-post-scraper/runs?token=${APIFY_TOKEN}&waitForFinish=300`;
        const postRun = await postJSON(postRunUrl, JSON.stringify({
          username: [username],
          resultsLimit: postLimit,
        }));
        if (postRun?.data?.defaultDatasetId) {
          const posts = await fetchJSONFromURL(`https://api.apify.com/v2/datasets/${postRun.data.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json`);
          if (Array.isArray(posts)) {
            for (const post of posts) {
              if (post.displayUrl && !videoRx.test(post.displayUrl) && !image_urls.includes(post.displayUrl)) {
                image_urls.push(post.displayUrl);
              }
              const cap = post.caption || "";
              if (cap) captions.push(cap.slice(0, 300));
            }
          }
        }
      } catch (e) {
        // Post-scraper fallback failed — keep what we have from profile-scraper
      }
    }

    res.json({
      username: p.username || username,
      full_name: p.fullName || "",
      bio: p.biography || "",
      follower_count: p.followersCount || 0,
      following_count: p.followsCount || 0,
      post_count: p.postsCount || 0,
      is_verified: p.verified || false,
      is_business: p.isBusinessAccount || false,
      is_private: p.private || p.isPrivate || false,
      business_category: p.businessCategoryName || p.categoryName || "",
      external_url: p.externalUrl || "",
      profile_pic: p.profilePicUrlHD || p.profilePicUrl || "",
      image_urls: [...new Set(image_urls)].slice(0, postLimit),
      recent_captions: captions.slice(0, postLimit).join("\n---\n"),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile: " + err.message });
  }
});

// --- API: Proxy image (avoids Instagram hotlink blocking) ---
app.get("/api/proxy-image", async (req, res) => {
  // Extract the full url param manually to avoid Express splitting on &
  const raw = req.originalUrl;
  const idx = raw.indexOf("url=");
  if (idx === -1) return res.status(400).send("Missing url param");
  const url = decodeURIComponent(raw.slice(idx + 4));
  if (!url) return res.status(400).send("Missing url param");
  try {
    const buffer = await fetchBuffer(url);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    res.status(502).send("Failed to fetch image");
  }
});

// --- API: Download image as base64 ---
app.post("/api/image-base64", async (req, res) => {
  const { url } = req.body;
  try {
    const buffer = await fetchBuffer(url);
    res.json({ data: buffer.toString("base64") });
  } catch (err) {
    res.json({ data: null, error: err.message });
  }
});

// --- API: Classify profile with Gemini ---
app.post("/api/classify", async (req, res) => {
  const { parts, profile } = req.body;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
  });

  try {
    const result = await postJSON(geminiUrl, body);
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(400).json({ error: "No JSON in response", raw: text });

    const classification = JSON.parse(jsonMatch[0]);

    // Normalize legacy field name
    if (classification.visible_watch_rank == null && classification.watch_collection_rank != null) {
      classification.visible_watch_rank = classification.watch_collection_rank;
    }

    // priority_score is computed here (not by the AI) so the math is deterministic:
    //   priority = MAX(visible_watch_rank, wealthTierToNum(net_worth_tier))
    //   +1 bonus if both >= 7, cap 10
    //   replica_dealer = 0
    const wcr = classification.visible_watch_rank || 0;
    const wealthNum = netWorthTierToNum(classification.net_worth_tier);
    let priority = Math.max(wcr, wealthNum);
    if (wcr >= 7 && wealthNum >= 7) priority = Math.min(10, priority + 1);
    if (classification.classification === "replica_dealer") priority = 0;
    classification.priority_score = priority;

    // Clear complication tier if no watches
    if (!classification.visible_watch_rank || classification.visible_watch_rank === 0) {
      classification.watch_complication_tier = "";
      classification.watch_complications = [];
    }

    // Write to Google Sheets
    if (profile && profile.username) {
      try {
        await writeClassificationToSheets(profile, classification);
      } catch (sheetErr) {
        console.error("Sheets write error:", sheetErr.message);
      }
    }

    res.json({ classification, raw: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Stage 1 Classify (n8n entrypoint, just takes username) ---
// Body: { username, seed_account, seed_type }
app.post("/api/stage1-classify", async (req, res) => {
  const { username, seed_account } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  try {
    // 1. Fetch profile (Stage 1 = 10 posts)
    const profile = await fetchProfileInternal(username, 10);
    if (!profile || profile.error) return res.status(404).json({ error: "Profile fetch failed" });

    // Inject seed account if provided (kept for provenance only)
    if (seed_account) profile.seed_account = seed_account;

    // Private accounts: if we got nothing usable, refuse rather than silently classify on bio alone.
    // Apify sometimes returns cached posts for private accounts that were public when last crawled,
    // so we only hard-skip when there are NO images to look at.
    const imageUrls = (profile.image_urls || []).slice(0, 10);
    if (profile.is_private && imageUrls.length === 0) {
      return res.status(200).json({
        username,
        skipped: true,
        reason: "private_no_images",
        is_private: true,
        message: "Account is private and no posts were accessible — Stage 1 skipped."
      });
    }
    const parts = [];
    let downloaded = 0;
    for (const url of imageUrls) {
      try {
        const buf = await fetchBuffer(url);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
        downloaded++;
      } catch (e) {}
    }

    // 3. Build prompt
    const tmpl = fs.readFileSync(PROMPT_FILE, "utf-8");
    const prompt = tmpl
      .replace(/\{\{IMAGE_COUNT\}\}/g, String(downloaded))
      .replace(/\{\{USERNAME\}\}/g, profile.username || username)
      .replace(/\{\{FULL_NAME\}\}/g, profile.full_name || "")
      .replace(/\{\{BIO\}\}/g, profile.bio || "")
      .replace(/\{\{FOLLOWER_COUNT\}\}/g, String(profile.follower_count || 0))
      .replace(/\{\{FOLLOWING_COUNT\}\}/g, String(profile.following_count || 0))
      .replace(/\{\{POST_COUNT\}\}/g, String(profile.post_count || 0))
      .replace(/\{\{IS_VERIFIED\}\}/g, String(profile.is_verified || false))
      .replace(/\{\{IS_BUSINESS\}\}/g, String(profile.is_business || false))
      .replace(/\{\{BUSINESS_CATEGORY\}\}/g, profile.business_category || "")
      .replace(/\{\{EXTERNAL_URL\}\}/g, profile.external_url || "")
      .replace(/\{\{RECENT_CAPTIONS\}\}/g, (profile.recent_captions || "").slice(0, 3000));
    parts.push({ text: prompt });

    // 4. Forward to /api/classify by calling it directly
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ parts, profile });
      const r = http.request({ hostname: "localhost", port: PORT, path: "/api/classify", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 180000 }, (resp) => {
        let data = "";
        resp.on("data", c => data += c);
        resp.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });

    if (result.error) return res.status(400).json(result);

    const cls = result.classification;
    const cName = cls.classification || "";
    const rank = cls.visible_watch_rank || 0;
    const ntw = (cls.net_worth_tier || "").toLowerCase();
    const routed_to = routeStage1(cName, rank, ntw);

    res.json({ username, routed_to, classification: cls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Deep Dive (Horology / Wealth / Lifestyle) ---
// Body: { kind: "horology" | "wealth" | "lifestyle", username }
app.post("/api/deep-dive", async (req, res) => {
  const { kind, username } = req.body;
  if (!kind || !username) return res.status(400).json({ error: "kind and username required" });

  const promptMap = {
    horology: path.join(__dirname, "prompt_horology.txt"),
    wealth: path.join(__dirname, "prompt_wealth.txt"),
    lifestyle: path.join(__dirname, "prompt_lifestyle.txt"),
  };
  if (!promptMap[kind]) return res.status(400).json({ error: "Unknown deep dive kind" });

  try {
    // 1. Stage 2 always triggers a FRESH Apify scrape for 50 posts (per spec).
    //    Stage 1 data is not reused — deep dive must see the most recent 50.
    const profileRes = await fetchProfileInternal(username, 50);
    if (!profileRes) return res.status(404).json({ error: "Profile not found (50-post Apify scrape failed)" });

    // 2. Download up to 50 images
    const imageUrls = (profileRes.image_urls || []).slice(0, 50);
    const parts = [];
    let downloaded = 0;
    for (const url of imageUrls) {
      try {
        const buf = await fetchBuffer(url);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
        downloaded++;
      } catch (e) { /* skip */ }
    }

    // 3. Look up Stage 1 result (need classification + rank for the prompt)
    const token = await getSheetsToken();
    const sheetA = await sheetsGet(token, `${SHEET_A}!A1:AZ10000`);
    const sheetB = await sheetsGet(token, `${SHEET_B}!A1:AZ10000`);
    let stage1Row = null, sourceSheet = null;
    for (const [sheet, data] of [[SHEET_A, sheetA], [SHEET_B, sheetB]]) {
      const rows = data.values || [];
      if (rows.length < 2) continue;
      const h = rows[0];
      const idx = rows.slice(1).findIndex(r => (r[0] || "").toLowerCase() === username.toLowerCase());
      if (idx >= 0) {
        stage1Row = {};
        h.forEach((col, i) => stage1Row[col] = rows[idx + 1][i] || "");
        sourceSheet = sheet;
        stage1Row._rowNum = idx + 2; // 1-based row in sheet
        break;
      }
    }
    if (!stage1Row) return res.status(404).json({ error: "Profile not found in Sheet A or B (run Stage 1 first)" });

    // GATING per PDF spec:
    //   - Horology: requires Sheet A AND visible_watch_rank >= 8
    //   - Wealth: requires Sheet A rank>=8 OR Sheet B (UHNWI gate is checked POST-result for routing)
    //   - Lifestyle: requires UHNWI gate already met (visible_wealth_tier=Ultra-High AND net_worth_tier=ultra-high from prior Wealth deep dive)
    const stage1Rank = parseInt(stage1Row.visible_watch_rank) || 0;
    const stage1NWT = (stage1Row.net_worth_tier || "").toLowerCase();
    const existingVWT = (stage1Row.visible_wealth_tier || "").toLowerCase();

    if (kind === "horology") {
      if (sourceSheet !== SHEET_A || stage1Rank < 8) {
        return res.status(412).json({ error: `Horology gate: requires Sheet A AND visible_watch_rank >= 8. Got sheet=${sourceSheet}, rank=${stage1Rank}.`, gated: true });
      }
    }
    if (kind === "wealth") {
      // Wealth runs to PRODUCE visible_wealth_tier, so we only check basic sheet+rank gate
      if (sourceSheet === SHEET_A && stage1Rank < 8) {
        return res.status(412).json({ error: `Wealth gate (Sheet A): requires visible_watch_rank >= 8. Got rank=${stage1Rank}.`, gated: true });
      }
      // Sheet B always allowed (need to confirm UHNWI)
    }
    if (kind === "lifestyle") {
      // visible_wealth_tier now lives in the dedicated Wealth Data sheet (written by the Wealth deep dive)
      let lookupVWT = existingVWT;
      try {
        const ddData = await sheetsGet(token, `${SHEET_WEALTH}!A1:AZ10000`);
        const ddRows = ddData.values || [];
        if (ddRows.length > 1) {
          const ddH = ddRows[0];
          const ddIdx = ddRows.slice(1).findIndex(r => (r[0] || "").toLowerCase() === username.toLowerCase());
          if (ddIdx >= 0) {
            const vwtIdx = ddH.indexOf("visible_wealth_tier");
            if (vwtIdx >= 0) lookupVWT = (ddRows[ddIdx + 1][vwtIdx] || "").toLowerCase();
          }
        }
      } catch (e) {}
      const isUhnwi = lookupVWT === "ultra-high" && stage1NWT === "ultra-high";
      if (!isUhnwi) {
        return res.status(412).json({ error: `Lifestyle gate: requires UHNWI (Ultra-High in both visible_wealth_tier AND net_worth_tier). Got vwt='${lookupVWT}', nwt='${stage1NWT}'. Run Wealth deep dive first.`, gated: true });
      }
      // Also require sheet+rank for Sheet A
      if (sourceSheet === SHEET_A && stage1Rank < 8) {
        return res.status(412).json({ error: `Lifestyle gate (Sheet A): requires visible_watch_rank >= 8. Got rank=${stage1Rank}.`, gated: true });
      }
    }

    // 4. Build prompt
    const tmpl = fs.readFileSync(promptMap[kind], "utf-8");
    const prompt = tmpl
      .replace(/\{\{IMAGE_COUNT\}\}/g, String(downloaded))
      .replace(/\{\{USERNAME\}\}/g, profileRes.username || username)
      .replace(/\{\{FULL_NAME\}\}/g, profileRes.full_name || "")
      .replace(/\{\{BIO\}\}/g, profileRes.bio || "")
      .replace(/\{\{BUSINESS_CATEGORY\}\}/g, profileRes.business_category || "")
      .replace(/\{\{EXTERNAL_URL\}\}/g, profileRes.external_url || "")
      .replace(/\{\{IS_VERIFIED\}\}/g, String(profileRes.is_verified || false))
      .replace(/\{\{IS_BUSINESS\}\}/g, String(profileRes.is_business || false))
      .replace(/\{\{RECENT_CAPTIONS\}\}/g, (profileRes.recent_captions || "").slice(0, 5000))
      .replace(/\{\{CLASSIFICATION\}\}/g, stage1Row.classification || "")
      .replace(/\{\{VISIBLE_WATCH_RANK\}\}/g, String(stage1Row.visible_watch_rank || 0));

    parts.push({ text: prompt });

    // 5. Call Gemini — Horology uses Pro (more accurate for watch ID), Wealth/Lifestyle use Flash (cheaper)
    const geminiModel = kind === "horology" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`;
    const result = await postJSON(geminiUrl, JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } }));
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(400).json({ error: "No JSON in response", raw: text });
    const deepData = parseLooseJSON(jsonMatch[0]);
    if (!deepData) return res.status(400).json({ error: "Could not parse JSON from AI response", raw: jsonMatch[0].slice(0, 500) });

    // 6. Build update map by kind
    const today = new Date().toISOString().split("T")[0];
    const updates = { deep_dive_date: today };
    if (kind === "horology") {
      updates.watch_brands = Array.isArray(deepData.watch_brands) ? deepData.watch_brands.join(", ") : (deepData.watch_brands || "");
      updates.specific_watches = Array.isArray(deepData.specific_watches)
        ? deepData.specific_watches.map(w => [w.brand, w.model, w.reference].filter(Boolean).join(" ") + (w.estimated_value_usd ? ` (~${w.estimated_value_usd})` : "")).join(" | ")
        : "";
      updates.watch_complications = Array.isArray(deepData.watch_complications) ? deepData.watch_complications.join(", ") : (deepData.watch_complications || "");
      updates.watch_complication_tier = deepData.watch_complication_tier || "";
      updates.visible_recent_collection_value = deepData.visible_recent_collection_value || "";
    } else if (kind === "wealth") {
      updates.visible_wealth_tier = deepData.visible_wealth_tier || "";
      updates.net_worth_tier = deepData.net_worth_tier || stage1Row.net_worth_tier;
      updates.profession = deepData.profession || "";
      updates.business_sector = deepData.business_sector || "";
      updates.wealth_signals = Array.isArray(deepData.wealth_signals) ? deepData.wealth_signals.join(", ") : (deepData.wealth_signals || "");
      updates.approach_suggestion = (deepData.approach_suggestion || "").slice(0, 500);
    } else if (kind === "lifestyle") {
      updates.inferred_lifestyle_value = deepData.inferred_lifestyle_value || "";
      updates.hobbies = Array.isArray(deepData.hobbies) ? deepData.hobbies.join(", ") : (deepData.hobbies || "");
      updates.locations = Array.isArray(deepData.locations) ? deepData.locations.join(", ") : (deepData.locations || "");
      updates.dining_preferences = Array.isArray(deepData.dining_preferences) ? deepData.dining_preferences.join(", ") : (deepData.dining_preferences || "");
      updates.vision_summary = (deepData.vision_summary || "").slice(0, 800);
    }

    // 7. Write deep dive results to the dedicated sheet for this kind:
    //    horology → Sheet 4, wealth → Sheet 5, lifestyle → Sheet 6
    const targetSheet = kind === "horology" ? SHEET_HOROLOGY
                      : kind === "wealth" ? SHEET_WEALTH
                      : SHEET_LIFESTYLE;
    // Identity columns carried into every deep-dive sheet
    const identity = {
      username,
      full_name: stage1Row.full_name || "",
      classification: stage1Row.classification || "",
      profile_url: stage1Row.profile_url || `https://instagram.com/${username}`,
      visible_watch_rank: stage1Row.visible_watch_rank || "",
    };
    const merged = { ...identity, ...updates };
    await writeRowByHeaders(token, targetSheet, username, merged);

    // 8. (No auto-downgrade.) Watchless UHNI rows stay in Sheet B once routed there.
    //    The Lifestyle workflow still enforces its own UHNWI gate (Ultra-High in both tiers).
    //    If the Wealth deep dive returns "High" instead of "Ultra-High", that's fine — the row
    //    stays in Watchless UHNI for follow-up.
    const downgraded = false;

    res.json({ kind, username, source_sheet: sourceSheet, written_to: targetSheet, updates, deep_data: deepData, images_analyzed: downloaded, downgraded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: delete a row from a sheet (by 1-based row number)
async function deleteSheetRow(token, sheetName, rowNum) {
  // Need sheetId (different from sheet name) for batchUpdate
  const info = await new Promise((resolve, reject) => {
    https.get({ hostname: "sheets.googleapis.com", path: `/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`, headers: { Authorization: "Bearer " + token } }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    }).on("error", reject);
  });
  const sheet = info.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  const sheetId = sheet.properties.sheetId;

  const body = JSON.stringify({
    requests: [{
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: rowNum - 1, endIndex: rowNum }
      }
    }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "sheets.googleapis.com", path: `/v4/spreadsheets/${SHEET_ID}:batchUpdate`, method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Create a tab if it doesn't already exist (the values API can't create tabs).
// Cached per process so we don't hit the spreadsheet metadata endpoint on every write.
const knownSheets = new Set();
async function ensureSheetExists(token, sheetName) {
  if (knownSheets.has(sheetName)) return;
  const info = await new Promise((resolve, reject) => {
    https.get({ hostname: "sheets.googleapis.com", path: `/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, headers: { Authorization: "Bearer " + token } }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    }).on("error", reject);
  });
  const titles = (info.sheets || []).map(s => s.properties.title);
  titles.forEach(t => knownSheets.add(t));
  if (titles.includes(sheetName)) return;

  const body = JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] });
  await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "sheets.googleapis.com", path: `/v4/spreadsheets/${SHEET_ID}:batchUpdate`, method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, resp => {
      let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  knownSheets.add(sheetName);
}

// Helper: fetch profile via local logic (reuse the /api/instagram path)
async function fetchProfileInternal(username, postLimit = 10) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${PORT}/api/instagram/${encodeURIComponent(username)}?postLimit=${postLimit}`;
    http.get(url, { timeout: 300000 }, (resp) => {
      let data = "";
      resp.on("data", c => data += c);
      resp.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on("error", reject);
  });
}

// Robust JSON parser — handles trailing commas, unclosed arrays/objects, and other AI quirks
function parseLooseJSON(raw) {
  // First try: as-is
  try { return JSON.parse(raw); } catch {}

  // Second try: strip trailing commas before } or ]
  let cleaned = raw.replace(/,(\s*[\]}])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}

  // Third try: progressively trim from the end until valid JSON
  // Often Gemini truncates the response mid-array
  for (let i = cleaned.length; i > 50; i--) {
    const sub = cleaned.slice(0, i);
    // Try to close any unclosed structures
    const opens = (sub.match(/[{[]/g) || []).length;
    const closes = (sub.match(/[}\]]/g) || []).length;
    if (opens > closes) {
      // Try closing brackets
      let attempt = sub;
      for (let j = 0; j < opens - closes; j++) {
        // Find the LAST unclosed structure and close it appropriately
        attempt += attempt.lastIndexOf('[') > attempt.lastIndexOf('{') ? ']' : '}';
      }
      try { return JSON.parse(attempt); } catch {}
    }
    // Try parsing this substring as-is too
    try { return JSON.parse(sub); } catch {}
    // Skip ahead - don't try every char
    i -= 9; // 10-char step
  }

  return null;
}

// Map wealth_rank number to tier label
function wealthRankToTier(rank) {
  const n = parseInt(rank) || 0;
  if (n >= 9) return "Ultra-High";
  if (n >= 7) return "High";
  if (n >= 5) return "Medium";
  if (n >= 3) return "Low";
  return "None";
}

// Inverse: tier label to numeric score for priority math
function netWorthTierToNum(tier) {
  const t = (tier || "").toLowerCase();
  if (t === "ultra-high") return 9;
  if (t === "high") return 7;
  if (t === "medium") return 5;
  if (t === "low") return 2;
  return 0;
}

// --- Write classification to Google Sheets (header-aware) ---
async function writeClassificationToSheets(profile, classification) {
  const token = await getSheetsToken();
  const today = new Date().toISOString().split("T")[0];
  const username = profile.username || "";

  const watches = classification.specific_watches || [];
  const watchStr = Array.isArray(watches)
    ? watches.map(w => [w.brand, w.model, w.reference].filter(Boolean).join(" ") + (w.estimated_value_usd ? ` (~${w.estimated_value_usd})` : "")).join(" | ")
    : String(watches);
  const brandsStr = Array.isArray(classification.watch_brands) ? classification.watch_brands.join(", ") : String(classification.watch_brands || "");
  const wealthStr = Array.isArray(classification.wealth_signals) ? classification.wealth_signals.join(", ") : String(classification.wealth_signals || "");
  const complicationsStr = Array.isArray(classification.watch_complications) ? classification.watch_complications.join(", ") : String(classification.watch_complications || "");

  // Seed account (kept for provenance). seed_type is intentionally removed —
  // the classification column already captures what the AI thinks the account is.
  const seedAccount = profile.seed_account || "";

  // Try to extract email/phone from bio
  const bio = (profile.bio || "");
  const emailMatch = bio.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const phoneMatch = bio.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/);

  // Build data map — Stage 1 triage fields + PRELIMINARY watch/wealth data (from 10 images)
  const clData = {
    // Core triage fields
    username,
    full_name: profile.full_name || "",
    classification: classification.classification || "unknown",
    visible_watch_rank: classification.visible_watch_rank ?? 0,
    net_worth_tier: classification.net_worth_tier || "unknown",
    priority_score: classification.priority_score ?? 0,
    confidence: classification.confidence || "low",
    profile_url: `https://instagram.com/${username}`,
    follower_count: profile.follower_count || 0,
    post_count: profile.post_count || 0,
    is_verified: profile.is_verified ? "Yes" : "No",
    is_business: profile.is_business ? "Yes" : "No",
    is_private: profile.is_private ? "Yes" : "No",
    business_category: profile.business_category || "",
    bio: bio.slice(0, 500),
    email_in_bio: emailMatch ? emailMatch[0] : "",
    phone_in_bio: phoneMatch ? phoneMatch[0] : "",
    external_url: profile.external_url || "",
    seed_account: seedAccount,
    scrape_date: today,

    // PRELIMINARY data captured from the 10 triage images (refined later by Deep Dive)
    watch_brands: brandsStr,
    specific_watches: watchStr,
    visible_recent_collection_value: classification.visible_recent_collection_value || "",
    visible_wealth_tier: classification.visible_wealth_tier || "",
    profession: classification.profession || "",
    business_sector: classification.business_sector || "",
    wealth_signals: wealthStr,
    ai_reasoning: (classification.reasoning || "").slice(0, 500),
    vision_summary: (classification.vision_summary || "").slice(0, 800),
    // NOTE: deep-dive-only fields (watch_complications, watch_complication_tier,
    // approach_suggestion, inferred_lifestyle_value, hobbies, locations,
    // dining_preferences, deep_dive_date) are intentionally NOT in this map.
    // writeRowByHeaders only writes columns that exist in the target sheet's headers,
    // so excluding them here keeps triage sheets from accidentally growing those columns.
  };

  // --- Stage 1 Routing: Sheet A / B / C ---
  const cls = classification.classification || "";
  const rank = classification.visible_watch_rank || 0;
  const ntw = (classification.net_worth_tier || "").toLowerCase();
  const targetSheet = routeStage1(cls, rank, ntw);
  clData.routed_to = targetSheet;

  if (targetSheet) {
    await writeRowByHeaders(token, targetSheet, username, clData);
  }
}

// Stage 1 routing rules per Jason's spec:
//   - Collectors / Dealers with rank 6-10 → Sheet A
//   - hnw_no_watches (with rank 0-1 + UHNI flag) → Sheet B
//   - Everything else (low rank, irrelevant, replica) → Sheet C
function routeStage1(classification, visibleWatchRank, netWorthTier) {
  if (classification === "replica_dealer" || classification === "irrelevant") {
    return SHEET_C;
  }
  // Sheet A = Collectors/Dealers with visible_watch_rank >= 6 (focus is on the watches)
  if ((classification === "collector" || classification === "dealer") && visibleWatchRank >= 6) {
    return SHEET_A;
  }
  // Sheet B = Watchless UHNI / High-value prospects. Catches:
  //   - hnw_no_watches (AI explicitly tagged as wealthy with no watch focus)
  //   - ANY ultra-high net worth profile that didn't qualify for Sheet A
  //     (e.g. a collector with rank 5 but ultra-high wealth — the wealth is what matters)
  if (classification === "hnw_no_watches" || netWorthTier === "ultra-high") {
    return SHEET_B;
  }
  return SHEET_C;
}

// Generic: read headers from a sheet, map data to correct columns, write/update
async function writeRowByHeaders(token, sheetName, username, data) {
  // Create the tab if it's missing (e.g. the deep-dive tabs on first run)
  await ensureSheetExists(token, sheetName);

  // Read headers
  const headersRes = await sheetsGet(token, `${sheetName}!1:1`);
  let headers = (headersRes.values || [[]])[0] || [];

  // Self-heal the header row so deep-dive data is never silently dropped:
  //   - empty tab → seed headers from the data keys
  //   - existing tab missing some keys → append the missing columns
  if (!headers.length) {
    headers = Object.keys(data);
    await sheetsUpdate(token, `${sheetName}!1:1`, [headers]);
  } else {
    const missing = Object.keys(data).filter(k => !headers.includes(k));
    if (missing.length) {
      headers = [...headers, ...missing];
      await sheetsUpdate(token, `${sheetName}!1:1`, [headers]);
    }
  }

  // Build row matching header order
  const row = headers.map(h => {
    const val = data[h];
    return val !== undefined && val !== null ? String(val) : "";
  });

  // Check if username already exists
  const existingRes = await sheetsGet(token, `${sheetName}!A:A`);
  const usernames = (existingRes.values || []).flat();
  const existingIdx = usernames.findIndex(u => (u || "").toLowerCase() === username.toLowerCase());

  if (existingIdx > 0) {
    await sheetsUpdate(token, `${sheetName}!A${existingIdx + 1}`, [row]);
  } else {
    await sheetsAppend(token, `${sheetName}!A:${colLetter(headers.length)}`, [row]);
  }
}

// Convert column number to letter (1=A, 26=Z, 27=AA, etc.)
function colLetter(n) {
  let s = "";
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

// --- Google Sheets Auth ---
function createJWT() {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: CREDS.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(header + "." + claim);
  const signature = sign.sign(CREDS.private_key, "base64url");
  return header + "." + claim + "." + signature;
}

async function getSheetsToken() {
  const jwt = createJWT();
  const body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt;
  const result = await postForm("https://oauth2.googleapis.com/token", body);
  return result.access_token;
}

async function sheetsGet(token, range) {
  return new Promise((resolve, reject) => {
    const p = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
    https.get({ hostname: "sheets.googleapis.com", path: p, headers: { Authorization: "Bearer " + token } }, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    }).on("error", reject);
  });
}

async function sheetsUpdate(token, range, values) {
  const p = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const body = JSON.stringify({ values });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "sheets.googleapis.com", path: p, method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sheetsAppend(token, range, values) {
  const p = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const body = JSON.stringify({ values });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "sheets.googleapis.com", path: p, method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- API: Get all seeds ---
app.get("/api/seeds", async (req, res) => {
  try {
    const token = await getSheetsToken();
    const result = await sheetsGet(token, `${SEEDS_SHEET}!A1:Z10000`);
    const rows = result.values || [];
    if (rows.length === 0) return res.json({ headers: [], seeds: [] });
    const headers = rows[0];
    const seeds = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i] || ""));
      return obj;
    });
    res.json({ headers, seeds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Add seed(s) ---
app.post("/api/seeds", async (req, res) => {
  try {
    const { seeds } = req.body; // array of { username, seed_type, original_url }
    if (!seeds || !seeds.length) return res.status(400).json({ error: "No seeds provided" });

    const token = await getSheetsToken();

    // Check for duplicates
    const existing = await sheetsGet(token, `${SEEDS_SHEET}!A:A`);
    const existingUsernames = new Set((existing.values || []).flat().map((u) => u.toLowerCase()));

    const newRows = [];
    const duplicates = [];
    for (const s of seeds) {
      const uname = (s.username || "").trim().replace(/^@/, "").toLowerCase();
      if (!uname) continue;
      if (existingUsernames.has(uname)) {
        duplicates.push(uname);
        continue;
      }
      existingUsernames.add(uname);
      const url = s.original_url || `https://www.instagram.com/${uname}/`;
      newRows.push([uname, s.seed_type || "manual", url]);
    }

    if (newRows.length > 0) {
      await sheetsAppend(token, `${SEEDS_SHEET}!A:C`, newRows);
    }

    res.json({ added: newRows.length, duplicates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Scrape followers from a seed account ---
app.post("/api/scrape-followers", async (req, res) => {
  const { username, maxFollowers, minPosts, minFollowers, filterReplicas } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  const apifyToken = APIFY_TOKEN;
  const maxCount = maxFollowers || 50;
  const minP = minPosts ?? 10;
  const minF = minFollowers ?? 50;

  try {
    // Step 1: Start the follower scraper
    const runUrl = `https://api.apify.com/v2/acts/datadoping~instagram-followers-scraper/runs?token=${apifyToken}&waitForFinish=300`;
    const runResult = await postJSON(runUrl, JSON.stringify({
      usernames: [username],
      max_count: maxCount,
    }));

    if (!runResult?.data?.defaultDatasetId) {
      return res.status(400).json({ error: "Scraper failed - no dataset returned. Account may be private.", raw: runResult });
    }

    const datasetId = runResult.data.defaultDatasetId;

    // Step 2: Fetch the dataset
    const dataUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&format=json`;
    const followers = await fetchJSONFromURL(dataUrl);

    if (!Array.isArray(followers)) {
      return res.status(400).json({ error: "Unexpected dataset format", raw: followers });
    }

    // Step 3: Filter
    const replicaRx = /\b(replica|1:1|superclone|super\s*clone|aaa\s*quality|clone|factory\s*direct|china\s*factory|noob\s*factory|clean\s*factory|vs\s*factory|fake|counterfeit|rep\s*watch|reptime|dhgate|mirror\s*quality)\b/i;
    const seen = new Set();
    const filtered = [];
    const rejected = { private: 0, duplicate: 0, replica: 0, low_posts: 0, low_followers: 0 };

    for (const f of followers) {
      const uname = (f.username || "").toLowerCase();
      if (!uname) continue;
      if (seen.has(uname)) { rejected.duplicate++; continue; }
      seen.add(uname);
      if (f.is_private) { rejected.private++; continue; }
      if (filterReplicas !== false && replicaRx.test(f.biography || "")) { rejected.replica++; continue; }
      // Note: follower scraper returns basic info, full post/follower counts need profile scrape
      filtered.push({
        username: f.username,
        full_name: f.full_name || "",
        is_private: f.is_private || false,
        is_verified: f.is_verified || false,
        biography: f.biography || "",
        follower_count: f.follower_count || f.edge_followed_by?.count || 0,
        profile_pic: f.profile_pic_url || "",
      });
    }

    // Step 4: Write to Google Sheets "Profiles" tab
    const token = await getSheetsToken();

    // Get existing profile usernames to avoid duplicates
    const existingProfiles = await sheetsGet(token, "Profiles!A:A");
    const existingSet = new Set((existingProfiles.values || []).flat().map(u => u.toLowerCase()));

    const today = new Date().toISOString().split("T")[0];
    const newRows = [];
    const duplicateProfiles = [];

    for (const f of filtered) {
      if (existingSet.has(f.username.toLowerCase())) {
        duplicateProfiles.push(f.username);
        continue;
      }
      existingSet.add(f.username.toLowerCase());
      // Match the Profiles sheet column order exactly
      newRows.push([
        f.username,                          // username
        "instagram",                         // platform
        f.full_name,                         // full_name
        (f.biography || "").slice(0, 500),   // bio
        f.follower_count || "",              // follower_count
        "",                                  // following_count
        "",                                  // post_count
        f.is_verified || false,              // is_verified
        "",                                  // is_business
        "",                                  // business_category
        "",                                  // external_url
        f.profile_pic || "",                 // profile_pic_url
        "",                                  // email_in_bio
        "",                                  // phone_in_bio
        "",                                  // engagement_rate
        "",                                  // recent_captions
        "",                                  // hashtags
        "",                                  // mentions
        "",                                  // recent_post_urls
        "",                                  // recent_post_likes
        "",                                  // recent_post_comments
        "",                                  // recent_post_dates
        "",                                  // recent_post_locations
        "",                                  // recent_post_types
        "",                                  // image_urls
        "",                                  // video_urls
        "",                                  // avg_likes
        "",                                  // avg_comments
        today,                               // scrape_date
        username,                            // seed_account
        "follower_scrape",                   // seed_type
        `https://instagram.com/${f.username}` // profile_url
      ]);
    }

    let sheetsWritten = 0;
    if (newRows.length > 0) {
      await sheetsAppend(token, "Profiles!A:AF", newRows);
      sheetsWritten = newRows.length;
    }

    res.json({
      seed: username,
      total_scraped: followers.length,
      after_filter: filtered.length,
      written_to_sheets: sheetsWritten,
      duplicate_profiles: duplicateProfiles.length,
      rejected,
      filters_applied: { maxFollowers: maxCount, minPosts: minP, minFollowers: minF, filterReplicas: filterReplicas !== false },
      followers: filtered,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Get profiles with classification status ---
// In the new pipeline, the Profiles sheet is deprecated.
// We build the profile list from the union of Sheet A, B, C (Stage 1 sheets).
app.get("/api/profiles", async (req, res) => {
  try {
    const token = await getSheetsToken();
    const profileMap = new Map();

    // Order matters: A first (richest), then B, then C - first hit wins
    for (const sheetName of [SHEET_A, SHEET_B, SHEET_C]) {
      try {
        const full = await sheetsGet(token, `${sheetName}!A1:AZ10000`);
        const rows = full.values || [];
        if (rows.length < 2) continue;
        const headers = rows[0];
        const classIdx = headers.indexOf("classification");
        const prioIdx = headers.indexOf("priority_score");
        const confIdx = headers.indexOf("confidence");
        const wrIdx = headers.indexOf("visible_watch_rank");
        const ntwIdx = headers.indexOf("net_worth_tier");
        for (const row of rows.slice(1)) {
          const u = (row[0] || "").toLowerCase();
          if (!u || profileMap.has(u)) continue;
          const profile = {};
          headers.forEach((h, i) => (profile[h] = row[i] || ""));
          profileMap.set(u, {
            ...profile,
            is_classified: true,
            classified_as: {
              classification: row[classIdx] || "",
              priority_score: row[prioIdx] || "",
              confidence: row[confIdx] || "",
              visible_watch_rank: row[wrIdx] || "",
              net_worth_tier: row[ntwIdx] || "",
              routed_to: sheetName,
            },
          });
        }
      } catch (e) { /* skip missing sheets */ }
    }

    res.json({ profiles: Array.from(profileMap.values()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Helpers ---
function fetchJSONFromURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); } });
    }).on("error", reject);
  });
}

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(url, { headers, timeout: 15000 }, (resp) => {
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      })
      .on("error", reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          },
          timeout: 15000,
        },
        (resp) => {
          // Follow redirects
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            return fetchBuffer(resp.headers.location).then(resolve).catch(reject);
          }
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => resolve(Buffer.concat(chunks)));
        }
      )
      .on("error", reject);
  });
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      (resp) => {
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 120000,
      },
      (resp) => {
        let data = "";
        resp.on("data", (c) => (data += c));
        resp.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

app.listen(PORT, () => {
  console.log(`\n  Classifier UI running at: http://localhost:${PORT}\n`);
});
