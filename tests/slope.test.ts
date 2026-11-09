import { describe, expect, it } from 'vitest';
import type { ElevationProfile } from '../src/core/geo/elevation';
import { slopeClass, slopeRuns } from '../src/core/geo/slope';

function profileFrom(grades: { lengthM: number; pct: number }[]): ElevationProfile {
  const distances = [0];
  const elevations = [100];
  for (const g of grades) {
    for (let d = 10; d <= g.lengthM; d += 10) {
      distances.push(distances[distances.length - 1] + 10);
      elevations.push(elevations[elevations.length - 1] + (10 * g.pct) / 100);
    }
  }
  return { step: 10, distances, elevations };
}

describe('slopeClass', () => {
  it('classe selon les seuils 3 / 6 / 9 %', () => {
    expect(slopeClass(0)).toBe(0);
    expect(slopeClass(2.9)).toBe(0);
    expect(slopeClass(3)).toBe(1);
    expect(slopeClass(5.9)).toBe(1);
    expect(slopeClass(6)).toBe(2);
    expect(slopeClass(9)).toBe(2);
    expect(slopeClass(9.1)).toBe(3);
  });
  it('tient compte des descentes raides', () => {
    expect(slopeClass(-12)).toBe(3);
  });
});

describe('slopeRuns', () => {
  it('découpe le profil en tronçons contigus couvrant tout le profil', () => {
    const p = profileFrom([
      { lengthM: 1000, pct: 1 },
      { lengthM: 1000, pct: 7 },
      { lengthM: 1000, pct: 12 },
    ]);
    const runs = slopeRuns(p);
    expect(runs[0].from).toBe(0);
    expect(runs[runs.length - 1].to).toBe(p.distances.length - 1);
    for (let i = 1; i < runs.length; i++) expect(runs[i].from).toBe(runs[i - 1].to);
    expect(runs.map((r) => r.cls)).toEqual([0, 1, 2, 3].filter((c) => runs.some((r) => r.cls === c)));
    // Les tronçons principaux sont bien présents.
    const longest = (cls: number) => Math.max(0, ...runs.filter((r) => r.cls === cls).map((r) => r.to - r.from));
    expect(longest(0)).toBeGreaterThan(80);
    expect(longest(2)).toBeGreaterThan(80);
    expect(longest(3)).toBeGreaterThan(80);
  });
  it('renvoie un tableau vide pour un profil trop court', () => {
    expect(slopeRuns({ step: 10, distances: [0], elevations: [100] })).toEqual([]);
  });
});
