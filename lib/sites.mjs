// sites.mjs — proposing places to stand on a map, and writing them into one.
//
// A terrain map is kilometres across and the builder's default stand point is
// the centre of the box, which on a canyon map is a wall. The sim can move the
// stand point at runtime, but a map should still ship with somewhere sensible.
//
// THIS PROPOSES, IT DOES NOT DECIDE. The scores below are a reading of the
// shape of the ground and nothing else: they do not know where the road is,
// where you are allowed to stand, or which direction the interesting flying
// is. `flmap sites DIR` prints candidates for a person to choose and name,
// and `--set` writes the ones they chose. Nothing here runs during a build.
//
// What makes a spot worth standing on, in the order it matters:
//
//   1. You can stand and land on it. Flat over the dozen metres around you.
//   2. You can see the model. Nothing towering over you — measured by firing
//      rays outward and asking how high the horizon climbs along each one.
//   3. There is something to fly at. A site in the middle of a featureless
//      shelf scores well on the first two and is dull, so relief in view is
//      a tie-breaker, not a filter.

import fs from 'node:fs';
import path from 'node:path';
import { readMap, CLASS_OF } from './maps.mjs';

const D2R = Math.PI / 180;

/** Bilinear height in local metres, clamped at the edges. */
function sampler(m) {
  const g = m.json.grid;
  const { cols, rows, cell } = g;
  const [n0, e0] = g.originNE; // north-west post
  const H = g.heights;
  const at = (c, r) => m.raw[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))] * H.scale + H.offset;
  return {
    cols, rows, cell, n0, e0,
    nMax: n0, nMin: n0 - (rows - 1) * cell,
    eMin: e0, eMax: e0 + (cols - 1) * cell,
    h(n, e) {
      const x = (e - e0) / cell, y = (n0 - n) / cell;
      const c = Math.floor(x), r = Math.floor(y);
      const fx = x - c, fy = y - r;
      return (at(c, r) * (1 - fx) + at(c + 1, r) * fx) * (1 - fy)
           + (at(c, r + 1) * (1 - fx) + at(c + 1, r + 1) * fx) * fy;
    },
    cls(n, e) {
      if (!m.classes) return 0;
      const c = Math.round((e - e0) / cell), r = Math.round((n0 - n) / cell);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
      return m.classes[r * cols + c];
    },
  };
}

/**
 * Score one spot.
 *
 * `openness` is the share of 16 compass directions along which the horizon
 * stays below `skyDeg` out to `reachM`. It is the number that actually
 * separates a usable site from a hole: on a canyon floor most directions are
 * blocked, on a rim almost none are.
 */
function scoreSpot(S, n, e, o) {
  const here = S.h(n, e);
  if (S.cls(n, e) === CLASS_OF.water) return null;

  // 1. flat enough to stand and land on
  let slope = 0;
  for (let a = 0; a < 8; a++) {
    const th = (a / 8) * 2 * Math.PI;
    const d = o.padM;
    slope = Math.max(slope, Math.abs(S.h(n + Math.cos(th) * d, e + Math.sin(th) * d) - here) / d);
  }
  if (slope > o.maxSlope) return null;

  // 2. how much sky, and 3. how much relief is in view
  const tanLimit = Math.tan(o.skyDeg * D2R);
  let open = 0, relief = 0;
  for (let a = 0; a < 16; a++) {
    const th = (a / 16) * 2 * Math.PI, cn = Math.cos(th), ce = Math.sin(th);
    let worst = -Infinity;
    for (let d = o.padM * 2; d <= o.reachM; d += o.stepM) {
      const nn = n + cn * d, ee = e + ce * d;
      if (nn < S.nMin || nn > S.nMax || ee < S.eMin || ee > S.eMax) break;
      const dh = S.h(nn, ee) - here;
      worst = Math.max(worst, dh / d);
      if (Math.abs(dh) > relief) relief = Math.abs(dh);
    }
    if (worst < tanLimit) open++;
  }

  return { n, e, up: here, slope, open, relief };
}

/**
 * Propose stand points across a map.
 *
 * Greedy: best score first, then anything within `apartM` of a chosen site is
 * skipped, so the list is spread over the map rather than clustered on the
 * one good hillside.
 */
