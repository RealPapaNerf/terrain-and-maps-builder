// imagery.mjs — an orthophoto to drape over the terrain.
//
// Same ArcGIS image service mechanism the elevation uses, asking for a JPEG
// instead of a float grid. The map format wants the image to cover the grid
// corner to corner, so the request is the grid's own bounding box and the
// aspect ratio is made to match.
//
// IMPORTANT, and the reason every URL here carries a `verified` flag: these
// service endpoints move. The elevation service in sources.mjs is one the
// relief tool exercises against the live server in its own tests, so it is
// known good. The imagery services below are NOT — they are written from the
// published USGS service names and have not been reached from this machine.
// `flmap probe` is what turns an unverified URL into a verified one, and
// `flmap build --color` refuses to carry on quietly if the probe has not
// passed. Do not take the `verified: false` entries as working.

export const IMAGERY_PRESETS = [
  {
    id: 'naip',
    label: 'USGS NAIP — United States, about 0.6 m',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer',
    attribution: 'USGS National Agriculture Imagery Program (public domain)',
    resolutionM: 0.6,
    verified: false,
  },
  {
    id: 'naip-plus',
    label: 'USGS NAIP Plus — United States, about 1 m',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer',
    attribution: 'USGS National Agriculture Imagery Program (public domain)',
    resolutionM: 1,
    verified: false,
  },
];

export const findImagery = (id) => IMAGERY_PRESETS.find((s) => s.id === id) || null;

/**
 * Build the exportImage URL for the grid's exact footprint.
 * `box` is {west, south, east, north} in degrees.
 */
export function imageryUrl(service, box, pxW, pxH, format = 'jpg') {
  const params = new URLSearchParams({
    bbox: `${box.west},${box.south},${box.east},${box.north}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${pxW},${pxH}`,
    format,
    f: 'image',
  });
  return `${String(service.url).replace(/\/+$/, '')}/exportImage?${params.toString()}`;
}

/**
 * Pick an image size: a power of two per side, because WebGL 1 will not
 * mipmap a non-power-of-two texture and an un-mipmapped orthophoto shimmers
 * badly at distance. Capped so a map stays downloadable on a phone tether.
 */
export function imagerySize(sizeM, resolutionM, maxPx = 2048) {
  const wanted = sizeM / Math.max(0.1, resolutionM);
  let px = 256;
  while (px * 2 <= Math.min(maxPx, wanted)) px *= 2;
  return px;
}

/** Fetch the orthophoto. Returns the raw bytes and the file name to write. */
export async function fetchImagery(service, box, px, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const url = imageryUrl(service, box, px, px, opts.format || 'jpg');
  const res = await doFetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`${service.label}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // ArcGIS answers errors with JSON and a 200, so the body has to be sniffed
  if (buf[0] === 0x7b) {
    let why = 'the service returned an error rather than an image';
    try { why = JSON.parse(buf.toString('utf8').slice(0, 2000)).error?.message || why; } catch { /* keep the default */ }
    throw new Error(`${service.label}: ${why}`);
  }
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpeg && !isPng) throw new Error(`${service.label}: the response is neither JPEG nor PNG (first bytes ${buf.subarray(0, 4).toString('hex')})`);
  return { buf, file: isJpeg ? 'color.jpg' : 'color.png', px };
}
