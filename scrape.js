import { chromium } from "playwright";

const PAGE_URL = "https://www.whatnot.com/tag/toys";
const WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const TOKEN = process.env.SHEETS_AUTH_TOKEN;

function nowISO() {
  return new Date().toISOString();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(5000);
  await page.waitForSelector('a[href^="/tag/"]', { timeout: 120000 });

  const rows = await page.evaluate(() => {
    const out = [];
    const links = [...document.querySelectorAll('a[href^="/tag/"]')];

    function parse(text) {
      const m = text.match(/(\d[\d,]*)\s*(watching|viewers?)/i);
      if (!m) return null;
      return parseInt(m[1].replace(/,/g,""),10);
    }

    for (const a of links) {
      const tag = a.getAttribute("href").replace("/tag/","");
      const texts = [...a.querySelectorAll("span,div,p,strong")].map(n=>n.textContent||"");

      let best = null;
      let raw = "";
      for (const t of texts) {
        const v = parse(t);
        if (v && (!best || v > best)) {
          best = v;
          raw = t.trim();
        }
      }
      if (!best) continue;

      out.push({ tag, watchers: best, watching_text: raw });
    }

    const map = new Map();
    out.forEach(r => {
      const prev = map.get(r.tag);
      if (!prev || r.watchers > prev.watchers) map.set(r.tag, r);
    });
    return [...map.values()];
  });

  await browser.close();

  const payload = {
    token: TOKEN,
    rows: rows.map(r => ({
      ts: nowISO(),
      page: PAGE_URL,
      tag: r.tag,
      watching_text: r.watching_text,
      watchers: r.watchers
    }))
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  console.log("Response:", text);
}

main();
