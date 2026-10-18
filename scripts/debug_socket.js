#!/usr/bin/env node
/* Debug: what happens to socket.io on direct :3000? */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const sockReqs = [];
  p.on('response', (r) => { if (r.url().includes('socket.io')) sockReqs.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 110)}`); });
  const wsFrames = [];
  p.on('websocket', (ws) => {
    wsFrames.push('WS open: ' + ws.url().slice(0, 110));
    ws.on('framereceived', (f) => wsFrames.push('WS<< ' + String(f.payload).slice(0, 160)));
  });
  await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  for (const d of '2026') {
    await p.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    await p.waitForTimeout(140);
  }
  await p.waitForTimeout(2500);
  const pill = await p.locator('header span.flex, header span').allInnerTexts().catch(() => []);
  console.log('pill texts =', JSON.stringify(pill.filter((t) => /Live|Syncing|Offline/.test(t))));
  console.log('socket.io requests:', sockReqs.length);
  sockReqs.slice(0, 6).forEach((l) => console.log('  ', l));
  console.log('websockets:', wsFrames.length);
  wsFrames.slice(0, 8).forEach((l) => console.log('  ', l));
  await ctx.close(); await browser.close();
})();
