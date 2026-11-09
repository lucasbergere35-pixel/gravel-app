import { describe, expect, it } from 'vitest';
import { detectClimbs } from '../src/core/geo/climbs';
import type { ElevationProfile } from '../src/core/geo/elevation';
import { estimateEnergy } from '../src/core/energy/model';
import { DEFAULT_FOODS, sanitizeFoods, type Food } from '../src/core/nutrition/foods';
import { chooseItems, nearestCalmPoint, planNutrition } from '../src/core/nutrition/plan';
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

const food = (id: string, carbsG: number, maxPerIntake = 1): Food => ({ id, name: id, carbsG, unit: id, unitPlural: `${id}s`, selected: true, maxPerIntake });

describe('recommandations', () => {
  it('avant : g/kg selon la durée', () => {
    expect(preRideCarbs(3600, 70)).toMatchObject({ gPerKg: 1, totalG: 70 });
    expect(preRideCarbs(2 * 3600, 70).gPerKg).toBe(2);
    expect(preRideCarbs(3 * 3600, 70).gPerKg).toBe(3);
    expect(preRideCarbs(5 * 3600, 70)).toMatchObject({ gPerKg: 4, totalG: 280 });
  });

  it('pendant : fourchettes par durée, objectif selon le niveau', () => {
    expect(duringRideCarbs(3600, 'confirme')).toMatchObject({ optional: true, targetGPerH: 0 });
    expect(duringRideCarbs(2 * 3600, 'debutant').targetGPerH).toBe(30);
    expect(duringRideCarbs(2 * 3600, 'confirme').targetGPerH).toBe(60);
    const long = duringRideCarbs(4 * 3600, 'intermediaire');
    expect(long.rangeGPerH).toEqual([60, 90]);
    expect(long.targetGPerH).toBe(75);
    expect(long.totalG).toBe(300);
    expect(long.waterTotalMl).toBe(2400);
  });

  it('exemples d’aliments avant la sortie ≈ total visé', () => {
    const ex = preRideExamples(200);
    const carbs = ex[0].grams * 0.3 + ex[1].grams * 0.5 + ex[2].grams * 0.22 + ex[3].grams * 0.75;
    expect(carbs).toBeGreaterThan(180);
    expect(carbs).toBeLessThan(220);
  });
});

describe('choix des aliments d’une prise', () => {
  it('un aliment principal complété par des petits', () => {
    const items = chooseItems([food('barre', 25), food('dragibus', 2.5, 8)], 30, 0);
    expect(items).toEqual([
      { foodId: 'barre', count: 1 },
      { foodId: 'dragibus', count: 2 },
    ]);
  });

  it('alterne les aliments principaux d’une prise à l’autre', () => {
    const foods = [food('barre', 25), food('gel', 22)];
    expect(chooseItems(foods, 25, 0)[0].foodId).toBe('barre');
    expect(chooseItems(foods, 25, 1)[0].foodId).toBe('gel');
  });

  it('combine plusieurs aliments principaux pour une grosse prise', () => {
    const items = chooseItems([food('barre', 25), food('gel', 22), food('dragibus', 2.5, 8)], 45, 0);
    expect(items.map((i) => i.foodId)).toEqual(['barre', 'gel']);
  });

  it('écart entre prises ≤ 25 min', () => {
    const p = profileOf(60_000, () => 100);
    const e = estimateEnergy(p, { riderKg: 75, bikeKg: 11, heightCm: 178, avgSpeedKmh: 20 });
    const plan = planNutrition({ profile: p, timeAt: e.timeAt, durationS: e.durationS, targetGPerH: 60, foods: [food('barre', 25)], climbs: [] });
    for (let k = 1; k < plan.intakes.length; k++) expect(plan.intakes[k].timeS - plan.intakes[k - 1].timeS).toBeLessThanOrEqual(25 * 60 + 1);
  });

  it('respecte le maximum par prise', () => {
    const items = chooseItems([food('dragibus', 2.5, 8)], 40, 0);
    expect(items).toEqual([{ foodId: 'dragibus', count: 8 }]);
  });
});

