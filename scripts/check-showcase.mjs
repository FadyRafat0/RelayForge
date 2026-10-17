// Browser tooling is optional and isolated from the backend's dependencies.
// See docs/showcase.md for installation and capture instructions.
import { chromium } from '../.tools/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = process.env.SHOWCASE_URL ?? 'http://127.0.0.1:4173/RelayForge/';
const captures = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
await mkdir(captures, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#delivery-rows tr').length === 4);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('#detail-title').textContent(), 'Transient failure and recovery');
  assert.equal(await page.locator('#timeline li').count(), 4);
  await page.screenshot({ path: captures + 'overview.png', fullPage: true });
  await page.getByRole('button', { name: 'Permanent failure showcase.dead' }).click();
  assert.match(await page.locator('#detail-status').textContent(), /Dead letter/);
  assert.match(await page.locator('#effect-proof').textContent(), /0 committed/);
  await page.getByRole('button', { name: 'Repair and audited replay showcase.replay' }).click();
  assert.match(await page.locator('#timeline').textContent(), /Manual replay accepted/);
  await page.getByRole('button', { name: 'Play recorded trace' }).click();
  await page.waitForFunction(() => document.querySelector('#playback-status').textContent.includes('Playback complete'));
  await page.getByRole('button', { name: 'Successful delivery showcase.success' }).click();
  assert.match(await page.locator('#case-explanation').textContent(), /original event/);
  await page.getByRole('button', { name: 'Run with Docker' }).click();
  assert.equal(await page.locator('#local-dialog').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Architecture', exact: false }).first().click();
  await page.getByRole('button', { name: /Workers Claim/ }).click();
  assert.match(await page.locator('#component-detail').textContent(), /30-second lease/);
  await page.screenshot({ path: captures + 'architecture.png', fullPage: true });
  await page.getByRole('link', { name: 'Benchmarks', exact: false }).first().click();
  assert.equal(await page.locator('#benchmark-rows tr').count(), 2);
  assert.match(await page.locator('#benchmark-rows').textContent(), /200\/200/);
  await page.screenshot({ path: captures + 'benchmarks.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '#overview');
  await page.waitForFunction(() => document.querySelectorAll('#delivery-rows tr').length === 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile viewport overflows');
  await page.getByRole('button', { name: 'Repair and audited replay showcase.replay' }).click();
  await page.screenshot({ path: captures + 'mobile.png', fullPage: true });
  // An unavailable recording must show an error instead of fabricated numbers.
  await page.route('**/traces.json', route => route.fulfill({ status: 503, body: '' }));
  await page.reload();
  await page.locator('#trace-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#delivery-rows tr').count(), 0);
  assert.equal(await page.locator('#play-button').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: selection, recorded playback, modal, component explorer, benchmark data, mobile layout, unavailable data. Screenshots captured.');
} finally { await browser.close(); }
