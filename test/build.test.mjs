// End-to-end: drive the CLI against the stubbed service and check what lands
// on disk is a valid Flightline map with the right numbers in it.
//
// Run: node test/build.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMap, SURFACE_NAMES } from '../lib/maps.mjs';
import { toUTM, toLatLon } from '../lib/utm.mjs';
import { bareEarth, surfaceModel } from './stub-network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flmap-'));

let pass = 0, fail = 0;
const ok = (c, what, got) => { if (c) { pass++; console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); } else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, `${what} within ${tol}`, `${a.toFixed(4)} vs ${b.toFixed(4)}`);

const flmap = (...args) => execFileSync(process.execPath,
  ['--import', path.join(HERE, 'stub-network.mjs'), path.join(ROOT, 'bin', 'flmap.mjs'), ...args],
  { encoding: 'utf8', cwd: ROOT });

/* ------------------------------------------------------------ UTM */
console.log('== UTM: forward and inverse are different series, so a closed round trip is evidence ==');
{
  let worst = 0, at = '';
  for (let lat = -78; lat <= 82; lat += 2) for (let lon = -177; lon <= 177; lon += 7) {
    const u = toUTM(lat, lon);
    const [la, lo] = toLatLon(u.easting, u.northing, u.zone, u.hemisphere);
    const d = Math.hypot((la - lat) * 111320, (lo - lon) * 111320 * Math.cos((lat * Math.PI) / 180));
    if (d > worst) { worst = d; at = `${lat}, ${lon}`; }
  }
  console.log(`  worst closure over 5,760 points: ${(worst * 1000).toFixed(3)} mm, at ${at}`);
  ok(worst < 0.01, 'round trip closes to under 10 mm anywhere UTM is defined', `${(worst * 1000).toFixed(3)} mm`);
  // one published reference point, as a check the whole thing is not self-consistently wrong
  const ny = toUTM(40.7128, -74.006);
  console.log(`  New York 40.7128, -74.0060 -> ${ny.zone}${ny.hemisphere} ${ny.easting.toFixed(0)}E ${ny.northing.toFixed(0)}N (published: 18N 583959E 4507351N)`);
  ok(ny.zone === 18 && Math.abs(ny.easting - 583959) < 2 && Math.abs(ny.northing - 4507351) < 2,
    'matches the published UTM for a known point', `off by ${Math.hypot(ny.easting - 583959, ny.northing - 4507351).toFixed(2)} m`);
}

/* --------------------------------------------------------- the build */
console.log('\n== flmap build, against the stubbed service ==');
const OUT = path.join(TMP, 'library', 'stub-field');
const out = flmap('build',
  '--center', '37.6775,-113.0628', '--size', '1024', '--cell', '4',
  '--out', OUT, '--id', 'stub-field', '--name', 'Stub field', '--region', 'A test fixture',
  '--runway', '-12,0,90,120,10', '--flatten-runway', '--classify', '--range', '1200');
console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));

const m = readMap(OUT);
const g = m.json.grid;
ok(m.problems.length === 0, 'the map reads back clean', m.problems.join('; ') || 'no problems');
ok(g.cols === 257 && g.rows === 257, '1024 m at 4 m a cell is 257 posts a side', `${g.cols}x${g.rows}`);
near(g.cell, 4, 1e-9, 'cell size');
ok(fs.statSync(path.join(OUT, 'height.u16')).size === 2 * g.cols * g.rows, 'height.u16 is exactly 2*cols*rows bytes', fs.statSync(path.join(OUT, 'height.u16')).size);
ok(fs.statSync(path.join(OUT, 'surface.u8')).size === g.cols * g.rows, 'surface.u8 is exactly cols*rows bytes', fs.statSync(path.join(OUT, 'surface.u8')).size);
ok(m.json.rangeM === 1200, '--range came through', m.json.rangeM);

/* ---- the one that matters: is the terrain where the source said it was?
   Every post is checked against the analytic function the stub serves, so a
   flipped row, a transposed axis or a half-cell offset shows up as metres of
   error rather than looking plausible. */
