// @vitest-environment jsdom
// (jsdom pour relire le GPX exporté avec DOMParser.)
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/core/gpx/parse';
import type { GpsFix } from '../src/core/gps/types';
import {
  activeIntake,
  announcedIntake,
  drinkDue,
  initNutritionState,
  markDone,
  markDrink,
  markLater,
  markSkipped,
  summarizeNutrition,
  updateIntakes,
  type FrozenPlan,
} from '../src/core/ride/intakes';
import { buildRideSummary, rideGain, rideToGpx, sanitizeFeeling } from '../src/core/ride/summary';

/** Plan figé : prises aux km 10, 20, 30 (temps estimés 30, 60, 90 min). */
function plan(): FrozenPlan {
  return {
    intakes: [10, 20, 30].map((km, k) => ({
      id: `p${k}`,
      distanceM: km * 1000,
      timeS: km * 3 * 60,
      label: `prise ${k}`,
      carbsG: 25,
      why: k === 1 ? 'avant la montée de 2,1 km à 8 % (+159 m)' : 'prise régulière',
      reason: k === 1 ? ('preClimb' as const) : ('regular' as const),
    })),
    targetGPerH: 45,
    plannedTotalG: 75,
    fuelStartS: 45 * 60,
    frozenAt: 0,
  };
}

const at = (alongM: number | null, movingTimeS: number, onTrack = true) => ({ alongM, onTrack, movingTimeS });

describe('déclenchement des prises', () => {
  it('pré-alerte à 500 m, puis alerte au km de la prise', () => {
    const s = initNutritionState(plan());
    expect(updateIntakes(s, at(9000, 1600))).toEqual([]);
    const pre = updateIntakes(s, at(9500, 1700));
    expect(pre.map((e) => e.kind)).toEqual(['pre']);
    expect(announcedIntake(s)?.id).toBe('p0');
    expect(updateIntakes(s, at(9800, 1750))).toEqual([]); // pas de répétition
    const due = updateIntakes(s, at(10_000, 1800));
    expect(due.map((e) => `${e.kind}:${e.intake.id}`)).toEqual(['due:p0']);
    expect(activeIntake(s)?.id).toBe('p0');
    expect(announcedIntake(s)).toBeNull();
  });

  it('suit la position sur le tracé, pas la distance parcourue (détour)', () => {
    const s = initNutritionState(plan());
    // 40 min de détour : on reste au km 8 du tracé, le temps avance au-delà du temps prévu
    expect(updateIntakes(s, at(8000, 40 * 60)).filter((e) => e.kind === 'due')).toEqual([]);
    expect(activeIntake(s)).toBeNull();
  });

  it('hors tracé : déclenche au temps estimé pour ne pas sauter une prise', () => {
    const s = initNutritionState(plan());
    expect(updateIntakes(s, at(null, 28 * 60, false))).toEqual([]); // 2 min avant : rien
    expect(updateIntakes(s, at(null, 28 * 60 + 40, false)).map((e) => e.kind)).toEqual(['pre']); // < 90 s avant
    expect(updateIntakes(s, at(8000, 30 * 60, false)).map((e) => e.kind)).toEqual(['due']);
  });

  it('reste affichée tant qu’elle n’est pas traitée, et les suivantes attendent leur tour', () => {
    const s = initNutritionState(plan());
    // Retour après écran éteint : on est déjà au km 21 → deux prises dues d'un coup
    const ev = updateIntakes(s, at(21_000, 65 * 60));
    expect(ev.filter((e) => e.kind === 'due').map((e) => e.intake.id)).toEqual(['p0', 'p1']);
    expect(activeIntake(s)?.id).toBe('p0');
    updateIntakes(s, at(21_200, 66 * 60));
    expect(activeIntake(s)?.id).toBe('p0');
    markDone(s, 'p0', 66 * 60);
    expect(activeIntake(s)?.id).toBe('p1');
  });

  it('« Plus tard » : nouveau rappel 1 km plus loin', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_050, 1800));
    markLater(s, 'p0', at(10_050, 1800));
    expect(activeIntake(s)).toBeNull();
    expect(updateIntakes(s, at(10_900, 2000))).toEqual([]); // ni pré-alerte ni alerte
    expect(updateIntakes(s, at(11_050, 2050)).map((e) => e.kind)).toEqual(['due']);
    expect(s.states[0].laterCount).toBe(1);
  });

  it('« Plus tard » hors tracé : rappel 4 min plus tard', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 1800));
    markLater(s, 'p0', at(10_000, 1800));
    expect(updateIntakes(s, at(null, 1800 + 200, false))).toEqual([]);
    expect(updateIntakes(s, at(null, 1800 + 240, false)).map((e) => e.kind)).toEqual(['due']);
  });

  it('« Passer » retire la prise', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 1800));
    markSkipped(s, 'p0');
    expect(activeIntake(s)).toBeNull();
    expect(updateIntakes(s, at(10_500, 1900))).toEqual([]);
  });
});

