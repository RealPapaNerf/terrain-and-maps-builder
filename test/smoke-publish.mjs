// Save publishes. Drive the editor in a real browser, drag the stand point,
// press Save, and check the commit landed on a remote.
//
// This exists because the thing that goes wrong is silent: the builder saved
// to its folder, the sim read the PUBLISHED library, and an afternoon of moved
// stand points was invisible with no error anywhere. Save therefore commits
// and pushes, and that has to be checked against a real remote rather than by
// reading the handler.
//
// It never touches the real library. It copies one map into a temp folder,
// gives it its own git repo and a bare remote, and works on that:
//
//   NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules node test/smoke-publish.mjs [LIB]
//
// Needs playwright, which this repo does not carry — borrowed from the one
// repo here that does. Not part of `npm test` (needs a browser).

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';

const require = createRequire(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, 'x.js') : import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_LIB = process.argv[2] || path.join(process.env.HOME, 'code', 'maps-folder');

let fail = 0;
const ok = (c, what, got) => { console.log(`  ${c ? 'ok   ' : 'FAIL '} ${what}${got === undefined ? '' : `  (${got})`}`); if (!c) fail++; };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

/* A library of one map, with somewhere to push it. The map is whichever the
   source library lists first, so this works against any library. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flmap-publish-'));
  const lib = path.join(dir, 'lib'), remote = path.join(dir, 'remote.git');
  fs.mkdirSync(lib);
  const index = JSON.parse(fs.readFileSync(path.join(SRC_LIB, 'index.json'), 'utf8'));
  const entry = (index.maps || []).find((m) => m.kind !== 'arena') || index.maps[0];
  if (!entry) throw new Error(`${SRC_LIB}/index.json lists no maps`);
  fs.cpSync(path.join(SRC_LIB, entry.id), path.join(lib, entry.id), { recursive: true });
  index.maps = [entry];
  fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify(index, null, 2));

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const G = (...a) => execFileSync('git', ['-C', lib, '-c', 'user.email=test@test', '-c', 'user.name=test', ...a], { encoding: 'utf8' });
  G('init', '-q', '-b', 'main');
  G('add', '-A');
  G('commit', '-qm', 'the fixture library');
  G('remote', 'add', 'origin', remote);
  G('push', '-q', '-u', 'origin', 'main');
  return { dir, lib, remote, id: entry.id };
}

const fx = fixture();
const { server, port } = await startServer({ libDir: fx.lib, port: 0, quiet: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

console.log(`\n== ${fx.id}, in a library of its own with a bare remote ==`);
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForSelector(`[data-edit="${fx.id}"]`, { timeout: 30000 });
await page.click(`[data-edit="${fx.id}"]`);
await page.waitForTimeout(2000);
ok(!(await page.evaluate(() => document.querySelector('#view-edit').hidden)), 'the editor opened');
ok((await page.textContent('#edSave')) === 'Save & publish', 'the Save button says it will publish');
ok(await page.isChecked('#edPub'), 'and it is on by default');

/* Move the default stand point: click the map to add an alternative, then
   press its "stand" button. That is the edit that used to go nowhere, and it
   lands on an exact spot whatever map the fixture picked. */
await page.click('[data-tool="sites"]');
await page.waitForTimeout(600);
const box = await page.locator('#edCanvas').boundingBox();
const at = (dx, dy) => [box.x + box.width / 2 + dx, box.y + box.height / 2 + dy];
const standText = () => page.evaluate(() => {
  const el = document.querySelector('[data-pick="pilot"] .mono');
  return el ? el.textContent : '?';
});
const was = await standText();
await page.mouse.click(...at(90, 60));
await page.waitForTimeout(500);
ok(!!(await page.$('[data-stand="0"]')), 'clicking the map added an alternative stand point');
await page.click('[data-stand="0"]');
await page.waitForTimeout(500);
const now = await standText();
ok(now !== was, 'and "stand" made it the default', `${was} -> ${now}`);

console.log('\n== Save ==');
const before = git(fx.remote, 'rev-parse', 'main');
await page.click('#edSave');
await page.waitForFunction(() => !document.querySelector('#edSave').disabled, null, { timeout: 90000 });
await page.waitForTimeout(500);
const said = await page.textContent('#toast');
console.log(`  toast: ${said}`);
ok(/Saved/.test(said), 'it saved');
ok(/Published/.test(said), 'and said so');
const after = git(fx.remote, 'rev-parse', 'main');
ok(after !== before, 'the remote moved', `${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
const files = git(fx.remote, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean);
console.log(`  committed: ${files.join(', ')}`);
ok(files.includes(`${fx.id}/map.json`), 'the map document is in it');
ok(files.includes('index.json'), 'and the index');
// scoped: nothing outside this map's folder and the index, because other
// sessions share a real library's working copy
ok(files.every((f) => f === 'index.json' || f.startsWith(`${fx.id}/`)), 'and nothing else', files.join(', '));
ok(git(fx.lib, 'status', '--porcelain') === '', 'the working copy is clean afterwards');

console.log('\n== with the box unticked ==');
await page.uncheck('#edPub');
ok((await page.textContent('#edSave')) === 'Save', 'the button goes back to plain Save');
await page.mouse.click(...at(-60, -40));
await page.waitForTimeout(500);
await page.click('#edSave');
await page.waitForFunction(() => !document.querySelector('#edSave').disabled, null, { timeout: 90000 });
await page.waitForTimeout(500);
const said2 = await page.textContent('#toast');
console.log(`  toast: ${said2}`);
ok(/Saved/.test(said2) && !/Publish/i.test(said2), 'it saved and said nothing about publishing', said2);
ok(git(fx.remote, 'rev-parse', 'main') === after, 'the remote did not move');
ok(git(fx.lib, 'status', '--porcelain') !== '', 'and the edit is in the working copy', git(fx.lib, 'status', '--porcelain').split('\n').join(', '));

ok(errs.length === 0, 'no page errors throughout', errs.join(' | ') || 'none');

await browser.close();
server.close();
fs.rmSync(fx.dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
