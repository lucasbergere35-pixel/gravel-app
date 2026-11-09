/**
 * Plan de ravitaillement : à quels kilomètres manger, quoi, et pourquoi.
 *
 * QUANTITÉ TOTALE
 *   Objectif (g/h) × durée « à couvrir ». Les FIRST_INTAKE_S premières minutes
 *   sont couvertes par le repas d'avant : on ne les compte pas.
 *   Exemple : 3 h à 45 g/h, première prise à 45 min → 45 × 2,25 = 101 g.
 *
 * ESPACEMENT SELON L'ÉNERGIE (pas selon le temps)
 *   Les prises « régulières » sont placées à intervalles d'ÉNERGIE dépensée
 *   égaux (modèle physique, puissance plus forte en montée). Résultat : elles
 *   se rapprochent dans les parties vallonnées et s'espacent sur le plat.
 *   Leur nombre donne un intervalle moyen adapté à la taille des portions
 *   (intakeIntervalS : ~1 aliment principal par prise).
 *
 * AVANT LES MONTÉES IMPORTANTES (> 50 m de D+, ou > 1 km à plus de 4 %)
 *   Une prise d'aliments RAPIDES 10 à 20 min avant le pied de la côte, sur un
 *   point calme. Les prises régulières trop proches (< MERGE_S) sont retirées.
 *
 * LIEUX
 *   Chaque prise est décalée vers le point « calme » le plus proche : pente
 *   entre -3 et +4 %, hors montée repérée (pas dans une côte raide, pas dans
 *   une descente où les mains sont sur les freins).
 *
 * PORTIONS
 *   Chaque prise reçoit les glucides correspondant à l'énergie dépensée jusqu'à
 *   la suivante (= objectif g/h × intervalle). Les portions sont arrondies VERS
 *   LE BAS ; l'écart est reporté sur la prise suivante. Aliments LENTS sur les
 *   parties roulantes, RAPIDES avant une montée ou en secteur vallonné.
 */
import { gradeAt, type Climb } from '../geo/climbs';
import type { ElevationProfile } from '../geo/elevation';
import { distanceAtSeries, seriesAtDistance } from '../energy/model';
import { portionLabel, type Food, type FoodKind } from './foods';

export const FIRST_INTAKE_S = 45 * 60;
/** Bornes de l'intervalle moyen entre deux prises. */
export const MIN_INTERVAL_S = 20 * 60;
export const MAX_INTERVAL_S = 45 * 60;
export const LAST_GAP_S = 15 * 60;
export const PRE_CLIMB_LEAD_S = 15 * 60;
export const PRE_CLIMB_MIN_S = 10 * 60;
export const PRE_CLIMB_MAX_S = 20 * 60;
/** Fenêtre élargie si aucun point calme dans la fenêtre idéale. */
export const PRE_CLIMB_WIDE_MIN_S = 5 * 60;
export const PRE_CLIMB_WIDE_MAX_S = 25 * 60;
/** Une prise régulière à moins de ça d'une prise « avant montée » est supprimée. */
export const MERGE_S = 12 * 60;
/** Zone sans prise régulière avant le pied d'une montée importante (m). */
export const BEFORE_CLIMB_AVOID_M = 800;
export const BIG_CLIMB_GAIN_M = 50;
export const BIG_CLIMB_LENGTH_M = 1000;
export const BIG_CLIMB_GRADE_PCT = 4;
export const SHIFT_MAX_M = 1000;
/** Recherche élargie (longues montées) : jusqu'à 3 km du point idéal. */
export const SHIFT_FAR_M = 3000;
export const CALM_MIN_GRADE = -3;
export const CALM_MAX_GRADE = 4;
/** Dépassement toléré par portion (g) : on arrondit vers le bas. */
const TOLERANCE_G = 2;
/** En dessous, un aliment sert de « complément » (Dragibus, dattes…). */
const SMALL_FOOD_G = 10;

export interface IntakeItem {
  foodId: string;
  count: number;
}

