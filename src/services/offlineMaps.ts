/**
 * Cartes hors ligne (tuiles vectorielles OpenFreeMap).
 *
 * Conditions OpenFreeMap (https://openfreemap.org/tos/, vérifiées en novembre
 * 2026) pour les téléchargements hors ligne : au plus 3 000 tuiles OU 50 Mo
 * par téléchargement, au plus 4 requêtes en parallèle, User-Agent unique.
 * → planOfflinePack respecte les limites, le téléchargement s'arrête net s'il
 *   les atteint, et OFM_MAX_PARALLEL = 4.
 * → Le User-Agent ne peut PAS être modifié par une appli web (Safari l'interdit) :
 *   les requêtes portent l'en-tête Origin/Referer du site, qui identifie l'appli.
 *
 * Stockage (IndexedDB) :
 *  - tiles : une seule copie par tuile « z/x/y », partagée entre les cartes ;
 *  - offlinePacks : la liste des tuiles de chaque itinéraire et leur taille ;
 *  - mapAssets : polices des noms de lieux (téléchargées une fois).
 * Reprise : on ne télécharge que les tuiles absentes ; une carte interrompue
 * reste « partielle » et peut être reprise.
 */
import { OFM_MAX_BYTES, OFM_MAX_PARALLEL, OFM_MAX_TILES, planOfflinePack, tilesToDelete, type PackPlan } from '../core/offline/tiles';
import { db, type OfflinePack } from './db';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FONT_URL = 'https://tiles.openfreemap.org/fonts';
export const MAP_FONTS = ['Noto Sans Regular', 'Noto Sans Bold'] as const;
/** Plages de caractères utiles en français (latin + ponctuation typographique). */
const FONT_RANGES = ['0-255', '256-511', '8192-8447'];
const TEMPLATE_KEY = 'gc.ofm.tileTemplate';
const SAVE_EVERY = 10;
const RETRIES = 2;

// ---------- Adresse des tuiles ----------

let templatePromise: Promise<string> | null = null;

/**
 * Modèle d'URL des tuiles (il change chaque semaine chez OpenFreeMap). Lu dans
 * le TileJSON, mémorisé pour pouvoir servir hors ligne / en cas d'échec.
 */
export function tileUrlTemplate(): Promise<string> {
  if (!templatePromise) {
    templatePromise = (async () => {
      try {
        const res = await fetch(TILEJSON_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`TileJSON ${res.status}`);
        const json = (await res.json()) as { tiles?: string[] };
        const t = json.tiles?.[0];
        if (!t) throw new Error('TileJSON sans tuiles');
        try {
          localStorage.setItem(TEMPLATE_KEY, t);
        } catch {
          /* sans importance */
        }
        return t;
      } catch (err) {
        templatePromise = null; // on réessaiera
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(TEMPLATE_KEY);
        } catch {
          /* sans importance */
        }
        if (stored) return stored;
        throw err;
      }
    })();
  }
  return templatePromise;
}

