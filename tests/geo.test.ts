import { describe, expect, it } from 'vitest';
import { cumulativeDistances, haversine } from '../src/core/geo/distance';
import {
  buildElevationProfile,
  climbAndDescent,
  fillMissingElevations,
  movingAverage,
  resample,
} from '../src/core/geo/elevation';
import { computeRouteStats, estimateDurationS } from '../src/core/geo/stats';
import { pointAtDistance } from '../src/core/geo/track';
import type { TrackPoint } from '../src/core/types';

/** Générateur pseudo-aléatoire déterministe (tests reproductibles). */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Tracé nord-sud : un point tous les `stepM` mètres, altitude donnée par f(distance). */
function line(n: number, stepM: number, f: (d: number) => number | null): TrackPoint[] {
  const dLat = stepM / 111_195; // 1° de latitude ≈ 111,195 km
  return Array.from({ length: n }, (_, i) => ({ lat: 45 + i * dLat, lon: 5, ele: f(i * stepM) }));
}

describe('distance', () => {
  it('1° de latitude ≈ 111,2 km', () => {
    expect(haversine(45, 5, 46, 5)).toBeCloseTo(111_195, -1);
  });
  it('Paris → Lyon ≈ 391,5 km', () => {
    expect(haversine(48.8566, 2.3522, 45.764, 4.8357) / 1000).toBeCloseTo(391.5, 0);
  });
  it('distance nulle et distances cumulées', () => {
    expect(haversine(45, 5, 45, 5)).toBe(0);
    const cum = cumulativeDistances(line(11, 100, () => 0));
    expect(cum[0]).toBe(0);
    expect(cum[10]).toBeCloseTo(1000, 0);
    expect(cumulativeDistances([])).toEqual([]);
  });
});

describe('profil altimétrique', () => {
  it('interpole les altitudes manquantes', () => {
    expect(fillMissingElevations([null, 10, null, 30, null], [0, 1, 2, 3, 4])).toEqual([10, 10, 20, 30, 30]);
    expect(fillMissingElevations([null, null], [0, 1])).toBeNull();
  });

  it('ré-échantillonne à pas régulier en gardant le dernier point', () => {
    const r = resample([0, 25], [0, 25], 10);
    expect(r.distances).toEqual([0, 10, 20, 25]);
    expect(r.values).toEqual([0, 10, 20, 25]);
  });

  it('supporte des points superposés (distance identique)', () => {
    const r = resample([0, 10, 10, 20], [0, 5, 5, 10], 10);
    expect(r.values.every(Number.isFinite)).toBe(true);
  });

  it('moyenne glissante', () => {
    expect(movingAverage([0, 0, 3, 0, 0], 1)).toEqual([0, 1, 1, 1, 0]);
  });

  it('hystérésis : ignore les petites oscillations', () => {
    expect(climbAndDescent([0, 2, 0, 2, 0, 2], 4)).toEqual({ gain: 0, loss: 0 });
    expect(climbAndDescent([0, 5, 10, 5, 0], 4)).toEqual({ gain: 10, loss: 10 });
  });

  it('terrain plat bruité (±3 m) : dénivelé presque nul', () => {
    const r = rng(1);
    const pts = line(1000, 10, () => 100 + (r() - 0.5) * 6); // 10 km
    const s = computeRouteStats(pts);
    // Sans lissage on obtiendrait ~2000 m de D+ !
    expect(s.gainM).toBeLessThan(15);
  });

  it('montée régulière de 300 m bruitée : D+ juste à ±5 %', () => {
    const r = rng(2);
    const pts = line(1000, 10, (d) => 100 + (300 * d) / 10_000 + (r() - 0.5) * 6);
    const s = computeRouteStats(pts);
    expect(s.gainM).toBeGreaterThan(285);
    expect(s.gainM).toBeLessThan(315);
    expect(s.lossM).toBeLessThan(15);
  });

  it('tracé sans altitude', () => {
    const s = computeRouteStats(line(10, 100, () => null));
    expect(s.hasElevation).toBe(false);
    expect(s.gainM).toBe(0);
    expect(s.distanceM).toBeCloseTo(900, 0);
    expect(buildElevationProfile(line(10, 100, () => null))).toBeNull();
  });
});

describe('stats et utilitaires', () => {
  it('durée estimée', () => {
    expect(estimateDurationS(36_000, 18)).toBeCloseTo(7200);
    expect(estimateDurationS(1000, 0)).toBe(0);
  });

  it('point à une distance donnée', () => {
    const pts = line(3, 1000, () => 0);
    const cum = cumulativeDistances(pts);
    const mid = pointAtDistance(pts, cum, 500)!;
    expect(mid.lat).toBeCloseTo((pts[0].lat + pts[1].lat) / 2, 6);
    expect(pointAtDistance(pts, cum, -10)).toEqual({ lat: pts[0].lat, lon: 5 });
    expect(pointAtDistance(pts, cum, 1e9)).toEqual({ lat: pts[2].lat, lon: 5 });
    expect(pointAtDistance([], [], 0)).toBeNull();
  });
});
