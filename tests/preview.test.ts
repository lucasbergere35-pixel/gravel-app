import { describe, expect, it } from 'vitest';
import { trackPreview } from '../src/core/geo/preview';

describe('trackPreview', () => {
  it('renvoie un tableau vide pour moins de 2 points', () => {
    expect(trackPreview([])).toEqual([]);
    expect(trackPreview([{ lat: 45, lon: 5 }])).toEqual([]);
  });

  it('limite le nombre de points et garde le départ et l’arrivée', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ lat: 45 + i * 1e-4, lon: 5 + i * 1e-4 }));
    const prev = trackPreview(pts, 50);
    expect(prev).toHaveLength(50);
    // Départ en bas à gauche, arrivée en haut à droite (y vers le bas).
    expect(prev[0][1]).toBeGreaterThan(prev[49][1]);
    expect(prev[0][0]).toBeLessThan(prev[49][0]);
  });

  it('reste dans le carré 0…1 et centre un tracé allongé', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ lat: 45, lon: 5 + i * 0.01 }));
    const prev = trackPreview(pts);
    for (const [x, y] of prev) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeCloseTo(0.5, 3);
    }
    expect(prev[0][0]).toBe(0);
    expect(prev[prev.length - 1][0]).toBe(1);
  });
});
