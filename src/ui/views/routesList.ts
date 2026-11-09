/** Écran « Itinéraires » : import GPX et liste des itinéraires enregistrés. */
import { parseGpx } from '../../core/gpx/parse';
import { estimateDurationS } from '../../core/geo/stats';
import { addRoute, getActiveRide, getProfile, listRoutes, type RouteMeta } from '../../services/db';
import { listPacks } from '../../services/offlineMaps';
import { readTextFile } from '../../services/files';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { duration, int, km } from '../format';
import { icon } from '../icons';
import { navigate, type View } from '../router';

async function importFiles(files: File[]): Promise<RouteMeta[]> {
  const imported: RouteMeta[] = [];
  for (const file of files) {
    try {
      const gpx = parseGpx(await readTextFile(file));
      const fallbackName = file.name.replace(/\.[^.]+$/, '') || 'Itinéraire';
      imported.push(
        await addRoute({
          name: gpx.name ?? fallbackName,
          points: gpx.points,
          waypoints: gpx.waypoints,
          sourceFileName: file.name,
        }),
      );
    } catch (err) {
      toast(`${file.name} : ${errorMessage(err)}`, 'error');
    }
  }
  return imported;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Mini-carte du tracé (SVG, sans fond de carte). */
function previewSvg(points: readonly [number, number][]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-0.1 -0.06 1.2 1.12');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  if (points.length >= 2) {
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
    const halo = document.createElementNS(SVG_NS, 'path');
    halo.setAttribute('d', d);
    halo.setAttribute('class', 'pv-halo');
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('class', 'pv-line');
    const [sx, sy] = points[0];
    const start = document.createElementNS(SVG_NS, 'circle');
    start.setAttribute('cx', String(sx));
    start.setAttribute('cy', String(sy));
    start.setAttribute('r', '0.035');
    start.setAttribute('class', 'pv-start');
    svg.append(halo, line, start);
  }
  return svg;
}

function routeCard(r: RouteMeta, avgSpeedKmh: number, offline: boolean): HTMLElement {
  const s = r.stats;
  return el(
    'a',
    { class: 'card route-card', href: `#/itineraire/${encodeURIComponent(r.id)}` },
    el('div', { class: 'route-preview' }, previewSvg(r.preview ?? [])),
    el(
      'div',
      { class: 'route-body' },
      el(
        'div',
        { class: 'route-card-name' },
        el('span', {}, r.name),
        offline ? el('span', { class: 'badge' }, icon('cloud-check'), 'Hors ligne') : null,
      ),
      el(
        'div',
        { class: 'chips' },
        el('span', { class: 'chip' }, icon('route'), `${km(s.distanceM)} km`),
        s.hasElevation ? el('span', { class: 'chip' }, icon('trending-up'), `${int(s.gainM)} m`) : null,
        el('span', { class: 'chip' }, icon('clock'), duration(estimateDurationS(s.distanceM, avgSpeedKmh))),
      ),
    ),
  );
}

export const routesListView: View = async (root) => {
  // Pas d'attribut « accept » : sur iPhone, les .gpx apparaissent sinon grisés
  // dans l'app Fichiers. Le contenu est vérifié après sélection.
  const input = el('input', { type: 'file', id: 'gpx-input', class: 'visually-hidden', multiple: true });
  const importLabel = el('label', { for: 'gpx-input', class: 'btn btn-primary btn-block' }, icon('plus'), 'Importer un GPX');
  const list = el('div', { class: 'stack' });

  async function refresh(): Promise<void> {
    const [routes, profile, packs] = await Promise.all([listRoutes(), getProfile(), listPacks()]);
    const offline = new Set(packs.filter((p) => p.status === 'complete').map((p) => p.routeId));
    list.replaceChildren();
    if (routes.length === 0) {
      list.append(
        el(
          'div',
          { class: 'empty' },
          icon('route'),
          el('p', {}, 'Aucun itinéraire pour l’instant.'),
          el('p', { class: 'muted' }, 'Exporte un GPX depuis Komoot (ou autre), enregistre-le dans Fichiers, puis importe-le ici.'),
        ),
      );
      return;
    }
    list.append(...routes.map((r) => routeCard(r, profile.avgSpeedKmh, offline.has(r.id))));
  }

  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    input.value = ''; // permet de ré-importer le même fichier
    if (files.length === 0) return;
    importLabel.classList.add('busy');
    try {
      const imported = await importFiles(files);
      if (imported.length === 1) {
        toast('Itinéraire importé', 'success');
        navigate(`/itineraire/${imported[0].id}`);
        return;
      }
      if (imported.length > 1) toast(`${imported.length} itinéraires importés`, 'success');
      await refresh();
    } finally {
      importLabel.classList.remove('busy');
    }
  });

  root.append(el('h1', {}, 'Itinéraires'));

  // Sortie interrompue (appli fermée par iOS, retour en arrière…) : proposer la reprise.
  const active = await getActiveRide();
  if (active && !active.simulated) {
    root.append(
      el(
        'a',
        { class: 'card active-ride', href: `#/sortie/${encodeURIComponent(active.routeId)}` },
        el('strong', { class: 'offline-title ok' }, icon('activity'), 'Sortie en cours'),
        el('div', {}, `${active.routeName} · ${km(active.distanceM)} km`),
        el('div', { class: 'btn btn-primary btn-block' }, icon('play'), 'Reprendre'),
      ),
    );
  }

  root.append(input, importLabel, list);
  await refresh();
};
