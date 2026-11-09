/**
 * Aperçu miniature d'un tracé (carte de la liste des itinéraires) :
 * quelques dizaines de points, projetés à plat et ramenés dans un carré 0…1
 * en gardant les proportions (y vers le bas, comme en SVG).
 */
import type { TrackPoint } from '../types';

export const PREVIEW_POINTS = 80;

/** Points de l'aperçu [x, y] arrondis au millième ; tableau vide si moins de 2 points. */
export function trackPreview(points: readonly Pick<TrackPoint, 'lat' | 'lon'>[], maxPoints = PREVIEW_POINTS): [number, number][] {
  if (points.length < 2) return [];
  // Sous-échantillonnage régulier (premier et dernier point gardés).
  const n = Math.min(points.length, Math.max(2, maxPoints));
  const picked: Pick<TrackPoint, 'lat' | 'lon'>[] = [];
  for (let i = 0; i < n; i++) picked.push(points[Math.round((i * (points.length - 1)) / (n - 1))]);

  // Projection équirectangulaire autour de la latitude moyenne.
  let latSum = 0;
  for (const p of picked) latSum += p.lat;
  const cosLat = Math.cos(((latSum / picked.length) * Math.PI) / 180);
  const xy = picked.map((p) => [p.lon * cosLat, -p.lat] as const);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of xy) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  // Centré dans le carré.
  const offX = (1 - (maxX - minX) / size) / 2;
  const offY = (1 - (maxY - minY) / size) / 2;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return xy.map(([x, y]) => [r(offX + (x - minX) / size), r(offY + (y - minY) / size)]);
}
