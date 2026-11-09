/**
 * Classes de pente pour colorer le profil altimétrique
 * (vert < 3 %, jaune 3–6 %, orange 6–9 %, rouge > 9 %).
 * On regarde la pente en valeur absolue : une descente raide est aussi signalée.
 */
import { gradeAt } from './climbs';
import type { ElevationProfile } from './elevation';

export type SlopeClass = 0 | 1 | 2 | 3;

export const SLOPE_CLASSES: readonly { label: string; color: string }[] = [
  { label: '< 3 %', color: '#43a047' },
  { label: '3–6 %', color: '#f9c21a' },
  { label: '6–9 %', color: '#fb8c00' },
  { label: '> 9 %', color: '#e53935' },
];

export function slopeClass(gradePct: number): SlopeClass {
  const g = Math.abs(gradePct);
  if (g < 3) return 0;
  if (g < 6) return 1;
  if (g <= 9) return 2;
  return 3;
}

export interface SlopeRun {
  cls: SlopeClass;
  /** Indices (inclus) dans le profil. */
  from: number;
  to: number;
}

/**
 * Découpe le profil en tronçons de même classe de pente (pente mesurée sur 100 m).
 * Les tronçons se touchent : `to` d'un tronçon = `from` du suivant.
 */
export function slopeRuns(profile: ElevationProfile, windowM = 100): SlopeRun[] {
  const { distances } = profile;
  const n = distances.length;
  if (n < 2) return [];
  const runs: SlopeRun[] = [];
  for (let i = 0; i < n - 1; i++) {
    const mid = (distances[i] + distances[i + 1]) / 2;
    const cls = slopeClass(gradeAt(profile, mid, windowM));
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.to = i + 1;
    else runs.push({ cls, from: i, to: i + 1 });
  }
  return runs;
}