describe('plan de ravitaillement', () => {
  // 60 km, montée à 8 % entre 20 et 22 km
  const profile = profileOf(60_000, (d) => (d < 20_000 ? 100 : d < 22_000 ? 100 + (d - 20_000) * 0.08 : 260));
  const climbs = detectClimbs(profile);
  const energy = estimateEnergy(profile, { riderKg: 75, bikeKg: 11, heightCm: 178, avgSpeedKmh: 20 });
  const foods = [food('barre', 25), food('gel', 25), food('dragibus', 2.5, 8)];
  const plan = planNutrition({ profile, timeAt: energy.timeAt, durationS: energy.durationS, targetGPerH: 60, foods, climbs });

  it('prises régulières, la première vers 30 min, aucune dans la montée', () => {
    expect(plan.intakes.length).toBeGreaterThanOrEqual(6);
    expect(plan.intakes[0].timeS).toBeGreaterThan(25 * 60);
    expect(plan.intakes[0].timeS).toBeLessThan(40 * 60);
    for (const i of plan.intakes) {
      expect(i.distanceM < 20_000 || i.distanceM > 22_000).toBe(true);
      expect(i.onSlope).toBe(false);
    }
    // ordre croissant et dernière prise avant la fin
    for (let k = 1; k < plan.intakes.length; k++) expect(plan.intakes[k].distanceM).toBeGreaterThan(plan.intakes[k - 1].distanceM);
    expect(plan.intakes.at(-1)!.timeS).toBeLessThan(energy.durationS - 10 * 60);
  });

  it('total prévu proche de l’objectif, liste à emporter cohérente', () => {
    expect(plan.targetTotalG).toBe(180); // 3 h à 60 g/h
    expect(Math.abs(plan.plannedTotalG - plan.targetTotalG)).toBeLessThanOrEqual(10);
    const packed = plan.packing.reduce((s, p) => s + p.count * (foods.find((f) => f.id === p.foodId)!.carbsG), 0);
    expect(packed).toBeCloseTo(plan.plannedTotalG, 0);
    expect(plan.intakes[0].label).toMatch(/barre|gel/);
  });

  it('plan vide expliqué : sortie courte ou rien de coché', () => {
    expect(planNutrition({ profile, timeAt: energy.timeAt, durationS: 3000, targetGPerH: 0, foods, climbs }).emptyReason).toMatch(/facultatif/);
    expect(planNutrition({ profile, timeAt: energy.timeAt, durationS: 9000, targetGPerH: 60, foods: [], climbs }).emptyReason).toMatch(/Coche/);
  });

  it('cherche un point calme à proximité (ici : juste après le sommet)', () => {
    const spot = nearestCalmPoint(profile, climbs, 21_600, 0, 60_000);
    expect(spot.calm).toBe(true);
    expect(spot.distanceM).toBeGreaterThan(22_000);
    expect(spot.distanceM - 21_600).toBeLessThanOrEqual(1000);
  });

  it('signale quand aucun point calme n’existe à moins de 1 km', () => {
    const spot = nearestCalmPoint(profile, climbs, 21_000, 0, 60_000);
    expect(spot.calm).toBe(false);
    expect(spot.distanceM).toBe(21_000);
  });
});

describe('base d’aliments', () => {
  it('les aliments par défaut sont valides', () => {
    expect(sanitizeFoods(DEFAULT_FOODS)).toHaveLength(DEFAULT_FOODS.length);
    expect(DEFAULT_FOODS.find((f) => f.id === 'dragibus')?.carbsG).toBe(2.5);
  });
  it('rejette les saisies invalides', () => {
    expect(sanitizeFoods('x')).toBeNull();
    expect(sanitizeFoods([{ name: '', carbsG: 10 }, { name: 'Gel', carbsG: -1 }, { name: 'Ok', carbsG: '12' }])).toHaveLength(1);
  });
});
