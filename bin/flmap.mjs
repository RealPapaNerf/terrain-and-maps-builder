#!/usr/bin/env node
// flmap — build Flightline map folders from public elevation data.
//
//   flmap probe                         check every service, from this machine
//   flmap build --center LAT,LON ...    fetch a map and write the folder
//   flmap from-grid FILE.json ...       build from elevations you already have
//   flmap arena FILE.json --out LIB     file a Frag Zone arena into a library
//   flmap inspect DIR                   read a map back and check it
//   flmap index DIR                     rebuild a library's index.json
//
// No dependencies. The elevation layer is relief's, copied into lib/.

import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_PRESETS, findSource, normalizeSource, fetchSourceTerrain, probeSource, gridForSource } from '../lib/sources.mjs';
import { makeProjector, metersPerDegree } from '../lib/geo.mjs';
import { writeMap, readMap, readArena, writeArena, mapKind, writeIndex, fromSouthUpGrid, SURFACE_NAMES, MAX_SIDE } from '../lib/maps.mjs';
import { classify, tally, obstaclesFromSurface } from '../lib/classify.mjs';
import { IMAGERY_PRESETS, findImagery, fetchImagery, imagerySize } from '../lib/imagery.mjs';
import { toUTM, formatUTM } from '../lib/utm.mjs';

const say = (...a) => console.log(...a);
const die = (m) => { console.error(`flmap: ${m}`); process.exit(1); };

/* ----------------------------------------------------------- arguments */
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
      else o[a.slice(2)] = true;
    } else o._.push(a);
  }
  return o;
}
const num = (v, d) => (v == null || v === true ? d : Number(v));
const pair = (v, what) => {
  if (!v || v === true) return null;
  const p = String(v).split(',').map(Number);
  if (p.length !== 2 || p.some((x) => !Number.isFinite(x))) die(`${what} wants two numbers, like 37.6,-113.1 — got "${v}"`);
  return p;
};

const HELP = `flmap — Flightline map builder

  flmap probe [--center LAT,LON]
      Reach every service this tool uses and say what came back. Run this
      first: nothing else here is trustworthy until it passes.

  flmap build --center LAT,LON --out DIR [options]
  flmap build --bbox W,S,E,N --out DIR [options]
      Fetch elevation and write a map folder.

      --size M          ground covered, metres square          (default 2048)
      --cell M          metres per cell                        (default 4)
      --source ID|URL   usgs-3dep | open-meteo | an ImageServer URL
      --id, --name, --region, --author, --license
      --pilot N,E       where you stand, local metres          (default 0,0)
      --home N,E        autopilot home                         (default: pilot)
      --runway N,E,YAW,LEN,WID    a runway rectangle
      --flatten-runway  level the heightfield under the runway
      --field-elev M    overrides the elevation at the pilot spot
      --datum M         elevation of local NED z = 0           (default: field)
      --range M         how far out before a reset             (default 1500)
      --classify        write a surface grid (a HEURISTIC — see the README)
      --snow-above M    snow line, for --classify
      --water-below M   water level, for --classify
      --color [ID]      drape an orthophoto (naip | naip-plus)
      --color-px N      image size per side, a power of two    (default: auto)
      --dsm URL         a first-return surface service; trees and buildings
                        are taken from where it stands above the bare earth
      --obstacles FILE  merge an obstacle array from a JSON file
      --dry-run         work it all out and print, write nothing

  flmap from-grid FILE.json --out DIR [options]
      Build from elevations you already have. The file is
      { cols, rows, cell, lat, lon, elev: [...] }, north-up, metres above sea
      level — which is the escape hatch for a GeoTIFF or LAZ tile you have
      converted yourself with GDAL or PDAL.

  flmap arena FILE.json --out LIB [options]
      File a Frag Zone arena into a map library. FILE.json is what the
      arena editor's Save button hands you; it lands at LIB/<id>/map.json.

      --id, --name, --region, --author, --license   override the document
      --force           file it even though it has problems

  flmap inspect DIR
      Read a map back and check it against itself.

  flmap index DIR [--name NAME]
      Rebuild index.json across every map folder under DIR.
`;

