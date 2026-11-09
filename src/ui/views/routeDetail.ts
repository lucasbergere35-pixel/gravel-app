/** Écran détail d'un itinéraire : carte, statistiques, profil, actions. */
import { cumulativeDistances } from '../../core/geo/distance';
import { buildElevationProfile } from '../../core/geo/elevation';
import { estimateDurationS } from '../../core/geo/stats';
import { pointAtDistance } from '../../core/geo/track';
import { writeGpx } from '../../core/gpx/write';
import { createMapView } from '../../map/mapView';
import { deleteRoute, getProfile, getRoute, renameRoute } from '../../services/db';
import { safeFileName, shareOrDownload } from '../../services/files';
import { deletePack } from '../../services/offlineMaps';
import { createElevationChart } from '../components/elevationChart';
import { createOfflinePackCard } from '../components/offlinePackCard';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { duration, int, km } from '../format';
import { icon, type IconName } from '../icons';
import { navigate, type View } from '../router';

function stat(label: string, value: string, unit: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-value' }, value, el('span', { class: 'stat-unit' }, unit)), el('div', { class: 'stat-label' }, label));
}

function action(ic: IconName, label: string, attrs: Record<string, string>): HTMLElement {
  const tag = attrs.href ? 'a' : 'button';
  return el(tag, { class: 'action', ...(tag === 'button' ? { type: 'button' } : {}), ...attrs }, el('span', { class: 'action-ic' }, icon(ic)), label);
}

export const routeDetailView: View = async (root, params) => {
  const [data, profile] = await Promise.all([getRoute(params.id), getProfile()]);
  if (!data) {
    toast('Itinéraire introuvable', 'error');
    navigate('/');
    return;
  }
  const { meta, track } = data;
  const s = meta.stats;
  const cum = cumulativeDistances(track.points);
  const elevationProfile = buildElevationProfile(track.points, cum);

  // --- En-tête + renommage ---
  const title = el('h1', { class: 'route-title' }, meta.name);
  const renameInput = el('input', { type: 'text', value: meta.name, maxlength: 100, 'aria-label': 'Nouveau nom' });
  const renameForm = el(
    'form',
    { class: 'rename-form', hidden: true },
    renameInput,
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'OK'),
  );
  const renameBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Renommer' }, icon('pencil'));
  renameBtn.addEventListener('click', () => {
    renameForm.hidden = false;
    renameBtn.hidden = true;
    title.hidden = true;
    renameInput.focus();
    renameInput.select();
  });
  renameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = renameInput.value.trim();
    if (!name) return;
    try {
      await renameRoute(meta.id, name);
      meta.name = name;
      title.textContent = name;
      toast('Nom enregistré', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    renameForm.hidden = true;
    renameBtn.hidden = false;
    title.hidden = false;
  });

  // --- Carte ---
  const mapEl = el('div', { class: 'map map-route' });

  // --- Statistiques ---
  const stats = el(
    'div',
    { class: 'stats-grid' },
    stat('Distance', km(s.distanceM), ' km'),
    stat(`À ${int(profile.avgSpeedKmh)} km/h`, duration(estimateDurationS(s.distanceM, profile.avgSpeedKmh)), ''),
    s.hasElevation ? stat('Dénivelé +', int(s.gainM), ' m') : null,
    s.hasElevation ? stat('Dénivelé −', int(s.lossM), ' m') : null,
    s.hasElevation && s.minEleM !== null ? stat('Alt. min', int(s.minEleM), ' m') : null,
    s.hasElevation && s.maxEleM !== null ? stat('Alt. max', int(s.maxEleM), ' m') : null,
  );

  // --- Carte hors ligne ---
  const offlineCard = createOfflinePackCard(meta.id, meta.name, track.points);

  // --- Actions ---
  const exportBtn = action('share', 'Exporter', {});
  exportBtn.addEventListener('click', async () => {
    try {
      const xml = writeGpx({ name: meta.name, points: track.points, waypoints: track.waypoints });
      await shareOrDownload(safeFileName(meta.name, 'gpx'), xml, 'application/gpx+xml');
    } catch (err) {
      toast(`Export impossible : ${errorMessage(err)}`, 'error');
    }
  });

  // Suppression en deux appuis (pas de fenêtre de confirmation système).
  const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger btn-block' }, 'Supprimer l’itinéraire');
  let confirmTimer: number | undefined;
  deleteBtn.addEventListener('click', async () => {
    if (!deleteBtn.classList.contains('confirm')) {
      deleteBtn.classList.add('confirm');
      deleteBtn.textContent = 'Appuie encore pour confirmer la suppression';
      confirmTimer = window.setTimeout(() => {
        deleteBtn.classList.remove('confirm');
        deleteBtn.textContent = 'Supprimer l’itinéraire';
      }, 4000);
      return;
    }
    window.clearTimeout(confirmTimer);
    try {
      await deleteRoute(meta.id);
      await deletePack(meta.id).catch(() => {}); // libère aussi la carte hors ligne
      toast('Itinéraire supprimé', 'success');
      navigate('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  const offlineSection = el('section', { class: 'card' }, el('h2', {}, icon('cloud-download'), 'Carte hors ligne'), offlineCard.element);
  const chartSection = elevationProfile
    ? el('section', { class: 'card' }, el('h2', {}, icon('mountain'), 'Profil altimétrique'))
    : el('p', { class: 'muted' }, 'Ce GPX ne contient pas d’altitude : dénivelé et profil indisponibles.');
  const id = encodeURIComponent(meta.id);
  // « Hors ligne » fait défiler jusqu'à l'encart de la carte hors ligne.
  const offlineBtn = action('cloud-download', 'Hors ligne', {});
  offlineBtn.addEventListener('click', () => offlineSection.scrollIntoView({ behavior: 'smooth', block: 'center' }));

  root.append(
    el(
      'div',
      { class: 'detail' },
      el('div', { class: 'detail-map' }, el('a', { href: '#/', class: 'float-btn', 'aria-label': 'Itinéraires' }, icon('chevron-left')), mapEl),
      el(
        'div',
        { class: 'sheet' },
        el('div', { class: 'grab' }),
        el('div', { class: 'title-row' }, title, renameForm, renameBtn),
        stats,
        el('a', { href: `#/sortie/${id}`, class: 'btn btn-primary btn-block btn-huge start-btn' }, icon('play'), 'Démarrer la sortie'),
        el(
          'div',
          { class: 'action-grid' },
          action('utensils', 'Nutrition', { href: `#/nutrition/${id}` }),
          offlineBtn,
          action('flask', 'Simuler', { href: `#/simulation/${id}` }),
          exportBtn,
        ),
        chartSection,
        offlineSection,
        el('div', { class: 'actions' }, deleteBtn),
      ),
    ),
  );

  // La carte doit être créée une fois l'élément dans la page (pour connaître sa taille).
  const map = createMapView(mapEl);
  map?.showTrack(track.points);
  requestAnimationFrame(() => {
    map?.invalidateSize();
    map?.fitTrack();
  });

  const chart = elevationProfile
    ? createElevationChart(elevationProfile, (d) => map?.setCursor(d === null ? null : pointAtDistance(track.points, cum, d)))
    : null;
  if (chart) chartSection.append(chart.element);

  return () => {
    offlineCard.destroy();
    window.clearTimeout(confirmTimer);
    chart?.destroy();
    map?.destroy();
  };
};
