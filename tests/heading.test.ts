import { describe, expect, it } from 'vitest';
import { angleDiff, bearing, HeadingEstimator } from '../src/core/gps/heading';
import type { GpsFix } from '../src/core/gps/types';

const M_PER_DEG = 111_195;
const COS45 = Math.cos((45 * Math.PI) / 180);

/** Position à (nord, est) mètres d'un point de référence, à l'instant t (s). */
function fix(northM: number, eastM: number, t: number, speed: number | null = 6): GpsFix {
  return { lat: 45 + northM / M_PER_DEG, lon: 5 + eastM / (M_PER_DEG * COS45), accuracy: 5, altitude: null, speed, time: t * 1000 };
}

describe('bearing / angleDiff', () => {
  it('points cardinaux', () => {
    expect(bearing(45, 5, 46, 5)).toBeCloseTo(0, 5);
    expect(bearing(45, 5, 45, 6)).toBeCloseTo(90, 0);
    expect(bearing(45, 5, 44, 5)).toBeCloseTo(180, 5);
    expect(bearing(45, 5, 45, 4)).toBeCloseTo(270, 0);
  });
  it('écart angulaire par le plus court chemin', () => {
    expect(angleDiff(10, 350)).toBe(20);
    expect(angleDiff(350, 10)).toBe(-20);
    expect(angleDiff(90, 270)).toBe(-180);
  });
});

describe('HeadingEstimator', () => {
  it('donne le cap en ligne droite vers l’est', () => {
    const h = new HeadingEstimator();
    for (let t = 0; t <= 20; t++) h.update(fix(0, t * 6, t));
    expect(h.heading).toBeCloseTo(90, 0);
  });

  it('inconnu tant qu’on n’a pas roulé', () => {
    const h = new HeadingEstimator();
    h.update(fix(0, 0, 0, 0));
    h.update(fix(3, 2, 1, 0));
    expect(h.heading).toBeNull();
  });

  it('garde le dernier cap à l’arrêt malgré le bruit GPS', () => {
    const h = new HeadingEstimator();
    for (let t = 0; t <= 10; t++) h.update(fix(t * 6, 0, t)); // vers le nord
    const before = h.heading!;
    // Arrêt : positions qui sautillent dans tous les sens, vitesse nulle
    for (let t = 11; t <= 40; t++) h.update(fix(60 + (t % 2 ? 4 : -4), t % 3 ? 4 : -4, t, 0));
    expect(h.heading).toBe(before);
    expect(before).toBeCloseTo(0, 0);
  });

  it('tourne en douceur, par le plus court chemin (350° → 10°)', () => {
    const h = new HeadingEstimator();
    // Cap 350° puis cap 10°
    const dir = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    let n = 0;
    let e = 0;
    let t = 0;
    const [n1, e1] = dir(350);
    for (let k = 0; k < 15; k++, t++) h.update(fix((n += 6 * n1), (e += 6 * e1), t));
    expect(h.heading).toBeCloseTo(350, 0);
    const [n2, e2] = dir(10);
    const seen: number[] = [];
    for (let k = 0; k < 30; k++, t++) {
      h.update(fix((n += 6 * n2), (e += 6 * e2), t));
      seen.push(h.heading!);
    }
    expect(h.heading).toBeCloseTo(10, 0);
    // Jamais passé par le sud
    expect(seen.every((x) => x > 340 || x < 20)).toBe(true);
  });

  it('ignore les déplacements trop lents (poussage à 3 km/h)', () => {
    const h = new HeadingEstimator();
    for (let t = 0; t <= 10; t++) h.update(fix(t * 6, 0, t)); // nord, 6 m/s
    for (let t = 11; t <= 60; t++) h.update(fix(60, (t - 10) * 0.8, t, 0.8)); // est, 0,8 m/s
    expect(h.heading).toBeCloseTo(0, 0);
  });
});
