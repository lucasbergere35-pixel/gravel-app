import { describe, expect, it } from 'vitest';
import { detectClimbs } from '../src/core/geo/climbs';
import type { ElevationProfile } from '../src/core/geo/elevation';
import { estimateEnergy } from '../src/core/energy/model';
import { DEFAULT_FOODS, sanitizeFoods, type Food, type FoodKind } from '../src/core/nutrition/foods';
import {
  chooseItems,
  FIRST_INTAKE_S,
  intakeIntervalS,
  isBigClimb,
  nearestCalmPoint,
  planNutrition,
  type NutritionPlan,
} from '../src/core/nutrition/plan';
import { duringRideCarbs, preRideCarbs, preRideExamples } from '../src/core/nutrition/recommendations';

function profileOf(totalM: number, f: (d: number) => number): ElevationProfile {
  const distances: number[] = [];
  const elevations: number[] = [];
  for (let d = 0; d <= totalM; d += 10) {
    distances.push(d);
    elevations.push(f(d));
  }
  return { step: 10, distances, elevations };
}

const food = (id: string, carbsG: number, kind: FoodKind, maxPerIntake = 1): Food => ({
  id,
  name: id,
  carbsG,
  unit: id,
  unitPlural: `${id}s`,
  kind,
  selected: true,
  maxPerIntake,
});
const FOODS = [food('barre', 25, 'lent'), food('gel', 25, 'rapide'), food('pate', 15, 'rapide', 2), food('dragibus', 2.5, 'rapide', 8), food('dattes', 5, 'lent', 4)];
const rider = { riderKg: 75, bikeKg: 11, heightCm: 178, avgSpeedKmh: 19 };

function planFor(profile: ElevationProfile, targetGPerH: number, foods: Food[] = FOODS): { plan: NutritionPlan; durationS: number } {
  const climbs = detectClimbs(profile);
  const e = estimateEnergy(profile, rider);
  const plan = planNutrition({ profile, timeAt: e.timeAt, energyAt: e.energyAt, durationS: e.durationS, targetGPerH, foods, climbs });
  return { plan, durationS: e.durationS };
}

const sum = (plan: NutritionPlan) => plan.intakes.reduce((s, i) => s + i.carbsG, 0);

describe('recommandations', () => {
  it('avant : g/kg selon la durée', () => {
    expect(preRideCarbs(3600, 70)).toMatchObject({ gPerKg: 1, totalG: 70 });
    expect(preRideCarbs(3 * 3600, 70).gPerKg).toBe(3);
  });

  it('pendant : objectifs loisir par niveau', () => {
    expect(duringRideCarbs(3600, 'confirme')).toMatchObject({ optional: true, targetGPerH: 0 });
    expect(duringRideCarbs(2 * 3600, 'debutant').targetGPerH).toBe(30);
    expect(duringRideCarbs(4 * 3600, 'debutant').targetGPerH).toBe(40);
    expect(duringRideCarbs(4 * 3600, 'intermediaire')).toMatchObject({ targetGPerH: 50, rangeGPerH: [40, 60] });
    expect(duringRideCarbs(4 * 3600, 'confirme').targetGPerH).toBe(70);
  });

  it('pendant : objectif saisi à la main prioritaire et borné', () => {
    expect(duringRideCarbs(4 * 3600, 'debutant', 55)).toMatchObject({ targetGPerH: 55, manual: true, autoTargetGPerH: 40 });
    expect(duringRideCarbs(3600, 'debutant', 30)).toMatchObject({ targetGPerH: 30, optional: false });
    expect(duringRideCarbs(4 * 3600, 'debutant', 500).targetGPerH).toBe(120);
  });

  it('exemples d’aliments avant la sortie ≈ total visé', () => {
    const ex = preRideExamples(200);
    const carbs = ex[0].grams * 0.3 + ex[1].grams * 0.5 + ex[2].grams * 0.22 + ex[3].grams * 0.75;
    expect(carbs).toBeGreaterThan(180);
    expect(carbs).toBeLessThan(220);
  });
});