/* --------------------------------------------------------------- probe */
async function cmdProbe(o) {
  const [lat, lon] = pair(o.center, '--center') || [37.6775, -113.0628];
  const sizeM = num(o.size, 1000);
  const projector = makeProjector(lat, lon);
  say(`Probing from this machine, at ${lat}, ${lon}.\n`);

  let bad = 0;
  say('Elevation services');
  for (const src of SOURCE_PRESETS) {
    if (src.kind !== 'elevation') continue;
    const r = await probeSource(src, projector, sizeM);
    if (!r.ok) bad++;
    say(`  ${r.ok ? 'OK  ' : 'FAIL'} ${src.label.padEnd(34)} ${r.ms} ms  ${r.message}`);
  }
  if (o.source && !findSource(String(o.source))) {
    const custom = normalizeSource({ url: String(o.source), label: String(o.source) });
    const r = await probeSource(custom, projector, sizeM);
    if (!r.ok) bad++;
    say(`  ${r.ok ? 'OK  ' : 'FAIL'} ${custom.label.slice(0, 34).padEnd(34)} ${r.ms} ms  ${r.message}`);
  }

  say('\nImagery services  (none of these is verified — this is the check)');
  const box = bboxOf(projector, sizeM);
  for (const svc of IMAGERY_PRESETS) {
    const t0 = Date.now();
    try {
      const got = await fetchImagery(svc, box, 256);
      say(`  OK   ${svc.label.padEnd(44)} ${Date.now() - t0} ms  ${got.buf.length} bytes of ${got.file.endsWith('jpg') ? 'JPEG' : 'PNG'}`);
    } catch (e) {
      bad++;
      say(`  FAIL ${svc.label.padEnd(44)} ${Date.now() - t0} ms  ${e.message}`);
    }
  }

  say(`\n${bad === 0 ? 'Everything answered.' : `${bad} service${bad === 1 ? '' : 's'} did not answer.`}`);
  say('If a service is unreachable it is usually the network between you and it,');
  say('not the URL: a corporate proxy, or a sandbox with an allow-list.');
  process.exit(bad === 0 ? 0 : 1);
}

const bboxOf = (projector, sizeM) => {
  const half = sizeM / 2;
  const [south, west] = projector.inverse(-half, -half);
  const [north, east] = projector.inverse(half, half);
  return { west, south, east, north };
};

