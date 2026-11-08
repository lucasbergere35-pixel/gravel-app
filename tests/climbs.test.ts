import { describe, expect, it } from 'vitest';
import { climbStatus, detectClimbs, elevationAt, gradeAt } from '../src/core/geo/climbs';
import type { ElevationProfile } from '../src/core/geo/elevation';
import { pageAfterSwipe, parseStoredPage } from '../src/ui/pager';

/** Profil à pas de 10 m dont l'altitude est donnée par f(distance). */
function profileOf(totalM: number, f: (d: number) => number): ElevationProfile {
  const distances: number[] = [];
  const elevations: number[] = [];
  for (let d = 0; d <= totalM; d += 10) {
    distances.push(d);
    elevations.push(f(d));
  }
  return { step: 10, distances, elevations };
}

/**
 * Parcours de 10 km :
 *  0–2 km plat (100 m), 2–3 km montée à 6 % (+60 m), 3–5 km plat (160 m),
 *  5–6 km descente (−60 m), 6–8 km plat, 8–8,5 km montée à 10 % (+50 m), puis plat.
 */
const course = (d: number): number => {
  if (d < 2000) return 100;
  if (d < 3000) return 100 + (d - 2000) * 0.06;
  if (d < 5000) return 160;
  if (d < 6000) return 160 - (d - 5000) * 0.06;
  if (d < 8000) return 100;
  if (d < 8500) return 100 + (d - 8000) * 0.1;
  return 150;
};

describe('detectClimbs', () => {
  const profile = profileOf(10_000, course);
  const climbs = detectClimbs(profile);

  it('trouve les deux montées avec leurs caractéristiques', () => {
    expect(climbs).toHaveLength(2);
    const [a, b] = climbs;
    expect(a.startM).toBeCloseTo(2000, -2);
    expect(a.endM).toBeCloseTo(3000, -2);
    expect(a.gainM).toBeCloseTo(60, 0);
    expect(a.avgGradePct).toBeCloseTo(6, 0);
    expect(b.startM).toBeCloseTo(8000, -2);
    expect(b.lengthM).toBeCloseTo(500, -1);
    expect(b.avgGradePct).toBeCloseTo(10, 0);
  });

  it('ignore les bosses trop petites ou trop douces', () => {
    // +15 m : trop petit ; +40 m sur 4 km (1 %) : trop doux
    const small = profileOf(3000, (d) => (d > 1000 && d < 1500 ? 100 + (d - 1000) * 0.03 : d >= 1500 ? 115 : 100));
    expect(detectClimbs(small)).toHaveLength(0);
    const gentle = profileOf(6000, (d) => 100 + Math.min(d, 4000) * 0.01);
    expect(detectClimbs(gentle)).toHaveLength(0);
  });

  it('une petite redescente (< 10 m) ne coupe pas une montée', () => {
    const p = profileOf(3000, (d) => {
      if (d < 1000) return 100 + d * 0.05; // +50 m
      if (d < 1100) return 150 - (d - 1000) * 0.05; // −5 m
      if (d < 2000) return 145 + (d - 1100) * 0.05; // +45 m
      return 190;
    });
    const c = detectClimbs(p);
    expect(c).toHaveLength(1);
    expect(c[0].gainM).toBeCloseTo(90, 0);
  });

  it('profil vide ou plat', () => {
    expect(detectClimbs({ step: 10, distances: [], elevations: [] })).toEqual([]);
    expect(detectClimbs(profileOf(5000, () => 100))).toEqual([]);
  });
});

describe('situation par rapport aux montées', () => {
  const profile = profileOf(10_000, course);
  const climbs = detectClimbs(profile);

  it('avant la première montée : prochaine montée et distance', () => {
    const s = climbStatus(climbs, profile, 500);
    expect(s.current).toBeNull();
    expect(s.next?.distanceToStartM).toBeCloseTo(1500, -2);
  });

  it('pendant une montée : reste jusqu’au sommet et pente', () => {
    const s = climbStatus(climbs, profile, 2500);
    expect(s.current?.remainingM).toBeCloseTo(500, -2);
    expect(s.current?.remainingGainM).toBeCloseTo(30, 0);
    expect(s.current?.gradePct).toBeCloseTo(6, 0);
    expect(s.next?.climb.startM).toBeCloseTo(8000, -2); // la suivante
  });

  it('après la dernière montée : rien', () => {
    expect(climbStatus(climbs, profile, 9000)).toEqual({ current: null, next: null });
  });

  it('altitude et pente interpolées', () => {
    expect(elevationAt(profile, 2505)).toBeCloseTo(130.3, 1);
    expect(gradeAt(profile, 5500)).toBeCloseTo(-6, 0);
    expect(gradeAt(profile, 0)).toBeCloseTo(0, 5);
  });
});

describe('pagination', () => {
  it('glisser à gauche = page suivante, à droite = précédente, sans boucle', () => {
    expect(pageAfterSwipe(0, -80, 5, 3)).toBe(1);
    expect(pageAfterSwipe(1, 80, 5, 3)).toBe(0);
    expect(pageAfterSwipe(2, -80, 0, 3)).toBe(2);
    expect(pageAfterSwipe(0, 80, 0, 3)).toBe(0);
  });
  it('ignore les gestes courts ou verticaux', () => {
    expect(pageAfterSwipe(1, -20, 0, 3)).toBe(1);
    expect(pageAfterSwipe(1, -60, 80, 3)).toBe(1);
  });
  it('page mémorisée invalide → 0', () => {
    expect(parseStoredPage('2', 3)).toBe(2);
    expect(parseStoredPage('7', 3)).toBe(0);
    expect(parseStoredPage(null, 3)).toBe(0);
    expect(parseStoredPage('abc', 3)).toBe(0);
  });
});
