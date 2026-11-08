// @vitest-environment jsdom
// (DOMParser n'existe pas dans Node : on simule un navigateur pour ce fichier.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GpxError, parseGpx } from '../src/core/gpx/parse';
import { writeGpx } from '../src/core/gpx/write';

// Les tests sont lancés depuis la racine du projet.
const komoot = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'komoot-sample.gpx'), 'utf8');

describe('parseGpx', () => {
  it('lit un export Komoot (nom, points, altitude, temps)', () => {
    const gpx = parseGpx(komoot);
    expect(gpx.name).toBe('Boucle gravel & forêt');
    // 7 trkpt dans le fichier : 1 doublon consécutif et 1 latitude invalide retirés
    expect(gpx.points).toHaveLength(5);
    expect(gpx.points[0]).toEqual({ lat: 48.11, lon: -1.68, ele: 40, time: Date.parse('2026-06-01T08:00:00Z') });
    expect(gpx.points[3].ele).toBeNull(); // point sans <ele>
    expect(gpx.points[4].ele).toBe(52);
  });

  it('accepte un BOM en début de fichier', () => {
    expect(parseGpx('﻿' + komoot).points).toHaveLength(5);
  });

  it('utilise les <rtept> quand il n’y a pas de trace', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <rte><name>Route</name>
          <rtept lat="45.0" lon="5.0"><ele>200</ele></rtept>
          <rtept lat="45.01" lon="5.0"><ele>210</ele></rtept>
        </rte>
      </gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.name).toBe('Route');
    expect(gpx.points).toHaveLength(2);
  });

  it('lit un GPX 1.0 sans espace de noms et ses waypoints', () => {
    const xml = `<gpx version="1.0">
        <name>Ancien</name>
        <wpt lat="45.005" lon="5.0"><name>Fontaine</name></wpt>
        <trk><trkseg>
          <trkpt lat="45.0" lon="5.0"/><trkpt lat="45.01" lon="5.0"/>
        </trkseg></trk>
      </gpx>`;
    const gpx = parseGpx(xml);
    expect(gpx.name).toBe('Ancien');
    expect(gpx.waypoints).toEqual([{ lat: 45.005, lon: 5, name: 'Fontaine' }]);
    expect(gpx.points.every((p) => p.ele === null)).toBe(true);
  });

  it('enchaîne plusieurs segments', () => {
    const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk>
        <trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.1" lon="1"/></trkseg>
        <trkseg><trkpt lat="1.2" lon="1"/><trkpt lat="1.3" lon="1"/></trkseg>
      </trk></gpx>`;
    expect(parseGpx(xml).points.map((p) => p.lat)).toEqual([1, 1.1, 1.2, 1.3]);
  });

  it('refuse les fichiers invalides avec un message clair', () => {
    expect(() => parseGpx('')).toThrow(GpxError);
    expect(() => parseGpx('ceci n’est pas du xml <')).toThrow(GpxError);
    expect(() => parseGpx('<kml></kml>')).toThrow(/pas un GPX/);
    expect(() => parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>')).toThrow(/Aucun tracé/);
  });
});

describe('writeGpx', () => {
  it('produit un GPX relisible à l’identique (aller-retour)', () => {
    const original = parseGpx(komoot);
    const xml = writeGpx({ name: 'Test <spécial> & "guillemets"', points: original.points, waypoints: [{ lat: 48.1, lon: -1.6, name: 'Eau' }] });
    const again = parseGpx(xml);
    expect(again.name).toBe('Test <spécial> & "guillemets"');
    expect(again.points).toEqual(original.points);
    expect(again.waypoints).toEqual([{ lat: 48.1, lon: -1.6, name: 'Eau' }]);
  });
});