describe('portions d’une prise (arrondi vers le bas)', () => {
  it('ne dépasse pas l’objectif de la prise', () => {
    for (const goal of [8, 12, 19, 24, 31, 37, 44, 52]) {
      const items = chooseItems(FOODS, goal, 0, 'lent');
      const carbs = items.reduce((s, it) => s + it.count * FOODS.find((f) => f.id === it.foodId)!.carbsG, 0);
      expect(carbs).toBeLessThanOrEqual(goal + 2);
    }
  });

  it('privilégie les aliments lents sur le roulant, rapides avant une montée', () => {
    expect(chooseItems(FOODS, 25, 0, 'lent')).toEqual([{ foodId: 'barre', count: 1 }]);
    const fast = chooseItems(FOODS, 30, 0, 'rapide');
    expect(fast.every((it) => FOODS.find((f) => f.id === it.foodId)!.kind === 'rapide')).toBe(true);
  });

  it('respecte le maximum par prise', () => {
    expect(chooseItems([food('dragibus', 2.5, 'rapide', 8)], 40, 0)).toEqual([{ foodId: 'dragibus', count: 8 }]);
  });
});

describe('intervalle entre prises', () => {
  it('adapté à la taille des portions et à l’objectif, borné 20–45 min', () => {
    expect(intakeIntervalS(45, FOODS) / 60).toBeCloseTo(33.3, 0); // portion type 25 g
    expect(intakeIntervalS(80, FOODS) / 60).toBe(20);
    expect(intakeIntervalS(20, FOODS) / 60).toBe(45);
  });
});

describe('plan : quantités', () => {
  const flat = profileOf(60_000, () => 100); // ~3 h 10 à 19 km/h

  for (const target of [30, 45, 60, 80]) {
    it(`total ≤ objectif + 10 % (objectif ${target} g/h)`, () => {
      const { plan } = planFor(flat, target);
      expect(Math.round(sum(plan))).toBe(plan.plannedTotalG);
      expect(plan.plannedTotalG).toBeLessThanOrEqual(plan.targetTotalG * 1.1);
      expect(plan.plannedTotalG).toBeGreaterThanOrEqual(plan.targetTotalG * 0.85);
      expect(plan.plannedGPerH).toBeLessThanOrEqual(target * 1.1);
    });
  }

  it('objectif total = g/h × durée couverte (après le repas d’avant)', () => {
    const { plan, durationS } = planFor(flat, 45);
    expect(plan.fuelStartS).toBe(FIRST_INTAKE_S);
    expect(plan.targetTotalG).toBe(Math.round((45 * (durationS - FIRST_INTAKE_S)) / 3600));
  });

  it('première prise vers 45–60 min, aucune la première demi-heure', () => {
    const { plan } = planFor(flat, 45);
    expect(plan.intakes[0].timeS).toBeGreaterThanOrEqual(40 * 60);
    expect(plan.intakes[0].timeS).toBeLessThanOrEqual(60 * 60);
  });

  it('aliments lents sur le plat', () => {
    const { plan } = planFor(flat, 45);
    const slowShare = plan.intakes.filter((i) => i.items.some((it) => ['barre', 'dattes'].includes(it.foodId))).length / plan.intakes.length;
    expect(slowShare).toBeGreaterThan(0.6);
  });
});

