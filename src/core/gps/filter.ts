/**
 * Filtre des positions GPS aberrantes, pour éviter les « sauts » sur la carte
 * et les kilomètres fantômes.
 *
 * Une position est rejetée si :
 *  - sa précision annoncée est moins bonne que MAX_ACCURACY_M ;
 *  - elle n'est pas plus récente que la précédente ;
 *  - elle implique une vitesse impossible à vélo (> MAX_SPEED_MS), en laissant
 *    une marge égale aux précisions des deux points.
 * Sécurité : après MAX_SPEED_REJECTS rejets « vitesse » d'affilée, on suppose
 * que c'est la position de référence qui était fausse et on accepte.
 */
import { haversine } from '../geo/distance';
import type { GpsFix } from './types';

export const MAX_ACCURACY_M = 30;
export const MAX_SPEED_MS = 25; // 90 km/h
const MAX_SPEED_REJECTS = 3;

export type FilterResult = { ok: true } | { ok: false; reason: 'invalid' | 'accuracy' | 'time' | 'speed' };

export class GpsFilter {
  private last: GpsFix | null = null;
  private speedRejects = 0;

  constructor(
    private readonly maxAccuracy = MAX_ACCURACY_M,
    private readonly maxSpeed = MAX_SPEED_MS,
  ) {}

  /** Définit la dernière position valide (reprise d'une sortie). */
  prime(fix: GpsFix | null): void {
    this.last = fix;
    this.speedRejects = 0;
  }

  check(fix: GpsFix): FilterResult {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.time)) {
      return { ok: false, reason: 'invalid' };
    }
    if (!(fix.accuracy <= this.maxAccuracy)) return { ok: false, reason: 'accuracy' };
    const last = this.last;
    if (last) {
      const dt = (fix.time - last.time) / 1000;
      if (dt <= 0) return { ok: false, reason: 'time' };
      const d = haversine(last.lat, last.lon, fix.lat, fix.lon);
      const plausible = Math.max(0, d - fix.accuracy - last.accuracy);
      if (plausible / dt > this.maxSpeed && this.speedRejects < MAX_SPEED_REJECTS) {
        this.speedRejects++;
        return { ok: false, reason: 'speed' };
      }
    }
    this.speedRejects = 0;
    this.last = fix;
    return { ok: true };
  }
}