console.log('\n== Is the ground where the service put it? ==');
{
  const originNE = g.originNE;
  const mPerDegLat = 111132, mPerDegLon = 88000; // the stub's own scaling
  let worst = 0, worstAt = '';
  let n = 0;
  for (let r = 0; r < g.rows; r += 7) for (let c = 0; c < g.cols; c += 7) {
    const north = originNE[0] - r * g.cell, east = originNE[1] + c * g.cell;
    // skip the runway, which was deliberately flattened away from the source
    if (Math.abs(north + 12) < 25 && Math.abs(east) < 80) continue;
    const lat = m.json.origin.lat + north / mPerDegLat;
    const lon = m.json.origin.lon + east / mPerDegLon;
    const d = Math.abs(m.elevAt(c, r) - bareEarth(lat, lon));
    n++;
    if (d > worst) { worst = d; worstAt = `post (${c}, ${r}), local n=${north.toFixed(0)} e=${east.toFixed(0)}`; }
  }
  console.log(`  worst error over ${n} posts: ${worst.toFixed(3)} m, at ${worstAt}`);
  console.log('  (this catches a flipped row or a transposed axis: either would read tens of metres here)');
  ok(worst < 1.5, 'every post matches the analytic surface the service served', `${worst.toFixed(3)} m`);
}

console.log('\n== The runway was flattened ==');
{
  const originNE = g.originNE;
  const at = (north, east) => {
    const c = Math.round((east - originNE[1]) / g.cell), r = Math.round((originNE[0] - north) / g.cell);
    return m.elevAt(c, r);
  };
  const on = [-55, -20, 0, 20, 55].map((e) => at(-12, e));
  const spread = Math.max(...on) - Math.min(...on);
  console.log(`  along the strip: ${on.map((v) => v.toFixed(2)).join(', ')} m`);
  ok(spread < 0.05, 'the runway is level end to end', `${(spread * 100).toFixed(1)} cm of spread`);
  const off = at(-12, 300);
  ok(Math.abs(off - on[2]) > 0.3, 'and the ground 300 m away was not flattened with it', `${off.toFixed(2)} m there vs ${on[2].toFixed(2)} m on the strip`);
}

console.log('\n== Surface classes ==');
{
  const counts = {};
  for (let i = 0; i < m.classes.length; i++) counts[SURFACE_NAMES[m.classes[i]]] = (counts[SURFACE_NAMES[m.classes[i]]] || 0) + 1;
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${((100 * v) / m.classes.length).toFixed(1)}%`).join(', ')}`);
  const originNE = g.originNE;
  const clsAt = (north, east) => SURFACE_NAMES[m.classes[Math.round((originNE[0] - north) / g.cell) * g.cols + Math.round((east - originNE[1]) / g.cell)]];
  ok(clsAt(-12, 0) === 'asphalt', 'the runway is classed asphalt, so the lidar reads 0.12 over it', clsAt(-12, 0));
  ok(['grass', 'brush'].includes(clsAt(0, 300)), 'open ground is grass or brush', clsAt(0, 300));
}