/* --------------------------------------------------------------- build */
async function cmdBuild(o) {
  const out = o.out && o.out !== true ? String(o.out) : die('--out is required');
  let lat, lon, sizeM;
  const bbox = o.bbox && o.bbox !== true ? String(o.bbox).split(',').map(Number) : null;
  if (bbox) {
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) die('--bbox wants W,S,E,N');
    const [w, s, e, n] = bbox;
    lat = (s + n) / 2; lon = (w + e) / 2;
    const m = metersPerDegree(lat);
    sizeM = Math.max((e - w) * m.lon, (n - s) * m.lat);
    say(`--bbox covers ${((e - w) * m.lon).toFixed(0)} x ${((n - s) * m.lat).toFixed(0)} m; squaring it to ${sizeM.toFixed(0)} m.`);
  } else {
    const c = pair(o.center, '--center') || die('--center LAT,LON or --bbox W,S,E,N is required');
    [lat, lon] = c;
    sizeM = num(o.size, 2048);
  }

  let cell = num(o.cell, 4);
  let posts = Math.round(sizeM / cell) + 1;
  if (posts > MAX_SIDE) {
    const wanted = cell;
    cell = sizeM / (MAX_SIDE - 1);
    posts = MAX_SIDE;
    say(`${sizeM} m at ${wanted} m a cell would need ${Math.round(sizeM / wanted) + 1} posts a side; the format allows ${MAX_SIDE}, so the cell becomes ${cell.toFixed(3)} m.`);
  }
  const span = (posts - 1) * cell;

  const srcId = o.source && o.source !== true ? String(o.source) : 'usgs-3dep';
  const source = /^https?:/i.test(srcId) ? normalizeSource({ url: srcId, label: srcId }) : findSource(srcId);
  const projector = makeProjector(lat, lon);
  const plan = gridForSource(source, span, cell);

  say(`\n${o.name || o.id || path.basename(out)}`);
  say(`  centre        ${lat}, ${lon}   ${formatUTM(toUTM(lat, lon))}`);
  say(`  ground        ${(span / 1000).toFixed(3)} km square`);
  say(`  grid          ${posts} x ${posts} posts at ${cell.toFixed(3)} m`);
  say(`  source        ${source.label}, which resolves ${source.resolutionM} m`);
  if (plan.oversampled) say(`  NOTE          ${cell.toFixed(2)} m cells are finer than the ${source.resolutionM} m the data holds; the extra posts smooth it, they do not add detail.`);
  say(`  heightfield   ${((2 * posts * posts) / 1024).toFixed(0)} KB`);
  if (o.dryRun || o['dry-run']) { say('\n--dry-run: nothing written.'); return; }

  say('\nFetching elevation…');
  const t0 = Date.now();
  const terrain = await fetchSourceTerrain(source, projector, span, {
    targetResM: cell,
    onProgress: (m) => say(`  ${m}`),
  });
  say(`  got ${terrain.n} x ${terrain.n} samples in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
    (terrain.filled ? `, ${terrain.filled} no-data cell${terrain.filled === 1 ? '' : 's'} filled from their neighbours` : ''));
  if (terrain.n !== posts) {
    say(`  the service capped the grid at ${terrain.n} posts, so the cell becomes ${(span / (terrain.n - 1)).toFixed(3)} m`);
    posts = terrain.n;
    cell = span / (posts - 1);
  }

  // relief's grids run south to north; the map format is north-up
  const elevM = fromSouthUpGrid(terrain.values, posts, posts);
  const originNE = [((posts - 1) * cell) / 2, -((posts - 1) * cell) / 2];

  // --- pads
  const pads = [];
  if (o.runway && o.runway !== true) {
    const p = String(o.runway).split(',').map(Number);
    if (p.length !== 5 || p.some((v) => !Number.isFinite(v))) die('--runway wants N,E,YAW,LENGTH,WIDTH');
    pads.push({ kind: 'runway', n: p[0], e: p[1], yawDeg: p[2], lengthM: p[3], widthM: p[4], surface: 'asphalt' });
  }
  const pilot = (() => { const p = pair(o.pilot, '--pilot'); return p ? { n: p[0], e: p[1] } : { n: 0, e: 0 }; })();
  const home = (() => { const p = pair(o.home, '--home'); return p ? { n: p[0], e: p[1] } : { ...pilot }; })();

  const atLocal = (n, e) => {
    const c = Math.max(0, Math.min(posts - 1, Math.round((e - originNE[1]) / cell)));
    const r = Math.max(0, Math.min(posts - 1, Math.round((originNE[0] - n) / cell)));
    return elevM[r * posts + c];
  };

  if ((o.flattenRunway || o['flatten-runway']) && pads.length) {
    for (const pad of pads) {
      const level = atLocal(pad.n, pad.e);
      const cs = Math.cos((pad.yawDeg * Math.PI) / 180), sn = Math.sin((pad.yawDeg * Math.PI) / 180);
      let moved = 0, worst = 0;
      for (let r = 0; r < posts; r++) for (let c = 0; c < posts; c++) {
        const n = originNE[0] - r * cell, e = originNE[1] + c * cell;
        const dn = n - pad.n, de = e - pad.e;
        const along = Math.abs(dn * cs + de * sn), across = Math.abs(-dn * sn + de * cs);
        // full inside the rectangle, feathered out over 15 m so there is no step
        const k = Math.max(0, Math.min(1,
          Math.min(1 - (along - pad.lengthM / 2) / 15, 1 - (across - pad.widthM / 2) / 15)));
        if (k <= 0) continue;
        const i = r * posts + c, before = elevM[i];
        elevM[i] = before * (1 - k) + level * k;
        if (k > 0.99) { moved++; worst = Math.max(worst, Math.abs(elevM[i] - before)); }
      }
      say(`  flattened the runway to ${level.toFixed(2)} m: ${moved} posts, moving the ground by up to ${worst.toFixed(2)} m`);
    }
  }

  const fieldElevM = o['field-elev'] != null ? num(o['field-elev']) : atLocal(pilot.n, pilot.e);
  const datumElevM = o.datum != null ? num(o.datum) : fieldElevM;

  // --- obstacles
  let obstacles = [];
  if (o.obstacles && o.obstacles !== true) {
    const extra = JSON.parse(fs.readFileSync(String(o.obstacles), 'utf8'));
    obstacles = obstacles.concat(Array.isArray(extra) ? extra : extra.obstacles || []);
    say(`  ${obstacles.length} obstacles read from ${o.obstacles}`);
  }
  if (o.dsm && o.dsm !== true) {
    say('\nFetching the surface model, for trees and buildings…');
    const dsmSrc = normalizeSource({ url: String(o.dsm), label: 'surface model', resolutionM: source.resolutionM });
    const dsmT = await fetchSourceTerrain(dsmSrc, projector, span, { targetResM: cell, onProgress: (m) => say(`  ${m}`) });
    if (dsmT.n !== posts) die(`the surface model came back ${dsmT.n} posts a side, the terrain ${posts}; they must match`);
    const dsm = fromSouthUpGrid(dsmT.values, posts, posts);
    const found = obstaclesFromSurface(elevM, dsm, posts, posts, cell, { originNE });
    const trees = found.filter((x) => x.t === 'tree').length;
    say(`  ${found.length} objects stand above the bare earth: ${trees} read as trees, ${found.length - trees} as buildings`);
    obstacles = obstacles.concat(found);
  }

  // --- surface classes
  let classes = null;
  if (o.classify) {
    classes = classify(elevM, posts, posts, cell, {
      originNE, pads,
      snowAboveM: o['snow-above'] != null ? num(o['snow-above']) : null,
      waterBelowM: o['water-below'] != null ? num(o['water-below']) : null,
    });
    say('\nSurface classes (a HEURISTIC from the shape of the ground, not a landcover product):');
    for (const row of tally(classes, SURFACE_NAMES)) say(`  ${row.name.padEnd(9)} ${row.pct.toFixed(1)}%`);
  }

  // --- imagery
  let colorFile = null;
  fs.mkdirSync(out, { recursive: true });
  if (o.color) {
    const id = o.color === true ? 'naip' : String(o.color);
    const svc = findImagery(id) || { id, label: id, url: id, attribution: '', resolutionM: 1, verified: false };
    const px = o['color-px'] ? num(o['color-px']) : imagerySize(span, svc.resolutionM);
    say(`\nFetching imagery: ${svc.label} at ${px} x ${px} (${(span / px).toFixed(2)} m a pixel)…`);
    try {
      const img = await fetchImagery(svc, bboxOf(projector, span), px);
      fs.writeFileSync(path.join(out, img.file), img.buf);
      colorFile = img.file;
      say(`  wrote ${img.file}, ${(img.buf.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      say(`  FAILED: ${e.message}`);
      say('  Carrying on without imagery. The terrain is coloured by surface class and slope instead.');
      say('  Run `flmap probe` to see whether the imagery service is reachable at all from here.');
    }
  }

  const id = o.id && o.id !== true ? String(o.id) : path.basename(out);
  const attribution = o.attribution && o.attribution !== true ? String(o.attribution)
    : [source.attribution, colorFile ? (findImagery(o.color === true ? 'naip' : String(o.color)) || {}).attribution : null].filter(Boolean).join('. ');

  const res = writeMap({
    dir: out, id,
    name: o.name && o.name !== true ? String(o.name) : id,
    region: o.region && o.region !== true ? String(o.region) : undefined,
    author: o.author && o.author !== true ? String(o.author) : undefined,
    license: o.license && o.license !== true ? String(o.license) : 'CC0-1.0',
    attribution,
    builder: 'flightline-map-builder 0.1.0',
    elevM, cols: posts, rows: posts, cell, originNE,
    lat, lon, fieldElevM, datumElevM,
    rangeM: o.range != null ? num(o.range) : undefined,
    pilot, home, pads, classes, colorFile,
    obstacles,
    starts: [
      { id: 'pad', name: 'On the pad', n: pilot.n + 8, e: pilot.e + 1.5, yawDeg: 0, aglM: 0 },
      ...(pads.length ? [{ id: 'runway', name: 'On the runway', n: pads[0].n, e: pads[0].e - pads[0].lengthM / 2 + 8, yawDeg: pads[0].yawDeg, aglM: 0 }] : []),
      { id: 'launch', name: 'In your hand', n: pilot.n + 0.6, e: pilot.e + 0.45, yawDeg: 0, aglM: 1.7 },
      { id: 'air', name: 'In the air, 60 m', n: pilot.n - 200, e: pilot.e + 120, yawDeg: 270, aglM: 60, speedMs: 16 },
    ],
  });

  const chk = readMap(out);
  say(`\nWrote ${out}`);
  say(`  elevation     ${res.enc.min.toFixed(1)} to ${res.enc.max.toFixed(1)} m — ${(res.enc.max - res.enc.min).toFixed(1)} m of relief`);
  say(`  height step   ${(res.enc.scale * 1000).toFixed(2)} mm, so at worst ${(res.enc.worstErrorM * 1000).toFixed(2)} mm of quantisation error`);
  say(`  field         ${fieldElevM.toFixed(1)} m  (${(fieldElevM / 0.3048).toFixed(0)} ft) — this is what sets density altitude`);
  say(`  folder        ${(res.bytes / 1024).toFixed(0)} KB`);
  say(`  checks        ${chk.problems.length === 0 ? 'read back clean' : `${chk.problems.length} PROBLEM(S)`}`);
  for (const p of chk.problems) say(`                - ${p}`);
  if (chk.problems.length) process.exitCode = 1;
}

