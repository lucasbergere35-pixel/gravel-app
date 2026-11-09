import { describe, expect, it } from 'vitest';
import type { ElevationProfile } from '../src/core/geo/elevation';
import {
  airDensity,
  bodySurfaceArea,
  distanceAtTime,
  estimateEnergy,
  powerForSpeed,
  speedForPower,
  timeAtDistance,
} from '../src/core/energy/model';

function profileOf(totalM: number, f: (d: number) => number): ElevationProfile {
  const distances: number[] = [];
  const elevations: number[] = [];
  for (let d = 0; d <= totalM; d += 10) {
    distances.push(d);
    elevations.push(f(d));
  }
  return { step: 10, distances, elevations };
}

const rider = { riderKg: 75, bikeKg: 11, heightCm: 178, avgSpeedKmh: 20 };

describe('briques physiques', () => {
  it('surface corporelle et densité de l’air', () => {
    expect(bodySurfaceArea(75, 178)).toBeCloseTo(1.93, 1);
    expect(airDensity(0)).toBeCloseTo(1.225, 3);
    expect(airDensity(1500)).toBeCloseTo(1.03, 1);
  });

  it('vitesse ↔ puissance sont cohérentes', () => {
    for (const grade of [0, 0.05, -0.02]) {
      const v = speedForPower(180, grade, 86, 0.4, 1.2);
      expect(powerForSpeed(v, grade, 86, 0.4, 1.2)).toBeCloseTo(180, 0);
    }
  });

  it('valeurs réalistes : ~180 W ≈ 26–30 km/h sur le plat, ~10 km/h à 6 %', () => {
    const flat = speedForPower(180, 0, 86, 0.4, 1.2) * 3.6;
    expect(flat).toBeGreaterThan(26);
    expect(flat).toBeLessThan(31);
    const climb = speedForPower(180, 0.06, 86, 0.4, 1.2) * 3.6;
    expect(climb).toBeGreaterThan(8);
    expect(climb).toBeLessThan(13);
  });

  it('vitesse plafonnée en forte descente', () => {
    expect(speedForPower(150, -0.12, 86, 0.4, 1.2) * 3.6).toBeCloseTo(40, 0);
  });
});

describe('estimateEnergy', () => {
  it('respecte la durée visée (vitesse moyenne) sur le plat', () => {
    const r = estimateEnergy(profileOf(40_000, () => 100), rider);
    expect(r.durationS).toBeCloseTo(7200, -1); // 40 km à 20 km/h
    expect(r.massKg).toBe(86);
    // 2 h à ~120 W : ~860 kJ mécaniques → ~860 kcal métaboliques (règle 1 kJ ≈ 1 kcal)
    expect(r.metabolicKcal).toBeGreaterThan(600);
    expect(r.metabolicKcal).toBeLessThan(1100);
    expect(r.metabolicKcal).toBeCloseTo(r.mechanicalKJ / 0.24 / 4.184, 0);
  });

  it('un parcours vallonné à même vitesse moyenne coûte plus d’énergie', () => {
    const flat = estimateEnergy(profileOf(40_000, () => 100), rider);
    const hilly = estimateEnergy(profileOf(40_000, (d) => 100 + 80 * Math.sin(d / 2000)), rider);
    expect(hilly.metabolicKcal).toBeGreaterThan(flat.metabolicKcal);
    expect(hilly.powerW).toBeGreaterThan(flat.powerW);
  });

  it('plus lourd = plus d’énergie', () => {
    const p = profileOf(20_000, (d) => 100 + d * 0.02);
    expect(estimateEnergy(p, { ...rider, riderKg: 90 }).metabolicKcal).toBeGreaterThan(estimateEnergy(p, rider).metabolicKcal);
  });

  it('conversion km ↔ temps', () => {
    const p = profileOf(10_000, () => 100);
    const r = estimateEnergy(p, rider);
    expect(timeAtDistance(p, r.timeAt, 5000)).toBeCloseTo(900, -1);
    expect(distanceAtTime(p, r.timeAt, 900)).toBeCloseTo(5000, -2);
    expect(distanceAtTime(p, r.timeAt, 1e9)).toBe(10_000);
  });
});
