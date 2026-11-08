/** Écriture d'un fichier GPX 1.1 (une trace, un segment). */
import type { TrackPoint, Waypoint } from '../types';

export interface GpxWriteInput {
  name: string;
  points: readonly TrackPoint[];
  waypoints?: readonly Waypoint[];
  creator?: string;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pointXml(tag: 'trkpt' | 'wpt', p: { lat: number; lon: number }, inner: string): string {
  return `<${tag} lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${inner}</${tag}>`;
}

export function writeGpx({ name, points, waypoints = [], creator = 'Gravel Compagnon' }: GpxWriteInput): string {
  const safeName = escapeXml(name);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata><name>${safeName}</name></metadata>`,
  ];
  for (const w of waypoints) {
    lines.push('  ' + pointXml('wpt', w, `<name>${escapeXml(w.name)}</name>`));
  }
  lines.push('  <trk>', `    <name>${safeName}</name>`, '    <trkseg>');
  for (const p of points) {
    let inner = '';
    if (p.ele !== null && Number.isFinite(p.ele)) inner += `<ele>${p.ele.toFixed(1)}</ele>`;
    if (p.time !== undefined && Number.isFinite(p.time)) inner += `<time>${new Date(p.time).toISOString()}</time>`;
    lines.push('      ' + pointXml('trkpt', p, inner));
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}
