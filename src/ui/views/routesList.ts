/** Écran « Itinéraires » : import GPX et liste des itinéraires enregistrés. */
import { parseGpx } from '../../core/gpx/parse';
import { addRoute, getActiveRide, listRoutes, type RouteMeta } from '../../services/db';
import { readTextFile } from '../../services/files';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { date, int, km } from '../format';
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

function routeCard(r: RouteMeta): HTMLElement {
  const s = r.stats;
  return el(
    'a',
    { class: 'card route-card', href: `#/itineraire/${encodeURIComponent(r.id)}` },
    el('div', { class: 'route-card-name' }, r.name),
    el(
      'div',
      { class: 'route-card-stats' },
      el('span', {}, el('strong', {}, km(s.distanceM)), ' km'),
      s.hasElevation ? el('span', {}, el('strong', {}, int(s.gainM)), ' m D+') : null,
      el('span', { class: 'muted' }, date(r.createdAt)),
    ),
  );
}

export const routesListView: View = async (root) => {
  // Pas d'attribut « accept » : sur iPhone, les .gpx apparaissent sinon grisés
  // dans l'app Fichiers. Le contenu est vérifié après sélection.
  const input = el('input', { type: 'file', id: 'gpx-input', class: 'visually-hidden', multiple: true });
  const importLabel = el('label', { for: 'gpx-input', class: 'btn btn-primary btn-block' }, '＋ Importer un GPX');
  const list = el('div', { class: 'stack' });

  async function refresh(): Promise<void> {
    const routes = await listRoutes();
    list.replaceChildren();
    if (routes.length === 0) {
      list.append(
        el(
          'div',
          { class: 'empty' },
          el('p', {}, 'Aucun itinéraire pour l’instant.'),
          el('p', { class: 'muted' }, 'Exporte un GPX depuis Komoot (ou autre), enregistre-le dans Fichiers, puis importe-le ici.'),
        ),
      );
      return;
    }
    list.append(...routes.map(routeCard));
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
        el('strong', {}, '● Sortie en cours'),
        el('div', {}, `${active.routeName} · ${km(active.distanceM)} km`),
        el('div', { class: 'btn btn-primary btn-block' }, 'Reprendre'),
      ),
    );
  }

  root.append(input, importLabel, list);
  await refresh();
};
