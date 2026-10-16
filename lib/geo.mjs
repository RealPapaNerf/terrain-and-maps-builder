// ---------------------------------------------------------------------------
// The local metric projector from RealPapaNerf/relief, js/geo.js, at commit
// 5263350 — just the projection, without relief's print-boundary clipping.
// ---------------------------------------------------------------------------
// geo.js — local metric projection and convex-boundary clipping.
//
// Everything downstream works in metres on a flat local plane: for the map
// tiles we cut (a few hundred metres to a few kilometres across) the error of
// a local equirectangular projection is far below the resolution of a 3D
// printer, and it keeps the maths simple and dependency-free.

// Metres per degree of latitude / longitude at a given latitude.
export function metersPerDegree(latDeg) {
  const p = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

// Projector centred on (centerLat, centerLon). +x is east, +y is north.
export function makeProjector(centerLat, centerLon) {
  const m = metersPerDegree(centerLat);
  return {
    centerLat,
    centerLon,
    forward(lat, lon) {
      return [(lon - centerLon) * m.lon, (lat - centerLat) * m.lat];
    },
    inverse(x, y) {
      return [centerLat + y / m.lat, centerLon + x / m.lon];
    },
  };
}
