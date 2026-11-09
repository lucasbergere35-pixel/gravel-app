import { describe, expect, it } from 'vitest';
import {
  bboxTiles,
  corridorTiles,
  lonLatToTile,
  OFM_MAX_BYTES,
  OFM_MAX_TILES,
  parseTileKey,
  planOfflinePack,
  tileKey,
  tileSizeM,
  tilesToDelete,
} from '../src/core/offline/tiles';

const M_PER_DEG = 111_195;

/** Ligne droite vers l'est depuis Rennes, `km` kilomètres, un point tous les 100 m. */
function eastLine(km: number, lat = 48.11, lon0 = -1.68) {
  const pts = [];
  for (let d = 0; d <= km * 1000; d += 100) pts.push({ lat, lon: lon0 + d / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)) });
  return pts;
}

describe('coordonnées de tuiles', () => {
  it('valeurs connues', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
    const r = lonLatToTile(-1.68, 48.11, 14);
    expect(Math.floor(r.x)).toBe(8115);
    expect(Math.floor(r.y)).toBe(5687); // tuile vérifiée sur OpenFreeMap
    expect(tileSizeM(48.11, 14)).toBeCloseTo(1632, -1);
    expect(parseTileKey(tileKey(14, 8115, 5687))).toEqual({ z: 14, x: 8115, y: 5687 });
  });
});

describe('couloir', () => {
  const line = eastLine(20);

  it('contient les tuiles sous le tracé et dans le couloir, pas au-delà', () => {
    const keys = new Set(corridorTiles(line, 14, 2000));
    // Sous le tracé (départ, milieu, arrivée)
    for (const p of [line[0], line[100], line[line.length - 1]]) {
      const t = lonLatToTile(p.lon, p.lat, 14);
      expect(keys.has(tileKey(14, Math.floor(t.x), Math.floor(t.y)))).toBe(true);
    }
    // 1,5 km au nord : dans le couloir ; 6 km au nord : hors couloir
    const p = line[100];
    const near = lonLatToTile(p.lon, p.lat + 1500 / M_PER_DEG, 14);
    const far = lonLatToTile(p.lon, p.lat + 6000 / M_PER_DEG, 14);
    expect(keys.has(tileKey(14, Math.floor(near.x), Math.floor(near.y)))).toBe(true);
    expect(keys.has(tileKey(14, Math.floor(far.x), Math.floor(far.y)))).toBe(false);
  });

  it('nombre de tuiles raisonnable (20 km, ±2 km, z14 ≈ 1,6 km/tuile)', () => {
    const n = corridorTiles(line, 14, 2000).length;
    // ~ (20 km / 1,63) × (4 km / 1,63 + 1) ≈ 12 × 3,5 ≈ 40 à 70
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(90);
  });

  it('dans l’ordre du parcours : les tuiles du début d’abord', () => {
    const keys = corridorTiles(line, 14, 2000);
    const firstX = parseTileKey(keys[0]).x;
    const lastX = parseTileKey(keys[keys.length - 1]).x;
    expect(lastX).toBeGreaterThan(firstX);
  });

  it('pas de doublons', () => {
    const keys = corridorTiles(line, 13, 2000);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rectangle englobant pour la vue d’ensemble', () => {
    const keys = bboxTiles(line, 6);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.length).toBeLessThanOrEqual(16);
  });
});

describe('plan de téléchargement', () => {
  it('itinéraire de 100 km : dans les limites d’OpenFreeMap, vue d’ensemble en premier', () => {
    const plan = planOfflinePack(eastLine(100));
    expect(plan.withinLimits).toBe(true);
    expect(plan.narrow).toBe(false);
    expect(plan.keys.length).toBeLessThanOrEqual(OFM_MAX_TILES);
    expect(plan.estimatedBytes).toBeLessThanOrEqual(OFM_MAX_BYTES);
    expect(parseTileKey(plan.keys[0]).z).toBe(5);
    expect(parseTileKey(plan.keys[plan.keys.length - 1]).z).toBe(14);
    expect(Object.keys(plan.byZoom).map(Number)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('itinéraire très long : couloir réduit, puis signalé hors limites si encore trop gros', () => {
    const long = planOfflinePack(eastLine(250));
    expect(long.narrow).toBe(true);
    const huge = planOfflinePack(eastLine(900));
    expect(huge.withinLimits).toBe(false);
  });
});

describe('zones communes stockées une seule fois', () => {
  it('ne supprime que les tuiles propres à la carte supprimée', () => {
    const a = ['14/1/1', '14/1/2', '14/1/3'];
    const b = ['14/1/3', '14/1/4'];
    expect(tilesToDelete(a, [b])).toEqual(['14/1/1', '14/1/2']);
    expect(tilesToDelete(b, [a])).toEqual(['14/1/4']);
    expect(tilesToDelete(a, [])).toEqual(a);
  });
});
