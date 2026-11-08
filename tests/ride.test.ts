import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from '../src/core/geo/distance';
import { climbAndDescent, cumulativeClimb, remainingClimb } from '../src/core/geo/elevation';
import { RouteMatcher } from '../src/core/geo/trackMatch';
import { GpsFilter } from '../src/core/gps/filter';
import type { GpsFix } from '../src/core/gps/types';
import { RideTracker } from '../src/core/ride/tracker';

const M_PER_DEG_LAT = 111_195;
const T0 = 1_750_000_000_000;

/** Position à `northM` mètres au nord et `eastM` à l'est d'un point de référence. */
function at(northM: number, eastM = 0): { lat: number; lon: number } {
  const lat = 45 + northM / M_PER_DEG_LAT;
  return { lat, lon: 5 + eastM / (M_PER_DEG_LAT * Math.cos((45 * Math.PI) / 180)) };
}

function fix(northM: number, tS: number, extra: Partial<GpsFix> = {}): GpsFix {
  return { ...at(northM), accuracy: 5, altitude: null, speed: null, time: T0 + tS * 1000, ...extra };
}

describe('GpsFilter', () => {
  it('rejette les positions imprécises, anciennes ou impossibles', () => {
    const f = new GpsFilter();
    expect(f.check(fix(0, 0))).toEqual({ ok: true });
    expect(f.check(fix(5, 1, { accuracy: 65 }))).toEqual({ ok: false, reason: 'accuracy' });
    expect(f.check(fix(5, 0))).toEqual({ ok: false, reason: 'time' });
    expect(f.check(fix(500, 2))).toEqual({ ok: false, reason: 'speed' }); // 250 m/s
    expect(f.check(fix(10, 2))).toEqual({ ok: true });
  });

  it('accepte après plusieurs rejets « vitesse » (référence probablement fausse)', () => {
    const f = new GpsFilter();
    f.check(fix(0, 0));
    expect(f.check(fix(1000, 1)).ok).toBe(false);
    expect(f.check(fix(1005, 2)).ok).toBe(false);
    expect(f.check(fix(1010, 3)).ok).toBe(false);
    expect(f.check(fix(1015, 4)).ok).toBe(true);
  });

  it('tolère un saut expliqué par la précision annoncée', () => {
    const f = new GpsFilter();
    f.check(fix(0, 0, { accuracy: 25 }));
    // 70 m en 1 s, mais 25 + 25 m d'incertitude → 20 m/s plausibles
    expect(f.check(fix(70, 1, { accuracy: 25 })).ok).toBe(true);
  });
});

describe('RideTracker', () => {
  it('compte distance et temps en mouvement, avec pause auto', () => {
    const t = new RideTracker(T0);
    let s = 0;
    // 100 s à 5 m/s
    for (; s <= 100; s++) t.addFix(fix(s * 5, s, { speed: 5 }));
    // 60 s à l'arrêt avec tremblement GPS de ±3 m
    for (let k = 1; k <= 60; k++) t.addFix(fix(500 + (k % 2 ? 3 : -3), 100 + k, { speed: 0 }));
    // 100 s de plus à 5 m/s
    for (let k = 1; k <= 100; k++) t.addFix(fix(500 + k * 5, 160 + k, { speed: 5 }));

    const snap = t.snapshot(T0 + 260_000);
    expect(snap.distanceM).toBeGreaterThan(990);
    expect(snap.distanceM).toBeLessThan(1010);
    expect(snap.movingTimeS).toBeGreaterThan(195);
    expect(snap.movingTimeS).toBeLessThan(205);
    expect(snap.totalTimeS).toBe(260);
    expect(snap.speedMs).toBeCloseTo(5, 1);
  });

  it('à l’arrêt : vitesse nulle ; sans position récente : vitesse inconnue', () => {
    const t = new RideTracker(T0);
    for (let s = 0; s <= 10; s++) t.addFix(fix(0, s, { speed: 0 }));
    expect(t.snapshot(T0 + 10_000).speedMs).toBe(0);
    expect(t.snapshot(T0 + 60_000).speedMs).toBeNull();
    expect(t.snapshot(T0 + 60_000).distanceM).toBe(0);
  });

  it('trou de 5 min (écran éteint) en roulant : distance et temps en mouvement comptés', () => {
    const t = new RideTracker(T0);
    t.addFix(fix(0, 0, { speed: 5 }));
    t.addFix(fix(5, 1, { speed: 5 }));
    t.addFix(fix(5 + 1500, 301, { speed: 5 }));
    const snap = t.snapshot(T0 + 301_000);
    expect(snap.distanceM).toBeCloseTo(1505, -1);
    expect(snap.movingTimeS).toBeCloseTo(301, 0);
  });

  it('trou de 5 min à l’arrêt : pas de temps en mouvement', () => {
    const t = new RideTracker(T0);
    t.addFix(fix(0, 0, { speed: 0 }));
    t.addFix(fix(2, 300, { speed: 0 }));
    expect(t.snapshot(T0 + 300_000).movingTimeS).toBe(0);
  });
});