export type IntakeReason = 'preClimb' | 'regular';

export interface Intake {
  distanceM: number;
  timeS: number;
  items: IntakeItem[];
  carbsG: number;
  /** Texte court : « 1 barre + 2 Dragibus ». */
  label: string;
  reason: IntakeReason;
  /** Pourquoi cette prise est là : « avant la montée de 2,1 km à 6 % ». */
  why: string;
  /** Montée qui suit, pour une prise « avant montée ». */
  climb?: Climb;
  /** Vrai si aucun endroit calme n'a été trouvé à proximité. */
  onSlope: boolean;
}

export interface NutritionPlan {
  intakes: Intake[];
  /** Début de la période à couvrir (s). */
  fuelStartS: number;
  /** Durée couverte par le plan (h). */
  fuelHours: number;
  targetTotalG: number;
  plannedTotalG: number;
  /** Glucides réellement prévus par heure couverte. */
  plannedGPerH: number;
  /** Quantités à emporter, par aliment. */
  packing: { foodId: string; count: number; label: string }[];
  /** Pourquoi le plan est vide, le cas échéant. */
  emptyReason: string | null;
}

export interface PlanInput {
  profile: ElevationProfile;
  timeAt: readonly number[];
  energyAt: readonly number[];
  durationS: number;
  targetGPerH: number;
  foods: readonly Food[];
  climbs: readonly Climb[];
}

const fr1 = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',');

export function isBigClimb(c: Climb): boolean {
  return c.gainM > BIG_CLIMB_GAIN_M || (c.lengthM > BIG_CLIMB_LENGTH_M && c.avgGradePct > BIG_CLIMB_GRADE_PCT);
}

export function describeClimb(c: Climb): string {
  return `${fr1(c.lengthM / 1000)} km à ${Math.round(c.avgGradePct)} % (+${Math.round(c.gainM)} m)`;
}

export interface Zone {
  startM: number;
  endM: number;
}

function isCalm(profile: ElevationProfile, climbs: readonly Climb[], d: number, avoid: readonly Zone[]): boolean {
  const g = gradeAt(profile, d);
  if (g < CALM_MIN_GRADE || g > CALM_MAX_GRADE) return false;
  if (avoid.some((z) => d >= z.startM && d <= z.endM)) return false;
  return !climbs.some((c) => d >= c.startM && d <= c.endM);
}

/**
 * Point calme le plus proche de `d`, entre `minD` et `maxD`.
 * `avoid` : zones supplémentaires à éviter (ex. juste avant une grosse montée).
 */
export function nearestCalmPoint(
  profile: ElevationProfile,
  climbs: readonly Climb[],
  d: number,
  minD: number,
  maxD: number,
  avoid: readonly Zone[] = [],
): { distanceM: number; calm: boolean } {
  for (let off = 0; off <= SHIFT_MAX_M; off += profile.step * 5) {
    for (const cand of off === 0 ? [d] : [d + off, d - off]) {
      if (cand < minD || cand > maxD) continue;
      if (isCalm(profile, climbs, cand, avoid)) return { distanceM: cand, calm: true };
    }
  }
  // Au milieu d'une longue montée : on cherche plus loin (sommet ou pied), jusqu'à SHIFT_FAR_M.
  for (let off = SHIFT_MAX_M; off <= SHIFT_FAR_M; off += profile.step * 10) {
    for (const cand of [d + off, d - off]) {
      if (cand < minD || cand > maxD) continue;
      if (isCalm(profile, climbs, cand, avoid)) return { distanceM: cand, calm: true };
    }
  }
  return { distanceM: Math.min(maxD, Math.max(minD, d)), calm: false };
}

/**
 * Choisit les portions d'une prise pour approcher `goalG` SANS la dépasser
 * (± TOLERANCE_G). `prefer` : type d'aliment privilégié ; en mode « rapide »,
 * seuls les aliments rapides sont proposés (s'il y en a).
 */
