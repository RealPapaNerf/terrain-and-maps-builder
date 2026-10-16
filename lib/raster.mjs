// ---------------------------------------------------------------------------
// Copied verbatim from RealPapaNerf/relief, js/raster.js, at commit 5263350.
// relief is the LiDAR-to-STL tool this builder's elevation layer comes from;
// that code is already proven against the live services, so it is reused as
// it stands rather than rewritten. Keep edits here to a minimum so the two
// copies can still be diffed. MIT, same as both repos.
// ---------------------------------------------------------------------------
// raster.js — just enough raster decoding to read elevation out of an ArcGIS
// image service without pulling in a GIS library.
//
// Two formats cover it: `bsq`, which is a bare grid of values, and
// uncompressed GeoTIFF, which most services will emit as a fallback.

const NO_DATA = (v) => !isFinite(v) || v < -1e30 || v > 1e30;

// Score a grid on how much it looks like ground elevation. Reading floats with
// the bytes the wrong way round almost always lands in the denormal or huge
// end of the range, and destroys the smoothness a real surface has.
function plausibility(values) {
  const stride = Math.max(1, Math.floor(values.length / 4096));
  let good = 0;
  let seen = 0;
  for (let i = 0; i < values.length; i += stride) {
    const v = values[i];
    seen++;
    if (NO_DATA(v)) continue;
    // Denormals and near-zero noise are the signature of swapped bytes.
    if (v > -12000 && v < 9000 && (v === 0 || Math.abs(v) > 1e-3)) good++;
  }
  return { good, ratio: seen ? good / seen : 0, roughness: roughness(values, stride) };
}

// Mean step between neighbouring samples, relative to the spread. A real
// surface is smooth; byte-swapped noise is not.
function roughness(values, stride) {
  let sum = 0;
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = stride; i < values.length; i += stride) {
    const a = values[i - stride];
    const b = values[i];
    if (NO_DATA(a) || NO_DATA(b)) continue;
    sum += Math.abs(b - a);
    n++;
    if (a < min) min = a;
    if (a > max) max = a;
  }
  if (!n || !isFinite(min) || max === min) return Infinity;
  return sum / n / (max - min);
}

function better(a, b) {
  if (a.good !== b.good) return a.good > b.good;
  return a.roughness <= b.roughness;
}

/**
 * Decode a band-sequential float grid. Byte order is not declared anywhere in
 * the response, so both are tried and the one that yields elevations wins.
 */
