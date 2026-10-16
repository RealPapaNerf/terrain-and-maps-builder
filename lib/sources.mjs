// ---------------------------------------------------------------------------
// Copied verbatim from RealPapaNerf/relief, js/sources.js, at commit 5263350.
// relief is the LiDAR-to-STL tool this builder's elevation layer comes from;
// that code is already proven against the live services, so it is reused as
// it stands rather than rewritten. Keep edits here to a minimum so the two
// copies can still be diffed. MIT, same as both repos.
// ---------------------------------------------------------------------------
// sources.js — where elevation and depth data comes from.
//
// One adapter type does most of the work: an ArcGIS image service, which is
// how USGS, NOAA and most state GIS offices publish their rasters. Point it at
// a service URL and it returns a grid of real numbers for any bounding box, so
// adding a new dataset is a matter of adding a URL rather than writing code.
//
// Nothing here needs an account or an API key.

import { terrainFromGrid, fetchTerrain } from './elevation.mjs';
import { decodeFloatGrid, decodeGeoTiff, fillNoData } from './raster.mjs';

export const SOURCE_PRESETS = [
  {
    id: 'open-meteo',
    label: 'Open-Meteo — worldwide',
    type: 'openmeteo',
    kind: 'elevation',
    resolutionM: 90,
    maxGrid: 32,
    coverage: 'Everywhere',
    attribution: 'Open-Meteo (Copernicus DEM)',
    notes: 'Good enough for city maps and gentle hills. Too coarse for a canyon.',
  },
  {
    id: 'usgs-3dep',
    label: 'USGS 3DEP — United States',
    type: 'arcgis',
    kind: 'elevation',
    url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    resolutionM: 1,
    maxGrid: 1024,
    coverage: 'United States and territories',
    attribution: 'USGS 3D Elevation Program',
    notes:
      'Best-available mosaic: 1 m where lidar has been flown — which includes the Utah state lidar over Grand Staircase-Escalante — and 10 m elsewhere.',
  },
  {
    id: 'noaa-topobathy',
    label: 'NOAA topo-bathy mosaic — worldwide',
    type: 'arcgis',
    kind: 'bathymetry',
    url: 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer',
    resolutionM: 30,
    maxGrid: 1024,
    coverage: 'Worldwide; detailed around US coasts and the Great Lakes',
    attribution: 'NOAA NCEI',
    notes: 'Carries real depths below the waterline where a survey exists. Inland lakes are mostly not covered.',
  },
];

export function findSource(id, extra = []) {
  return [...SOURCE_PRESETS, ...extra].find((s) => s.id === id) || SOURCE_PRESETS[0];
}

export function normalizeSource(s = {}) {
  return {
    id: s.id || `custom-${Math.random().toString(36).slice(2, 8)}`,
    label: s.label || s.url || 'Custom source',
    type: s.type || 'arcgis',
    kind: s.kind || 'elevation',
    url: (s.url || '').replace(/\/+$/, ''),
    resolutionM: Number(s.resolutionM) > 0 ? Number(s.resolutionM) : 10,
    maxGrid: Math.min(2048, Math.max(16, Number(s.maxGrid) || 1024)),
    coverage: s.coverage || 'Unknown',
    attribution: s.attribution || '',
    notes: s.notes || '',
    custom: s.custom !== false && !SOURCE_PRESETS.some((p) => p.id === s.id),
  };
}

// How many samples across to ask for, given what the source can actually
// resolve and how much ground is being covered.
export function gridForSource(source, sizeM, targetResM) {
  const res = Math.max(targetResM || source.resolutionM, source.resolutionM);
  const wanted = Math.ceil(sizeM / res) + 1;
  const n = Math.max(16, Math.min(source.maxGrid, wanted));
  const effectiveResM = sizeM / (n - 1);
  return {
    n,
    effectiveResM, // how far apart the samples are
    sourceResM: source.resolutionM, // the finest detail the data actually holds
    // Sampling closer together than the data resolves only smooths it; say so
    // rather than implying detail that is not there.
    oversampled: effectiveResM < source.resolutionM - 1e-9,
  };
}

