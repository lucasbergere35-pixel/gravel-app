/**
 * Bilan d'une sortie réelle : statistiques et export GPX.
 */
import { computeRouteStats } from '../geo/stats';
import type { GpsFix } from '../gps/types';
import { writeGpx } from '../gpx/write';
import type { TrackPoint } from '../types';
import type { NutritionSummary } from './intakes';

export type FeelingKind = 'bonne' | 'coup-de-mou' | 'fringale';

export const FEELING_LABELS: Record<FeelingKind, string> = {
  bonne: '😀 Bonne sortie',
  'coup-de-mou': '😐 Coup de mou',
  fringale: '😵 Fringale',
};

export interface RideFeeling {
  kind: FeelingKind;
  /** Kilomètre approximatif du coup de mou / de la fringale. */
  km: number | null;
  note: string;
}

export interface RideSummary {
  distanceM: number;
  movingTimeS: number;
  totalTimeS: number;
  /** D+ mesuré par le GPS (lissé), ou null si pas d'altitude. */
  gainM: number | null;
  avgSpeedKmh: number;
  nutrition: NutritionSummary | null;
}

/** Points GPS de la sortie → points de tracé (altitude GPS, heure). */
export function fixesToTrack(fixes: readonly GpsFix[]): TrackPoint[] {
  return fixes.map((f) => ({ lat: f.lat, lon: f.lon, ele: f.altitude, time: f.time }));
}

/** D+ réel à partir des altitudes GPS (même lissage que les itinéraires). */
export function rideGain(fixes: readonly GpsFix[]): number | null {
  if (fixes.length < 2) return null;
  const stats = computeRouteStats(fixesToTrack(fixes));
  return stats.hasElevation ? stats.gainM : null;
}

export function buildRideSummary(
  fixes: readonly GpsFix[],
  snap: { distanceM: number; movingTimeS: number; totalTimeS: number },
  nutrition: NutritionSummary | null,
): RideSummary {
  return {
    distanceM: snap.distanceM,
    movingTimeS: snap.movingTimeS,
    totalTimeS: snap.totalTimeS,
    gainM: rideGain(fixes),
    avgSpeedKmh: snap.movingTimeS > 0 ? (snap.distanceM / snap.movingTimeS) * 3.6 : 0,
    nutrition,
  };
}

/** GPX de la sortie réelle, avec heures et altitudes. */
export function rideToGpx(name: string, fixes: readonly GpsFix[]): string {
  return writeGpx({ name, points: fixesToTrack(fixes), creator: 'Gravel Compagnon (sortie enregistrée)' });
}

/** Nettoie un ressenti saisi (ou importé). */
export function sanitizeFeeling(raw: unknown): RideFeeling | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'bonne' && o.kind !== 'coup-de-mou' && o.kind !== 'fringale') return null;
  const km = Number(o.km);
  return {
    kind: o.kind,
    km: o.km !== null && o.km !== undefined && o.km !== '' && Number.isFinite(km) && km >= 0 && km < 2000 ? Math.round(km * 10) / 10 : null,
    note: typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '',
  };
}