export function proposeSites(dir, opts = {}) {
  const o = {
    count: 4, padM: 15, maxSlope: 0.14, skyDeg: 12,
    reachM: 800, stepM: 25, apartM: 900, marginM: 250, ...opts,
  };
  const m = readMap(dir);
  const S = sampler(m);
  const step = Math.max(S.cell * 4, 32);

  const spots = [];
  for (let n = S.nMin + o.marginM; n <= S.nMax - o.marginM; n += step) {
    for (let e = S.eMin + o.marginM; e <= S.eMax - o.marginM; e += step) {
      const s = scoreSpot(S, n, e, o);
      if (s) spots.push(s);
    }
  }
  // open sky first; among equals, the flattest; then the most to look at
  spots.sort((a, b) => b.open - a.open || a.slope - b.slope || b.relief - a.relief);

  const far = (list, s) => !list.some((p) => Math.hypot(p.n - s.n, p.e - s.e) < o.apartM);
  const picked = [];

  /* One slot is reserved for the best LOW site. Ranking by open sky alone
     puts every proposal on the rim, because a rim is where the horizon is
     lowest — and on a canyon map that quietly deletes the canyon floor,
     which is where most people would actually want to stand. */
  const lowMark = m.min + (m.max - m.min) * 0.35;
  const low = spots.find((s) => s.up <= lowMark);
  if (low) picked.push(low);

  for (const s of spots) {
    if (picked.length >= o.count) break;
    if (!far(picked, s)) continue;
    picked.push(s);
  }
  picked.sort((a, b) => a.up - b.up);

  /* Heights decode to metres above sea level already — `encodeHeights` keeps
     the absolute value and stores the minimum as the offset — so the datum
     must NOT be added back on. Adding it put Zion's rim at 3,695 m. */
  const band = (up) => {
    const rel = (up - m.min) / ((m.max - m.min) || 1);
    return rel > 0.66 ? 'rim' : rel > 0.33 ? 'bench' : 'floor';
  };
  const compass = (n, e) => {
    const a = (Math.atan2(e, n) * 180) / Math.PI;
    return ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'][
      Math.round(((a + 360) % 360) / 45) % 8];
  };

  return {
    map: m, total: spots.length,
    sites: picked.map((s) => ({
      ...s,
      aslM: s.up,
      suggested: `${compass(s.n, s.e)} ${band(s.up)}`,
    })),
  };
}

/** Write a `sites` array into an existing map.json, without rebuilding it. */
export function setSites(dir, sites) {
  const file = path.join(dir, 'map.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (sites.length) json.sites = sites;
  else delete json.sites;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return json;
}

/**
 * Move a map's default stand point, the one the document calls `pilot`.
 *
 * The starts that belong to you have to come too. The builder writes the pad,
 * the hand launch and the airborne start relative to the pilot spot and marks
 * them `anchor: "pilot"`; moving the pilot and leaving them behind would put
 * you on one side of the canyon and the model on the other. A start anchored
 * to the map — a runway — is a place and stays.
 *
 * `fieldElevM` is re-read from the heightfield under the new spot, because it
 * is what sets density altitude and it was measured at a spot you just left.
 */
export function setPilot(dir, n, e) {
  const m = readMap(dir);
  const S = sampler(m);
  const file = path.join(dir, 'map.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));

  const old = json.pilot || { n: 0, e: 0 };
  const dn = n - (+old.n || 0), de = e - (+old.e || 0);
  const same = (p) => p && (+p.n || 0) === (+old.n || 0) && (+p.e || 0) === (+old.e || 0);

  if (same(json.home)) json.home = { ...json.home, n, e };
  json.pilot = { ...old, n, e };

  let moved = 0;
  for (const st of json.starts || []) {
    if (st.anchor === 'map') continue;
    st.n = +((+st.n || 0) + dn).toFixed(3);
    st.e = +((+st.e || 0) + de).toFixed(3);
    moved++;
  }

  /* The datum has to come too. `up` in the heightfield is metres above
     origin.datumElevM, the builder sets that to the ground under the pilot,
     and the sim's altimeter therefore reads zero at your feet. Move the
     pilot and leave the datum where it was and you stand on the ground
     reading +1,100 ft, which is how this was caught. */
  const before = json.fieldElevM;
  const beforeDatum = (json.origin && json.origin.datumElevM) || 0;
  const ground = +S.h(n, e).toFixed(2);
  json.fieldElevM = ground;
  if (json.origin) json.origin.datumElevM = ground;

  // Anything whose height was written against the old datum would shift.
  // These maps carry none, but say so rather than silently moving them.
  const absolute = (json.gates || []).length + (json.obstacles || []).length;

  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { json, dn, de, moved, before, after: ground, beforeDatum, afterDatum: ground, absolute };
}
