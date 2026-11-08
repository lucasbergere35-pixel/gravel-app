/**
 * Lecture de fichiers GPX 1.0 / 1.1 (dont exports Komoot, Strava, Garmin…).
 *
 * - Utilise les traces (<trk>/<trkseg>/<trkpt>) ; à défaut, les routes (<rte>/<rtept>).
 * - Plusieurs segments/traces sont mis bout à bout dans l'ordre du fichier.
 * - Les points invalides sont ignorés, les doublons consécutifs supprimés.
 * - Ignore les espaces de noms (xmlns) : on compare uniquement le nom local des balises.
 */
import type { TrackPoint, Waypoint } from '../types';

export class GpxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpxError';
  }
}

export interface ParsedGpx {
  name: string | null;
  points: TrackPoint[];
  waypoints: Waypoint[];
}

function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function childText(el: Element, localName: string): string | null {
  for (const child of Array.from(el.children)) {
    if (child.localName === localName) {
      const text = child.textContent?.trim();
      return text ? text : null;
    }
  }
  return null;
}

function childElement(el: Element, localName: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.localName === localName) return child;
  }
  return null;
}

function readLatLon(el: Element): { lat: number; lon: number } | null {
  const lat = Number.parseFloat(el.getAttribute('lat') ?? '');
  const lon = Number.parseFloat(el.getAttribute('lon') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function readPoint(el: Element): TrackPoint | null {
  const ll = readLatLon(el);
  if (!ll) return null;
  const eleText = childText(el, 'ele');
  const ele = eleText !== null ? Number.parseFloat(eleText) : Number.NaN;
  const point: TrackPoint = { lat: ll.lat, lon: ll.lon, ele: Number.isFinite(ele) ? ele : null };
  const timeText = childText(el, 'time');
  if (timeText) {
    const t = Date.parse(timeText);
    if (Number.isFinite(t)) point.time = t;
  }
  return point;
}

function removeConsecutiveDuplicates(points: TrackPoint[]): TrackPoint[] {
  return points.filter((p, i) => i === 0 || p.lat !== points[i - 1].lat || p.lon !== points[i - 1].lon);
}

export function parseGpx(text: string): ParsedGpx {
  const clean = text.replace(/^﻿/, '').trim();
  if (!clean) throw new GpxError('Le fichier est vide.');

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(clean, 'application/xml');
  } catch {
    throw new GpxError("Impossible de lire ce fichier (XML invalide).");
  }
  if (byLocalName(doc, 'parsererror').length > 0) {
    throw new GpxError("Ce fichier n'est pas un XML valide (GPX abîmé ?).");
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') {
    throw new GpxError("Ce fichier n'est pas un GPX.");
  }

  const collect = (tag: string): TrackPoint[] =>
    byLocalName(root, tag)
      .map(readPoint)
      .filter((p): p is TrackPoint => p !== null);

  let points = removeConsecutiveDuplicates(collect('trkpt'));
  if (points.length < 2) points = removeConsecutiveDuplicates(collect('rtept'));
  if (points.length < 2) {
    throw new GpxError('Aucun tracé trouvé dans ce GPX (il faut au moins 2 points).');
  }

  const waypoints: Waypoint[] = [];
  for (const wpt of byLocalName(root, 'wpt')) {
    const ll = readLatLon(wpt);
    if (ll) waypoints.push({ ...ll, name: childText(wpt, 'name') ?? 'Point' });
  }

  const metadata = childElement(root, 'metadata');
  const trk = byLocalName(root, 'trk')[0];
  const rte = byLocalName(root, 'rte')[0];
  const name =
    (metadata && childText(metadata, 'name')) ||
    (trk && childText(trk, 'name')) ||
    (rte && childText(rte, 'name')) ||
    // GPX 1.0 : <name> directement sous <gpx>
    childText(root, 'name') ||
    null;

  return { name, points, waypoints };
}
