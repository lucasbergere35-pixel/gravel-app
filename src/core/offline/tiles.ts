/**
 * Calcul des tuiles de carte à télécharger autour d'un itinéraire (logique pure, testée).
 *
 * Tuiles « web mercator » z/x/y. Plan retenu :
 *  - zooms 12 à 14 : couloir de ±2 km autour du tracé (détail) ;
 *  - zooms 9 à 11 : couloir de ±8 km (vue intermédiaire) ;
 *  - zooms 5 à 8 : rectangle englobant l'itinéraire (vue d'ensemble).
 * Les tuiles vectorielles OpenFreeMap s'arrêtent au zoom 14 ; MapLibre les
 * agrandit au-delà, sans perte de netteté.
 *
 * Conditions OpenFreeMap (vérifiées en novembre 2026) : un téléchargement
 * hors ligne doit faire au plus 3 000 tuiles ou 50 Mo, avec au plus 4 requêtes
 * en parallèle. Les tuiles sont triées pour que, si la limite est atteinte,
 * la vue d'ensemble et le DÉBUT du parcours soient couverts.
 */
import { cumulativeDistances } from '../geo/distance';

export const OFM_MAX_TILES = 3000;
export const OFM_MAX_BYTES = 50 * 1024 * 1024;
export const OFM_MAX_PARALLEL = 4;
export const VECTOR_MAX_ZOOM = 14;

export interface ZoomBand {
  minZoom: number;
  maxZoom: number;
  /** Demi-largeur du couloir (m) ; null = rectangle englobant. */
  bufferM: number | null;
}

export const DEFAULT_BANDS: ZoomBand[] = [
  { minZoom: 5, maxZoom: 8, bufferM: null },
  { minZoom: 9, maxZoom: 11, bufferM: 8000 },
  { minZoom: 12, maxZoom: 14, bufferM: 2000 },
];

/** Couloir réduit, si l'itinéraire est trop long pour le couloir normal. */
export const NARROW_BANDS: ZoomBand[] = [
  { minZoom: 5, maxZoom: 8, bufferM: null },
  { minZoom: 9, maxZoom: 11, bufferM: 5000 },
  { minZoom: 12, maxZoom: 14, bufferM: 1000 },
];

/**
 * Taille moyenne mesurée d'une tuile OpenFreeMap par zoom (octets), mélange
 * campagne / petites villes. Une grande ville peut faire beaucoup plus.
 */
export const AVG_TILE_BYTES: Record<number, number> = {
  5: 300_000,
  6: 300_000,
  7: 300_000,
  8: 270_000,
  9: 200_000,
  10: 110_000,
  11: 70_000,
  12: 60_000,
  13: 60_000,
  14: 70_000,
};

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function parseTileKey(key: string): { z: number; x: number; y: number } {
  const [z, x, y] = key.split('/').map(Number);
  return { z, x, y };
}

