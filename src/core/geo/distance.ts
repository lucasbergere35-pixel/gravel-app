/** Rayon moyen de la Terre (m), valeur IUGG. */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Distance « à vol d'oiseau » entre deux points (formule de haversine), en mètres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance cumulée depuis le départ pour chaque point (m).
 * Le résultat a la même longueur que `points` ; le premier élément vaut 0.
 */
export function cumulativeDistances(points: ReadonlyArray<{ lat: number; lon: number }>): number[] {
  const out: number[] = new Array(points.length);
  if (points.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    out[i] = out[i - 1] + haversine(a.lat, a.lon, b.lat, b.lon);
  }
  return out;
}
