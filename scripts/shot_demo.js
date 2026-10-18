#!/usr/bin/env node
/* Screenshot: Settings screen with the new "Hear them live" demo box. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.route(/\/socket\.io\//, async (route) => {
    try {
      const u = new URL(route.request().url());
      const req = route.request();
      const headers = { 'content-type': req.headers()['content-type'] || '' };
      if (req.headers()['cookie']) headers.cookie = req.headers()['cookie'];
      const upstream = await fetch('http://localhost:3003' + u.pathname + u.search, {
        method: req.method(), headers,
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() || undefined,
      });
      await route.fulfill({ status: upstream.status, contentType: upstream.headers.get('content-type') || 'text/plain', body: await upstream.text() });
    } catch { await route.abort(); }
  });

  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1400);
  for (const d of '2026') {
    await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    await p.waitForTimeout(140);
  }
  await p.waitForTimeout(2600);
  const nn = p.locator('button', { hasText: 'Not now' });
  if (await nn.count()) { await nn.first().click(); await p.waitForTimeout(300); }
  await p.locator('nav[aria-label="Main navigation"] button', { hasText: 'More' }).first().click();
  await p.waitForTimeout(1300);
  // scroll the notification prefs section into view
  await p.locator('text=Hear them live').first().scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'scripts/shot-demo-box.png' });
  // fire the order demo and capture the toast + header area
  await p.locator('button', { hasText: 'Demo order' }).first().click();
  await p.waitForTimeout(1400);
  await p.screenshot({ path: 'scripts/shot-demo-toast.png' });
  await browser.close();
  console.log('screenshots saved');
})();
