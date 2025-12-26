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
