/**
 * Détection des montées sur un profil altimétrique lissé, et situation du
 * cycliste par rapport à elles (montée en cours, prochaine montée).
 *
 * Méthode :
 *  1. On cherche un point bas, puis on « entre en montée » dès qu'on est
 *     MIN_RISE_M au-dessus. On suit le sommet ; la montée se termine quand on
 *     redescend de DROP_M sous ce sommet (une petite descente intermédiaire
 *     ne coupe donc pas une montée).
 *  2. On rogne les débuts/fins trop plats (pente < TRIM_GRADE sur 100 m) pour
 *     que « la montée commence dans 2 km » corresponde au vrai pied de la côte.
 *  3. On ne garde que les montées d'au moins MIN_GAIN_M et MIN_AVG_GRADE % de moyenne.
 */
import type { ElevationProfile } from './elevation';

export const MIN_RISE_M = 8;
export const DROP_M = 10;
export const MIN_GAIN_M = 20;
export const MIN_AVG_GRADE_PCT = 3;
const TRIM_GRADE = 0.02;
const TRIM_WINDOW_M = 100;

export interface Climb {
  startM: number;
  endM: number;
  lengthM: number;
  /** Dénivelé du pied au sommet (m). */
  gainM: number;
  avgGradePct: number;
  startEleM: number;
  topEleM: number;
}

export function detectClimbs(profile: ElevationProfile): Climb[] {
  const { distances: d, elevations: e } = profile;
  const n = e.length;
  const climbs: Climb[] = [];
  if (n < 2) return climbs;
  const w = Math.max(1, Math.round(TRIM_WINDOW_M / profile.step));

  const close = (low: number, top: number) => {
    let s = low;
    let t = top;
    // Rogne les parties presque plates au pied et au sommet.
    while (s + w < t && (e[s + w] - e[s]) / (d[s + w] - d[s]) < TRIM_GRADE) s++;
    while (t - w > s && (e[t] - e[t - w]) / (d[t] - d[t - w]) < TRIM_GRADE) t--;
    // Puis affinage point par point (le profil est déjà lissé).
    while (s + 1 < t && (e[s + 1] - e[s]) / (d[s + 1] - d[s]) < TRIM_GRADE) s++;
    while (t - 1 > s && (e[t] - e[t - 1]) / (d[t] - d[t - 1]) < TRIM_GRADE) t--;
    const lengthM = d[t] - d[s];
    const gainM = e[t] - e[s];
    if (lengthM <= 0) return;
    const avgGradePct = (gainM / lengthM) * 100;
    if (gainM >= MIN_GAIN_M && avgGradePct >= MIN_AVG_GRADE_PCT) {
      climbs.push({ startM: d[s], endM: d[t], lengthM, gainM, avgGradePct, startEleM: e[s], topEleM: e[t] });
    }
  };

  let climbing = false;
  let low = 0;
  let top = 0;
  for (let i = 1; i < n; i++) {
    if (!climbing) {
      if (e[i] < e[low]) low = i;
      else if (e[i] - e[low] >= MIN_RISE_M) {
        climbing = true;
        top = i;
      }
    } else if (e[i] >= e[top]) {
      top = i;
    } else if (e[top] - e[i] >= DROP_M) {
      close(low, top);
      climbing = false;
      low = i;
    }
  }
  if (climbing) close(low, top);
  return climbs;
}

/** Altitude interpolée sur le profil à une distance donnée. */
export function elevationAt(profile: ElevationProfile, alongM: number): number {
  const { distances: d, elevations: e, step } = profile;
  const n = e.length;
  if (n === 0) return 0;
  if (alongM <= 0) return e[0];
  if (alongM >= d[n - 1]) return e[n - 1];
  const i = Math.min(n - 2, Math.floor(alongM / step));
  const span = d[i + 1] - d[i];
  const t = span > 0 ? (alongM - d[i]) / span : 0;
  return e[i] + (e[i + 1] - e[i]) * t;
}

/** Pente (%) autour d'une distance, mesurée sur ± windowM/2. */
export function gradeAt(profile: ElevationProfile, alongM: number, windowM = 100): number {
  const total = profile.distances[profile.distances.length - 1] ?? 0;
  const a = Math.max(0, Math.min(total - windowM, alongM - windowM / 2));
  const b = Math.min(total, a + windowM);
  if (b <= a) return 0;
  return ((elevationAt(profile, b) - elevationAt(profile, a)) / (b - a)) * 100;
}

export interface ClimbStatus {
  /** Montée en cours, avec ce qui reste jusqu'au sommet. */
  current: { climb: Climb; remainingM: number; remainingGainM: number; gradePct: number } | null;
  /** Prochaine montée devant soi (après la montée en cours s'il y en a une). */
  next: { climb: Climb; distanceToStartM: number } | null;
}

export function climbStatus(climbs: readonly Climb[], profile: ElevationProfile, alongM: number): ClimbStatus {
  let current: ClimbStatus['current'] = null;
  let next: ClimbStatus['next'] = null;
  for (const c of climbs) {
    if (alongM >= c.startM && alongM < c.endM) {
      current = {
        climb: c,
        remainingM: c.endM - alongM,
        remainingGainM: Math.max(0, c.topEleM - elevationAt(profile, alongM)),
        gradePct: gradeAt(profile, alongM),
      };
    } else if (c.startM > alongM) {
      next = { climb: c, distanceToStartM: c.startM - alongM };
      break;
    }
  }
  return { current, next };
}
