// classify.mjs — a surface class per post, for the lidar's reflectivity.
//
// This is a HEURISTIC from the shape of the ground, not a landcover product.
// It gets snow on the tops, rock on the cliffs and water in the flat bottoms,
// which is what the rangefinder needs to behave differently in the places a
// search flight cares about. It will put rock on a steep meadow and miss a
// reservoir that is not in a hollow.
//
// Two better inputs exist and both are supported as overrides rather than
// guessed at:
//
//   --landcover URL   an ArcGIS image service serving a classed raster
//                     (NLCD, for instance), remapped by --landcover-map
//   --water-level M   everything below this elevation inside a closed basin
//                     is water, which is how you pin a known reservoir
//
// Until one of those is given, what this produces is a guess, and `flmap
// build` says so in its output rather than letting a guess look like data.

import { CLASS_OF } from './maps.mjs';

export const DEFAULTS = {
  snowAboveM: null, // metres above sea level; null = no snow line
  waterBelowM: null, // metres; null = detect flat basins instead
  rockSlope: 0.60, // rise over run: 31 degrees
  brushSlope: 0.26, // 15 degrees
  basinFlatness: 0.04, // a basin floor is flatter than this
};

/**
 * @param {Float64Array} elev  cols*rows, north-up
 * @returns {Uint8Array} one class per post
 */
export function classify(elev, cols, rows, cell, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = new Uint8Array(cols * rows);
  const at = (c, r) => elev[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < elev.length; i++) { const v = elev[i]; if (v < min) min = v; if (v > max) max = v; }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // central differences; row index grows south, so north is r-1
      const dE = (at(c + 1, r) - at(c - 1, r)) / (2 * cell);
      const dN = (at(c, r - 1) - at(c, r + 1)) / (2 * cell);
      const slope = Math.hypot(dE, dN);
      const z = at(c, r);

      let k;
      if (o.waterBelowM != null && z <= o.waterBelowM) k = CLASS_OF.water;
      else if (o.waterBelowM == null && slope < o.basinFlatness && z < min + (max - min) * 0.08) k = CLASS_OF.water;
      else if (o.snowAboveM != null && z >= o.snowAboveM) k = CLASS_OF.snow;
      else if (slope >= o.rockSlope) k = CLASS_OF.rock;
      else if (slope >= o.brushSlope) k = CLASS_OF.brush;
      else k = CLASS_OF.grass;
      out[r * cols + c] = k;
    }
  }

  // stamp pads flat and hard, since they are known rather than guessed
  for (const pad of opts.pads || []) {
    const cls = CLASS_OF[pad.surface] ?? CLASS_OF.asphalt;
    const cs = Math.cos((pad.yawDeg || 0) * Math.PI / 180), sn = Math.sin((pad.yawDeg || 0) * Math.PI / 180);
    const originNE = opts.originNE || [((rows - 1) * cell) / 2, -((cols - 1) * cell) / 2];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const n = originNE[0] - r * cell, e = originNE[1] + c * cell;
      const dn = n - pad.n, de = e - pad.e;
      const along = dn * cs + de * sn, across = -dn * sn + de * cs;
      if (Math.abs(along) <= pad.lengthM / 2 && Math.abs(across) <= pad.widthM / 2) out[r * cols + c] = cls;
    }
  }
  return out;
}

/** What the classifier produced, as a share of the map, for the build report. */
export function tally(classes, names) {
  const counts = new Array(names.length).fill(0);
  for (let i = 0; i < classes.length; i++) counts[classes[i]]++;
  return names
    .map((n, i) => ({ name: n, count: counts[i], pct: (100 * counts[i]) / classes.length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * Trees and buildings out of a surface model: where a first-return surface
 * (DSM) stands above the bare-earth ground (DEM) by more than a threshold,
 * something is there. Blobs are grouped and emitted as tree or building
 * obstacles by how square and how flat-topped they are.
 *
 * This is the one route to obstacles that does NOT need a LAZ reader — a DSM
 * raster goes through the same ArcGIS path as the DEM. USGS 3DEP publishes
 * bare earth nationally; a first-return surface is published by some states
 * and not others, so the service URL is yours to supply with --dsm.
 */
export function obstaclesFromSurface(dem, dsm, cols, rows, cell, opts = {}) {
  const minH = opts.minHeightM ?? 2.5;
  const maxH = opts.maxHeightM ?? 45;
  const originNE = opts.originNE || [((rows - 1) * cell) / 2, -((cols - 1) * cell) / 2];
  const seen = new Uint8Array(cols * rows);
  const out = [];
  const idx = (c, r) => r * cols + c;
  const height = (c, r) => dsm[idx(c, r)] - dem[idx(c, r)];

  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (seen[idx(c, r)] || height(c, r) < minH) continue;
    // flood fill one blob
    const stack = [[c, r]];
    let n = 0, sumC = 0, sumR = 0, peak = 0, minC = c, maxC = c, minR = r, maxR = r, flatSum = 0;
    seen[idx(c, r)] = 1;
    while (stack.length) {
      const [cc, rr] = stack.pop();
      const h = height(cc, rr);
      n++; sumC += cc; sumR += rr; flatSum += h;
      if (h > peak) peak = h;
      if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
      if (rr < minR) minR = rr; if (rr > maxR) maxR = rr;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = cc + dc, nr = rr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        if (seen[idx(nc, nr)] || height(nc, nr) < minH) continue;
        seen[idx(nc, nr)] = 1;
        stack.push([nc, nr]);
      }
    }
    if (peak > maxH || n < 2) continue;
    const wC = (maxC - minC + 1) * cell, wR = (maxR - minR + 1) * cell;
    const e = originNE[1] + (sumC / n) * cell, nn = originNE[0] - (sumR / n) * cell;
    // a building is flat-topped (mean height close to peak) and rectangular;
    // a tree is neither
    const flatness = flatSum / n / peak;
    const fill = n / (((maxC - minC + 1) * (maxR - minR + 1)) || 1);
    if (flatness > 0.75 && fill > 0.7 && Math.min(wC, wR) >= 3) {
      out.push({ t: 'building', n: +nn.toFixed(1), e: +e.toFixed(1), sizeN: +wR.toFixed(1), sizeE: +wC.toFixed(1), h: +peak.toFixed(1) });
    } else {
      out.push({ t: 'tree', n: +nn.toFixed(1), e: +e.toFixed(1), r: +(Math.max(wC, wR) / 2.6).toFixed(2), h: +peak.toFixed(1) });
    }
  }
  return out;
}
