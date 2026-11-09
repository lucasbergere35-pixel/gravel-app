/**
 * Stockage local (IndexedDB) via la petite librairie `idb`.
 *
 * Organisation :
 *  - routes      : infos légères d'un itinéraire (nom, stats) → liste rapide
 *  - routeTracks : les milliers de points du tracé, chargés seulement à l'ouverture
 *  - settings    : réglages clé/valeur (profil…)
 *
 * Pour faire évoluer la base (nouvelles tables : sorties, aliments…), on
 * incrémente DB_VERSION et on ajoute un `if (oldVersion < N)` dans upgrade().
 * Ne JAMAIS modifier un bloc de migration existant.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GpsFix } from '../core/gps/types';
import type { TrackPoint, Waypoint } from '../core/types';
import { computeRouteStats, STATS_VERSION, type RouteStats } from '../core/geo/stats';
import { trackPreview } from '../core/geo/preview';
import type { Backup } from '../core/backup';
import { DEFAULT_FOODS, sanitizeFoods, type Food } from '../core/nutrition/foods';
import type { Level } from '../core/nutrition/recommendations';
import { DEFAULT_DRINK_INTERVAL_S, type RideNutritionState } from '../core/ride/intakes';
import type { RideFeeling, RideSummary } from '../core/ride/summary';

const DB_NAME = 'gravel-compagnon';
const DB_VERSION = 3;

export interface RouteMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceFileName?: string;
  stats: RouteStats;
  statsVersion: number;
  /** Aperçu miniature du tracé (liste) ; calculé à la volée pour les anciens itinéraires. */
  preview?: [number, number][];
}

export interface RouteTrack {
  id: string;
  points: TrackPoint[];
  waypoints: Waypoint[];
}

export type Sex = 'homme' | 'femme';

export interface Profile {
  /** Vitesse moyenne habituelle en gravel, en roulant (km/h). */
  avgSpeedKmh: number;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: Sex;
  /** Poids du vélo équipé (sacoches, bidons pleins compris), kg. */
  bikeKg: number;
  level: Level;
  /** Vrai une fois le formulaire complet enregistré (sinon : valeurs par défaut). */
  complete: boolean;
}

export const DEFAULT_PROFILE: Profile = {
  avgSpeedKmh: 18,
  weightKg: 70,
  heightCm: 175,
  age: 35,
  sex: 'homme',
  bikeKg: 12,
  level: 'intermediaire',
  complete: false,
};

/** Une sortie réelle (ou simulée). Les positions sont dans le magasin ridePoints. */
export interface RideMeta {
  id: string;
  routeId: string;
  routeName: string;
  startedAt: number;
  /** null tant que la sortie est en cours. */
  endedAt: number | null;
  simulated: boolean;
  distanceM: number;
  movingTimeS: number;
  /** Plan nutrition figé au démarrage + état des prises (absent si pas de plan). */
  nutrition?: RideNutritionState;
  /** Bilan calculé à la fin de la sortie. */
  summary?: RideSummary;
  /** Ressenti saisi après la sortie. */
  feeling?: RideFeeling;
}

/** Position enregistrée (déjà filtrée) d'une sortie. */
export interface RidePoint extends GpsFix {
  rideId: string;
}

interface GravelDB extends DBSchema {
  routes: { key: string; value: RouteMeta; indexes: { byCreatedAt: number } };
  routeTracks: { key: string; value: RouteTrack };
  settings: { key: string; value: unknown };
  rides: { key: string; value: RideMeta; indexes: { byStartedAt: number } };
  ridePoints: { key: number; value: RidePoint; indexes: { byRide: string } };
  /** Tuiles de carte hors ligne, clé « z/x/y » (une seule copie, partagée entre cartes). */
  tiles: { key: string; value: StoredTile };
  /** Cartes hors ligne téléchargées, une par itinéraire. */
  offlinePacks: { key: string; value: OfflinePack };
  /** Petits fichiers permanents de la carte (polices des noms de lieux). */
  mapAssets: { key: string; value: StoredTile };
}

export interface StoredTile {
  key: string;
  data: ArrayBuffer;
  bytes: number;
}

