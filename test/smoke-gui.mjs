// Drive the GUI in a real browser: home view, the editor on a real map,
// a viewshed, a brush stroke. Needs playwright, which this repo does not
// carry — borrow it from the one repo here that does:
//
//   NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules node test/smoke-gui.mjs [LIB]
//
// Screenshots land in tmp/smoke/. Not part of `npm test` (needs a browser
// and a library with at least one terrain map).

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';

const require = createRequire(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'x.js') : import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = process.argv[2] || path.join(process.env.HOME, 'code', 'maps-folder');
const SHOTS = path.join(ROOT, 'tmp', 'smoke');
fs.mkdirSync(SHOTS, { recursive: true });

let fail = 0;
const ok = (c, what) => { console.log(`  ${c ? 'ok   ' : 'FAIL '} ${what}`); if (!c) fail++; };

const { server, port } = await startServer({ libDir: LIB, port: 0, quiet: true });
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('== home ==');
await page.goto(base);
await page.waitForSelector('.card', { timeout: 15000 });
const cards = await page.$$('.card');
ok(cards.length > 0, `${cards.length} map cards`);
await page.screenshot({ path: path.join(SHOTS, 'gui-home.png') });

console.log('== editor ==');
const editBtn = await page.$('.card button[data-edit]');
ok(!!editBtn, 'a terrain map offers Edit');
const mapId = await editBtn.getAttribute('data-edit');
await editBtn.click();
await page.waitForSelector('#view-edit:not([hidden])');
await page.waitForFunction(() => {
  const c = document.querySelector('#edCanvas');
  if (!c || !c.width) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4096) if (d[i] > 20 || d[i + 1] > 20) return true; // terrain drew something
  return false;
}, { timeout: 20000 });
ok(true, `editor opened on ${mapId} and drew terrain`);
await page.screenshot({ path: path.join(SHOTS, 'gui-editor.png') });

console.log('== viewshed ==');
await page.click('#edTools button[data-tool=view]');
const box = await (await page.$('#edCanvas')).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForSelector('#horizonStrip', { timeout: 20000 });
const open = await page.textContent('#edPanel .statline');
ok(/Open directions/.test(open), `viewshed ran: ${open.trim().replace(/\s+/g, ' ')}`);
await page.screenshot({ path: path.join(SHOTS, 'gui-viewshed.png') });

console.log('== sites tool ==');
await page.click('#edTools button[data-tool=sites]');
await page.click('#btnPropose');
await page.waitForFunction(() => document.querySelector('#proposals').children.length > 0 || document.querySelector('#proposals .note'), { timeout: 30000 });
ok(true, 'propose answered');
await page.screenshot({ path: path.join(SHOTS, 'gui-sites.png') });

ok(errors.length === 0, errors.length ? `console errors:\n    ${errors.join('\n    ')}` : 'no console errors');

await browser.close();
server.close();
console.log(`\n${fail === 0 ? 'SMOKE PASS' : 'SMOKE FAILURES'} — screenshots in tmp/smoke/`);
process.exit(fail ? 1 : 0);