/* ------------------------------------------------------- from a grid */
async function cmdFromGrid(o) {
  const file = o._[1] || die('give the JSON file to read');
  const out = o.out && o.out !== true ? String(o.out) : die('--out is required');
  const g = JSON.parse(fs.readFileSync(String(file), 'utf8'));
  for (const k of ['cols', 'rows', 'cell', 'lat', 'lon', 'elev']) if (g[k] == null) die(`${file} has no "${k}"`);
  const elevM = Float64Array.from(g.elev);
  if (elevM.length !== g.cols * g.rows) die(`"elev" holds ${elevM.length} values, cols*rows is ${g.cols * g.rows}`);
  const pilot = (() => { const p = pair(o.pilot, '--pilot'); return p ? { n: p[0], e: p[1] } : (g.pilot || { n: 0, e: 0 }); })();
  const id = o.id && o.id !== true ? String(o.id) : path.basename(out);
  const res = writeMap({
    dir: out, id, name: o.name && o.name !== true ? String(o.name) : (g.name || id),
    region: g.region, author: o.author && o.author !== true ? String(o.author) : g.author,
    attribution: o.attribution && o.attribution !== true ? String(o.attribution) : g.attribution,
    license: 'CC0-1.0', builder: 'flightline-map-builder 0.1.0',
    elevM, cols: g.cols, rows: g.rows, cell: g.cell, originNE: g.originNE,
    lat: g.lat, lon: g.lon, pilot, home: g.home || pilot,
    pads: g.pads || [], obstacles: g.obstacles || [], gates: g.gates || [],
    starts: g.starts || [{ id: 'pad', name: 'On the pad', n: pilot.n + 8, e: pilot.e + 1.5, aglM: 0 }],
    classes: o.classify ? classify(elevM, g.cols, g.rows, g.cell, { originNE: g.originNE, pads: g.pads || [] }) : null,
  });
  const chk = readMap(out);
  say(`Wrote ${out}: ${g.cols}x${g.rows} at ${g.cell} m, ${(res.enc.max - res.enc.min).toFixed(1)} m of relief, ${(res.bytes / 1024).toFixed(0)} KB`);
  say(`  checks: ${chk.problems.length === 0 ? 'read back clean' : chk.problems.join('; ')}`);
  if (chk.problems.length) process.exitCode = 1;
}