export interface OfflinePack {
  routeId: string;
  routeName: string;
  /** Tuiles de la carte, dans l'ordre de téléchargement. */
  keys: string[];
  /** Taille (octets) de chaque tuile de `keys` ; -1 = pas encore téléchargée. */
  sizes: number[];
  /** Nombre de tuiles déjà présentes (mis à jour pendant le téléchargement). */
  done: number;
  status: 'partial' | 'complete' | 'limit';
  /** Couloir réduit (itinéraire long). */
  narrow: boolean;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase<GravelDB>> | null = null;

/** Accès à la base (aussi utilisé par services/offlineMaps.ts). */
export function db(): Promise<IDBPDatabase<GravelDB>> {
  if (!dbPromise) {
    dbPromise = openDB<GravelDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const routes = database.createObjectStore('routes', { keyPath: 'id' });
          routes.createIndex('byCreatedAt', 'createdAt');
          database.createObjectStore('routeTracks', { keyPath: 'id' });
          database.createObjectStore('settings');
        }
        if (oldVersion < 2 && !database.objectStoreNames.contains('rides')) {
          const rides = database.createObjectStore('rides', { keyPath: 'id' });
          rides.createIndex('byStartedAt', 'startedAt');
          const pts = database.createObjectStore('ridePoints', { autoIncrement: true });
          pts.createIndex('byRide', 'rideId');
        }
        if (oldVersion < 3) {
          if (!database.objectStoreNames.contains('tiles')) database.createObjectStore('tiles', { keyPath: 'key' });
          if (!database.objectStoreNames.contains('offlinePacks')) database.createObjectStore('offlinePacks', { keyPath: 'routeId' });
          if (!database.objectStoreNames.contains('mapAssets')) database.createObjectStore('mapAssets', { keyPath: 'key' });
        }
        // if (oldVersion < 4) { ... } ← prochaines évolutions ici
      },
      blocking() {
        // Une nouvelle version de l'appli (autre onglet) veut mettre la base à jour.
        void dbPromise?.then((d) => d.close());
        dbPromise = null;
      },
    }).catch((err: unknown) => {
      dbPromise = null;
      throw new Error(
        "Impossible d'ouvrir le stockage local. Si tu es en navigation privée, ouvre l'appli normalement.",
        { cause: err },
      );
    });
  }
  return dbPromise;
}

/** Demande au navigateur de ne pas effacer nos données en cas de manque de place. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* non supporté : sans conséquence */
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- Itinéraires ----------

export async function listRoutes(): Promise<RouteMeta[]> {
  const d = await db();
  const metas = await d.getAll('routes');
  // Recalcule les stats enregistrées avec une ancienne version de l'algorithme.
  for (const meta of metas) {
    if (meta.statsVersion !== STATS_VERSION || !meta.preview) {
      const track = await d.get('routeTracks', meta.id);
      if (track) {
        meta.stats = computeRouteStats(track.points);
        meta.statsVersion = STATS_VERSION;
        meta.preview = trackPreview(track.points);
        await d.put('routes', meta);
      }
    }
  }
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRoute(id: string): Promise<{ meta: RouteMeta; track: RouteTrack } | null> {
  const d = await db();
  const [meta, track] = await Promise.all([d.get('routes', id), d.get('routeTracks', id)]);
  if (!meta || !track) return null;
  return { meta, track };
}

export async function addRoute(input: {
  name: string;
  points: TrackPoint[];
  waypoints: Waypoint[];
  sourceFileName?: string;
}): Promise<RouteMeta> {
  const now = Date.now();
  const id = newId();
  const meta: RouteMeta = {
    id,
    name: input.name,
    createdAt: now,
    updatedAt: now,
    sourceFileName: input.sourceFileName,
    stats: computeRouteStats(input.points),
    statsVersion: STATS_VERSION,
    preview: trackPreview(input.points),
  };
  const d = await db();
  const tx = d.transaction(['routes', 'routeTracks'], 'readwrite');
  await Promise.all([
    tx.objectStore('routes').put(meta),
    tx.objectStore('routeTracks').put({ id, points: input.points, waypoints: input.waypoints }),
    tx.done,
  ]);
  return meta;
}

export async function renameRoute(id: string, name: string): Promise<void> {
  const d = await db();
  const meta = await d.get('routes', id);
  if (!meta) throw new Error('Itinéraire introuvable.');
  await d.put('routes', { ...meta, name, updatedAt: Date.now() });
}

export async function deleteRoute(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['routes', 'routeTracks'], 'readwrite');
  await Promise.all([tx.objectStore('routes').delete(id), tx.objectStore('routeTracks').delete(id), tx.done]);
}