// Image services keep their pixels square in the image's own units, and when
// the box asked for is not a whole number of square pixels they widen it to
// make it so — silently, about its centre. A square of ground is not a square
// in degrees (a degree of latitude is longer than a degree of longitude), so
// asking for the map's exact box got back a grid covering ~1.4x more ground
// north-south than the model assumed, and the terrain slid out from under the
// rivers. Instead the request is a whole number of cells each way, with a cell
// of slack all round so the edge samples can be interpolated, and the grid is
// resampled onto the model's metre grid afterwards.
function imageRequest(projector, sizeM, n) {
  const half = sizeM / 2;
  const [south, west] = projector.inverse(-half, -half);
  const [north, east] = projector.inverse(half, half);
  // One model step, in degrees of latitude — the longer degree, so a cell is
  // no coarser than a step on the ground in either direction.
  const cell = (north - south) / Math.max(1, n - 1);
  const rows = n + 2;
  const cols = Math.ceil((east - west) / cell) + 2;
  const cx = (east + west) / 2;
  const cy = (north + south) / 2;
  return {
    cols,
    rows,
    cell,
    west: cx - (cols * cell) / 2,
    east: cx + (cols * cell) / 2,
    south: cy - (rows * cell) / 2,
    north: cy + (rows * cell) / 2,
  };
}

function exportUrl(source, img, format) {
  const params = new URLSearchParams({
    bbox: `${img.west},${img.south},${img.east},${img.north}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${img.cols},${img.rows}`,
    format,
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    noDataInterpretation: 'esriNoDataMatchAny',
    f: 'image',
  });
  if (format === 'tiff') params.set('compression', 'None');
  return `${source.url}/exportImage?${params.toString()}`;
}

// ArcGIS answers errors with JSON and a 200, so the body has to be sniffed.
function jsonError(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (head[0] !== 0x7b) return null; // '{'
  try {
    const text = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 2000));
    const json = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
    return json?.error?.message || json?.error?.details?.join?.('; ') || 'service returned an error';
  } catch {
    return 'service returned something that is not a raster';
  }
}

// Read the model's n x n grid (rows south to north, in local metres) out of an
// image (rows north to south, pixel centres half a cell in from its edges).
function resampleToGrid(values, img, projector, sizeM, n) {
  const half = sizeM / 2;
  const step = n > 1 ? sizeM / (n - 1) : 0;
  const { cols, rows } = img;
  const cellX = (img.east - img.west) / cols;
  const cellY = (img.north - img.south) / rows;
  const at = (c, r) => values[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  const out = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [lat, lon] = projector.inverse(-half + i * step, -half + j * step);
      const fc = (lon - img.west) / cellX - 0.5;
      const fr = (img.north - lat) / cellY - 0.5;
      const c = Math.floor(fc);
      const r = Math.floor(fr);
      const tc = fc - c;
      const tr = fr - r;
      out[j * n + i] =
        at(c, r) * (1 - tc) * (1 - tr) +
        at(c + 1, r) * tc * (1 - tr) +
        at(c, r + 1) * (1 - tc) * tr +
        at(c + 1, r + 1) * tc * tr;
    }
  }
  return out;
}

