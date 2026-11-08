/**
 * Statistiques d'une sortie en cours, calculées à partir des positions déjà filtrées.
 *
 * - Vitesse : celle du GPS si disponible (mesure Doppler, fiable), sinon déduite
 *   des positions ; lissée sur quelques secondes pour l'affichage.
 * - Pause auto : on passe « en mouvement » au-dessus de MOVING_SPEED_MS et
 *   « à l'arrêt » sous STOPPED_SPEED_MS (hystérésis : pas de clignotement).
 * - Distance : comptée seulement en mouvement, par pas d'au moins MIN_STEP_M
 *   depuis le dernier point retenu → le « tremblement » GPS à l'arrêt n'ajoute rien.
 * - Trous (écran éteint) : si l'intervalle dépasse GAP_S, on utilise la vitesse
 *   moyenne sur le trou pour décider s'il compte comme temps en mouvement.
 * Le temps total, lui, est simplement « maintenant − départ ».
 */
import { haversine } from '../geo/distance';
import type { GpsFix } from '../gps/types';

export const MOVING_SPEED_MS = 3 / 3.6;
export const STOPPED_SPEED_MS = 1.5 / 3.6;
export const MIN_STEP_M = 5;
export const GAP_S = 15;
/** Au-delà, la vitesse affichée est considérée comme périmée. */
export const STALE_FIX_S = 10;
const SPEED_SMOOTHING_S = 3;

export interface RideSnapshot {
  distanceM: number;
  movingTimeS: number;
  totalTimeS: number;
  /** Vitesse lissée (m/s), null si pas de position récente. */
  speedMs: number | null;
  isMoving: boolean;
  lastFix: GpsFix | null;
}

export class RideTracker {
  private distanceM = 0;
  private movingTimeS = 0;
  private speedMs = 0;
  private moving = false;
  private anchor: GpsFix | null = null;
  private last: GpsFix | null = null;

  constructor(private readonly startTime: number) {}

  addFix(fix: GpsFix): void {
    const last = this.last;
    if (!last) {
      this.anchor = fix;
      this.last = fix;
      return;
    }
    const dt = (fix.time - last.time) / 1000;
    if (dt <= 0) return;

    const step = haversine(last.lat, last.lon, fix.lat, fix.lon);
    const isGap = dt > GAP_S;
    const raw = !isGap && fix.speed !== null && fix.speed >= 0 ? fix.speed : step / dt;

    // Lissage exponentiel (constante de temps ~3 s). Après un trou, on repart de la mesure brute.
    const alpha = isGap ? 1 : 1 - Math.exp(-dt / SPEED_SMOOTHING_S);
    this.speedMs += alpha * (raw - this.speedMs);

    if (!this.moving && raw >= MOVING_SPEED_MS) this.moving = true;
    else if (this.moving && raw < STOPPED_SPEED_MS) this.moving = false;
    if (isGap) this.moving = raw >= MOVING_SPEED_MS;

    if (this.moving) {
      this.movingTimeS += dt;
      const anchor = this.anchor ?? last;
      const fromAnchor = haversine(anchor.lat, anchor.lon, fix.lat, fix.lon);
      if (fromAnchor >= MIN_STEP_M) {
        this.distanceM += fromAnchor;
        this.anchor = fix;
      }
    }
    this.last = fix;
  }

  snapshot(now: number): RideSnapshot {
    const fresh = this.last !== null && (now - this.last.time) / 1000 <= STALE_FIX_S;
    return {
      distanceM: this.distanceM,
      movingTimeS: this.movingTimeS,
      totalTimeS: Math.max(0, (now - this.startTime) / 1000),
      speedMs: fresh ? (this.moving ? this.speedMs : 0) : null,
      isMoving: fresh && this.moving,
      lastFix: this.last,
    };
  }
}
