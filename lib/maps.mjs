// maps.mjs — writing and reading a Flightline map folder.
//
// The format is specified in flightline-sim/docs/map-format.md. The one thing
// worth repeating here is the layout, because getting it backwards is silent:
//
//   height.u16 is cols*rows little-endian Uint16, row-major,
//   ROW 0 IS THE NORTH EDGE and COLUMN 0 IS THE WEST EDGE.
//
// The elevation sources this tool reads hand back grids running south to north
// (that is the convention in relief's sources.mjs, where y is north), so
// writing a map always involves one flip. `fromSouthUpGrid` is that flip, in
// one place, so it cannot be half-done.

import fs from 'node:fs';
import path from 'node:path';
import { toUTM } from './utm.mjs';

export const FORMAT = 'flightline-map/1';
export const LIB_FORMAT = 'flightline-maps/1';
/* Frag Zone arena documents. A library holds both kinds side by side: the
   heightfield terrain Flightline flies, and the brush arenas Frag Zone
   fights in. They share storage and an index, not a geometry model — an
   arena is axis-aligned boxes, terrain is a heightfield, and neither game
   can read the other's maps. Each index entry says which it is, so each
   game lists only what it understands. */
export const ARENA_FORMAT = 'fragzone-map/1';
export const MAX_SIDE = 1024;

export const SURFACE_NAMES = ['unknown', 'grass', 'rock', 'water', 'asphalt', 'snow', 'dirt', 'brush'];
export const CLASS_OF = Object.fromEntries(SURFACE_NAMES.map((n, i) => [n, i]));

/** Flip a south-to-north grid (row 0 = south) into the map's north-up order. */
export function fromSouthUpGrid(values, cols, rows) {
  const out = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const src = (rows - 1 - r) * cols, dst = r * cols;
    for (let c = 0; c < cols; c++) out[dst + c] = values[src + c];
  }
  return out;
}

/**
 * Quantise elevations to Uint16, spending the whole range on the relief that
 * is actually there: scale = (max - min) / 65535, offset = min. Worst-case
 * error is scale/2, which the caller is told so it can be reported.
 */
export function encodeHeights(elev, opts = {}) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    const v = elev[i];
    if (!Number.isFinite(v)) throw new Error(`the heightfield holds a non-finite value at index ${i}`);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const scale = opts.scale || (max - min) / 65535 || 1e-6;
  const offset = opts.offset != null ? opts.offset : min;
  const out = new Uint16Array(elev.length);
  for (let i = 0; i < elev.length; i++) {
    out[i] = Math.max(0, Math.min(65535, Math.round((elev[i] - offset) / scale)));
  }
  return { values: out, scale, offset, min, max, worstErrorM: scale / 2 };
}

/**
 * Write a map folder.
 *
 * @param {object} o
 *   dir        where to write
 *   id/name/region/author/attribution/license
 *   elevM      Float64Array of cols*rows elevations, metres above sea level,
 *              ALREADY in the map's north-up order
 *   cols/rows/cell
 *   lat/lon    of local (0, 0)
 *   datumElevM elevation that local NED z = 0 sits at; defaults to fieldElevM
 *   fieldElevM defaults to the elevation at the pilot spot
 *   originNE   north-west post in local metres; defaults to grid-centred
 *   pilot/home/pads/starts/obstacles/gates/rangeM
 *   classes    optional Uint8Array of cols*rows surface classes
 *   colorFile  optional file name already written into the folder
 */
