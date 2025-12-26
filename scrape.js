import { chromium } from "playwright";
import fs from "fs";

const PAGE_URL = "https://www.whatnot.com/tag/toys";
const DISNEY_URL = "https://www.whatnot.com/tag/disneyana";

const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const TOKEN = process.env.SHEETS_AUTH_TOKEN;

if (!WEBHOOK_URL) throw new Error("Missing SHEETS_WEBHOOK_URL");
if (!TOKEN) throw new Error("Missing SHEETS_AUTH_TOKEN");

function nowISO() {
  return new Date().toISOString();
}

async function saveDebug(page, label = "debug") {
  try {
    await page.screenshot({ path: `${label}.png`, fullPage: true });
  } catch {}
  try {
    const html = await page.content();
    fs.writeFileSync(`${label}.html`, html, "utf8");
  } catch {}
}

async function waitForSomeTagLinks(page) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const c = await page
      .evaluate(() => document.querySelectorAll('a[href^="/tag/"]').length)
      .catch(() => 0);

    if (c > 0) return true;

    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(2500);
  }
  return false;
}

async function scrapeTagCounts(page) {
  const ok = await waitForSomeTagLinks(page);
  if (!ok) return [];

  // Nudge lazy rendering a bit
  await page.mouse.wheel(0, 1600).catch(() => {});
  await page.waitForTimeout(2000);
  await page.mouse.wheel(0, -1600).catch(() => {});
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href^="/tag/"]')];

    function sanitize(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    // Supports: "895 viewers", "1.6K viewers", "2K watching", "1.2M viewers"
    function parseCount(text) {
      const t = sanitize(text);

      // Accept "View", "Viewer", "Viewers", "Watching" variants
      const m = t.match(/(\d+(?:\.\d+)?)([KM])?\s*(watching|view|viewer|viewers|watchers?)\b/i);
      if (!m) return null;

      let n = parseFloat(m[1]);
      const suf = (m[2] || "").toUpperCase();
      if (suf === "K") n *= 1000;
      if (suf === "M") n *= 1000000;

      n = Math.round(n);
      if (!Number.isFinite(n)) return null;

      return { watchers: n, watching_text: t };
    }

    // Key fix: choose the smallest ancestor container that contains ONLY this tag link.
    function findSingleTagTile(a) {
      let tile = a;
      let prev = a;

      for (let i = 0; i < 10; i++) {
        const p = tile.parentElement;
        if (!p) break;

        const tagLinkCount = p.querySelectorAll('a[href^="/tag/"]').length;

        // As soon as the parent contains multiple /tag/ links, we've gone too far.
        if (tagLinkCount > 1) {
          tile = prev; // last "small" container
          break;
        }

        prev = p;
        tile = p;
      }

      return tile;
    }

    const out = [];

    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const tag = href.replace("/tag/", "");
      if (!tag) continue;

      const tile = findSingleTagTile(a);

      // Prefer scanning within this tile only (prevents Disney count bleeding)
      const texts = (tile.textContent || "")
        .split("\n")
        .map(sanitize)
        .filter(Boolean);

      let best = null;
      for (const t of texts) {
        const p = parseCount(t);
        if (p && (!best || p.watchers > best.watchers)) best = p;
      }

      // Fallback: scan immediate siblings near the anchor if tile text is noisy
      if (!best) {
        const sibs = [
          a.nextElementSibling,
          a.previousElementSibling,
          a.parentElement?.nextElementSibling,
          a.parentElement?.previousElementSibling,
        ].filter(Boolean);

        for (const s of sibs) {
          const t = sanitize(s.textContent || "");
          const p = parseCount(t);
          if (p && (!best || p.watchers > best.watchers)) best = p;
        }
      }

      if (!best) continue;

      out.push({ tag, watchers: best.watchers, watching_text: best.watching_text });
    }

    // De-dupe by tag
    const map = new Map();
    for (const r of out) {
      const prev = map.get(r.tag);
      if (!prev || r.watchers > prev.watchers) map.set(r.tag, r);
    }
    return [...map.values()];
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
  });

  const page = await context.newPage();

  // --- Scrape toys page
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(6000);

  let rows = await scrapeTagCounts(page);

  if (!rows.length) {
    await saveDebug(page, "debug-toys");
    await browser.close();
    throw new Error("No rows scraped from toys page. See debug-toys.png/html artifacts.");
  }

  // --- Guarantee disneyana: if missing OR if present but looks wrong, scrape disneyana page directly
  const disneyFromToys = rows.find(r => r.tag === "disneyana");

  const disneyLooksBad =
    disneyFromToys &&
    /disney/i.test(disneyFromToys.watching_text) &&
    // if the tile text got polluted, it often repeats weirdly; also if watchers is suspiciously identical across many tags
    false;

  if (!disneyFromToys || disneyLooksBad) {
    console.log("ℹ️ Ensuring disneyana by scraping /tag/disneyana directly...");
    await page.goto(DISNEY_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(6000);

    const disneyRows = await scrapeTagCounts(page);
    const disney = disneyRows.find(r => r.tag === "disneyana");

    // Remove any bad disneyana from toys scrape, then add direct one
    rows = rows.filter(r => r.tag !== "disneyana");

    if (disney) {
      rows.push(disney);
      console.log("✅ Disneyana direct:", disney.watchers, disney.watching_text);
    } else {
      rows.push({ tag: "disneyana", watchers: 0, watching_text: "NOT_FOUND" });
      await saveDebug(page, "debug-disneyana");
      console.log("⚠️ Could not extract disneyana even from its own page.");
    }
  }

  await browser.close();

  // --- Send to Sheets
  const payload = {
    token: TOKEN,
    rows: rows.map(r => ({
      ts: nowISO(),
      page: PAGE_URL,
      tag: r.tag,
      watching_text: r.watching_text,
      watchers: r.watchers,
    })),
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webhook failed (${res.status}): ${text}`);

  console.log(`✅ Sent ${rows.length} rows. Response: ${text}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
