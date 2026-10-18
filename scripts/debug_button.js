#!/usr/bin/env node
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });

  await p.addInitScript(() => {
    const pk = window.PublicKeyCredential;
    if (pk) pk.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  });

  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2400);
  for (const d of '2026') {
    await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    await p.waitForTimeout(140);
  }
  await p.waitForTimeout(2600);
  const nn = p.locator('button', { hasText: 'Not now' });
  if (await nn.count()) { await nn.first().click(); await p.waitForTimeout(400); }

  await p.locator('nav[aria-label="Main navigation"] button', { hasText: 'More' }).first().click();
  await p.waitForTimeout(1400);
  await p.locator('button', { hasText: 'Set up Face ID' }).first().click();

  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(1000);
    const states = await p.evaluate(() => {
      return [...document.querySelectorAll('button')]
        .filter((b) => /Continue|Preparing|scan/i.test(b.textContent || ''))
        .map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
    });
    console.log(`t+${i + 1}s:`, JSON.stringify(states));
  }
  await ctx.close();
  await browser.close();
})();
