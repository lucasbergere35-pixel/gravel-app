// @vitest-environment jsdom
// (jsdom pour relire le GPX exporté avec DOMParser.)
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/core/gpx/parse';
import type { GpsFix } from '../src/core/gps/types';
import {
  announcedIntake,
  describeIntakes,
  drinkDue,
  initNutritionState,
  markDrink,
  setTaken,
  summarizeNutrition,
  updateIntakes,
  type FrozenPlan,
  type RideNutritionState,
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
const dueIds = (s: RideNutritionState, pos: ReturnType<typeof at>) =>
  updateIntakes(s, pos)
    .filter((e) => e.kind === 'due')
    .map((e) => e.intake.id);

describe('déclenchement des prises', () => {
  it('pré-alerte à 500 m, puis prise au km prévu (faite par défaut)', () => {
    const s = initNutritionState(plan());
    expect(updateIntakes(s, at(9000, 1600))).toEqual([]);
    expect(updateIntakes(s, at(9500, 1700)).map((e) => e.kind)).toEqual(['pre']);
    expect(announcedIntake(s)?.id).toBe('p0');
    expect(updateIntakes(s, at(9800, 1750))).toEqual([]); // pas de répétition
    expect(dueIds(s, at(10_000, 1800))).toEqual(['p0']);
    expect(s.states[0].status).toBe('done');
    expect(announcedIntake(s)).toBeNull();
    expect(dueIds(s, at(10_200, 1830))).toEqual([]); // une seule fois
  });

  it('suit la position sur le tracé, pas la distance parcourue (détour)', () => {
    const s = initNutritionState(plan());
    // 40 min de détour : on reste au km 8 du tracé, le temps avance au-delà du temps prévu
    expect(dueIds(s, at(8000, 40 * 60))).toEqual([]);
  });

  it('hors tracé : déclenche au temps estimé pour ne pas sauter une prise', () => {
    const s = initNutritionState(plan());
    expect(updateIntakes(s, at(null, 28 * 60, false))).toEqual([]); // 2 min avant : rien
    expect(updateIntakes(s, at(null, 28 * 60 + 40, false)).map((e) => e.kind)).toEqual(['pre']); // < 90 s avant
    expect(dueIds(s, at(8000, 30 * 60, false))).toEqual(['p0']);
  });

  it('écran éteint : toutes les prises manquées arrivent ensemble au retour', () => {
    const s = initNutritionState(plan());
    expect(dueIds(s, at(21_000, 65 * 60))).toEqual(['p0', 'p1']);
  });
});

describe('texte des bannières', () => {
  it('une prise : contenu + raison + grammes', () => {
    const t = describeIntakes([plan().intakes[1]]);
    expect(t.title).toBe('Km 20 : prise 1');
    expect(t.lines).toEqual(['⛰ avant la montée de 2,1 km à 8 % (+159 m) · 25 g']);
  });

  it('plusieurs prises manquées : regroupées dans une seule bannière', () => {
    const t = describeIntakes(plan().intakes.slice(0, 2));
    expect(t.title).toBe('2 prises à rattraper');
    expect(t.lines).toEqual(['Km 10 : prise 0 (25 g)', 'Km 20 : prise 1 (25 g)', 'Total 50 g, en une ou deux fois']);
  });
});

describe('rappel boisson', () => {
  it('toutes les 20 min de temps en mouvement, compté dès l’affichage', () => {
    const s = initNutritionState(plan(), 20 * 60);
    expect(drinkDue(s, 19 * 60)).toBe(false);
    expect(drinkDue(s, 20 * 60)).toBe(true);
    markDrink(s, 20 * 60);
    expect(drinkDue(s, 30 * 60)).toBe(false);
    expect(drinkDue(s, 40 * 60)).toBe(true);
    expect(s.drinkCount).toBe(1);
  });

  it('pas dans les 5 min après une prise', () => {
    const s = initNutritionState(plan(), 20 * 60);
    updateIntakes(s, at(10_000, 29 * 60)); // prise à 29 min
    expect(drinkDue(s, 29 * 60)).toBe(false);
    expect(drinkDue(s, 33 * 60)).toBe(false); // < 5 min après
    expect(drinkDue(s, 34 * 60)).toBe(true);
  });

  it('désactivé si intervalle 0', () => {
    expect(drinkDue(initNutritionState(plan(), 0), 5 * 3600)).toBe(false);
  });
});

describe('bilan', () => {
  it('prises faites par défaut ; décocher met à jour g et g/h', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 30 * 60));
    updateIntakes(s, at(20_000, 60 * 60));
    markDrink(s, 50 * 60);
    // arrêt à 75 min au km 25 : p2 non atteinte
    let b = summarizeNutrition(s, 75 * 60);
    expect(b).toMatchObject({ taken: 2, notTaken: 0, notReached: 1, takenG: 50, plannedG: 50, drinks: 1 });
    expect(b.takenGPerH).toBeCloseTo(100, 0); // 50 g en 30 min après la 45e minute

    setTaken(s, 'p1', false); // pas prise finalement
    b = summarizeNutrition(s, 75 * 60);
    expect(b).toMatchObject({ taken: 1, notTaken: 1, takenG: 25 });
    expect(b.takenGPerH).toBeCloseTo(50, 0);

    setTaken(s, 'p1', true);
    expect(summarizeNutrition(s, 75 * 60).takenG).toBe(50);
  });

  it('on ne peut pas cocher une prise non atteinte', () => {
    const s = initNutritionState(plan());
    setTaken(s, 'p2', true);
    expect(s.states[2].status).toBe('pending');
  });

  it('pas de g/h si la durée couverte est trop courte', () => {
    const s = initNutritionState(plan());
    updateIntakes(s, at(10_000, 30 * 60));
    expect(summarizeNutrition(s, 48 * 60).takenGPerH).toBeNull(); // 3 min après la 45e minute
  });

  it('compatible avec les sorties de la version précédente (statut « due »)', () => {
    const s = initNutritionState(plan());
    s.states[0].status = 'due';
    expect(summarizeNutrition(s, 75 * 60)).toMatchObject({ taken: 1, takenG: 25 });
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
    expect(sanitizeFeeling({ kind: 'fringale', km: '42.5', note: ' trop peu mangé ' })).toEqual({ kind: 'fringale', km: 42.5, note: 'trop peu mangé' });
    expect(sanitizeFeeling({ kind: 'bonne', km: '' })).toEqual({ kind: 'bonne', km: null, note: '' });
    expect(sanitizeFeeling({ kind: 'autre' })).toBeNull();
  });
});