/** Position (fractionnaire) en coordonnées de tuile au zoom z. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latR = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n,
  };
}

/** Largeur d'une tuile au sol (m) à une latitude donnée. */
export function tileSizeM(lat: number, z: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

type LatLon = { lat: number; lon: number };

/** Points du tracé tous les `stepM` mètres (pour ne rater aucune tuile). */
function sampleTrack(points: readonly LatLon[], stepM: number): LatLon[] {
  if (points.length === 0) return [];
  const cum = cumulativeDistances(points);
  const out: LatLon[] = [points[0]];
  let next = stepM;
  for (let i = 1; i < points.length; i++) {
    while (cum[i] >= next) {
      const span = cum[i] - cum[i - 1];
      const t = span > 0 ? (next - cum[i - 1]) / span : 0;
      out.push({ lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t, lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * t });
      next += stepM;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Tuiles d'un couloir de ±bufferM autour du tracé, au zoom z, dans l'ordre du
 * parcours (les tuiles du début d'abord).
 */
export function corridorTiles(points: readonly LatLon[], z: number, bufferM: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (points.length === 0) return out;
  const n = 2 ** z;
  // Échantillonnage : au moins 4 points par tuile et par largeur de couloir.
  const step = Math.max(50, Math.min(tileSizeM(points[0].lat, z), bufferM) / 4);
  for (const p of sampleTrack(points, step)) {
    const c = lonLatToTile(p.lon, p.lat, z);
    const r = bufferM / tileSizeM(p.lat, z); // rayon en unités de tuile
    for (let x = Math.floor(c.x - r); x <= Math.floor(c.x + r); x++) {
      for (let y = Math.floor(c.y - r); y <= Math.floor(c.y + r); y++) {
        if (y < 0 || y >= n) continue;
        // Distance du point au carré de la tuile (en unités de tuile).
        const dx = Math.max(x - c.x, 0, c.x - (x + 1));
        const dy = Math.max(y - c.y, 0, c.y - (y + 1));
        if (dx * dx + dy * dy > r * r) continue;
        const key = tileKey(z, ((x % n) + n) % n, y);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
  }
  return out;
}

/** Tuiles du rectangle englobant le tracé (+ marge d'une tuile), au zoom z. */
export function bboxTiles(points: readonly LatLon[], z: number): string[] {
  if (points.length === 0) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const n = 2 ** z;
  const a = lonLatToTile(minLon, maxLat, z);
  const b = lonLatToTile(maxLon, minLat, z);
  const out: string[] = [];
  for (let x = Math.floor(a.x) - 1; x <= Math.floor(b.x) + 1; x++) {
    for (let y = Math.max(0, Math.floor(a.y) - 1); y <= Math.min(n - 1, Math.floor(b.y) + 1); y++) {
      out.push(tileKey(z, ((x % n) + n) % n, y));
    }
  }
  return out;
}

export interface PackPlan {
  /** Tuiles dans l'ordre de téléchargement. */
  keys: string[];
  byZoom: Record<number, number>;
  estimatedBytes: number;
  /** Couloir utilisé (normal ou réduit). */
  narrow: boolean;
  /** Vrai si le plan respecte les limites d'OpenFreeMap. */
  withinLimits: boolean;
}

function buildPlan(points: readonly LatLon[], bands: readonly ZoomBand[]): Omit<PackPlan, 'narrow'> {
  const keys: string[] = [];
  const byZoom: Record<number, number> = {};
  let estimatedBytes = 0;
  // Vue d'ensemble d'abord (zooms bas), puis détail le long du parcours.
  for (const band of bands) {
    for (let z = band.minZoom; z <= band.maxZoom; z++) {
      const tiles = band.bufferM === null ? bboxTiles(points, z) : corridorTiles(points, z, band.bufferM);
      keys.push(...tiles);
      byZoom[z] = tiles.length;
      estimatedBytes += tiles.length * (AVG_TILE_BYTES[z] ?? 100_000);
    }
  }
  return { keys, byZoom, estimatedBytes, withinLimits: keys.length <= OFM_MAX_TILES && estimatedBytes <= OFM_MAX_BYTES };
}

/** Plan de téléchargement ; couloir réduit automatiquement si le normal dépasse les limites. */
export function planOfflinePack(points: readonly LatLon[]): PackPlan {
  const normal = buildPlan(points, DEFAULT_BANDS);
  if (normal.withinLimits) return { ...normal, narrow: false };
  const narrow = buildPlan(points, NARROW_BANDS);
  return { ...narrow, narrow: true };
}

/**
 * Tuiles à effacer quand on supprime une carte : celles qui ne servent à
 * aucune autre carte (les zones communes ne sont stockées qu'une fois).
 */
export function tilesToDelete(packKeys: readonly string[], otherPacksKeys: readonly (readonly string[])[]): string[] {
  const used = new Set<string>();
  for (const keys of otherPacksKeys) for (const k of keys) used.add(k);
  return [...new Set(packKeys)].filter((k) => !used.has(k));
}
