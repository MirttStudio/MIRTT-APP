#!/usr/bin/env node
/* Reproduce "More not opening": click the More tab, capture console + page errors. */
const { chromium } = require('playwright');

async function tryLogin(browser, pin, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  p.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2400);

  // switch to Staff tab if needed
  if (label === 'Staff') {
    const staffTab = p.locator('button', { hasText: 'Staff' }).first();
    if (await staffTab.count()) await staffTab.click();
    await p.waitForTimeout(300);
  }
  for (const d of pin) {
    await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    await p.waitForTimeout(140);
  }
  await p.waitForTimeout(2600);
  const nn = p.locator('button', { hasText: 'Not now' });
  if (await nn.count()) { await nn.first().click(); await p.waitForTimeout(500); }

  // click the More tab in the bottom nav
  const moreBtn = p.locator('nav[aria-label="Main navigation"] button', { hasText: 'More' }).first();
  const moreCount = await moreBtn.count();
  console.log(`${label}: more button count = ${moreCount}`);
  if (moreCount) {
    await moreBtn.click();
    await p.waitForTimeout(1500);
    const hash = await p.evaluate(() => window.location.hash);
    console.log(`${label}: hash after click = ${hash}`);
    await p.screenshot({ path: `/home/z/my-project/scripts/verify-more-${label}.png` });
  }
  console.log(`${label}: errors =`, errors.length ? errors : 'none');
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await tryLogin(browser, '2026', 'Admin');
  await tryLogin(browser, '20060', 'Staff');
  await browser.close();
})();