export function writeMap(o) {
  const { dir, cols, rows, cell } = o;
  if (!(cols >= 2 && rows >= 2)) throw new Error(`a map needs at least 2x2 posts, got ${cols}x${rows}`);
  if (cols > MAX_SIDE || rows > MAX_SIDE) throw new Error(`${cols}x${rows} exceeds the format's ${MAX_SIDE} post limit per side`);
  if (o.elevM.length !== cols * rows) throw new Error(`heightfield is ${o.elevM.length} values, expected ${cols * rows}`);
  if (o.classes && o.classes.length !== cols * rows) throw new Error(`surface grid is ${o.classes.length} values, expected ${cols * rows}`);

  fs.mkdirSync(dir, { recursive: true });
  const originNE = o.originNE || [((rows - 1) * cell) / 2, -((cols - 1) * cell) / 2];

  // sample the grid at a local point, for the field elevation
  const at = (n, e) => {
    const c = Math.max(0, Math.min(cols - 1, Math.round((e - originNE[1]) / cell)));
    const r = Math.max(0, Math.min(rows - 1, Math.round((originNE[0] - n) / cell)));
    return o.elevM[r * cols + c];
  };
  const pilot = o.pilot || { n: 0, e: 0 };
  const fieldElevM = o.fieldElevM != null ? o.fieldElevM : at(pilot.n, pilot.e);
  const datumElevM = o.datumElevM != null ? o.datumElevM : fieldElevM;

  const enc = encodeHeights(o.elevM);
  const utm = toUTM(o.lat, o.lon);

  const json = {
    format: FORMAT,
    id: o.id,
    name: o.name || o.id,
    ...(o.region ? { region: o.region } : {}),
    ...(o.author ? { author: o.author } : {}),
    ...(o.attribution ? { attribution: o.attribution } : {}),
    ...(o.license ? { license: o.license } : {}),
    created: o.created || new Date().toISOString().slice(0, 10),
    builder: o.builder || 'flightline-map-builder',
    origin: {
      lat: +o.lat.toFixed(7),
      lon: +o.lon.toFixed(7),
      utm: { zone: utm.zone, hemisphere: utm.hemisphere, easting: +utm.easting.toFixed(2), northing: +utm.northing.toFixed(2) },
      datumElevM: +datumElevM.toFixed(2),
    },
    grid: {
      cols, rows, cell,
      originNE: [+originNE[0].toFixed(3), +originNE[1].toFixed(3)],
      heights: {
        file: 'height.u16', type: 'uint16le',
        scale: +enc.scale.toPrecision(10), offset: +enc.offset.toFixed(4),
        min: +enc.min.toFixed(2), max: +enc.max.toFixed(2),
      },
      ...(o.classes ? { surface: { file: 'surface.u8', type: 'uint8' } } : {}),
    },
    ...(o.colorFile ? { color: { file: o.colorFile, coverage: 'grid' } } : {}),
    fieldElevM: +fieldElevM.toFixed(2),
    ...(o.rangeM ? { rangeM: o.rangeM } : {}),
    pilot,
    home: o.home || { ...pilot },
    ...(o.pads && o.pads.length ? { pads: o.pads } : {}),
    ...(o.starts && o.starts.length ? { starts: o.starts } : {}),
    obstacles: o.obstacles || [],
    gates: o.gates || [],
  };

  fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'height.u16'), Buffer.from(enc.values.buffer, enc.values.byteOffset, enc.values.byteLength));
  if (o.classes) fs.writeFileSync(path.join(dir, 'surface.u8'), Buffer.from(o.classes.buffer, o.classes.byteOffset, o.classes.byteLength));

  return { json, enc, dir, bytes: folderBytes(dir) };
}

export const folderBytes = (dir) =>
  fs.readdirSync(dir).reduce((sum, f) => {
    const st = fs.statSync(path.join(dir, f));
    return sum + (st.isFile() ? st.size : 0);
  }, 0);

/**
 * Read a map folder back and check it against itself: the right number of
 * values, the declared range matching what the heightfield holds, the pilot
 * spot inside the grid. This is what `flmap inspect` runs, and what the tests
 * use, so a map is never shipped on the strength of having been written
 * without anyone reading it.
 */
export function readMap(dir) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
  const problems = [];
  if (!String(json.format || '').startsWith('flightline-map/1')) problems.push(`format is "${json.format}", not flightline-map/1`);
  const g = json.grid || {};
  const { cols, rows, cell } = g;
  const H = g.heights || {};

  const buf = fs.readFileSync(path.join(dir, H.file || 'height.u16'));
  if (buf.length % 2) problems.push(`${H.file} is ${buf.length} bytes, not a whole number of Uint16`);
  const raw = new Uint16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  if (raw.length !== cols * rows) problems.push(`${H.file} holds ${raw.length} values, map.json says ${cols}x${rows} = ${cols * rows}`);
  if (!(H.scale > 0)) problems.push(`grid.heights.scale is ${H.scale}, which must be positive`);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] * H.scale + H.offset;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const tol = Math.max(0.5, H.scale);
  if (H.min != null && Math.abs(H.min - min) > tol) problems.push(`grid.heights.min says ${H.min} m, the heightfield holds ${min.toFixed(2)} m`);
  if (H.max != null && Math.abs(H.max - max) > tol) problems.push(`grid.heights.max says ${H.max} m, the heightfield holds ${max.toFixed(2)} m`);

  let classes = null;
  if (g.surface && g.surface.file) {
    const cb = fs.readFileSync(path.join(dir, g.surface.file));
    classes = new Uint8Array(cb.buffer, cb.byteOffset, cb.length);
    if (classes.length !== cols * rows) problems.push(`${g.surface.file} holds ${classes.length} values, expected ${cols * rows}`);
    for (let i = 0; i < classes.length; i++) {
      if (classes[i] >= SURFACE_NAMES.length) { problems.push(`${g.surface.file} holds class ${classes[i]}, which is not one of the ${SURFACE_NAMES.length} defined`); break; }
    }
  }
  if (json.color && json.color.file && !fs.existsSync(path.join(dir, json.color.file))) {
    problems.push(`map.json names colour image ${json.color.file}, which is not in the folder`);
  }

  const originNE = g.originNE || [((rows - 1) * cell) / 2, -((cols - 1) * cell) / 2];
  const inside = (p) => p && p.e >= originNE[1] && p.e <= originNE[1] + (cols - 1) * cell
    && p.n <= originNE[0] && p.n >= originNE[0] - (rows - 1) * cell;
  if (!inside(json.pilot)) problems.push(`the pilot spot (${json.pilot && json.pilot.n}, ${json.pilot && json.pilot.e}) is outside the grid`);
  if (!inside(json.home)) problems.push(`home (${json.home && json.home.n}, ${json.home && json.home.e}) is outside the grid`);
  for (const s of json.starts || []) if (!inside(s)) problems.push(`start "${s.id}" is outside the grid`);

  return { json, raw, classes, min, max, problems, elevAt: (c, r) => raw[r * cols + c] * H.scale + H.offset };
}