export function chooseItems(foods: readonly Food[], goalG: number, rotation: number, prefer: FoodKind = 'lent'): IntakeItem[] {
  const fast = foods.filter((f) => f.kind === 'rapide');
  const pool = prefer === 'rapide' && fast.length > 0 ? fast : foods;
  const rank = (f: Food) => (f.kind === prefer ? 0 : 1);
  const big = pool.filter((f) => f.carbsG >= SMALL_FOOD_G).sort((a, b) => rank(a) - rank(b) || b.carbsG - a.carbsG);
  const small = pool.filter((f) => f.carbsG < SMALL_FOOD_G).sort((a, b) => rank(a) - rank(b) || a.carbsG - b.carbsG);

  const items = new Map<string, number>();
  let remaining = goalG;
  const add = (f: Food, n: number) => {
    if (n <= 0) return;
    items.set(f.id, (items.get(f.id) ?? 0) + n);
    remaining -= n * f.carbsG;
  };

  // Aliments principaux : rotation dans le type préféré pour varier d'une prise à l'autre.
  const preferredBig = big.filter((f) => f.kind === prefer);
  const otherBig = big.filter((f) => f.kind !== prefer);
  const ordered = [
    ...preferredBig.map((_, k) => preferredBig[(rotation + k) % preferredBig.length]),
    ...otherBig.map((_, k) => otherBig[(rotation + k) % otherBig.length]),
  ];
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    for (const f of ordered) {
      if ((items.get(f.id) ?? 0) >= f.maxPerIntake) continue;
      if (f.carbsG <= remaining + TOLERANCE_G) {
        add(f, 1);
        added = true;
      }
    }
    if (!added) break;
  }
  // Compléments : arrondi vers le bas.
  for (const f of small) {
    const n = Math.min(f.maxPerIntake - (items.get(f.id) ?? 0), Math.floor((remaining + TOLERANCE_G) / f.carbsG));
    add(f, n);
  }
  // Rien ne rentre : une portion du plus petit si cela reste proche de l'objectif.
  if (items.size === 0 && pool.length > 0) {
    const smallest = [...pool].sort((a, b) => a.carbsG - b.carbsG)[0];
    if (smallest.carbsG <= goalG * 1.5) add(smallest, 1);
  }
  return [...items].map(([foodId, count]) => ({ foodId, count }));
}

/**
 * Intervalle moyen entre deux prises : le temps qu'il faut, à l'objectif g/h,
 * pour « consommer » une portion type (médiane des aliments principaux cochés).
 * Ex. 45 g/h avec des barres/gels de 25 g → une prise toutes les ~33 min.
 * Borné entre 20 et 45 min.
 */
export function intakeIntervalS(targetGPerH: number, foods: readonly Food[]): number {
  const mains = foods.filter((f) => f.carbsG >= SMALL_FOOD_G).map((f) => f.carbsG).sort((a, b) => a - b);
  const typical = mains.length > 0 ? mains[Math.floor((mains.length - 1) / 2)] : 20;
  if (targetGPerH <= 0) return MAX_INTERVAL_S;
  return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, (typical / targetGPerH) * 3600));
}

interface Slot {
  distanceM: number;
  timeS: number;
  reason: IntakeReason;
  climb?: Climb;
  onSlope: boolean;
  /** Prises régulières : écart prévu (s) avec la prise régulière suivante. */
  scheduledGapS?: number;
}