/* ------------------------------------------------------------- inspect */
function cmdInspect(o) {
  const dir = o._[1] || die('give the map folder to inspect');

  // A library holds both terrain and Frag Zone arenas; inspect whichever
  // this folder is rather than failing on a document it was not written for.
  if (mapKind(String(dir)) === 'arena') return inspectArena(String(dir));

  const m = readMap(String(dir));
  const g = m.json.grid;
  say(`${m.json.name}${m.json.region ? ` — ${m.json.region}` : ''}  [${m.json.id}]`);
  say(`  format        ${m.json.format}, written by ${m.json.builder || 'unknown'} on ${m.json.created || '?'}`);
  say(`  origin        ${m.json.origin.lat}, ${m.json.origin.lon}  ${formatUTM(m.json.origin.utm ? { ...m.json.origin.utm } : toUTM(m.json.origin.lat, m.json.origin.lon))}`);
  say(`  grid          ${g.cols} x ${g.rows} posts at ${g.cell} m = ${(((g.cols - 1) * g.cell) / 1000).toFixed(3)} x ${(((g.rows - 1) * g.cell) / 1000).toFixed(3)} km`);
  say(`  elevation     ${m.min.toFixed(1)} to ${m.max.toFixed(1)} m (${(m.max - m.min).toFixed(1)} m of relief)`);
  say(`  height step   ${(g.heights.scale * 1000).toFixed(2)} mm`);
  say(`  datum         ${m.json.origin.datumElevM} m is local NED z = 0`);
  say(`  field         ${m.json.fieldElevM} m (${(m.json.fieldElevM / 0.3048).toFixed(0)} ft)`);
  say(`  surface grid  ${m.classes ? tally(m.classes, SURFACE_NAMES).map((r) => `${r.name} ${r.pct.toFixed(0)}%`).join(', ') : 'none'}`);
  say(`  imagery       ${m.json.color ? m.json.color.file : 'none'}`);
  say(`  obstacles     ${(m.json.obstacles || []).length}, gates ${(m.json.gates || []).length}, pads ${(m.json.pads || []).length}`);
  say(`  corners       NW ${m.elevAt(0, 0).toFixed(1)}  NE ${m.elevAt(g.cols - 1, 0).toFixed(1)}  SW ${m.elevAt(0, g.rows - 1).toFixed(1)}  SE ${m.elevAt(g.cols - 1, g.rows - 1).toFixed(1)} m`);
  if (m.problems.length) { say(`\n  ${m.problems.length} PROBLEM(S):`); for (const p of m.problems) say(`    - ${p}`); process.exitCode = 1; }
  else say('\n  Reads back clean.');
}