// ---------- Sorties ----------

export async function createRide(input: {
  routeId: string;
  routeName: string;
  startedAt: number;
  simulated: boolean;
  nutrition?: RideNutritionState;
}): Promise<RideMeta> {
  const ride: RideMeta = { id: newId(), endedAt: null, distanceM: 0, movingTimeS: 0, ...input };
  const d = await db();
  await d.put('rides', ride);
  return ride;
}

export async function updateRide(ride: RideMeta): Promise<void> {
  const d = await db();
  await d.put('rides', ride);
}

/** Ajoute des positions et met à jour le résumé dans une seule transaction. */
export async function appendRidePoints(ride: RideMeta, fixes: readonly GpsFix[]): Promise<void> {
  const d = await db();
  const tx = d.transaction(['rides', 'ridePoints'], 'readwrite');
  const pts = tx.objectStore('ridePoints');
  await Promise.all([...fixes.map((f) => pts.add({ ...f, rideId: ride.id })), tx.objectStore('rides').put(ride), tx.done]);
}

export async function getRidePoints(rideId: string): Promise<RidePoint[]> {
  const d = await db();
  return d.getAllFromIndex('ridePoints', 'byRide', rideId);
}

/** Sortie non terminée la plus récente (reprise après fermeture de l'appli). */
export async function getActiveRide(): Promise<RideMeta | null> {
  const d = await db();
  const all = await d.getAll('rides');
  const active = all.filter((r) => r.endedAt === null).sort((a, b) => b.startedAt - a.startedAt);
  return active[0] ?? null;
}

export async function getRide(rideId: string): Promise<RideMeta | null> {
  const d = await db();
  return (await d.get('rides', rideId)) ?? null;
}

/** Sorties terminées, la plus récente d'abord. */
export async function listFinishedRides(): Promise<RideMeta[]> {
  const d = await db();
  const all = await d.getAll('rides');
  return all.filter((r) => r.endedAt !== null).sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteRide(rideId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['rides', 'ridePoints'], 'readwrite');
  const keys = await tx.objectStore('ridePoints').index('byRide').getAllKeys(rideId);
  await Promise.all([...keys.map((k) => tx.objectStore('ridePoints').delete(k)), tx.objectStore('rides').delete(rideId), tx.done]);
}

// ---------- Profil ----------

export async function getProfile(): Promise<Profile> {
  const d = await db();
  const stored = (await d.get('settings', 'profile')) as Partial<Profile> | undefined;
  return { ...DEFAULT_PROFILE, ...stored };
}

export async function saveProfile(profile: Profile): Promise<void> {
  const d = await db();
  await d.put('settings', profile, 'profile');
}

// ---------- Aliments ----------

export async function getFoods(): Promise<Food[]> {
  const d = await db();
  const stored = sanitizeFoods(await d.get('settings', 'foods'));
  return stored ?? DEFAULT_FOODS.map((f) => ({ ...f }));
}

export async function saveFoods(foods: Food[]): Promise<void> {
  const d = await db();
  await d.put('settings', foods, 'foods');
}

// ---------- Réglages du plan nutrition ----------

export interface NutritionPrefs {
  /** Objectif de glucides saisi à la main (g/h) ; null = automatique selon le niveau. */
  targetGPerH: number | null;
  /** Effort supplémentaire en montée > 4 % (%), utilisé par le modèle d'énergie. */
  climbBoostPct: number;
}

export const DEFAULT_NUTRITION_PREFS: NutritionPrefs = { targetGPerH: null, climbBoostPct: 25 };

