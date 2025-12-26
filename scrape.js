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

/**
 * Extract tag watcher counts from the current page.
 * Important: counts may live OUTSIDE the <a> in sibling elements, so we scan a "tile" container.
 */
async function scrapeTagCounts(page) {
  // Poll for tag anchors; also do some small scrolling to trigger lazy rendering.
  const deadline = Date.now() + 120000;
  let anchorCount = 0;

  while (Date.now() < deadline) {
    anchorCount = await page
      .evaluate(() => document.querySelectorAll('a[href^="/tag/"]').length)
      .catch(() => 0);

    if (anchorCount > 0) break;

    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(2500);
  }

  if (anchorCount === 0) return [];

  // Settle / nudge rendering
  await page.mouse.wheel(0, 1600).catch(() => {});
  await page.waitForTimeout(2000);
  await page.mouse.wheel(0, -1600).catch(() => {});
  await page.waitForTimeout(2000);

  const rows = await page.evaluate(() => {
    const out = [];
    const links = [...document.querySelectorAll('a[href^="/tag/"]')];

    function parseCount(text) {
      const t = (text || "").replace(/\s+/g, " ").trim();
      const m = t.match(/(\d[\d,]*)\s*(watching|viewers?|watchers?)/i);
      if (!m) return null;
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      return Number.isFinite(n) ? { watchers: n, watching_text: t } : null;
    }

    function findTile(a) {
      let n = a;
      for (let i = 0; i < 10 && n; i++) {
        const txt = n.textContent || "";
        if (/watching|viewers?|watchers?/i.test(txt)) return n;
        n = n.parentElement;
      }
      return a.parentElement || a;
    }

    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const tag = href.replace("/tag/", "");
      if (!tag) continue;

      const tile = findTile(a);

      const tileBits = (tile.textContent || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      let best = null;

      for (const t of tileBits) {
        const p = parseCount(t);
        if (p && (!best || p.watchers > best.watchers)) best = p;
      }

      if (!best) {
        const inner = [...a.querySelectorAll("span,div,p,strong")]
          .map((n) => (n.textContent || "").trim())
          .filter(Boolean);

        for (const t of inner) {
          const p = parseCount(t);
          if (p && (!best || p.watchers > best.watchers)) best = p;
        }
      }

      if (!best) continue;

      out.push({ tag, watchers: best.watchers, watching_text: best.watching_text });
    }

    // De-dupe by tag (keep max watchers)
    const map = new Map();
    for (const r of out) {
      const prev = map.get(r.tag);
      if (!prev || r.watchers > prev.watchers) map.set(r.tag, r);
    }
    return [...map.values()];
  });

  return rows;
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

  // --- Visit /tag/toys first
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(6000);

  const title = await page.title().catch(() => "");
  const url = page.url();
  const bodyText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 4000) || "")
    .catch(() => "");

  const looksBlocked =
    /access denied|forbidden|unusual traffic|verify you are human|captcha|cloudflare|attention required/i.test(
      `${title}\n${url}\n${bodyText}`
    );

  let rows = await scrapeTagCounts(page);

  // If we got nothing, save debug and error (this is your bot-block detection)
  if (!rows.length) {
    console.log("❌ No rows scraped from toys page.");
    console.log("Title:", title);
    console.log("URL:", url);
    console.log("Blocked heuristics:", looksBlocked);

    await saveDebug(page, "debug-toys");
    await browser.close();

    throw new Error(
      looksBlocked
        ? "Likely bot-protection / blocked page served to GitHub runner. See debug-toys.png + debug-toys.html."
        : "Page never rendered tag anchors in time. See debug-toys.png + debug-toys.html."
    );
  }

  // --- Guarantee disneyana: if missing from /tag/toys scrape, fetch it directly from /tag/disneyana
  const hasDisneyana = rows.some((r) => r.tag === "disneyana");

  if (!hasDisneyana) {
    console.log("ℹ️ disneyana missing on /tag/toys — fetching directly from /tag/disneyana...");
    await page.goto(DISNEY_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(6000);

    const disneyRows = await scrapeTagCounts(page);
    const disney = disneyRows.find((r) => r.tag === "disneyana");

    if (disney) {
      rows.push(disney);
      console.log("✅ Pulled disneyana directly:", disney.watchers, disney.watching_text);
    } else {
      // Worst-case: still record a marker row instead of silently missing it
      rows.push({ tag: "disneyana", watchers: 0, watching_text: "NOT_FOUND" });
      await saveDebug(page, "debug-disneyana");
      console.log("⚠️ Could not extract disneyana even from its own page. Added NOT_FOUND row.");
    }
  }

  await browser.close();

  // --- Send to Sheets
  const payload = {
    token: TOKEN,
    rows: rows.map((r) => ({
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