function inspectArena(dir) {
  const a = readArena(dir);
  const j = a.json;
  const b = j.bounds || {};
  say(`${j.name || j.id}  [${j.id}]`);
  say(`  format        ${j.format}, schema ${j.schema}${j.author ? `, by ${j.author}` : ''}`);
  say(`  kind          Frag Zone arena — axis-aligned brushes, not terrain`);
  if (b.min && b.max) {
    say(`  bounds        ${b.max[0] - b.min[0]} x ${b.max[2] - b.min[2]} m, ${b.min[1]} to ${b.max[1]} m tall`);
  }
  say(`  brushes       ${a.brushes}`);
  say(`  spawns        ${a.spawns}`);
  say(`  jump pads     ${(j.jumpPads || []).length}`);
  say(`  pickups       ${(j.pickups || []).length}`);
  say(`  waypoints     ${(j.waypoints?.nodes || []).length} nodes, ${(j.waypoints?.links || []).length} explicit links`);
  say(`  gravity       ${j.gravity ?? -22} m/s², kill plane at y = ${j.killZ ?? -50}`);
  if (a.problems.length) { say(`\n  ${a.problems.length} PROBLEM(S):`); for (const p of a.problems) say(`    - ${p}`); process.exitCode = 1; }
  else say('\n  Reads back clean.');
}

