// utm.mjs — WGS84 latitude/longitude to UTM.
//
// A Flightline map carries its origin as both lat/lon and UTM easting/northing,
// so a map can be lined up against a paper topo or a GPS set to UTM without
// anyone having to convert by hand in the field.
//
// This is the standard Transverse Mercator series (Snyder, Map Projections — A
// Working Manual, USGS Professional Paper 1395, equations 8-9 to 8-15), good to
// well under a millimetre inside a zone, which is far better than the metre the
// map's cells are measured in.

const A = 6378137.0; // WGS84 semi-major axis, metres
const F = 1 / 298.257223563; // flattening
const K0 = 0.9996; // UTM scale factor on the central meridian
const E2 = F * (2 - F); // first eccentricity squared
const EP2 = E2 / (1 - E2); // second eccentricity squared
const D2R = Math.PI / 180;

/** The UTM zone a longitude falls in. 1 to 60, each 6 degrees wide. */
export function zoneFor(lonDeg) {
  const lon = ((lonDeg + 180) % 360 + 360) % 360 - 180; // wrap to [-180, 180)
  return Math.floor((lon + 180) / 6) + 1;
}

/** The central meridian of a zone, in degrees. */
export const centralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

/**
 * Project a WGS84 point to UTM.
 * @param {number} latDeg  -80 to 84; outside that UTM is not defined and UPS is used instead.
 * @param {number} lonDeg
 * @param {number} [forceZone]  use this zone rather than the natural one, for a
 *        map that straddles a zone boundary and should stay in one of them.
 * @returns {{zone, hemisphere, easting, northing, convergence}}
 *        `convergence` is grid north minus true north, in degrees: how far the
 *        map's north is from the north a compass needle's chart would call
 *        north. Small near the central meridian, up to about 3 degrees at a
 *        zone edge.
 *
 * The zone exceptions around southern Norway (31V/32V) and Svalbard (31X–37X)
 * are NOT applied: they shift the boundaries for a handful of cells in two
 * places on Earth, and applying them silently would put a map in a different
 * zone from the one `zoneFor` reports. Pass `forceZone` if you are working
 * there and need the official zone.
 */
export function toUTM(latDeg, lonDeg, forceZone) {
  if (!(latDeg >= -80 && latDeg <= 84)) {
    throw new Error(`UTM is not defined at latitude ${latDeg}; it covers -80 to 84 degrees`);
  }
  const zone = forceZone || zoneFor(lonDeg);
  const lat = latDeg * D2R;
  const lon0 = centralMeridian(zone) * D2R;
  const lon = lonDeg * D2R;

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = EP2 * cosLat * cosLat;
  // keep the longitude difference inside half a turn, so a map near the
  // antimeridian does not project to the far side of the world
  let dLon = lon - lon0;
  while (dLon > Math.PI) dLon -= 2 * Math.PI;
  while (dLon < -Math.PI) dLon += 2 * Math.PI;
  const Aa = dLon * cosLat;

  // meridional arc from the equator
  const M = A * (
    (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * lat
    - ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) * Math.sin(2 * lat)
    + ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * lat)
    - ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * lat)
  );

  const A2 = Aa * Aa, A3 = A2 * Aa, A4 = A3 * Aa, A5 = A4 * Aa, A6 = A5 * Aa;
  const easting = K0 * N * (Aa + ((1 - T + C) * A3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * A5) / 120) + 500000;
  let northing = K0 * (M + N * tanLat * (A2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * A6) / 720));
  const hemisphere = latDeg < 0 ? 'S' : 'N';
  if (latDeg < 0) northing += 10000000; // false northing in the south

  // grid convergence, to the same order
  const convergence = (dLon * sinLat * (1 + (dLon * dLon * cosLat * cosLat * (1 + 3 * C + 2 * C * C)) / 3)) / D2R;

  return { zone, hemisphere, easting, northing, convergence };
}

/** A UTM point as the string a GPS or a topo sheet would show. */
export const formatUTM = (u) => `${u.zone}${u.hemisphere} ${Math.round(u.easting)}E ${Math.round(u.northing)}N`;

/**
 * UTM back to WGS84 latitude/longitude (Snyder 8-17 to 8-23). This is a
 * different series from the forward one, not an inversion of it, so a round
 * trip that closes is real evidence both are right rather than a tautology.
 */
export function toLatLon(easting, northing, zone, hemisphere = 'N') {
  const x = easting - 500000;
  const y = hemisphere === 'S' ? northing - 10000000 : northing;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const C1 = EP2 * cos1 * cos1;
  const T1 = tan1 * tan1;
  const N1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sin1 * sin1, 1.5);
  const D = x / (N1 * K0);
  const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D;

  const lat = phi1 - ((N1 * tan1) / R1) * (D2 / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D5) / 120) / cos1;

  return [lat / D2R, centralMeridian(zone) + lon / D2R];
}