export async function getNutritionPrefs(): Promise<NutritionPrefs> {
  const d = await db();
  const raw = (await d.get('settings', 'nutritionPrefs')) as Partial<NutritionPrefs> | undefined;
  const target = Number(raw?.targetGPerH);
  const boost = Number(raw?.climbBoostPct);
  return {
    targetGPerH: raw?.targetGPerH !== null && raw?.targetGPerH !== undefined && Number.isFinite(target) ? target : null,
    climbBoostPct: Number.isFinite(boost) && boost >= 0 && boost <= 60 ? boost : DEFAULT_NUTRITION_PREFS.climbBoostPct,
  };
}

export async function saveNutritionPrefs(prefs: NutritionPrefs): Promise<void> {
  const d = await db();
  await d.put('settings', prefs, 'nutritionPrefs');
}

// ---------- Réglages du mode sortie ----------

export interface RideSettings {
  /** Son des alertes (prises, boisson). */
  sound: boolean;
  /** Intervalle du rappel boisson en minutes de temps en mouvement ; 0 = désactivé. */
  drinkIntervalMin: number;
}

export const DEFAULT_RIDE_SETTINGS: RideSettings = { sound: true, drinkIntervalMin: DEFAULT_DRINK_INTERVAL_S / 60 };

export async function getRideSettings(): Promise<RideSettings> {
  const d = await db();
  const raw = (await d.get('settings', 'rideSettings')) as Partial<RideSettings> | undefined;
  const interval = Number(raw?.drinkIntervalMin);
  return {
    sound: raw?.sound !== false,
    drinkIntervalMin: Number.isFinite(interval) && interval >= 0 && interval <= 120 ? interval : DEFAULT_RIDE_SETTINGS.drinkIntervalMin,
  };
}

export async function saveRideSettings(settings: RideSettings): Promise<void> {
  const d = await db();
  await d.put('settings', settings, 'rideSettings');
}

// ---------- Sauvegarde complète (export / import JSON) ----------

/** Toutes les données, prêtes à être écrites dans un fichier JSON. */
export async function dumpAll(): Promise<Backup['stores']> {
  const d = await db();
  const tx = d.transaction(['routes', 'routeTracks', 'settings', 'rides', 'ridePoints'], 'readonly');
  const settingsStore = tx.objectStore('settings');
  const [routes, routeTracks, settingKeys, settingValues, rides, ridePoints] = await Promise.all([
    tx.objectStore('routes').getAll(),
    tx.objectStore('routeTracks').getAll(),
    settingsStore.getAllKeys(),
    settingsStore.getAll(),
    tx.objectStore('rides').getAll(),
    tx.objectStore('ridePoints').getAll(),
  ]);
  await tx.done;
  return {
    routes,
    routeTracks,
    settings: settingKeys.map((key, i) => ({ key: String(key), value: settingValues[i] })),
    rides,
    ridePoints,
  };
}

/**
 * Restaure une sauvegarde EN FUSIONNANT : les éléments de la sauvegarde
 * remplacent ceux qui ont le même identifiant ; les autres sont conservés.
 * Tout se fait dans une seule transaction (tout ou rien).
 */
export async function restoreAll(stores: Backup['stores']): Promise<void> {
  const d = await db();
  const tx = d.transaction(['routes', 'routeTracks', 'settings', 'rides', 'ridePoints'], 'readwrite');
  const ops: Promise<unknown>[] = [];
  for (const r of stores.routes) ops.push(tx.objectStore('routes').put(r as RouteMeta));
  for (const t of stores.routeTracks) ops.push(tx.objectStore('routeTracks').put(t as RouteTrack));
  for (const s of stores.settings) ops.push(tx.objectStore('settings').put(s.value, s.key));
  const pts = tx.objectStore('ridePoints');
  for (const r of stores.rides) {
    const ride = r as RideMeta;
    ops.push(tx.objectStore('rides').put(ride));
    // Remplace les positions de cette sortie (évite les doublons).
    const keys = await pts.index('byRide').getAllKeys(ride.id);
    for (const k of keys) ops.push(pts.delete(k));
  }
  for (const p of stores.ridePoints) ops.push(pts.add(p as RidePoint));
  await Promise.all([...ops, tx.done]);
}