/** Rebuild index.json by reading every map folder under `dir`. */
/**
 * Read a Frag Zone arena document and check the things the game's own
 * loader checks, so a broken arena is caught here rather than in a browser.
 * Returns the same `{ json, problems }` shape readMap does.
 */
export function readArena(dir) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
  const problems = [];
  if (json.format !== ARENA_FORMAT) problems.push(`format is "${json.format}", not ${ARENA_FORMAT}`);
  if (json.schema !== 1) problems.push(`schema is ${json.schema}, not 1`);
  if (!json.id) problems.push('no id');

  const brushes = Array.isArray(json.brushes) ? json.brushes : [];
  if (!brushes.length) problems.push('needs at least one brush');
  brushes.forEach((b, i) => {
    if (b.pos?.length !== 3 || b.size?.length !== 3) problems.push(`brush ${i} needs pos[3] and size[3]`);
    else if (!b.size.every((s) => s > 0)) problems.push(`brush ${i} has a non-positive size`);
  });

  const spawns = Array.isArray(json.spawns) ? json.spawns : [];
  if (!spawns.length) problems.push('needs at least one spawn');
  spawns.forEach((s, i) => {
    if (s.pos?.length !== 3) problems.push(`spawn ${i} needs pos[3]`);
  });

  for (const [i, pad] of (json.jumpPads || []).entries()) {
    if (pad.pos?.length !== 3 || pad.size?.length !== 3 || pad.launch?.length !== 3) {
      problems.push(`jump pad ${i} needs pos[3], size[3] and launch[3]`);
    }
  }

  const ids = new Set();
  for (const node of json.waypoints?.nodes || []) {
    if (node.pos?.length !== 3) problems.push(`waypoint "${node.id}" needs pos[3]`);
    if (ids.has(node.id)) problems.push(`duplicate waypoint id "${node.id}"`);
    ids.add(node.id);
  }
  for (const link of json.waypoints?.links || []) {
    if (!ids.has(link.from) || !ids.has(link.to)) {
      problems.push(`link ${link.from} -> ${link.to} references a missing waypoint`);
    }
  }

  return { json, problems, brushes: brushes.length, spawns: spawns.length };
}

/** Which kind of map a folder holds, read from the document itself. */
export function mapKind(dir) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
  if (json.format === ARENA_FORMAT || Array.isArray(json.brushes)) return 'arena';
  return 'terrain';
}

export function writeIndex(dir, opts = {}) {
  const entries = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, name);
    if (!fs.statSync(sub).isDirectory() || !fs.existsSync(path.join(sub, 'map.json'))) continue;

    if (mapKind(sub) === 'arena') {
      const a = readArena(sub);
      const b = a.json.bounds || {};
      entries.push({
        id: a.json.id,
        name: a.json.name,
        kind: 'arena',
        ...(a.json.region ? { region: a.json.region } : {}),
        path: `${name}/`,
        ...(b.min && b.max ? { extentM: [b.max[0] - b.min[0], b.max[2] - b.min[2]] } : {}),
        brushes: a.brushes,
        spawns: a.spawns,
        bytes: folderBytes(sub),
        ...(a.json.author ? { author: a.json.author } : {}),
        ...(a.json.attribution ? { attribution: a.json.attribution } : {}),
        ...(a.problems.length ? { problems: a.problems } : {}),
      });
      continue;
    }

    const m = readMap(sub);
    const g = m.json.grid;
    entries.push({
      id: m.json.id,
      name: m.json.name,
      kind: 'terrain',
      ...(m.json.region ? { region: m.json.region } : {}),
      path: `${name}/`,
      extentM: [(g.cols - 1) * g.cell, (g.rows - 1) * g.cell],
      cell: g.cell,
      fieldElevM: m.json.fieldElevM,
      reliefM: Math.round(m.max - m.min),
      bytes: folderBytes(sub),
      hasColor: !!(m.json.color && m.json.color.file),
      ...(m.json.attribution ? { attribution: m.json.attribution } : {}),
      ...(m.problems.length ? { problems: m.problems } : {}),
    });
  }
  const index = {
    format: LIB_FORMAT,
    name: opts.name || 'Flightline maps',
    updated: new Date().toISOString().slice(0, 10),
    maps: entries,
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}