export function planNutrition(input: PlanInput): NutritionPlan {
  const { profile, timeAt, energyAt, durationS, targetGPerH, climbs } = input;
  const foods = input.foods.filter((f) => f.selected);
  const fuelStartS = Math.min(FIRST_INTAKE_S, durationS / 2);
  const fuelHours = Math.max(0, (durationS - fuelStartS) / 3600);
  const targetTotalG = Math.round(targetGPerH * fuelHours);
  const base = { fuelStartS, fuelHours, targetTotalG };
  const empty = (reason: string): NutritionPlan => ({ ...base, intakes: [], plannedTotalG: 0, plannedGPerH: 0, packing: [], emptyReason: reason });

  if (targetGPerH <= 0) return empty('Sortie courte : manger pendant l’effort est facultatif (le repas d’avant suffit).');
  if (foods.length === 0) return empty('Coche au moins un aliment à emporter.');

  const totalM = profile.distances[profile.distances.length - 1] ?? 0;
  const dAt = (t: number) => distanceAtSeries(profile, timeAt, t);
  const tAt = (d: number) => seriesAtDistance(profile, timeAt, d);
  const eAt = (d: number) => seriesAtDistance(profile, energyAt, d);
  const tLast = Math.max(fuelStartS, durationS - LAST_GAP_S);

  // 1. Prises « avant montée », 10–20 min avant le pied des montées importantes.
  const pre: Slot[] = [];
  for (const c of climbs) {
    if (!isBigClimb(c)) continue;
    const ts = tAt(c.startM);
    const want = ts - PRE_CLIMB_LEAD_S;
    // Fenêtre idéale 10–20 min avant le pied, puis élargie à 5–25 min.
    let spot: { distanceM: number; calm: boolean } | null = null;
    for (const [minS, maxS] of [
      [PRE_CLIMB_MIN_S, PRE_CLIMB_MAX_S],
      [PRE_CLIMB_WIDE_MIN_S, PRE_CLIMB_WIDE_MAX_S],
    ]) {
      const lo = Math.max(10 * 60, ts - maxS);
      const hi = ts - minS;
      if (hi < lo) continue;
      const s = nearestCalmPoint(profile, climbs, dAt(Math.min(hi, Math.max(lo, want))), dAt(lo), dAt(hi));
      if (s.calm) {
        spot = s;
        break;
      }
    }
    // Pas d'endroit calme avant cette montée (ex. elle suit une autre côte) : les
    // prises régulières prennent le relais.
    if (!spot) continue;
    const timeS = tAt(spot.distanceM);
    const prev = pre[pre.length - 1];
    if (prev && timeS - prev.timeS < MERGE_S) continue; // la prise précédente couvre déjà
    pre.push({ distanceM: spot.distanceM, timeS, reason: 'preClimb', climb: c, onSlope: false });
  }

  // 2. Prises régulières, à intervalles d'énergie égaux.
  const e0 = eAt(dAt(fuelStartS));
  const eLast = eAt(dAt(tLast));
  const meanIntervalS = intakeIntervalS(targetGPerH, foods);
  // Arrondi vers le bas : chaque prise vaut au moins une portion principale.
  const n = tLast > fuelStartS ? Math.max(1, Math.floor((durationS - fuelStartS) / meanIntervalS)) : 1;
  const nominalGapS = n > 1 ? (tLast - fuelStartS) / (n - 1) : meanIntervalS;
  // Pas de prise régulière (souvent un aliment lent, à mâcher) juste au pied d'une grosse montée.
  // Zone = les PRE_CLIMB_MIN_S dernières minutes avant le pied (au moins BEFORE_CLIMB_AVOID_M).
  const avoid: Zone[] = climbs.filter(isBigClimb).map((c) => ({
    startM: Math.min(c.startM - BEFORE_CLIMB_AVOID_M, dAt(tAt(c.startM) - PRE_CLIMB_MIN_S)),
    endM: c.startM,
  }));
  const regular: Slot[] = [];
  let prevD = -Infinity;
  for (let k = 0; k < n; k++) {
    const e = n > 1 ? e0 + (k * (eLast - e0)) / (n - 1) : e0;
    // Écart minimal avec la prise régulière précédente : la moitié de l'intervalle prévu (en temps).
    const minD = prevD === -Infinity ? 0 : Math.max(prevD + 300, dAt(tAt(prevD) + nominalGapS * 0.5));
    const ideal = Math.max(minD, distanceAtSeries(profile, energyAt, e));
    let spot = nearestCalmPoint(profile, climbs, ideal, minD, totalM, avoid);
    // Côtes très rapprochées : la zone « avant montée » est une préférence, pas une interdiction.
    if (!spot.calm) spot = nearestCalmPoint(profile, climbs, ideal, minD, totalM);
    prevD = spot.distanceM;
    regular.push({ distanceM: spot.distanceM, timeS: tAt(spot.distanceM), reason: 'regular', onSlope: !spot.calm, scheduledGapS: nominalGapS });
  }
  // Écart prévu avec la prise régulière suivante : reflète le relief (énergie/temps).
  for (let k = 0; k + 1 < regular.length; k++) regular[k].scheduledGapS = regular[k + 1].timeS - regular[k].timeS;

  // Chaque prise « avant montée » remplace la prise régulière la plus proche dans le temps.
  const kept = new Set(regular);
  for (const p of pre) {
    let closest: Slot | null = null;
    for (const r of kept) if (!closest || Math.abs(r.timeS - p.timeS) < Math.abs(closest.timeS - p.timeS)) closest = r;
    if (closest && Math.abs(closest.timeS - p.timeS) < Math.max(MERGE_S, nominalGapS * 0.6)) kept.delete(closest);
  }
  const slots = [...pre, ...kept].sort((a, b) => a.distanceM - b.distanceM);

  // 3. Glucides de chaque prise ∝ énergie dépensée jusqu'à la suivante.
  const eEnd = energyAt[energyAt.length - 1] ?? 0;
  const bounds = slots.map((s, i) => (i === 0 ? Math.min(e0, eAt(s.distanceM)) : eAt(s.distanceM)));
  const coverTotal = Math.max(1e-9, eEnd - bounds[0]);
  const byId = new Map(foods.map((f) => [f.id, f]));
  const intakes: Intake[] = [];
  let planned = 0;
  let cumCover = 0;
  let rotation = 0;
  slots.forEach((s, i) => {
    const next = i + 1 < slots.length ? bounds[i + 1] : eEnd;
    cumCover += next - bounds[i];
    const goal = (targetTotalG * cumCover) / coverTotal - planned; // rattrape les arrondis
    // Relief : écart prévu entre prises régulières, comparé à l'écart « nominal » (en temps).
    const gapS = s.scheduledGapS ?? nominalGapS;
    const hilly = s.reason === 'regular' && gapS < nominalGapS * 0.85;
    const prefer: FoodKind = s.reason === 'preClimb' || hilly ? 'rapide' : 'lent';
    const items = chooseItems(foods, goal, rotation++, prefer);
    if (items.length === 0) return; // reporté sur la prise suivante
    const carbsG = items.reduce((sum, it) => sum + it.count * (byId.get(it.foodId)?.carbsG ?? 0), 0);
    planned += carbsG;
    let why: string;
    if (s.reason === 'preClimb' && s.climb) why = `avant la montée de ${describeClimb(s.climb)}`;
    else if (hilly) why = 'secteur vallonné : prise rapprochée';
    else if (gapS > nominalGapS * 1.15) why = 'terrain roulant : prise espacée';
    else why = 'prise régulière';
    intakes.push({
      distanceM: s.distanceM,
      timeS: s.timeS,
      items,
      carbsG,
      label: items.map((it) => portionLabel(byId.get(it.foodId)!, it.count)).join(' + '),
      reason: s.reason,
      why,
      climb: s.climb,
      onSlope: s.onSlope,
    });
  });

  const counts = new Map<string, number>();
  for (const it of intakes.flatMap((x) => x.items)) counts.set(it.foodId, (counts.get(it.foodId) ?? 0) + it.count);
  const packing = [...counts].map(([foodId, count]) => ({
    foodId,
    count,
    label: `${portionLabel(byId.get(foodId)!, count)} (${byId.get(foodId)!.name})`,
  }));
  const plannedTotalG = Math.round(planned);
  return {
    ...base,
    intakes,
    plannedTotalG,
    plannedGPerH: fuelHours > 0 ? plannedTotalG / fuelHours : 0,
    packing,
    emptyReason: null,
  };
}