describe('RouteMatcher', () => {
  /** Aller-retour de 2 km vers le nord, décalé de 30 m à l'est au retour. */
  function outAndBack() {
    const pts: { lat: number; lon: number }[] = [];
    for (let d = 0; d <= 2000; d += 50) pts.push(at(d, 0));
    for (let d = 2000; d >= 0; d -= 50) pts.push(at(d, 30));
    return pts;
  }

  it('suit la progression sans sauter sur le retour d’un aller-retour', () => {
    const pts = outAndBack();
    const m = new RouteMatcher(pts, cumulativeDistances(pts));
    let r = m.match(at(10, 15).lat, at(10, 15).lon)!; // à mi-chemin entre aller et retour
    expect(r.alongM).toBeLessThan(100); // au départ : on choisit l'aller
    for (let d = 100; d <= 1900; d += 100) r = m.match(at(d, 2).lat, at(d, 2).lon)!;
    expect(r.alongM).toBeCloseTo(1900, -1);
    // Demi-tour puis retour
    for (let d = 1900; d >= 1000; d -= 100) r = m.match(at(d, 28).lat, at(d, 28).lon)!;
    expect(r.alongM).toBeGreaterThan(2900); // 2030 + (2000 − 1000) ≈ 3030
    expect(r.offTrackM).toBeLessThan(5);
  });

  it('mesure l’écart au tracé', () => {
    const pts = [at(0), at(1000)];
    const m = new RouteMatcher(pts, cumulativeDistances(pts));
    const p = at(500, 80);
    const r = m.match(p.lat, p.lon)!;
    expect(r.offTrackM).toBeCloseTo(80, 0);
    expect(r.alongM).toBeCloseTo(500, 0);
  });

  it('se recale par recherche globale si on rejoint le tracé ailleurs', () => {
    const pts: { lat: number; lon: number }[] = [];
    for (let d = 0; d <= 10_000; d += 100) pts.push(at(d));
    const m = new RouteMatcher(pts, cumulativeDistances(pts));
    m.match(at(100).lat, at(100).lon);
    const r = m.match(at(8000, 5).lat, at(8000, 5).lon)!; // raccourci
    expect(r.alongM).toBeCloseTo(8000, -1);
  });
});

describe('D+ restant', () => {
  it('cumul cohérent avec le D+ total', () => {
    const elev = [0, 10, 20, 10, 0, 30, 30];
    const cum = cumulativeClimb(elev);
    expect(cum[cum.length - 1]).toBe(climbAndDescent(elev).gain);
    const profile = { step: 10, distances: elev.map((_, i) => i * 10), elevations: elev };
    expect(remainingClimb(profile, cum, 0)).toBe(50);
    expect(remainingClimb(profile, cum, 25)).toBe(30); // après le sommet à 20 m
    expect(remainingClimb(profile, cum, 1e6)).toBe(0);
  });
});