function fillTemplate(template: string, key: string): string {
  const [z, x, y] = key.split('/');
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// ---------- Lecture (pour la carte) ----------

export async function readTile(key: string): Promise<ArrayBuffer | null> {
  const t = await (await db()).get('tiles', key);
  return t ? t.data : null;
}

/** Tuile pour la carte : copie locale, sinon réseau (sans la stocker), sinon tuile vide. */
export async function loadTileForMap(key: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const local = await readTile(key).catch(() => null);
  if (local) return local;
  try {
    const res = await fetch(fillTemplate(await tileUrlTemplate(), key), { signal });
    if (res.ok) return await res.arrayBuffer();
  } catch {
    /* hors ligne */
  }
  return new ArrayBuffer(0); // tuile vide : fond uni, le tracé reste visible
}

/** Police (plage de caractères) : copie locale, sinon téléchargée et gardée. */
export async function loadFont(fontstack: string, range: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `font/${fontstack}/${range}`;
  const d = await db();
  const local = await d.get('mapAssets', key).catch(() => undefined);
  if (local) return local.data;
  try {
    const res = await fetch(`${FONT_URL}/${encodeURIComponent(fontstack)}/${range}.pbf`, { signal });
    if (res.ok) {
      const data = await res.arrayBuffer();
      await d.put('mapAssets', { key, data, bytes: data.byteLength }).catch(() => {});
      return data;
    }
  } catch {
    /* hors ligne */
  }
  return new ArrayBuffer(0);
}

async function ensureFonts(signal: AbortSignal): Promise<void> {
  for (const f of MAP_FONTS) for (const r of FONT_RANGES) if (!signal.aborted) await loadFont(f, r, signal);
}

// ---------- Cartes téléchargées ----------

export async function getPack(routeId: string): Promise<OfflinePack | null> {
  return (await (await db()).get('offlinePacks', routeId)) ?? null;
}

export async function listPacks(): Promise<OfflinePack[]> {
  const packs = await (await db()).getAll('offlinePacks');
  return packs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function packBytes(pack: OfflinePack): number {
  return pack.sizes.reduce((s, b) => s + Math.max(0, b), 0);
}

export interface StorageInfo {
  /** Taille réelle des tuiles stockées (zones communes comptées une fois). */
  tilesBytes: number;
  tilesCount: number;
  /** Estimation du navigateur pour tout le site (données + appli), si disponible. */
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}

export async function storageInfo(): Promise<StorageInfo> {
  const sizes = new Map<string, number>();
  for (const p of await listPacks()) p.keys.forEach((k, i) => p.sizes[i] >= 0 && sizes.set(k, p.sizes[i]));
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    usageBytes = est?.usage ?? null;
    quotaBytes = est?.quota ?? null;
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    /* non supporté */
  }
  return { tilesBytes: [...sizes.values()].reduce((a, b) => a + b, 0), tilesCount: sizes.size, usageBytes, quotaBytes, persisted };
}

/** Demande à iOS de ne pas effacer les données en cas de manque de place. */
export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** Supprime une carte ; seules les tuiles qui ne servent à aucune autre carte sont effacées. */
export async function deletePack(routeId: string): Promise<void> {
  cancelDownload(routeId);
  const d = await db();
  const pack = await d.get('offlinePacks', routeId);
  if (!pack) return;
  const others = (await d.getAll('offlinePacks')).filter((p) => p.routeId !== routeId).map((p) => p.keys);
  const tx = d.transaction(['tiles', 'offlinePacks'], 'readwrite');
  await Promise.all([...tilesToDelete(pack.keys, others).map((k) => tx.objectStore('tiles').delete(k)), tx.objectStore('offlinePacks').delete(routeId), tx.done]);
}

// ---------- Téléchargement ----------

export type DownloadStatus = 'running' | 'complete' | 'limit' | 'error' | 'cancelled';

export interface DownloadProgress {
  routeId: string;
  done: number;
  total: number;
  bytes: number;
  status: DownloadStatus;
  message: string | null;
}

interface Running {
  controller: AbortController;
  progress: DownloadProgress;
  listeners: Set<(p: DownloadProgress) => void>;
}

const running = new Map<string, Running>();
const finished = new Map<string, DownloadProgress>();

/** Suit un téléchargement (en cours ou juste terminé). Retourne la fonction de désabonnement. */
export function subscribeDownload(routeId: string, fn: (p: DownloadProgress) => void): () => void {
  const r = running.get(routeId);
  if (r) {
    r.listeners.add(fn);
    fn(r.progress);
    return () => r.listeners.delete(fn);
  }
  const f = finished.get(routeId);
  if (f) fn(f);
  return () => {};
}

export function isDownloading(routeId: string): boolean {
  return running.has(routeId);
}

export function cancelDownload(routeId: string): void {
  running.get(routeId)?.controller.abort();
}

export function planForPoints(points: readonly { lat: number; lon: number }[]): PackPlan {
  return planOfflinePack(points);
}

async function fetchTile(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.status === 404) return new ArrayBuffer(0); // pas de données ici (mer…)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Télécharge (ou reprend) la carte hors ligne d'un itinéraire.
 * Ne relance rien si un téléchargement est déjà en cours pour cet itinéraire.
 */
export function startDownload(routeId: string, routeName: string, points: readonly { lat: number; lon: number }[]): void {
  if (running.has(routeId)) return;
  const controller = new AbortController();
  const entry: Running = {
    controller,
    progress: { routeId, done: 0, total: 0, bytes: 0, status: 'running', message: null },
    listeners: new Set(),
  };
  running.set(routeId, entry);
  finished.delete(routeId);
  const emit = (patch: Partial<DownloadProgress>) => {
    entry.progress = { ...entry.progress, ...patch };
    for (const fn of entry.listeners) fn(entry.progress);
  };

  void (async () => {
    const d = await db();
    try {
      const plan = planOfflinePack(points);
      if (!plan.withinLimits) {
        throw new Error('Itinéraire trop long pour un seul téléchargement (limite OpenFreeMap : 3 000 tuiles ou 50 Mo).');
      }
      await requestPersistence();
      const template = await tileUrlTemplate().catch(() => {
        throw new Error('Pas de connexion : impossible de joindre OpenFreeMap.');
      });

      // Reprise : on garde les tailles connues (cette carte ou d'autres cartes).
      const known = new Map<string, number>();
      for (const p of await d.getAll('offlinePacks')) p.keys.forEach((k, i) => p.sizes[i] >= 0 && known.set(k, p.sizes[i]));
      const old = await d.get('offlinePacks', routeId);
      const pack: OfflinePack = {
        routeId,
        routeName,
        keys: plan.keys,
        sizes: plan.keys.map((k) => known.get(k) ?? -1),
        done: 0,
        status: 'partial',
        narrow: plan.narrow,
        estimatedBytes: plan.estimatedBytes,
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      // Tuiles déjà présentes en base (téléchargées avant une interruption).
      const tx = d.transaction('tiles');
      const present = await Promise.all(plan.keys.map((k, i) => (pack.sizes[i] >= 0 ? Promise.resolve(true) : tx.store.getKey(k).then((x) => x !== undefined))));
      await tx.done;
      const missing: number[] = [];
      present.forEach((ok, i) => {
        if (!ok) missing.push(i);
        else if (pack.sizes[i] < 0) pack.sizes[i] = 0; // présente, taille inconnue
      });
      pack.done = plan.keys.length - missing.length;
      await d.put('offlinePacks', pack);
      emit({ total: plan.keys.length, done: pack.done, bytes: packBytes(pack) });

      // Téléchargement : 4 requêtes en parallèle au maximum, arrêt aux limites.
      let next = 0;
      let downloadedBytes = 0;
      let downloadedTiles = 0;
      let hitLimit = false;
      let sinceSave = 0;
      let failure: unknown = null;
      const worker = async () => {
        while (!controller.signal.aborted && !hitLimit && failure === null) {
          const i = missing[next++];
          if (i === undefined) return;
          const key = plan.keys[i];
          let data: ArrayBuffer;
          try {
            data = await fetchTile(fillTemplate(template, key), controller.signal);
          } catch (err) {
            if (!controller.signal.aborted) failure = err; // arrête les autres requêtes proprement
            return;
          }
          await d.put('tiles', { key, data, bytes: data.byteLength });
          pack.sizes[i] = data.byteLength;
          pack.done++;
          downloadedBytes += data.byteLength;
          downloadedTiles++;
          if (downloadedBytes >= OFM_MAX_BYTES || downloadedTiles >= OFM_MAX_TILES) hitLimit = true;
          if (++sinceSave >= SAVE_EVERY) {
            sinceSave = 0;
            pack.updatedAt = Date.now();
            await d.put('offlinePacks', pack);
          }
          emit({ done: pack.done, bytes: packBytes(pack) });
        }
      };
      await Promise.all(Array.from({ length: OFM_MAX_PARALLEL }, worker));
      pack.updatedAt = Date.now();
      await d.put('offlinePacks', pack); // progression sauvegardée dans tous les cas (reprise)

      if (controller.signal.aborted) throw new DOMException('annulé', 'AbortError');
      if (failure !== null) {
        throw new Error(`Téléchargement interrompu (${pack.done}/${plan.keys.length} tuiles). Vérifie la connexion puis reprends.`);
      }
      const complete = pack.done >= plan.keys.length;
      if (complete) await ensureFonts(controller.signal);
      pack.status = complete ? 'complete' : hitLimit ? 'limit' : 'partial';
      pack.updatedAt = Date.now();
      await d.put('offlinePacks', pack);
      emit({
        status: complete ? 'complete' : 'limit',
        message: complete ? null : 'Limite de 50 Mo atteinte : le début du parcours est couvert, pas la fin.',
      });
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
      emit({ status: aborted ? 'cancelled' : 'error', message: aborted ? 'Téléchargement interrompu.' : err instanceof Error ? err.message : String(err) });
      // La carte reste « partielle » : on pourra reprendre.
    } finally {
      running.delete(routeId);
      finished.set(routeId, entry.progress);
      for (const fn of entry.listeners) fn(entry.progress);
    }
  })();
}
