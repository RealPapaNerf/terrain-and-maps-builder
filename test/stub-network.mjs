// A canned ArcGIS image service, so the CLI can be driven end to end without
// touching the network. Used as:
//
//   node --import ./test/stub-network.mjs bin/flmap.mjs build ...
//
// It stands in for the real service at the protocol level — the same
// exportImage query string, the same raw little-endian Float32 band-sequential
// body, rows north first, one sample per pixel centre — so what it exercises
// is the URL this tool builds and the decode it does, not a mock of them.
//
// What it CANNOT tell you is whether the real service is up, whether its URL
// is still right, or whether it holds data where you are pointing. Only
// `flmap probe` against the live services answers that.

const CENTER = [37.6775, -113.0628]; // near Cedar City, so the numbers look familiar

// Bare earth: a ridge to the north, a bowl to the south-west, gentle texture.
export const bareEarth = (lat, lon) => {
  const n = (lat - CENTER[0]) * 111132;
  const e = (lon - CENTER[1]) * 88000;
  let z = 1700;
  z += 190 * Math.exp(-((n - 320) ** 2) / (2 * 120 ** 2));
  z -= 45 * Math.exp(-(((n + 400) ** 2) / (2 * 170 ** 2) + ((e + 430) ** 2) / (2 * 170 ** 2)));
  z += 6 * Math.sin(n / 90) * Math.cos(e / 70);
  return z;
};

// A first-return surface: the bare earth with a stand of trees and one shed.
//
// The canopy is deliberately lumpy. A uniform slab of trees would be
// indistinguishable from a warehouse, and rightly so — what tells a tree stand
// from a building is that a building has a flat top and a canopy does not. A
// stub that served a flat slab would let a classifier that cannot tell them
// apart pass.
export const surfaceModel = (lat, lon) => {
  const n = (lat - CENTER[0]) * 111132;
  const e = (lon - CENTER[1]) * 88000;
  let z = bareEarth(lat, lon);
  if (n > 100 && n < 220 && e > -260 && e < -140) {
    // crowns 6 to 11 m, varying over about 15 m — the scale of real crowns
    z += 8.5 + 2.5 * Math.sin(n / 4.7) * Math.cos(e / 5.3) + 1.2 * Math.sin(e / 2.9 + 1);
  }
  if (n > -80 && n < -50 && e > 30 && e < 70) z += 4.2; // a flat-topped shed
  return z;
};

const grid = (href, fn) => {
  const params = new URL(href).searchParams;
  const [w, h] = params.get('size').split(',').map(Number);
  const [west, south, east, north] = params.get('bbox').split(',').map(Number);
  const buf = new ArrayBuffer(w * h * 4);
  const view = new DataView(buf);
  for (let row = 0; row < h; row++) {
    const lat = north - ((north - south) * (row + 0.5)) / h;
    for (let i = 0; i < w; i++) {
      const lon = west + ((east - west) * (i + 0.5)) / w;
      view.setFloat32((row * w + i) * 4, fn(lat, lon), true);
    }
  }
  return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
};

// A 1x1 JPEG, enough for the imagery path to recognise and write one
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

globalThis.fetch = async (url) => {
  const href = typeof url === 'string' ? url : url.url;
  if (href.includes('imagery.nationalmap.gov')) {
    return new Response(JPEG_1PX, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (href.includes('/dsm/')) return grid(href, surfaceModel);
  if (href.includes('exportImage')) return grid(href, bareEarth);
  if (href.includes('open-meteo')) {
    const params = new URL(href).searchParams;
    const lats = params.get('latitude').split(',').map(Number);
    const lons = params.get('longitude').split(',').map(Number);
    return new Response(JSON.stringify({ elevation: lats.map((la, i) => bareEarth(la, lons[i])) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`the stub was not expecting a request to ${href}`);
};