export function decodeFloatGrid(buffer, width, height) {
  const expected = width * height * 4;
  if (buffer.byteLength < expected) {
    throw new Error(`expected ${expected} bytes for ${width}x${height}, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer, 0, expected);
  const little = new Float32Array(width * height);
  const big = new Float32Array(width * height);
  for (let i = 0; i < little.length; i++) {
    little[i] = view.getFloat32(i * 4, true);
    big[i] = view.getFloat32(i * 4, false);
  }
  return better(plausibility(little), plausibility(big)) ? little : big;
}

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, photometric: 262,
  stripOffsets: 273, samplesPerPixel: 277, rowsPerStrip: 278, stripByteCounts: 279,
  planar: 284, tileWidth: 322, tileLength: 323, tileOffsets: 324, tileByteCounts: 325,
  sampleFormat: 339, pixelScale: 33550, tiepoint: 33922,
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/**
 * Minimal GeoTIFF reader: single band, uncompressed, strips or tiles.
 * Enough for `format=tiff&compression=none` from an image service; anything
 * else throws so the caller can fall back or report it honestly.
 */
export function decodeGeoTiff(buffer) {
  const view = new DataView(buffer);
  const order = view.getUint16(0, true);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) throw new Error('not a TIFF');
  if (view.getUint16(2, le) !== 42) throw new Error('unsupported TIFF version');

  const entries = new Map();
  const ifd = view.getUint32(4, le);
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const off = ifd + 2 + i * 12;
    const tag = view.getUint16(off, le);
    const type = view.getUint16(off + 2, le);
    const n = view.getUint32(off + 4, le);
    const size = (TYPE_SIZE[type] || 1) * n;
    const base = size <= 4 ? off + 8 : view.getUint32(off + 8, le);
    const values = [];
    for (let k = 0; k < n; k++) {
      const at = base + k * (TYPE_SIZE[type] || 1);
      switch (type) {
        case 1: case 2: case 6: case 7: values.push(view.getUint8(at)); break;
        case 3: values.push(view.getUint16(at, le)); break;
        case 8: values.push(view.getInt16(at, le)); break;
        case 4: values.push(view.getUint32(at, le)); break;
        case 9: values.push(view.getInt32(at, le)); break;
        case 11: values.push(view.getFloat32(at, le)); break;
        case 12: values.push(view.getFloat64(at, le)); break;
        default: values.push(0);
      }
    }
    entries.set(tag, values);
  }

  const first = (tag, fallback) => (entries.has(tag) ? entries.get(tag)[0] : fallback);
  const width = first(TAG.width);
  const height = first(TAG.height);
  if (!width || !height) throw new Error('TIFF has no dimensions');
  if (first(TAG.compression, 1) !== 1) throw new Error('compressed TIFF is not supported');
  if (first(TAG.samplesPerPixel, 1) !== 1) throw new Error('only single-band TIFF is supported');

  // Where the image sits, if it says: ModelTiepoint maps a pixel corner to a
  // ground position and ModelPixelScale gives the cell size. The image's own
  // units — degrees for a 4326 request — with rows running north to south.
  let geo = null;
  const tie = entries.get(TAG.tiepoint);
  const scale = entries.get(TAG.pixelScale);
  if (tie && tie.length >= 6 && scale && scale.length >= 2 && scale[0] > 0 && scale[1] > 0) {
    const west = tie[3] - tie[0] * scale[0];
    const north = tie[4] + tie[1] * scale[1];
    geo = { west, north, east: west + width * scale[0], south: north - height * scale[1] };
  }

  const bits = first(TAG.bits, 32);
  const format = first(TAG.sampleFormat, 1); // 1 uint, 2 int, 3 float
  const read = pixelReader(view, le, bits, format);
  const out = new Float32Array(width * height);
  const bytes = bits / 8;

  if (entries.has(TAG.tileOffsets)) {
    const tw = first(TAG.tileWidth);
    const th = first(TAG.tileLength);
    const offsets = entries.get(TAG.tileOffsets);
    const across = Math.ceil(width / tw);
    for (let t = 0; t < offsets.length; t++) {
      const tx = (t % across) * tw;
      const ty = Math.floor(t / across) * th;
      for (let j = 0; j < th; j++) {
        const y = ty + j;
        if (y >= height) break;
        for (let i = 0; i < tw; i++) {
          const x = tx + i;
          if (x >= width) continue;
          out[y * width + x] = read(offsets[t] + (j * tw + i) * bytes);
        }
      }
    }
    return { width, height, values: out, geo };
  }

  const offsets = entries.get(TAG.stripOffsets);
  if (!offsets) throw new Error('TIFF has neither strips nor tiles');
  const rowsPerStrip = first(TAG.rowsPerStrip, height);
  for (let s = 0; s < offsets.length; s++) {
    for (let r = 0; r < rowsPerStrip; r++) {
      const y = s * rowsPerStrip + r;
      if (y >= height) break;
      for (let x = 0; x < width; x++) {
        out[y * width + x] = read(offsets[s] + (r * width + x) * bytes);
      }
    }
  }
  return { width, height, values: out, geo };
}

function pixelReader(view, le, bits, format) {
  if (format === 3 && bits === 32) return (o) => view.getFloat32(o, le);
  if (format === 3 && bits === 64) return (o) => view.getFloat64(o, le);
  if (format === 2 && bits === 16) return (o) => view.getInt16(o, le);
  if (format === 2 && bits === 32) return (o) => view.getInt32(o, le);
  if (bits === 16) return (o) => view.getUint16(o, le);
  if (bits === 32) return (o) => view.getUint32(o, le);
  if (bits === 8) return (o) => view.getUint8(o);
  throw new Error(`unsupported TIFF sample: ${bits}-bit format ${format}`);
}

/**
 * Replace no-data cells with the nearest real value, so a gap at the edge of a
 * survey does not punch a hole in the model. Returns how many were filled.
 */
export function fillNoData(values, width, height) {
  const bad = [];
  for (let i = 0; i < values.length; i++) if (NO_DATA(values[i])) bad.push(i);
  if (!bad.length) return 0;
  if (bad.length === values.length) return -1; // nothing to fill from

  // Repeated neighbour averaging converges quickly and keeps the code short.
  const filled = new Uint8Array(values.length);
  for (const i of bad) filled[i] = 1;
  let remaining = bad.length;
  for (let pass = 0; pass < 64 && remaining; pass++) {
    let progressed = 0;
    for (const i of bad) {
      if (!filled[i]) continue;
      const x = i % width;
      const y = Math.floor(i / width);
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const k = ny * width + nx;
          if (filled[k]) continue;
          sum += values[k];
          n++;
        }
      }
      if (!n) continue;
      values[i] = sum / n;
      filled[i] = 0;
      remaining--;
      progressed++;
    }
    if (!progressed) break;
  }
  for (const i of bad) if (filled[i]) values[i] = 0;
  return bad.length;
}

export const isNoData = NO_DATA;