// Fetch the map's elevation as the model's n x n grid, south to north.
// Returns the grid and how many no-data cells had to be filled (-1: all).
async function fetchArcgisGrid(source, projector, sizeM, n, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const img = imageRequest(projector, sizeM, n);
  const attempts = [
    { format: 'bsq', decode: (buf) => ({ values: decodeFloatGrid(buf, img.cols, img.rows) }) },
    { format: 'tiff', decode: (buf) => decodeGeoTiff(buf) },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await doFetch(exportUrl(source, img, attempt.format), { signal: opts.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buffer = await res.arrayBuffer();
      const err = jsonError(buffer);
      if (err) throw new Error(err);
      const decoded = attempt.decode(buffer);
      if (decoded.values.length < img.cols * img.rows) {
        throw new Error(`short grid: ${decoded.values.length} of ${img.cols * img.rows}`);
      }
      // A GeoTIFF says where it really is; trust that over what was asked for.
      const placed = decoded.geo ? { ...img, ...decoded.geo, cols: decoded.width, rows: decoded.height } : img;
      const filled = fillNoData(decoded.values, placed.cols, placed.rows);
      if (filled === -1) return { values: null, filled };
      return { values: resampleToGrid(decoded.values, placed, projector, sizeM, n), filled };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw new Error(`${source.label}: ${lastError ? lastError.message : 'no data'}`);
}

/**
 * Sample a source over the whole map.
 * @returns a terrain object ({sample, min, max, n, values}) plus which source
 *          it came from and the resolution actually achieved.
 */
export async function fetchSourceTerrain(source, projector, sizeM, opts = {}) {
  const src = normalizeSource(source);
  const onProgress = opts.onProgress || (() => {});

  if (src.type === 'openmeteo') {
    const n = gridForSource(src, sizeM, opts.targetResM).n;
    onProgress(`Sampling ${src.label}…`);
    const terrain = await fetchTerrain(projector, sizeM, n, opts);
    const plan = gridForSource(src, sizeM, opts.targetResM);
    return { ...terrain, source: src, ...plan, filled: 0 };
  }

  if (src.type !== 'arcgis') throw new Error(`unknown source type: ${src.type}`);
  if (!src.url) throw new Error(`${src.label} has no service URL`);

  const plan = gridForSource(src, sizeM, opts.targetResM);
  const { n, effectiveResM } = plan;
  onProgress(`Requesting ${n}×${n} samples from ${src.label} (${effectiveResM.toFixed(1)} m per sample)…`);
  const { values, filled } = await fetchArcgisGrid(src, projector, sizeM, n, opts);
  if (filled === -1) {
    throw new Error(`${src.label} has no data for this area — try another source.`);
  }
  const terrain = terrainFromGrid(values, n, sizeM);
  return { ...terrain, source: src, ...plan, filled: Math.max(0, filled) };
}

/**
 * A cheap round trip to find out whether a source is actually usable from this
 * browser: reachable, CORS-friendly, and carrying data for this spot.
 */
export async function probeSource(source, projector, sizeM, opts = {}) {
  const src = normalizeSource(source);
  const started = Date.now();
  try {
    const terrain =
      src.type === 'openmeteo'
        ? await fetchSourceTerrain(src, projector, sizeM, { ...opts, targetResM: sizeM / 4 })
        : await (async () => {
            const { values, filled } = await fetchArcgisGrid(src, projector, sizeM, 16, opts);
            if (filled === -1) throw new Error('no data here');
            return terrainFromGrid(values, 16, sizeM);
          })();
    const spread = terrain.max - terrain.min;
    return {
      ok: true,
      ms: Date.now() - started,
      min: terrain.min,
      max: terrain.max,
      message: `Working — ${terrain.min.toFixed(0)} to ${terrain.max.toFixed(0)} m here (${spread.toFixed(0)} m of relief).`,
    };
  } catch (err) {
    const message = /Failed to fetch|NetworkError|CORS/i.test(err.message)
      ? `Unreachable from the browser (${err.message}). The service may block cross-origin requests.`
      : err.message;
    return { ok: false, ms: Date.now() - started, message };
  }
}

/**
 * Depth under water, for sources that carry bathymetry. The water surface comes
 * from the land DEM, which flattens lakes and the sea to their surface level.
 */
export function bathymetryFrom(terrain, surfaceTerrain) {
  if (!terrain) return null;
  return {
    sample: (x, y) => terrain.sample(x, y),
    surface: (x, y) => (surfaceTerrain ? surfaceTerrain.sample(x, y) : terrain.max),
  };
}

// ---------------------------------------------------------------------------
// Shaded relief, drawn by the service itself

// Only an image service can draw itself; a point-sampling API cannot.
export function canShade(source) {
  const src = normalizeSource(source);
  return src.type === 'arcgis' && !!src.url;
}

// The service's own multidirectional hillshade where it offers one (the USGS
// and NOAA mosaics do); otherwise the generic hillshade every image service
// understands. The generic one works in the image's own units — Web Mercator
// metres, which at `latDeg` are stretched by 1/cos(lat) — so the vertical is
// scaled to match, or every slope would look that much gentler than it is.
export async function shadingRule(source, latDeg, opts = {}) {
  const src = normalizeSource(source);
  const doFetch = opts.fetch || globalThis.fetch;
  const generic = {
    rasterFunction: 'Hillshade',
    rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1 / Math.cos((latDeg * Math.PI) / 180) },
  };
  if (!canShade(src)) return null;
  try {
    const res = await doFetch(`${src.url}?f=json`, { signal: opts.signal });
    if (!res.ok) return generic;
    const info = await res.json();
    const names = (info?.rasterFunctionInfos || []).map((f) => f.name);
    if (names.includes('Hillshade Multidirectional')) return { rasterFunction: 'Hillshade Multidirectional' };
    if (names.includes('Hillshade Gray')) return { rasterFunction: 'Hillshade Gray' };
  } catch {
    /* no catalogue — the generic function will do */
  }
  return generic;
}

// One map tile of shaded relief: `bbox` is {west, south, east, north} in
// Web Mercator metres (EPSG:3857), what a web map's tiles are laid out in.
export function shadeTileUrl(source, bbox, sizePx, rule) {
  const src = normalizeSource(source);
  const params = new URLSearchParams({
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${sizePx},${sizePx}`,
    format: 'jpgpng',
    renderingRule: JSON.stringify(rule),
    f: 'image',
  });
  return `${src.url}/exportImage?${params.toString()}`;
}
