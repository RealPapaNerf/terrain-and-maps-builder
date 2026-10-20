// The GUI server, end to end over real HTTP against a temp library:
// create a blank map, read it back, sculpt its heights, save flying bits,
// and check the datum rule — fieldElevM and datumElevM follow the ground
// under the pilot through every save, because that is the invariant that
// has cost two altimeter bugs already.
//
// Run: node test/server.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { readMap } from '../lib/maps.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flmap-serve-'));
const LIB = path.join(TMP, 'library');
fs.mkdirSync(LIB);

let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) { pass++; console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); } else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, `${what} within ${tol}`, `${(+a).toFixed(3)} vs ${(+b).toFixed(3)}`);

const git = (...a) => execFileSync('git', a, { cwd: LIB, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const { server, port } = await startServer({ libDir: LIB, port: 0, quiet: true });
const base = `http://127.0.0.1:${port}`;
const J = async (p, opts) => {
  const r = await fetch(base + p, opts);
  const j = await r.json();
  return { status: r.status, j };
};

/* ------------------------------------------------------- a blank map */
console.log('== /api/new: a blank synthetic map ==');
{
  const { status, j } = await J('/api/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'test-ridge', name: 'Test ridge', preset: 'ridge', sizeM: 512, cellM: 2, baseElevM: 1400, amplitudeM: 30 }),
  });
  ok(status === 200, 'created', JSON.stringify(j).slice(0, 80));
  ok(j.cols === 257 && j.rows === 257, '512 m at 2 m is 257 posts a side', `${j.cols}x${j.rows}`);
  const m = readMap(path.join(LIB, 'test-ridge'));
  ok(m.problems.length === 0, 'reads back clean', m.problems.join('; '));
  ok(m.max - m.min > 50, 'the ridge preset actually has a ridge', `${(m.max - m.min).toFixed(1)} m of relief`);
  near(m.json.fieldElevM, m.json.origin.datumElevM, 0.01, 'field and datum agree at birth');
}

{
  const { j } = await J('/api/library');
  ok(j.maps.length === 1 && j.maps[0].id === 'test-ridge', 'the library lists it', j.maps.map((m) => m.id).join(','));
  ok(Array.isArray(j.surfaceNames) && j.surfaceNames[3] === 'water', 'surface names ride along');
}

{
  const r = await fetch(`${base}/library/test-ridge/map.json`);
  ok(r.status === 200, 'the library files are served');
  ok(r.headers.get('access-control-allow-origin') === '*', 'with CORS, so the sim on another port can read them');
  const rIdx = await fetch(`${base}/library/`);
  const idx = await rIdx.json();
  ok(idx.format === 'flightline-maps/1', '/library/ serves the index itself', idx.format);
}

{
  const { status } = await J('/api/map/no-such-map');
  ok(status === 404, 'a missing map 404s');
  const bad = await J('/api/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '../evil', sizeM: 512 }),
  });
  ok(bad.status === 400, 'a path-traversal id is refused', bad.j.error);
}

/* ----------------------------------------- sculpt heights, datum rule */
console.log('\n== PUT heights: sculpting re-encodes, and the datum follows the ground ==');
{
  const dir = path.join(LIB, 'test-ridge');
  const before = readMap(dir);
  const g = before.json.grid;
  const elev = new Float32Array(g.cols * g.rows);
  for (let i = 0; i < elev.length; i++) elev[i] = before.raw[i] * g.heights.scale + g.heights.offset;
  // raise a 5 m knoll under the pilot (grid centre)
  const cc = (g.cols - 1) / 2, cr = (g.rows - 1) / 2;
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const d = Math.hypot(c - cc, r - cr) * g.cell;
    if (d < 40) elev[r * g.cols + c] += 5 * (1 - d / 40);
  }
  const put = await fetch(`${base}/api/map/test-ridge/heights`, { method: 'PUT', body: Buffer.from(elev.buffer) });
  const pj = await put.json();
  ok(put.status === 200, 'heights accepted', JSON.stringify(pj).slice(0, 100));
  const after = readMap(dir);
  ok(after.problems.length === 0, 'still reads back clean', after.problems.join('; '));
  near(after.json.fieldElevM, before.json.fieldElevM + 5, 0.1, 'fieldElevM rose with the knoll under the pilot');
  near(after.json.origin.datumElevM, after.json.fieldElevM, 0.01, 'datum moved with it (the altimeter reads zero at your feet)');

  const wrong = await fetch(`${base}/api/map/test-ridge/heights`, { method: 'PUT', body: Buffer.from(new Float32Array(10).buffer) });
  ok(wrong.status === 400, 'a wrong-sized heightfield is refused');
}

