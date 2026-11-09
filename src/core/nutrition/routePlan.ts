/**
 * Calcul complet du plan nutrition d'un itinéraire, partagé par l'écran
 * « Plan nutrition » et le démarrage d'une sortie (qui le fige) : les deux
 * obtiennent ainsi exactement le même plan.
 */
import { detectClimbs, type Climb } from '../geo/climbs';
import { cumulativeDistances } from '../geo/distance';
import { buildElevationProfile, PROFILE_STEP_M, type ElevationProfile } from '../geo/elevation';
import { estimateEnergy, type EnergyResult } from '../energy/model';
import type { TrackPoint } from '../types';
import type { Food } from './foods';
import { planNutrition, type NutritionPlan } from './plan';
import { duringRideCarbs, type DuringRideAdvice, type Level } from './recommendations';

export interface PreparedRoute {
  cum: number[];
  /** Profil réel, ou null si le GPX n'a pas d'altitude. */
  realProfile: ElevationProfile | null;
  /** Profil utilisé pour les calculs (plat de secours si pas d'altitude). */
  elevation: ElevationProfile;
  climbs: Climb[];
}

export interface RiderInput {
  weightKg: number;
  heightCm: number;
  bikeKg: number;
  avgSpeedKmh: number;
  level: Level;
}

export interface PlanPrefs {
  targetGPerH: number | null;
  climbBoostPct: number;
}

export interface RouteNutrition {
  energy: EnergyResult;
  during: DuringRideAdvice;
  plan: NutritionPlan;
}

/** Profil plat de secours quand le GPX n'a pas d'altitude. */
function flatProfile(totalM: number): ElevationProfile {
  const distances: number[] = [];
  for (let d = 0; d < totalM; d += PROFILE_STEP_M) distances.push(d);
  distances.push(totalM);
  return { step: PROFILE_STEP_M, distances, elevations: distances.map(() => 0) };
}

export function prepareRoute(points: readonly TrackPoint[]): PreparedRoute {
  const cum = cumulativeDistances(points);
  const realProfile = buildElevationProfile(points, cum);
  return {
    cum,
    realProfile,
    elevation: realProfile ?? flatProfile(cum[cum.length - 1] ?? 0),
    climbs: realProfile ? detectClimbs(realProfile) : [],
  };
}

export function computeEnergy(route: PreparedRoute, rider: RiderInput, prefs: PlanPrefs): EnergyResult {
  return estimateEnergy(route.elevation, {
    riderKg: rider.weightKg,
    bikeKg: rider.bikeKg,
    heightCm: rider.heightCm,
    avgSpeedKmh: rider.avgSpeedKmh,
    climbBoost: prefs.climbBoostPct / 100,
  });
}

export function computePlan(route: PreparedRoute, energy: EnergyResult, rider: RiderInput, prefs: PlanPrefs, foods: readonly Food[]): RouteNutrition {
  const during = duringRideCarbs(energy.durationS, rider.level, prefs.targetGPerH);
  const plan = planNutrition({
    profile: route.elevation,
    timeAt: energy.timeAt,
    energyAt: energy.energyAt,
    durationS: energy.durationS,
    targetGPerH: during.targetGPerH,
    foods,
    climbs: route.climbs,
  });
  return { energy, during, plan };
}

/** Raccourci : tout en une fois. */
export function computeRouteNutrition(points: readonly TrackPoint[], rider: RiderInput, prefs: PlanPrefs, foods: readonly Food[]): RouteNutrition {
  const route = prepareRoute(points);
  return computePlan(route, computeEnergy(route, rider, prefs), rider, prefs, foods);
}
