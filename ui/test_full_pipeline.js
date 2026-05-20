/**
 * Run full Stage 1 + deep dive pipeline on a list of usernames.
 * Usage: node test_full_pipeline.js username1 username2 ...
 */
const http = require("http");

const BASE = "http://localhost:3456";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 180000 }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve({ status: r.statusCode, data: JSON.parse(d) }); } catch { reject(new Error("Bad JSON")); } });
    }).on("error", reject);
  });
}
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/json" }, timeout: 240000 }, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { resolve({ status: r.statusCode, data: JSON.parse(d) }); } catch { reject(new Error("Bad JSON")); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runStage1(username) {
  // Fetch profile
  const p = await httpGet(`${BASE}/api/instagram/${encodeURIComponent(username)}`);
  if (p.status !== 200) return { error: p.data.error || "fetch fail" };

  // Download images
  const imageUrls = (p.data.image_urls || []).slice(0, 8);
  const parts = [];
  for (const url of imageUrls) {
    try {
      const r = await httpPost(`${BASE}/api/image-base64`, JSON.stringify({ url }));
      if (r.data && r.data.data) parts.push({ inlineData: { mimeType: "image/jpeg", data: r.data.data } });
    } catch (e) {}
  }
  if (!parts.length) return { error: "No images" };

  // Load prompt
  const fs = require("fs");
  const path = require("path");
  const tmpl = fs.readFileSync(path.join(__dirname, "prompt_stage1.txt"), "utf-8");
  const prompt = tmpl
    .replace(/\{\{IMAGE_COUNT\}\}/g, String(parts.length))
    .replace(/\{\{USERNAME\}\}/g, p.data.username || username)
    .replace(/\{\{FULL_NAME\}\}/g, p.data.full_name || "")
    .replace(/\{\{BIO\}\}/g, p.data.bio || "")
    .replace(/\{\{FOLLOWER_COUNT\}\}/g, String(p.data.follower_count || 0))
    .replace(/\{\{FOLLOWING_COUNT\}\}/g, String(p.data.following_count || 0))
    .replace(/\{\{POST_COUNT\}\}/g, String(p.data.post_count || 0))
    .replace(/\{\{IS_VERIFIED\}\}/g, String(p.data.is_verified || false))
    .replace(/\{\{IS_BUSINESS\}\}/g, String(p.data.is_business || false))
    .replace(/\{\{BUSINESS_CATEGORY\}\}/g, p.data.business_category || "")
    .replace(/\{\{EXTERNAL_URL\}\}/g, p.data.external_url || "")
    .replace(/\{\{RECENT_CAPTIONS\}\}/g, (p.data.recent_captions || "").slice(0, 3000));
  parts.push({ text: prompt });

  const r = await httpPost(`${BASE}/api/classify`, JSON.stringify({ parts, profile: p.data }));
  if (r.status !== 200) return { error: r.data.error };
  return r.data.classification;
}

async function runDeepDive(kind, username) {
  const r = await httpPost(`${BASE}/api/deep-dive`, JSON.stringify({ kind, username }));
  if (r.status !== 200) return { error: r.data.error };
  return r.data;
}

async function main() {
  const usernames = process.argv.slice(2);
  if (!usernames.length) { console.log("Usage: node test_full_pipeline.js u1 u2 ..."); process.exit(1); }

  console.log(`\n=== Running full pipeline on ${usernames.length} profiles ===\n`);

  for (let i = 0; i < usernames.length; i++) {
    const u = usernames[i];
    console.log(`\n[${i+1}/${usernames.length}] @${u}`);
    console.log("─".repeat(60));

    // Stage 1
    const s1 = await runStage1(u);
    if (s1.error) {
      console.log(`  STAGE 1 ERROR: ${s1.error}`);
      continue;
    }
    console.log(`  STAGE 1: ${s1.classification} | rank=${s1.visible_watch_rank} | wealth=${s1.net_worth_tier} | priority=${s1.priority_score}`);

    // Only run deep dives if it landed in Sheet A or B
    const cls = s1.classification;
    const rank = s1.visible_watch_rank || 0;
    const nwt = (s1.net_worth_tier || "").toLowerCase();
    const inSheetA = (cls === "collector" || cls === "dealer") && rank >= 6;
    const inSheetB = cls === "hnw_no_watches" && nwt === "ultra-high";

    if (!inSheetA && !inSheetB) {
      console.log(`  Routed to Sheet C — skipping deep dives`);
      if (i < usernames.length - 1) await sleep(5000);
      continue;
    }

    // Deep dives
    if (inSheetA) {
      console.log(`  Running Horology...`);
      const h = await runDeepDive("horology", u);
      if (h.error) console.log(`    HOROLOGY ERROR: ${h.error}`);
      else console.log(`    Tier=${h.updates.watch_complication_tier} | brands=${h.updates.watch_brands} | value=${h.updates.visible_recent_collection_value}`);
      await sleep(3000);
    }

    console.log(`  Running Wealth...`);
    const w = await runDeepDive("wealth", u);
    if (w.error) console.log(`    WEALTH ERROR: ${w.error}`);
    else console.log(`    Tier=${w.updates.visible_wealth_tier} | profession=${w.updates.profession} | sector=${w.updates.business_sector}`);
    await sleep(3000);

    console.log(`  Running Lifestyle...`);
    const l = await runDeepDive("lifestyle", u);
    if (l.error) console.log(`    LIFESTYLE ERROR: ${l.error}`);
    else console.log(`    Value=${l.updates.inferred_lifestyle_value} | hobbies=${l.updates.hobbies} | locations=${l.updates.locations}`);

    if (i < usernames.length - 1) await sleep(5000);
  }

  console.log(`\n=== Pipeline complete ===`);
}

main().catch(e => console.error("FATAL:", e.message));
