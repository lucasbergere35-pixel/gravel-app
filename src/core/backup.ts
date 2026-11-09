/**
 * Format du fichier de sauvegarde « Exporter / importer mes données ».
 * Un seul fichier JSON contenant profil, aliments, itinéraires et sorties.
 *
 * La lecture vérifie la structure avant toute écriture en base : un fichier
 * abîmé ou étranger est refusé avec un message clair, sans rien modifier.
 */

export const BACKUP_APP = 'gravel-compagnon';
export const BACKUP_VERSION = 1;

export interface Backup {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  stores: {
    routes: unknown[];
    routeTracks: unknown[];
    settings: { key: string; value: unknown }[];
    rides: unknown[];
    ridePoints: unknown[];
  };
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export function buildBackup(stores: Backup['stores'], now = new Date()): Backup {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), stores };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasId = (v: unknown): boolean => isObj(v) && typeof v.id === 'string' && v.id.length > 0;

/** Lit et vérifie un fichier de sauvegarde. Lève BackupError si invalide. */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new BackupError('Ce fichier n’est pas un JSON valide.');
  }
  if (!isObj(data) || data.app !== BACKUP_APP) throw new BackupError('Ce fichier n’est pas une sauvegarde de Gravel Compagnon.');
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    throw new BackupError('Sauvegarde créée par une version plus récente de l’appli : mets l’appli à jour d’abord.');
  }
  const s = data.stores;
  if (!isObj(s)) throw new BackupError('Sauvegarde incomplète (données manquantes).');
  const arr = (k: string): unknown[] => {
    const v = s[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new BackupError(`Sauvegarde abîmée (« ${k} » invalide).`);
    return v;
  };
  const routes = arr('routes');
  const routeTracks = arr('routeTracks');
  const rides = arr('rides');
  const ridePoints = arr('ridePoints');
  const settings = arr('settings');

  if (!routes.every(hasId) || !rides.every(hasId)) throw new BackupError('Sauvegarde abîmée (identifiants manquants).');
  for (const t of routeTracks) {
    if (!hasId(t) || !Array.isArray((t as Record<string, unknown>).points)) throw new BackupError('Sauvegarde abîmée (tracé invalide).');
  }
  for (const p of ridePoints) {
    const o = p as Record<string, unknown>;
    if (!isObj(p) || typeof o.rideId !== 'string' || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) {
      throw new BackupError('Sauvegarde abîmée (position de sortie invalide).');
    }
  }
  const cleanSettings = settings.filter((x): x is { key: string; value: unknown } => isObj(x) && typeof x.key === 'string');
  // Chaque itinéraire doit avoir son tracé (sinon il serait inutilisable).
  const trackIds = new Set(routeTracks.map((t) => (t as { id: string }).id));
  const orphan = routes.find((r) => !trackIds.has((r as { id: string }).id));
  if (orphan) throw new BackupError('Sauvegarde abîmée (un itinéraire n’a pas de tracé).');

  return {
    app: BACKUP_APP,
    version: data.version,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    stores: { routes, routeTracks, settings: cleanSettings, rides, ridePoints },
  };
}

/** Résumé lisible du contenu, pour la confirmation avant import. */
export function describeBackup(b: Backup): string {
  const n = (k: number, one: string, many: string) => `${k} ${k > 1 ? many : one}`;
  const parts = [n(b.stores.routes.length, 'itinéraire', 'itinéraires'), n(b.stores.rides.length, 'sortie', 'sorties')];
  if (b.stores.settings.some((s) => s.key === 'profile')) parts.push('le profil');
  if (b.stores.settings.some((s) => s.key === 'foods')) parts.push('les aliments');
  return parts.join(', ');
}
