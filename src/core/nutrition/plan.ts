/**
 * Plan de ravitaillement : à quels kilomètres manger, et quoi.
 *
 * 1. Moments : première prise après FIRST_INTAKE_S, puis environ toutes les
 *    INTERVAL_S, la dernière au moins LAST_GAP_S avant l'arrivée (manger juste
 *    avant d'arriver ne sert plus à rien). Le temps vient du modèle physique,
 *    donc on mange plus souvent par km dans les montées (on y va moins vite).
 * 2. Lieux : chaque prise est décalée (± SHIFT_MAX_M au plus) vers le point
 *    « calme » le plus proche : pente entre CALM_MIN_GRADE et CALM_MAX_GRADE %,
 *    hors montée repérée. On évite ainsi de manger dans une côte raide
 *    (souffle court) ou une descente (mains sur les freins).
 * 3. Quantités : on vise la même quantité à chaque prise, en corrigeant l'écart
 *    accumulé ; on alterne les aliments « principaux » (barre, gel…) et on
 *    complète avec les petits (Dragibus…).
 */
import { gradeAt, type Climb } from '../geo/climbs';
import type { ElevationProfile } from '../geo/elevation';
import { distanceAtTime, timeAtDistance } from '../energy/model';
import { portionLabel, type Food } from './foods';

export const FIRST_INTAKE_S = 30 * 60;
export const INTERVAL_S = 25 * 60;
export const LAST_GAP_S = 15 * 60;
export const SHIFT_MAX_M = 1000;
export const CALM_MIN_GRADE = -3;
export const CALM_MAX_GRADE = 4;
/** En dessous, un aliment sert de « complément » (Dragibus, dattes…). */
const SMALL_FOOD_G = 10;

export interface IntakeItem {
  foodId: string;
  count: number;
}

export interface Intake {
  distanceM: number;
  timeS: number;
  items: IntakeItem[];
  carbsG: number;
  /** Texte court : « 1 barre + 2 Dragibus ». */
  label: string;
  /** Vrai si aucun endroit calme n'a été trouvé à proximité. */
  onSlope: boolean;
}

export interface NutritionPlan {
  intakes: Intake[];
  targetTotalG: number;
  plannedTotalG: number;
  /** Quantités à emporter, par aliment. */
  packing: { foodId: string; count: number; label: string }[];
  /** Pourquoi le plan est vide, le cas échéant. */
  emptyReason: string | null;
}

export interface PlanInput {
  profile: ElevationProfile;
  timeAt: readonly number[];
  durationS: number;
  targetGPerH: number;
  foods: readonly Food[];
  climbs: readonly Climb[];
}

function isCalm(profile: ElevationProfile, climbs: readonly Climb[], d: number): boolean {
  const g = gradeAt(profile, d);
  if (g < CALM_MIN_GRADE || g > CALM_MAX_GRADE) return false;
  return !climbs.some((c) => d >= c.startM && d <= c.endM);
}

/** Point calme le plus proche de `d`, entre `minD` et `maxD`. */
export function nearestCalmPoint(
  profile: ElevationProfile,
  climbs: readonly Climb[],
  d: number,
  minD: number,
  maxD: number,
): { distanceM: number; calm: boolean } {
  for (let off = 0; off <= SHIFT_MAX_M; off += profile.step * 5) {
    for (const cand of off === 0 ? [d] : [d + off, d - off]) {
      if (cand < minD || cand > maxD) continue;
      if (isCalm(profile, climbs, cand)) return { distanceM: cand, calm: true };
    }
  }
  return { distanceM: Math.min(maxD, Math.max(minD, d)), calm: false };
}

