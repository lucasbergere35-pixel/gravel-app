import { describe, expect, it } from 'vitest';
import { BackupError, buildBackup, describeBackup, parseBackup } from '../src/core/backup';

const stores = {
  routes: [{ id: 'r1', name: 'Boucle' }],
  routeTracks: [{ id: 'r1', points: [{ lat: 45, lon: 5, ele: 100 }], waypoints: [] }],
  settings: [
    { key: 'profile', value: { weightKg: 72 } },
    { key: 'foods', value: [] },
  ],
  rides: [{ id: 's1', routeId: 'r1' }],
  ridePoints: [{ rideId: 's1', lat: 45, lon: 5, accuracy: 5, altitude: null, speed: 4, time: 1 }],
};

describe('sauvegarde JSON', () => {
  it('aller-retour : export puis lecture à l’identique', () => {
    const json = JSON.stringify(buildBackup(stores, new Date('2026-11-09T10:00:00Z')));
    const b = parseBackup(json);
    expect(b.stores).toEqual(stores);
    expect(b.exportedAt).toBe('2026-11-09T10:00:00.000Z');
    expect(describeBackup(b)).toBe('1 itinéraire, 1 sortie, le profil, les aliments');
  });

  it('refuse les fichiers étrangers ou abîmés avec un message clair', () => {
    expect(() => parseBackup('pas du json')).toThrow(BackupError);
    expect(() => parseBackup('{"app":"autre"}')).toThrow(/pas une sauvegarde/);
    expect(() => parseBackup(JSON.stringify({ ...buildBackup(stores), version: 99 }))).toThrow(/plus récente/);
    const noTrack = buildBackup({ ...stores, routeTracks: [] });
    expect(() => parseBackup(JSON.stringify(noTrack))).toThrow(/pas de tracé/);
    const badPoint = buildBackup({ ...stores, ridePoints: [{ rideId: 's1', lat: 'x' }] });
    expect(() => parseBackup(JSON.stringify(badPoint))).toThrow(/position/);
  });

  it('accepte une sauvegarde vide', () => {
    const empty = buildBackup({ routes: [], routeTracks: [], settings: [], rides: [], ridePoints: [] });
    expect(describeBackup(parseBackup(JSON.stringify(empty)))).toBe('0 itinéraire, 0 sortie');
  });
});
