const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  p.on('request', (r) => { if (r.url().includes('/api/push')) console.log('>>', r.method(), r.url(), '| body:', r.postData()?.slice(0, 220)); });
  p.on('response', (r) => { if (r.url().includes('/api/push')) console.log('<<', r.status(), r.url()); });

  console.log('step1: goto');
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  console.log('step2: login');
  for (const d of '2026') { await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click(); await p.waitForTimeout(120); }
  await p.waitForTimeout(2200);
  const nn = p.locator('button', { hasText: 'Not now' });
  if (await nn.count()) { await nn.first().click(); await p.waitForTimeout(250); }
  console.log('step3: More');
  await p.locator('nav[aria-label="Main navigation"] button', { hasText: 'More' }).first().click();
  await p.waitForTimeout(1000);

  console.log('step4: sw probe');
  const sub = await Promise.race([
    p.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.getSubscription();
      return s ? s.endpoint.slice(0, 60) : null;
    }),
    new Promise((res) => setTimeout(() => res('SW-PROBE-TIMEOUT'), 8000)),
  ]);
  console.log('pushManager.getSubscription() =', sub);
  console.log('Notification.permission =', await p.evaluate(() => Notification.permission));

  const btn = p.locator('button', { hasText: 'Send test push to this device' }).first();
  console.log('btn disabled before click:', await btn.isDisabled());
  await btn.click();
  await p.waitForTimeout(2500);
  console.log('btn disabled after click:', await btn.isDisabled());
  const toasts = await p.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
  console.log('toasts:', JSON.stringify(toasts));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
