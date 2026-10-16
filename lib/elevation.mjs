// ---------------------------------------------------------------------------
// Copied verbatim from RealPapaNerf/relief, js/elevation.js, at commit 5263350.
// relief is the LiDAR-to-STL tool this builder's elevation layer comes from;
// that code is already proven against the live services, so it is reused as
// it stands rather than rewritten. Keep edits here to a minimum so the two
// copies can still be diffed. MIT, same as both repos.
// ---------------------------------------------------------------------------
// elevation.js — optional terrain, sampled from Open-Meteo's free elevation
// API (no key, no account). Returns a bilinear sampler in local metres.

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100; // the API's per-request coordinate limit

export async function fetchTerrain(projector, sizeM, n = 20, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const onProgress = opts.onProgress || (() => {});
  const half = sizeM / 2;
  const step = n > 1 ? sizeM / (n - 1) : 0;

  const lats = [];
  const lons = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [lat, lon] = projector.inverse(-half + i * step, -half + j * step);
      lats.push(lat);
      lons.push(lon);
    }
  }

  const values = new Float64Array(n * n);
  for (let start = 0; start < lats.length; start += BATCH) {
    const end = Math.min(start + BATCH, lats.length);
    onProgress(`Sampling elevation ${Math.round((end / lats.length) * 100)}%…`);
    const url =
      `${ENDPOINT}?latitude=${lats.slice(start, end).map((v) => v.toFixed(6)).join(',')}` +
      `&longitude=${lons.slice(start, end).map((v) => v.toFixed(6)).join(',')}`;
    const res = await doFetch(url, { signal: opts.signal });
    if (!res.ok) throw new Error(`elevation service returned ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.elevation)) throw new Error('unexpected elevation response');
    for (let k = 0; k < end - start; k++) values[start + k] = json.elevation[k] ?? 0;
  }

  return terrainFromGrid(values, n, sizeM);
}

export function terrainFromGrid(values, n, sizeM) {
  const half = sizeM / 2;
  const step = n > 1 ? sizeM / (n - 1) : 1;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const at = (i, j) => values[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];

  return {
    n,
    values,
    min,
    max,
    sample(x, y) {
      const fx = (x + half) / step;
      const fy = (y + half) / step;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const tx = fx - i;
      const ty = fy - j;
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    },
  };
}