/** Choisit les portions d'une prise pour approcher `targetG`. */
export function chooseItems(foods: readonly Food[], targetG: number, rotation: number): IntakeItem[] {
  const big = foods.filter((f) => f.carbsG >= SMALL_FOOD_G).sort((a, b) => b.carbsG - a.carbsG);
  const small = foods.filter((f) => f.carbsG < SMALL_FOOD_G).sort((a, b) => a.carbsG - b.carbsG);
  const items = new Map<string, number>();
  let remaining = targetG;
  const add = (f: Food, n: number) => {
    if (n <= 0) return;
    items.set(f.id, (items.get(f.id) ?? 0) + n);
    remaining -= n * f.carbsG;
  };

  if (big.length > 0) {
    // Aliments principaux, en commençant par celui « du tour » (rotation pour
    // varier d'une prise à l'autre) ; on en ajoute tant qu'ils ne dépassent pas
    // trop la cible. Les petits complètent ensuite.
    for (let pass = 0; pass < 3 && remaining > 0; pass++) {
      let added = false;
      for (let k = 0; k < big.length; k++) {
        const f = big[(rotation + k) % big.length];
        if ((items.get(f.id) ?? 0) >= f.maxPerIntake) continue;
        if (remaining >= f.carbsG * 0.6) {
          add(f, 1);
          added = true;
        }
      }
      if (!added) break;
    }
  }
  for (const f of small) {
    if (remaining < f.carbsG / 2) break;
    add(f, Math.min(f.maxPerIntake, Math.round(remaining / f.carbsG)));
  }
  // Rien d'adapté (ex. un seul gros aliment et petite cible) : une portion du plus petit.
  if (items.size === 0 && foods.length > 0) {
    const smallest = [...foods].sort((a, b) => a.carbsG - b.carbsG)[0];
    add(smallest, 1);
  }
  return [...items].map(([foodId, count]) => ({ foodId, count }));
}

export function planNutrition(input: PlanInput): NutritionPlan {
  const { profile, timeAt, durationS, targetGPerH, climbs } = input;
  const foods = input.foods.filter((f) => f.selected);
  const targetTotalG = Math.round((targetGPerH * durationS) / 3600);
  const empty = (reason: string): NutritionPlan => ({ intakes: [], targetTotalG, plannedTotalG: 0, packing: [], emptyReason: reason });

  if (targetGPerH <= 0) return empty('Sortie courte : manger pendant l’effort est facultatif.');
  if (foods.length === 0) return empty('Coche au moins un aliment à emporter.');

  const tStart = Math.min(FIRST_INTAKE_S, durationS / 2);
  const tEnd = Math.max(tStart, durationS - LAST_GAP_S);
  // Assez de prises pour qu'elles soient espacées d'au plus INTERVAL_S.
  const n = Math.max(1, Math.ceil((tEnd - tStart) / INTERVAL_S - 1e-9) + 1);
  const step = n > 1 ? (tEnd - tStart) / (n - 1) : 0;
  const totalM = profile.distances[profile.distances.length - 1] ?? 0;
  const byId = new Map(foods.map((f) => [f.id, f]));

  const intakes: Intake[] = [];
  let planned = 0;
  let prevD = 0;
  for (let k = 0; k < n; k++) {
    const ideal = distanceAtTime(profile, timeAt, tStart + k * step);
    // Garder un écart minimal avec la prise précédente.
    const minGap = Math.min(2000, (totalM / (n + 1)) * 0.5);
    const spot = nearestCalmPoint(profile, climbs, ideal, k === 0 ? 0 : prevD + minGap, totalM);
    prevD = spot.distanceM;
    // Cible de la prise = cumul visé − déjà prévu (rattrape les arrondis).
    const goal = (targetTotalG * (k + 1)) / n - planned;
    const items = chooseItems(foods, goal, k);
    const carbsG = items.reduce((s, it) => s + it.count * (byId.get(it.foodId)?.carbsG ?? 0), 0);
    planned += carbsG;
    intakes.push({
      distanceM: spot.distanceM,
      timeS: timeAtDistance(profile, timeAt, spot.distanceM),
      items,
      carbsG,
      label: items.map((it) => portionLabel(byId.get(it.foodId)!, it.count)).join(' + '),
      onSlope: !spot.calm,
    });
  }

  const counts = new Map<string, number>();
  for (const it of intakes.flatMap((i) => i.items)) counts.set(it.foodId, (counts.get(it.foodId) ?? 0) + it.count);
  const packing = [...counts].map(([foodId, count]) => ({ foodId, count, label: `${portionLabel(byId.get(foodId)!, count)} (${byId.get(foodId)!.name})` }));

  return { intakes, targetTotalG, plannedTotalG: Math.round(planned), packing, emptyReason: null };
}
