/**
 * Captures REAL frames from the live Promit product + Basescan proof pages.
 * The video animates these captures (pan/zoom) instead of re-building UI in
 * Remotion, so what the judges see is the deployed product, pixel for pixel.
 *
 * Usage: node scripts/capture.mjs   (from video/)
 * Output: public/captures/*.png at deviceScaleFactor 2 (crisp when zoomed).
 */
import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const OUT = resolve(import.meta.dirname, '../public/captures');
mkdirSync(OUT, {recursive: true});

const SITE = 'https://promit-two.vercel.app';
const TX =
  '0x7b62a3ae1bd835907f3f4b9541cf9b4b082c687c5267795178ad2e2c5aad6a85';
const BUYER = '0xadE939F26516c657fc01f2eD1B069562b672644c';
const CONTRACT = '0x30c92fFadAd24Ca079227A92A33b78683D36Fde6';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: {width: 1920, height: 1080},
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const shot = async (name, opts = {}) => {
  await page.screenshot({path: `${OUT}/${name}.png`, ...opts});
  console.log(`captured ${name}.png`);
};

// --- Landing -----------------------------------------------------------
await page.goto(SITE, {waitUntil: 'networkidle', timeout: 60_000});
await page.waitForTimeout(4000); // let the hero video + entrance animations settle
await shot('landing-hero');

// --- Gallery (/prompts) ------------------------------------------------
await page.goto(`${SITE}/prompts`, {waitUntil: 'networkidle', timeout: 60_000});
await page.waitForTimeout(5000); // catalog fetch + card media
// Honesty gate: refuse to capture an empty gallery. If the catalog failed to
// load we abort and the capture must be re-run later — never fake the grid.
const cardCount = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/prompts/"]');
  const cards = document.querySelectorAll('[class*="card" i], article');
  return Math.max(links.length, cards.length);
});
if (cardCount < 5) {
  throw new Error(
    `Gallery shows only ${cardCount} cards — catalog may be down. Re-run later.`,
  );
}
console.log(`gallery cards detected: ${cardCount}`);
await shot('gallery-top');
await shot('gallery-full', {fullPage: true});

// --- Listing page (/list) ---------------------------------------------
await page.goto(`${SITE}/list`, {waitUntil: 'networkidle', timeout: 60_000});
await page.waitForTimeout(3000);
await shot('list');

// --- Basescan: settlement tx ------------------------------------------
await page.goto(`https://sepolia.basescan.org/tx/${TX}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(5000);
await shot('basescan-tx', {fullPage: true});

// --- Basescan: buyer address (0 ETH balance) --------------------------
await page.goto(`https://sepolia.basescan.org/address/${BUYER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(5000);
await shot('basescan-buyer');

// --- Basescan: verified contract --------------------------------------
await page.goto(`https://sepolia.basescan.org/address/${CONTRACT}#code`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(5000);
await shot('basescan-contract');

await browser.close();
console.log('done');
