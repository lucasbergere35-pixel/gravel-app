/**
 * Recalage d'une position sur l'itinéraire prévu :
 *  - distance déjà faite le long du tracé (→ distance et dénivelé restants) ;
 *  - écart au tracé (→ alerte hors tracé).
 *
 * Pour ne pas « sauter » de l'autre côté d'une boucle ou sur le retour d'un
 * aller-retour, on cherche d'abord dans une fenêtre autour de la dernière
 * position connue (LOOK_BACK_M en arrière, LOOK_AHEAD_M en avant). On ne
 * cherche sur tout le tracé que si rien n'est trouvé à moins de LOCAL_MAX_M.
 */
import { EARTH_RADIUS_M } from './distance';

export const LOOK_BACK_M = 200;
export const LOOK_AHEAD_M = 1500;
export const LOCAL_MAX_M = 100;
/** Deux candidats sont « aussi proches » s'ils diffèrent de moins de ça (m). */
const TIE_M = 20;

export interface MatchResult {
  /** Index du segment [i, i+1] le plus proche. */
  segment: number;
  /** Distance parcourue le long du tracé (m). */
  alongM: number;
  /** Distance entre la position et le tracé (m). */
  offTrackM: number;
}

interface Pt {
  lat: number;
  lon: number;
}

const DEG = Math.PI / 180;

export class RouteMatcher {
  private lastSegment: number | null = null;

  constructor(
    private readonly points: readonly Pt[],
    private readonly cum: readonly number[],
  ) {}

  reset(): void {
    this.lastSegment = null;
  }

  match(lat: number, lon: number): MatchResult | null {
    const n = this.points.length;
    if (n === 0) return null;
    if (n === 1) {
      return { segment: 0, alongM: 0, offTrackM: this.distToSegment(lat, lon, 0, 0).dist };
    }

    let best: MatchResult | null = null;
    if (this.lastSegment !== null) {
      const refAlong = this.cum[this.lastSegment];
      const from = this.indexAtDistance(refAlong - LOOK_BACK_M);
      const to = Math.min(n - 2, this.indexAtDistance(refAlong + LOOK_AHEAD_M) + 1);
      best = this.search(lat, lon, from, to, refAlong);
      if (best.offTrackM > LOCAL_MAX_M) best = null;
    }
    if (!best) {
      const refAlong = this.lastSegment !== null ? this.cum[this.lastSegment] : 0;
      best = this.search(lat, lon, 0, n - 2, refAlong);
    }
    this.lastSegment = best.segment;
    return best;
  }

  /** Meilleur segment dans [from, to] ; à égalité, celui le plus près de refAlong. */
  private search(lat: number, lon: number, from: number, to: number, refAlong: number): MatchResult {
    const candidates: MatchResult[] = [];
    let minDist = Infinity;
    for (let i = from; i <= to; i++) {
      const { dist, t } = this.distToSegment(lat, lon, i, i + 1);
      const segLen = this.cum[i + 1] - this.cum[i];
      candidates.push({ segment: i, alongM: this.cum[i] + t * segLen, offTrackM: dist });
      if (dist < minDist) minDist = dist;
    }
    let best = candidates[0];
    let bestGap = Infinity;
    for (const c of candidates) {
      if (c.offTrackM <= minDist + TIE_M) {
        const gap = Math.abs(c.alongM - refAlong);
        if (gap < bestGap || (gap === bestGap && c.offTrackM < best.offTrackM)) {
          best = c;
          bestGap = gap;
        }
      }
    }
    return best;
  }

  /** Distance point–segment en projection plane locale (suffisant à l'échelle d'un segment). */
  private distToSegment(lat: number, lon: number, ia: number, ib: number): { dist: number; t: number } {
    const a = this.points[ia];
    const b = this.points[ib];
    const k = Math.cos(lat * DEG) * EARTH_RADIUS_M * DEG;
    const kLat = EARTH_RADIUS_M * DEG;
    const ax = (a.lon - lon) * k;
    const ay = (a.lat - lat) * kLat;
    const bx = (b.lon - lon) * k;
    const by = (b.lat - lat) * kLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    return { dist: Math.hypot(px, py), t };
  }

  /** Index du dernier point dont la distance cumulée est ≤ d. */
  private indexAtDistance(d: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    if (d <= 0) return 0;
    if (d >= this.cum[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}
