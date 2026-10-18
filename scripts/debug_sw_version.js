const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const log = (...a) => console.log(Date.now() % 100000, ...a);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('response', (r) => { if (r.status() >= 400) log('HTTP', r.status(), r.url().slice(0, 110)); });
  p.on('requestfailed', (r) => log('REQFAIL', r.url().slice(0, 110), r.failure()?.errorText));
  log('goto');
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);
  log('sw state probe (NO ready call)');
  const st = await p.evaluate(async () => {
    const out = { perm: typeof Notification !== 'undefined' ? Notification.permission : 'none' };
    if (!('serviceWorker' in navigator)) { out.noSw = true; return out; }
    const regs = await navigator.serviceWorker.getRegistrations();
    out.regCount = regs.length;
    out.regs = regs.map((r) => ({
      scope: r.scope,
      active: !!r.active,
      installing: !!r.installing,
      waiting: !!r.waiting,
      script: (r.active || r.installing || r.waiting || {}).scriptURL,
    }));
    out.controller = navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;
    return out;
  });
  log('STATE:', JSON.stringify(st, null, 1));
  await browser.close();
  log('done');
})().catch((e) => { log('FATAL', String(e).slice(0, 300)); process.exit(1); });
