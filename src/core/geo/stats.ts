import type { TrackPoint } from '../types';
import { cumulativeDistances } from './distance';
import { buildElevationProfile, climbAndDescent } from './elevation';

/**
 * Version de l'algorithme de statistiques. À incrémenter si le calcul change :
 * les statistiques enregistrées seront alors recalculées automatiquement.
 */
export const STATS_VERSION = 1;

export interface RouteStats {
  distanceM: number;
  gainM: number;
  lossM: number;
  minEleM: number | null;
  maxEleM: number | null;
  hasElevation: boolean;
  pointCount: number;
}

export function computeRouteStats(points: readonly TrackPoint[]): RouteStats {
  const cum = cumulativeDistances(points);
  const distanceM = cum.length ? cum[cum.length - 1] : 0;
  const profile = buildElevationProfile(points, cum);
  if (!profile) {
    return { distanceM, gainM: 0, lossM: 0, minEleM: null, maxEleM: null, hasElevation: false, pointCount: points.length };
  }
  const { gain, loss } = climbAndDescent(profile.elevations);
  let min = Infinity;
  let max = -Infinity;
  for (const e of profile.elevations) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  return {
    distanceM,
    gainM: gain,
    lossM: loss,
    minEleM: min,
    maxEleM: max,
    hasElevation: true,
    pointCount: points.length,
  };
}

/**
 * Durée estimée (s) à partir de la vitesse moyenne habituelle en gravel.
 * Cette vitesse moyenne inclut déjà les montées d'une sortie typique ;
 * le modèle physique (étape 3) affinera par segment.
 */
export function estimateDurationS(distanceM: number, avgSpeedKmh: number): number {
  if (!(avgSpeedKmh > 0)) return 0;
  return distanceM / (avgSpeedKmh / 3.6);
}
