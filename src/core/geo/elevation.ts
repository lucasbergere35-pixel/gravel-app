/**
 * Profil altimétrique et calcul du dénivelé.
 *
 * Problème : les altitudes GPS/GPX sont bruitées. Additionner toutes les petites
 * variations surestime fortement le dénivelé (parfois +30 %).
 *
 * Méthode (simple et éprouvée) :
 *  1. on comble les altitudes manquantes par interpolation ;
 *  2. on ré-échantillonne le tracé tous les PROFILE_STEP_M mètres (pas régulier,
 *     indépendant de la densité de points du fichier) ;
 *  3. moyenne glissante sur SMOOTHING_WINDOW_M mètres ;
 *  4. hystérésis : une variation n'est comptée que lorsqu'elle dépasse
 *     HYSTERESIS_M mètres depuis le dernier point de référence.
 */
import type { TrackPoint } from '../types';
import { cumulativeDistances } from './distance';

export const PROFILE_STEP_M = 10;
export const SMOOTHING_WINDOW_M = 100;
export const HYSTERESIS_M = 4;

export interface ElevationProfile {
  /** Pas d'échantillonnage (m). */
  step: number;
  /** Distance depuis le départ (m), pas régulier sauf le dernier point. */
  distances: number[];
  /** Altitude lissée (m), même longueur que `distances`. */
  elevations: number[];
}

/**
 * Remplace les altitudes manquantes (null) par interpolation linéaire selon la distance.
 * Retourne null si aucune altitude n'est connue.
 */
export function fillMissingElevations(eles: ReadonlyArray<number | null>, dists: readonly number[]): number[] | null {
  const known: number[] = [];
  eles.forEach((e, i) => {
    if (e !== null && Number.isFinite(e)) known.push(i);
  });
  if (known.length === 0) return null;

  const out: number[] = new Array(eles.length);
  const first = known[0];
  const last = known[known.length - 1];
  for (let i = 0; i <= first; i++) out[i] = eles[first] as number;
  for (let i = last; i < eles.length; i++) out[i] = eles[last] as number;
  for (let k = 0; k < known.length - 1; k++) {
    const i0 = known[k];
    const i1 = known[k + 1];
    const e0 = eles[i0] as number;
    const e1 = eles[i1] as number;
    const span = dists[i1] - dists[i0];
    for (let i = i0; i <= i1; i++) {
      const t = span > 0 ? (dists[i] - dists[i0]) / span : 0;
      out[i] = e0 + (e1 - e0) * t;
    }
  }
  return out;
}

/** Ré-échantillonne une série (distance → valeur) à pas régulier par interpolation linéaire. */
export function resample(
  dists: readonly number[],
  values: readonly number[],
  step: number,
): { distances: number[]; values: number[] } {
  if (dists.length === 0) return { distances: [], values: [] };
  if (dists.length === 1) return { distances: [0], values: [values[0]] };

  const total = dists[dists.length - 1];
  const outD: number[] = [];
  const outV: number[] = [];
  let j = 0;
  for (let k = 0; k * step <= total; k++) {
    const d = k * step;
    while (j < dists.length - 2 && dists[j + 1] < d) j++;
    const d0 = dists[j];
    const d1 = dists[j + 1];
    const t = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 0;
    outD.push(d);
    outV.push(values[j] + (values[j + 1] - values[j]) * t);
  }
  if (outD[outD.length - 1] < total) {
    outD.push(total);
    outV.push(values[values.length - 1]);
  }
  return { distances: outD, values: outV };
}

/** Moyenne glissante centrée (fenêtre de 2·halfWindow+1 valeurs, réduite aux bords). */
export function movingAverage(values: readonly number[], halfWindow: number): number[] {
  const n = values.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWindow);
    const b = Math.min(n - 1, i + halfWindow);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

/** Dénivelé positif et négatif avec seuil d'hystérésis (m). */
export function climbAndDescent(elevations: readonly number[], threshold = HYSTERESIS_M): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  if (elevations.length === 0) return { gain, loss };
  let ref = elevations[0];
  for (const e of elevations) {
    const diff = e - ref;
    if (diff >= threshold) {
      gain += diff;
      ref = e;
    } else if (diff <= -threshold) {
      loss -= diff;
      ref = e;
    }
  }
  return { gain, loss };
}

/**
 * D+ cumulé depuis le départ pour chaque échantillon (même méthode d'hystérésis
 * que climbAndDescent). Permet d'obtenir le D+ restant : total − cumul[i].
 */
export function cumulativeClimb(elevations: readonly number[], threshold = HYSTERESIS_M): number[] {
  const out = new Array<number>(elevations.length);
  let gain = 0;
  let ref = elevations[0];
  for (let i = 0; i < elevations.length; i++) {
    const diff = elevations[i] - ref;
    if (diff >= threshold) {
      gain += diff;
      ref = elevations[i];
    } else if (diff <= -threshold) {
      ref = elevations[i];
    }
    out[i] = gain;
  }
  return out;
}

/** D+ restant (m) à partir d'une distance le long du profil. */
export function remainingClimb(profile: ElevationProfile, cumClimb: readonly number[], alongM: number): number {
  const n = cumClimb.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.floor(alongM / profile.step)));
  return Math.max(0, cumClimb[n - 1] - cumClimb[i]);
}

/**
 * Construit le profil altimétrique lissé d'un tracé.
 * Retourne null si le tracé n'a aucune altitude.
 */
export function buildElevationProfile(
  points: readonly TrackPoint[],
  cumDist: readonly number[] = cumulativeDistances(points),
): ElevationProfile | null {
  const filled = fillMissingElevations(
    points.map((p) => p.ele),
    cumDist,
  );
  if (!filled) return null;
  const sampled = resample(cumDist, filled, PROFILE_STEP_M);
  const halfWindow = Math.max(1, Math.round(SMOOTHING_WINDOW_M / 2 / PROFILE_STEP_M));
  return {
    step: PROFILE_STEP_M,
    distances: sampled.distances,
    elevations: movingAverage(sampled.values, halfWindow),
  };
}
