#!/usr/bin/env node
/* Log the exact URLs behind 401/404 responses. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('response', (r) => {
    if ([401, 404, 500].includes(r.status())) console.log(r.status(), r.url());
  });
  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2400);
  for (const d of ['2', '0', '2', '6']) {
    await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    await p.waitForTimeout(140);
  }
  await p.waitForTimeout(2600);
  const nn = p.locator('button', { hasText: 'Not now' });
  if (await nn.count()) { await nn.first().click(); await p.waitForTimeout(500); }
  console.log('--- clicking More ---');
  await p.locator('nav[aria-label="Main navigation"] button', { hasText: 'More' }).first().click();
  await p.waitForTimeout(2000);
  console.log('--- done, hash =', await p.evaluate(() => window.location.hash));
  await browser.close();
})();
