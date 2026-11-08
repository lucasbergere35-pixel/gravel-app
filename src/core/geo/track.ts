import type { TrackPoint } from '../types';

/**
 * Position interpolée sur le tracé à une distance donnée depuis le départ.
 * `cumDist` = distances cumulées des points (voir cumulativeDistances).
 */
export function pointAtDistance(
  points: readonly TrackPoint[],
  cumDist: readonly number[],
  distanceM: number,
): { lat: number; lon: number } | null {
  const n = points.length;
  if (n === 0) return null;
  if (distanceM <= 0 || n === 1) return { lat: points[0].lat, lon: points[0].lon };
  if (distanceM >= cumDist[n - 1]) return { lat: points[n - 1].lat, lon: points[n - 1].lon };

  // Recherche dichotomique du segment [lo, lo+1] contenant distanceM.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= distanceM) lo = mid;
    else hi = mid;
  }
  const span = cumDist[hi] - cumDist[lo];
  const t = span > 0 ? (distanceM - cumDist[lo]) / span : 0;
  return {
    lat: points[lo].lat + (points[hi].lat - points[lo].lat) * t,
    lon: points[lo].lon + (points[hi].lon - points[lo].lon) * t,
  };
}
