import { chromium } from "playwright";

const SOURCE_URL = process.env.SOURCE_URL; // you paste this when running workflow
const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const TOKEN = process.env.SHEETS_AUTH_TOKEN;

if (!SOURCE_URL) throw new Error("Missing SOURCE_URL");
if (!WEBHOOK_URL) throw new Error("Missing SHEETS_WEBHOOK_URL");
if (!TOKEN) throw new Error("Missing SHEETS_AUTH_TOKEN");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowISO() {
  return new Date().toISOString();
}

function makeTabName() {
  // e.g. sold_2025-12-26_2359 (UTC)
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `sold_${yyyy}-${mm}-${dd}_${hh}${mi}`;
}

async function closeLoginPopup(page) {
  // Try a few common “close” patterns; safe if not present.
  const selectors = [
    'button[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("Not now")',
    'button:has-text("No thanks")',
    'button:has-text("Maybe later")',
    '[role="dialog"] button',
    '[data-testid*="close"]',
    'button[aria-label="Dismiss"]',
  ];

  for (let i = 0; i < 6; i++) {
    for (const sel of selectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await sleep(400);
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  }
}

async function clickByText(page, rx) {
  return await page.evaluate((pattern) => {
    const r = new RegExp(pattern, "i");
    const els = [...document.querySelectorAll('[role="tab"],[role="button"],button,a,span,h5,div')];
    const el = els.find((e) => r.test((e.textContent || "").trim()));
    if (el) { el.click(); return true; }
    return false;
  }, rx.source);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
  });

  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(2500);
  await closeLoginPopup(page);

  // Activate Shop -> Sold (same approach as your browser-console script)
  await clickByText(page, /\bshop\b/i);
  await sleep(800);
  await closeLoginPopup(page);

  await clickByText(page, /\bsold\b/i);
  await sleep(1500);
  await closeLoginPopup(page);

  // Scrape inside the page context
  const items = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const sanitize = (s) => String(s == null ? "" : s).replace(/\r|\n/g, " ").trim();

    function findLiveGrid() {
      const byClass = [...document.querySelectorAll("div")].find((d) =>
        /\blive_.*livePageGrid/i.test(d.className || "")
      );
      return byClass || document.body;
    }

    function findScrollPanel(root) {
      const cands = [...root.querySelectorAll("div,section,main,article")].filter((el) => {
        if (!el.querySelector) return false;
        const hasListings = !!el.querySelector('a[href^="/listing/"]');
        const cs = getComputedStyle(el);
        const canScroll = el.scrollHeight > el.clientHeight && /(auto|scroll)/i.test(cs.overflowY);
        return hasListings && canScroll;
      });
      cands.sort(
        (a, b) =>
          b.querySelectorAll('a[href^="/listing/"]').length -
          a.querySelectorAll('a[href^="/listing/"]').length
      );
      return cands[0] || document.scrollingElement || document.documentElement;
    }

    const grid = findLiveGrid();
    const scroller = findScrollPanel(grid);

    function getCardFromLink(link, limitAncestor) {
      let n = link;
      for (let i = 0; i < 8 && n && n !== limitAncestor; i++) {
        if (n.querySelector && n.querySelector("img") && n.querySelector("strong")) return n;
        n = n.parentElement || n;
      }
      return link;
    }

    function parseBuyerFromCard(card) {
      const buyerStrong = card.querySelector(
        '[data-testid*="buyer"] a strong, [data-testid="show-buyer-details"] a strong'
      );
      if (buyerStrong) {
        const t = sanitize(buyerStrong.textContent || "");
        if (t) return t;
      }
      const buyerLabel = [...card.querySelectorAll("p, span, div, strong")].find((n) =>
        /Buyer:\s*/i.test(n.textContent || "")
      );
      if (buyerLabel) {
        const m = buyerLabel.textContent.match(/Buyer:\s*(.+)/i);
        if (m) return sanitize(m[1]);
      }
      const txt = card.textContent || "";
      const handle = txt.match(/@\w[\w.-]{1,28}/);
      return handle ? handle[0] : "";
    }

    function parseSoldPriceFromLink(link, titleStrong) {
      const strongs = [...link.querySelectorAll("strong")];
      for (const s of strongs) {
        if (s === titleStrong) continue;
        const t = (s.textContent || "").trim();
        const m = t.match(/^\$[\s]*([\d,]+(?:\.\d{2})?)$/);
        if (m) return parseFloat(m[1].replace(/,/g, ""));
      }
      return NaN;
    }

    function parseSoldPriceFallback(card, link, titleText) {
      const buyerBlock = card.querySelector('[data-testid*="buyer"], [data-testid="show-buyer-details"]');
      if (buyerBlock) {
        const neighbors = [buyerBlock.previousElementSibling, buyerBlock.nextElementSibling].filter(Boolean);
        for (const sib of neighbors) {
          const m = (sib.textContent || "").match(/\$\s*([\d,]+(?:\.\d{2})?)/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }

      let cardText = (card.textContent || "").replace(/\s+/g, " ");
      if (titleText) {
        const titleSnippet = titleText.slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cardText = cardText.replace(new RegExp(titleSnippet, "i"), "");
      }
      if (link) {
        const linkText = (link.textContent || "").replace(/\s+/g, " ");
        const linkSnippet = linkText.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cardText = cardText.replace(new RegExp(linkSnippet, "i"), "");
      }
      const mm = [...cardText.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)].map((x) =>
        parseFloat(x[1].replace(/,/g, ""))
      );
      return mm.length ? mm[0] : 0;
    }

    function parseVisible(listRoot) {
      const links = [...listRoot.querySelectorAll('a[href^="/listing/"]')];
      const out = [];

      for (const link of links) {
        const card = getCardFromLink(link, listRoot);

        const titleStrong = link.querySelector('strong[title]');
        let title = titleStrong
          ? titleStrong.getAttribute("title") || titleStrong.textContent || ""
          : "";
        title = sanitize(title);
        if (!title) {
          const fb = link.querySelector("strong");
          if (fb) title = sanitize(fb.textContent || "");
        }
        if (!title) continue;

        let price = parseSoldPriceFromLink(link, titleStrong);
        if (!Number.isFinite(price)) price = parseSoldPriceFallback(card, link, title);

        const buyer = sanitize(parseBuyerFromCard(card));
        out.push({ title, buyer, price: Number.isFinite(price) ? price : 0 });
      }

      const seen = new Set();
      const uniq = [];
      for (const r of out) {
        const k = `${r.title}||${r.buyer}||${r.price}`;
        if (!seen.has(k)) {
          seen.add(k);
          uniq.push(r);
        }
      }
      return uniq;
    }

    const bag = new Map();
    const STEP = Math.max(200, scroller.clientHeight - 80);

    // Big list = give it time
    const MAX_MS = 20 * 60 * 1000; // 20 minutes
    const start = performance.now();

    async function waitForGrowth(prevCount, msMax = 15000) {
      const end = performance.now() + msMax;
      while (performance.now() < end) {
        const chunk = parseVisible(scroller);
        for (const r of chunk) bag.set(`${r.title}||${r.buyer}||${r.price}`, r);
        if (bag.size > prevCount) return true;
        await sleep(900);
      }
      return false;
    }

    scroller.scrollTo({ top: 0, behavior: "instant" });
    await sleep(1400);

    while (true) {
      const chunk = parseVisible(scroller);
      for (const r of chunk) bag.set(`${r.title}||${r.buyer}||${r.price}`, r);

      const atBottom = Math.abs(scroller.scrollTop + scroller.clientHeight - scroller.scrollHeight) < 3;
      const timedOut = performance.now() - start > MAX_MS;

      if (atBottom) {
        const grew = await waitForGrowth(bag.size, 18000);
        if (!grew) break;
      }

      if (timedOut) break;

      scroller.scrollTo({
        top: Math.min(scroller.scrollTop + STEP, scroller.scrollHeight),
        behavior: "instant",
      });
      await sleep(1300);
    }

    return [...bag.values()];
  });

  await browser.close();

  const tabName = makeTabName();
  const exportTs = nowISO();

  const payload = {
    token: TOKEN,
    export_ts: exportTs,
    source_url: SOURCE_URL,
    tab_name: tabName,
    items,
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webhook failed (${res.status}): ${text}`);

  console.log(`✅ Exported ${items.length} sold items to tab "${tabName}". Response: ${text}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