/* --------------------------------------------- the flying bits + datum */
console.log('\n== POST meta: pilot move carries the datum; pads, sites, obstacles land ==');
{
  const dir = path.join(LIB, 'test-ridge');
  const { j } = await J('/api/map/test-ridge');
  const body = {
    ...{ name: j.name, region: 'Test bench' },
    pilot: { n: 100, e: 50 }, home: { n: 100, e: 50 },
    sites: [{ id: 'knoll', name: 'The knoll', n: 0, e: 0 }],
    starts: j.starts,
    pads: [{ kind: 'runway', n: 90, e: 50, yawDeg: 90, lengthM: 80, widthM: 8, surface: 'dirt' }],
    obstacles: [
      { t: 'tree', n: 20, e: -30, r: 2.5, h: 9 },
      { t: 'building', n: -40, e: 60, sizeN: 8, sizeE: 6, h: 3.2, roof: 'gable' },
      { t: 'wire', a: { n: 0, e: -100, up: 9 }, b: { n: 0, e: -40, up: 9 }, r: 0.02, sagM: 1 },
    ],
    gates: [],
  };
  const { status, j: resp } = await J('/api/map/test-ridge/meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  ok(status === 200, 'meta saved', JSON.stringify(resp.datum));
  ok(resp.problems.length === 0, 'and the map checks clean after it', resp.problems.join('; '));
  const m = readMap(dir);
  near(m.json.fieldElevM, resp.datum.ground, 0.01, 'fieldElevM is the ground under the NEW pilot spot');
  near(m.json.origin.datumElevM, m.json.fieldElevM, 0.01, 'datum agrees');
  ok(m.json.pads.length === 1 && m.json.obstacles.length === 3 && m.json.sites.length === 1,
    'pads, obstacles and sites all landed', `${m.json.pads.length}/${m.json.obstacles.length}/${m.json.sites.length}`);
  ok(m.json.region === 'Test bench', 'region landed');
  // the knoll is at (0,0); the pilot moved 100 m north of it, so field < peak
  ok(m.json.fieldElevM < readMap(dir).max, 'sanity: field is below the peak');
}

/* ------------------------------------------------------------ surface */
console.log('\n== PUT surface ==');
{
  const dir = path.join(LIB, 'test-ridge');
  const m = readMap(dir);
  const g = m.json.grid;
  const surf = new Uint8Array(g.cols * g.rows).fill(1); // all grass
  surf.fill(3, 0, g.cols * 5); // a northern strip of water
  const r = await fetch(`${base}/api/map/test-ridge/surface`, { method: 'PUT', body: Buffer.from(surf.buffer) });
  ok(r.status === 200, 'surface accepted');
  const after = readMap(dir);
  ok(after.classes && after.classes[0] === 3 && after.classes[after.classes.length - 1] === 1,
    'surface.u8 holds what was sent', `${after.classes && after.classes[0]}, ${after.classes && after.classes[after.classes.length - 1]}`);
  const badCls = new Uint8Array(g.cols * g.rows).fill(99);
  const rb = await fetch(`${base}/api/map/test-ridge/surface`, { method: 'PUT', body: Buffer.from(badCls.buffer) });
  ok(rb.status === 400, 'an undefined class is refused');
}

/* ------------------------------------------------------------ propose */
console.log('\n== GET propose ==');
{
  const { status, j } = await J('/api/map/test-ridge/propose?count=4&sky=20&apart=100');
  ok(status === 200 && Array.isArray(j.sites), 'proposals come back', `${j.sites.length} of ${j.total} candidates`);
}

/* ------------------------------------------------------------ publish */
console.log('\n== publish: scoped add, commit, no push ==');
{
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  // dirty the map again so there is something to commit
  const { j: mj } = await J('/api/map/test-ridge');
  await J('/api/map/test-ridge/meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test ridge, renamed', pilot: mj.pilot, starts: mj.starts, obstacles: mj.obstacles, gates: [] }),
  });
  // and drop an unrelated dirty file that a scoped publish must NOT commit
  fs.writeFileSync(path.join(LIB, 'unrelated.txt'), 'someone else was here\n');
  const { status, j } = await J('/api/publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['test-ridge'], message: 'test commit', push: false }),
  });
  ok(status === 200 && j.committed, 'committed', JSON.stringify(j).slice(0, 80));
  const shown = git('show', '--name-only', '--format=%s', 'HEAD');
  ok(shown.includes('test commit'), 'with the message given');
  ok(shown.includes('test-ridge/map.json') && shown.includes('index.json'), 'the map and the index are in it');
  ok(!shown.includes('unrelated.txt'), 'the unrelated dirty file was left alone');
  const st = git('status', '--porcelain');
  ok(st.includes('unrelated.txt'), 'and is still dirty in the tree');
}

/* ------------------------------------------------------------- delete */
console.log('\n== delete ==');
{
  await J('/api/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'doomed', sizeM: 256, cellM: 2 }),
  });
  const { status } = await J('/api/map/doomed/delete', { method: 'POST' });
  ok(status === 200, 'deleted');
  ok(!fs.existsSync(path.join(LIB, 'doomed')), 'the folder is gone');
  const { j } = await J('/api/library');
  ok(!j.maps.some((m) => m.id === 'doomed'), 'and the index no longer lists it');
}

server.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