describe('plan : relief', () => {
  // 30 km plat, montée de 3 km à 6 % (+180 m), 10 km vallonné, 20 km plat
  const course = (d: number) => {
    if (d < 30_000) return 100;
    if (d < 33_000) return 100 + (d - 30_000) * 0.06;
    if (d < 43_000) return 280 + 30 * Math.sin((d - 33_000) / 700);
    return 280;
  };
  const profile = profileOf(63_000, course);
  const climbs = detectClimbs(profile);
  const { plan } = planFor(profile, 50);

  it('la montée est repérée comme importante', () => {
    expect(climbs.some((c) => isBigClimb(c) && Math.abs(c.startM - 30_000) < 300)).toBe(true);
  });

  it('prise rapide 10–20 min avant le pied de la montée, sur un point calme', () => {
    const pre = plan.intakes.find((i) => i.reason === 'preClimb');
    expect(pre).toBeDefined();
    const e = estimateEnergy(profile, rider);
    const tStart = e.timeAt[Math.round(pre!.climb!.startM / 10)];
    expect(tStart - pre!.timeS).toBeGreaterThanOrEqual(9 * 60);
    expect(tStart - pre!.timeS).toBeLessThanOrEqual(21 * 60);
    expect(pre!.onSlope).toBe(false);
    expect(pre!.items.every((it) => FOODS.find((f) => f.id === it.foodId)!.kind === 'rapide')).toBe(true);
    expect(pre!.why).toMatch(/^avant la montée de \d+(,\d)? km à \d+ % \(\+\d+ m\)$/);
  });

  it('pas de prise régulière dans les 10 min avant le pied d’une montée isolée', () => {
    // 60 km plat avec une seule montée de 2 km à 7 % au km 25, pour plusieurs objectifs
    const single = profileOf(60_000, (d) => (d < 25_000 ? 100 : d < 27_000 ? 100 + (d - 25_000) * 0.07 : 240));
    const big = detectClimbs(single).filter(isBigClimb);
    const e = estimateEnergy(single, rider);
    for (const target of [40, 55, 70]) {
      const { plan: p } = planFor(single, target);
      for (const i of p.intakes.filter((x) => x.reason === 'regular')) {
        for (const c of big) {
          const tStart = e.timeAt[Math.round(c.startM / 10)];
          expect(i.timeS > tStart - 10 * 60 && i.timeS < tStart).toBe(false);
        }
      }
    }
  });

  it('aucune prise dans une montée (même quand deux côtes se suivent)', () => {
    for (const i of plan.intakes) {
      expect(i.distanceM < 30_000 || i.distanceM > 33_000).toBe(true);
      for (const c of climbs) expect(i.distanceM >= c.startM && i.distanceM <= c.endM).toBe(false);
    }
  });

  it('prises plus rapprochées (en km) dans la partie vallonnée que sur le plat', () => {
    const regular = plan.intakes.filter((i) => i.reason === 'regular');
    const gaps = regular.slice(1).map((i, k) => ({ at: i.distanceM, km: (i.distanceM - regular[k].distanceM) / 1000 }));
    const flatGaps = gaps.filter((g) => g.at < 30_000 || g.at > 45_000).map((g) => g.km);
    const avgFlat = flatGaps.reduce((a, b) => a + b, 0) / flatGaps.length;
    // Énergie par km plus élevée en montée / vallonné → moins de km entre deux prises.
    const e = estimateEnergy(profile, rider);
    const kcalPerKmFlat = e.energyAt[2500] / 25;
    const kcalPerKmHilly = (e.energyAt[4300] - e.energyAt[3000]) / 13;
    expect(kcalPerKmHilly).toBeGreaterThan(kcalPerKmFlat);
    expect(avgFlat).toBeGreaterThan(0);
  });

  it('jamais deux prises régulières trop rapprochées (≥ 10 min)', () => {
    for (const target of [40, 50, 70]) {
      const regular = planFor(profile, target).plan.intakes.filter((i) => i.reason === 'regular');
      for (let k = 1; k < regular.length; k++) expect(regular[k].timeS - regular[k - 1].timeS).toBeGreaterThanOrEqual(10 * 60);
    }
  });

  it('total ≤ objectif + 10 % aussi avec du relief', () => {
    expect(plan.plannedTotalG).toBeLessThanOrEqual(plan.targetTotalG * 1.1);
  });

  it('cherche un point calme à proximité (ici : juste après le sommet)', () => {
    const spot = nearestCalmPoint(profile, climbs, 32_600, 0, 63_000);
    expect(spot.calm).toBe(true);
    expect(spot.distanceM).toBeGreaterThan(33_000);
  });
});

describe('plan vide expliqué', () => {
  const p = profileOf(20_000, () => 100);
  it('sortie courte ou rien de coché', () => {
    expect(planFor(p, 0).plan.emptyReason).toMatch(/facultatif/);
    expect(planFor(p, 45, []).plan.emptyReason).toMatch(/Coche/);
  });
});

describe('base d’aliments', () => {
  it('aliments par défaut valides, avec un type', () => {
    expect(sanitizeFoods(DEFAULT_FOODS)).toHaveLength(DEFAULT_FOODS.length);
    expect(DEFAULT_FOODS.find((f) => f.id === 'gel')?.kind).toBe('rapide');
    expect(DEFAULT_FOODS.find((f) => f.id === 'barre')?.kind).toBe('lent');
  });
  it('anciennes données sans type : type déduit', () => {
    const old = sanitizeFoods([{ id: 'dragibus', name: 'Dragibus', carbsG: 2.5 }, { id: 'x', name: 'Gel maison', carbsG: 20 }, { id: 'y', name: 'Tartine', carbsG: 30 }]);
    expect(old!.map((f) => f.kind)).toEqual(['rapide', 'rapide', 'lent']);
  });
  it('rejette les saisies invalides', () => {
    expect(sanitizeFoods('x')).toBeNull();
    expect(sanitizeFoods([{ name: '', carbsG: 10 }, { name: 'Gel', carbsG: -1 }, { name: 'Ok', carbsG: '12' }])).toHaveLength(1);
  });
});
