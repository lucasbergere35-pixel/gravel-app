/**
 * Direction de marche (cap) calculée à partir des déplacements GPS.
 *
 * - On ne calcule un nouveau cap qu'au-dessus de HEADING_MIN_SPEED_MS (~5 km/h) :
 *   à l'arrêt ou en poussant le vélo, le bruit GPS ferait tourner la carte dans
 *   tous les sens. On garde alors le dernier cap connu.
 * - On attend d'avoir parcouru au moins HEADING_MIN_DIST_M depuis le dernier
 *   point de référence : sur une distance plus longue, le bruit de quelques
 *   mètres pèse moins sur l'angle.
 * - Lissage circulaire (on tourne toujours par le plus court chemin : 350° → 10°
 *   passe par 0°, pas par 180°).
 */
import { haversine } from '../geo/distance';
import type { GpsFix } from './types';

export const HEADING_MIN_SPEED_MS = 5 / 3.6;
export const HEADING_MIN_DIST_M = 10;
/** Part du nouveau cap mesuré à chaque mise à jour (0..1). Plus petit = plus lisse. */
export const HEADING_SMOOTHING = 0.4;

const DEG = Math.PI / 180;

/** Cap (0 = nord, 90 = est) pour aller du point 1 au point 2, en degrés [0, 360). */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeAngle(Math.atan2(y, x) / DEG);
}

export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Plus petit écart signé de `from` vers `to`, dans [-180, 180). */
export function angleDiff(to: number, from: number): number {
  return normalizeAngle(to - from + 180) - 180;
}

export class HeadingEstimator {
  private ref: GpsFix | null = null;
  private current: number | null = null;

  get heading(): number | null {
    return this.current;
  }

  /** Ajoute une position (déjà filtrée) ; retourne le cap lissé, ou null s'il est encore inconnu. */
  update(fix: GpsFix): number | null {
    const ref = this.ref;
    if (!ref) {
      this.ref = fix;
      return this.current;
    }
    const d = haversine(ref.lat, ref.lon, fix.lat, fix.lon);
    const dt = (fix.time - ref.time) / 1000;
    const speed = fix.speed ?? (dt > 0 ? d / dt : 0);

    if (speed < HEADING_MIN_SPEED_MS) {
      // Trop lent : on garde le cap, et on repart d'ici pour la prochaine mesure.
      this.ref = fix;
      return this.current;
    }
    if (d < HEADING_MIN_DIST_M) return this.current;

    const measured = bearing(ref.lat, ref.lon, fix.lat, fix.lon);
    this.current =
      this.current === null ? measured : normalizeAngle(this.current + HEADING_SMOOTHING * angleDiff(measured, this.current));
    this.ref = fix;
    return this.current;
  }
}