/* --------------------------------------------------------------- arena */
// Frag Zone's editor exports the game's own document, one file. A library
// stores one folder per map. This is the step between the two, and it is the
// only place an arena enters a library, so it is also where an arena gets
// checked — a map that cannot be played should not reach the index.
function cmdArena(o) {
  const file = o._[1] || die('give the arena JSON the editor saved');
  const lib = o.out && o.out !== true ? String(o.out) : die('--out LIB: which library to file it into');

  let json;
  try {
    json = JSON.parse(fs.readFileSync(String(file), 'utf8'));
  } catch (e) {
    die(`${file}: ${e.message}`);
  }

  // Metadata a library wants and the editor has no field for. Everything else
  // about the document is left exactly as the editor wrote it.
  for (const key of ['id', 'name', 'region', 'author', 'license']) {
    if (o[key] && o[key] !== true) json[key] = String(o[key]);
  }

  const w = writeArena(lib, json, { force: !!o.force });
  say(`${w.replaced ? 'Replaced' : 'Filed'} ${json.name || json.id} [${json.id}] in ${w.dir}`);
  say(`  ${w.brushes} brushes, ${w.spawns} spawns, ${(w.bytes / 1024).toFixed(0)} KB`);
  if (w.problems.length) {
    say(`\n  FILED ANYWAY, with ${w.problems.length} problem(s):`);
    for (const p of w.problems) say(`    - ${p}`);
    process.exitCode = 1;
  }
  say(`\nNow rebuild the index:  flmap index ${lib}`);
}

/* --------------------------------------------------------------- index */
function cmdIndex(o) {
  const dir = o._[1] || die('give the library folder');
  const idx = writeIndex(String(dir), { name: o.name && o.name !== true ? String(o.name) : undefined });
  say(`${path.join(String(dir), 'index.json')}: ${idx.maps.length} map${idx.maps.length === 1 ? '' : 's'}`);
  let bad = 0;
  for (const m of idx.maps) {
    const summary = m.kind === 'arena'
      ? `arena, ${m.brushes} brushes, ${m.spawns} spawns, ${(m.bytes / 1e3).toFixed(0)} KB`
      : `${(m.extentM[0] / 1000).toFixed(2)} km at ${m.cell} m, ${m.reliefM} m relief, ${(m.bytes / 1e6).toFixed(2)} MB${m.hasColor ? ', imagery' : ''}`;
    say(`  ${m.id.padEnd(24)} ${summary}`);
    if (m.problems) { bad++; for (const p of m.problems) say(`    PROBLEM: ${p}`); }
  }
  const arenas = idx.maps.filter((m) => m.kind === 'arena').length;
  if (arenas) say(`\n  ${idx.maps.length - arenas} for Flightline, ${arenas} for Frag Zone.`);
  if (bad) process.exitCode = 1;
}

/* ---------------------------------------------------------------- main */
const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
try {
  if (!cmd || o.help || cmd === 'help') say(HELP);
  else if (cmd === 'probe') await cmdProbe(o);
  else if (cmd === 'build') await cmdBuild(o);
  else if (cmd === 'from-grid') await cmdFromGrid(o);
  else if (cmd === 'arena') cmdArena(o);
  else if (cmd === 'inspect') cmdInspect(o);
  else if (cmd === 'index') cmdIndex(o);
  else die(`unknown command "${cmd}". Try: flmap help`);
} catch (e) {
  die(e.message);
}