describe('rappel boisson', () => {
  it('toutes les 20 min de temps en mouvement', () => {
    const s = initNutritionState(plan(), 20 * 60);
    expect(drinkDue(s, 19 * 60)).toBe(false);
    expect(drinkDue(s, 20 * 60)).toBe(true);
    markDrink(s, 20 * 60);
    expect(drinkDue(s, 30 * 60)).toBe(false);
    expect(drinkDue(s, 40 * 60)).toBe(true);
  });

  it('pas dans les 5 min après une prise, ni pendant une prise affichée', () => {
    const s = initNutritionState(plan(), 20 * 60);
    updateIntakes(s, at(10_000, 29 * 60)); // prise due à 29 min
    expect(drinkDue(s, 29 * 60)).toBe(false); // prise affichée
    markDone(s, 'p0', 29 * 60);
    expect(drinkDue(s, 31 * 60)).toBe(false); // < 5 min après
    expect(drinkDue(s, 34 * 60)).toBe(true);
  });

  it('désactivé si intervalle 0', () => {
    expect(drinkDue(initNutritionState(plan(), 0), 5 * 3600)).toBe(false);
  });
});

describe('bilan', () => {
  it('compte faites / plus tard / passées et les glucides réellement pris', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 30 * 60));
    markLater(s, 'p0', at(10_000, 30 * 60));
    updateIntakes(s, at(11_000, 33 * 60));
    markDone(s, 'p0', 33 * 60);
    updateIntakes(s, at(20_000, 60 * 60));
    markSkipped(s, 'p1');
    markDrink(s, 50 * 60);
    const b = summarizeNutrition(s, 75 * 60); // arrêt au km 25 : p2 non atteinte
    expect(b).toMatchObject({ done: 1, postponed: 1, skipped: 1, missed: 0, notReached: 1, takenG: 25, plannedG: 50, drinks: 1 });
    expect(b.takenGPerH).toBeCloseTo(50, 0); // 25 g en 30 min après la 45e minute
  });

  it('pas de g/h affiché si la durée couverte est trop courte', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 30 * 60));
    markDone(s, 'p0', 30 * 60);
    expect(summarizeNutrition(s, 48 * 60).takenGPerH).toBeNull(); // 3 min après la 45e minute
  });
});

describe('sortie réelle', () => {
  const T0 = Date.parse('2026-11-09T08:00:00Z');
  const fixes: GpsFix[] = Array.from({ length: 300 }, (_, i) => ({
    lat: 45 + (i * 10) / 111_195,
    lon: 5,
    accuracy: 5,
    altitude: 100 + i * 0.5, // +150 m
    speed: 5,
    time: T0 + i * 2000,
  }));

  it('D+ réel d’après les altitudes GPS', () => {
    expect(rideGain(fixes)).toBeGreaterThan(140);
    expect(rideGain(fixes)).toBeLessThan(155);
    expect(rideGain(fixes.map((f) => ({ ...f, altitude: null })))).toBeNull();
  });

  it('résumé : vitesse moyenne en mouvement', () => {
    const s = buildRideSummary(fixes, { distanceM: 3000, movingTimeS: 600, totalTimeS: 900 }, null);
    expect(s.avgSpeedKmh).toBeCloseTo(18, 5);
  });

  it('export GPX avec heures et altitudes, relisible', () => {
    const gpx = parseGpx(rideToGpx('Sortie du 9 nov.', fixes));
    expect(gpx.name).toBe('Sortie du 9 nov.');
    expect(gpx.points).toHaveLength(300);
    expect(gpx.points[0].time).toBe(T0);
    expect(gpx.points[299].ele).toBeCloseTo(249.5, 1);
  });

  it('ressenti nettoyé', () => {
    expect(sanitizeFeeling({ kind: 'fringale', km: '42,5'.replace(',', '.'), note: ' trop peu mangé ' })).toEqual({ kind: 'fringale', km: 42.5, note: 'trop peu mangé' });
    expect(sanitizeFeeling({ kind: 'bonne', km: '' })).toEqual({ kind: 'bonne', km: null, note: '' });
    expect(sanitizeFeeling({ kind: 'autre' })).toBeNull();
  });
});