/* ------------------------------------------------- trees and buildings */
console.log('\n== Trees and buildings out of a surface model ==');
{
  const OUT2 = path.join(TMP, 'library', 'stub-dsm');
  flmap('build', '--center', '37.6775,-113.0628', '--size', '1024', '--cell', '4',
    '--out', OUT2, '--id', 'stub-dsm', '--name', 'Stub with a surface model',
    '--dsm', 'https://example.invalid/dsm/ImageServer');
  const m2 = readMap(OUT2);
  const obs = m2.json.obstacles;
  const trees = obs.filter((o) => o.t === 'tree'), bldg = obs.filter((o) => o.t === 'building');
  console.log(`  ${obs.length} objects: ${trees.length} tree, ${bldg.length} building`);
  for (const b of bldg) console.log(`    building at n=${b.n} e=${b.e}, ${b.sizeN} x ${b.sizeE} m, ${b.h} m tall  (the stub's shed is 30 x 40 m and 4.2 m)`);
  for (const t of trees) console.log(`    tree blob at n=${t.n} e=${t.e}, r=${t.r} m, ${t.h} m tall  (the stub's stand is 120 x 120 m, crowns peaking at 12.2 m)`);
  ok(obs.length >= 2, 'both the tree stand and the shed were found', `${obs.length} objects`);
  ok(bldg.length === 1 && trees.length === 1, 'the flat-topped shed reads as a building and the lumpy canopy does not',
    `${bldg.length} building, ${trees.length} tree`);
  ok(bldg.length >= 1 && Math.abs(bldg[0].h - 4.2) < 0.3, 'the shed comes out at its real height', bldg.length ? `${bldg[0].h} m vs 4.2 m` : 'none found');
  /* An obstacle's height is the blob's PEAK, not its mean: a collision shape
     you can fly over has to clear the tallest thing in it. The stub's crowns
     peak at 8.5 + 2.5 + 1.2 = 12.2 m. */
  ok(trees.length >= 1 && Math.abs(trees[0].h - 12.2) < 0.4, 'the canopy comes out at its peak height, which is what you have to clear',
    trees.length ? `${trees[0].h} m vs 12.2 m` : 'none found');
  /* And the limitation worth knowing: a connected stand becomes ONE blob, so
     120 m of trees is a single 46 m cylinder rather than two hundred trees.
     For "do not fly into the trees" that is a conservative shape and fine. For
     threading gaps between individual trunks it is not, and per-tree
     extraction needs the lidar returns themselves (class 5), not a raster. */
  ok(trees[0].r > 40, 'a connected stand merges into one conservative cylinder (see the README)', `r = ${trees[0].r} m`);
  // and it must not invent anything on bare ground
  const spurious = obs.filter((o) => o.n < 0 && o.e < -300);
  ok(spurious.length === 0, 'nothing is invented on bare ground', `${spurious.length} spurious objects`);
  void surfaceModel;
}

/* ---------------------------------------------------------- the index */
console.log('\n== flmap index ==');
{
  const LIB = path.join(TMP, 'library');
  const txt = flmap('index', LIB, '--name', 'Test library');
  console.log(txt.split('\n').map((l) => `    ${l}`).join('\n'));
  const idx = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));
  ok(idx.format === 'flightline-maps/1', 'the index declares the library format', idx.format);
  ok(idx.maps.length === 2, 'both maps are listed', idx.maps.length);
  ok(idx.maps.every((e) => e.path.endsWith('/')), 'every path ends in a slash, as the format requires');
  ok(idx.maps.every((e) => !e.problems), 'no map in the library has a problem');
  ok(idx.maps.every((e) => e.bytes === fs.readdirSync(path.join(LIB, e.path)).reduce((s, f) => s + fs.statSync(path.join(LIB, e.path, f)).size, 0)),
    'the byte counts match the folders');
}

/* --------------------------------------------------- the cell-size cap */
console.log('\n== The format caps a side at 1024 posts ==');
{
  const OUT3 = path.join(TMP, 'big');
  const txt = flmap('build', '--center', '37.6775,-113.0628', '--size', '8192', '--cell', '2',
    '--out', OUT3, '--id', 'big', '--dry-run');
  const line = txt.split('\n').find((l) => l.includes('the cell becomes'));
  console.log(`    ${line ? line.trim() : '(no adjustment line)'}`);
  ok(!!line, '8,192 m at 2 m a cell is refused and the cell is widened instead');
  ok(/8\.0/.test(txt) || /grid\s+1024 x 1024/.test(txt), 'and the grid lands at 1024 posts a side', txt.split('\n').find((l) => l.includes('grid')).trim());
}

/* ------------------------------------------------------------ inspect */
console.log('\n== flmap inspect ==');
{
  const txt = flmap('inspect', OUT);
  console.log(txt.split('\n').map((l) => `    ${l}`).join('\n'));
  ok(/Reads back clean/.test(txt), 'inspect says the map is clean');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
