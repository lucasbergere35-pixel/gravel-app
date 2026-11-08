/** Écran détail d'un itinéraire : carte, statistiques, profil, actions. */
import { cumulativeDistances } from '../../core/geo/distance';
import { buildElevationProfile } from '../../core/geo/elevation';
import { estimateDurationS } from '../../core/geo/stats';
import { pointAtDistance } from '../../core/geo/track';
import { writeGpx } from '../../core/gpx/write';
import { MapView } from '../../map/mapView';
import { deleteRoute, getProfile, getRoute, renameRoute } from '../../services/db';
import { safeFileName, shareOrDownload } from '../../services/files';
import { createElevationChart } from '../components/elevationChart';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { duration, int, km } from '../format';
import { navigate, type View } from '../router';

function stat(label: string, value: string, unit: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-value' }, value, el('span', { class: 'stat-unit' }, unit)), el('div', { class: 'stat-label' }, label));
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
  const renameBtn = el('button', { type: 'button', class: 'btn btn-small' }, 'Renommer');
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
    stat(`Durée à ${int(profile.avgSpeedKmh)} km/h`, duration(estimateDurationS(s.distanceM, profile.avgSpeedKmh)), ''),
    s.hasElevation ? stat('Dénivelé +', int(s.gainM), ' m') : null,
    s.hasElevation ? stat('Dénivelé −', int(s.lossM), ' m') : null,
    s.hasElevation && s.minEleM !== null ? stat('Altitude min', int(s.minEleM), ' m') : null,
    s.hasElevation && s.maxEleM !== null ? stat('Altitude max', int(s.maxEleM), ' m') : null,
  );

  // --- Actions ---
  const exportBtn = el('button', { type: 'button', class: 'btn btn-block' }, 'Exporter en GPX');
  exportBtn.addEventListener('click', async () => {
    try {
      const xml = writeGpx({ name: meta.name, points: track.points, waypoints: track.waypoints });
      await shareOrDownload(safeFileName(meta.name, 'gpx'), xml, 'application/gpx+xml');
    } catch (err) {
      toast(`Export impossible : ${errorMessage(err)}`, 'error');
    }
  });

  // Suppression en deux appuis (pas de fenêtre de confirmation système).
  const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger btn-block' }, 'Supprimer');
  let confirmTimer: number | undefined;
  deleteBtn.addEventListener('click', async () => {
    if (!deleteBtn.classList.contains('confirm')) {
      deleteBtn.classList.add('confirm');
      deleteBtn.textContent = 'Appuie encore pour confirmer la suppression';
      confirmTimer = window.setTimeout(() => {
        deleteBtn.classList.remove('confirm');
        deleteBtn.textContent = 'Supprimer';
      }, 4000);
      return;
    }
    window.clearTimeout(confirmTimer);
    try {
      await deleteRoute(meta.id);
      toast('Itinéraire supprimé', 'success');
      navigate('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  root.append(
    el('a', { href: '#/', class: 'back-link' }, '‹ Itinéraires'),
    el('div', { class: 'title-row' }, title, renameForm, renameBtn),
    mapEl,
    stats,
    elevationProfile
      ? el('section', { class: 'card' }, el('h2', {}, 'Profil altimétrique'))
      : el('p', { class: 'muted' }, 'Ce GPX ne contient pas d’altitude : dénivelé et profil indisponibles.'),
    el(
      'div',
      { class: 'stack actions' },
      el('a', { href: `#/sortie/${encodeURIComponent(meta.id)}`, class: 'btn btn-primary btn-block btn-huge' }, '▶ Démarrer la sortie'),
      el('a', { href: `#/simulation/${encodeURIComponent(meta.id)}`, class: 'btn btn-block' }, 'Simuler la sortie (test)'),
      exportBtn,
      deleteBtn,
    ),
  );

  // La carte doit être créée une fois l'élément dans la page (pour connaître sa taille).
  const map = new MapView(mapEl);
  map.showTrack(track.points);
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitTrack();
  });

  const chart = elevationProfile
    ? createElevationChart(elevationProfile, (d) => map.setCursor(d === null ? null : pointAtDistance(track.points, cum, d)))
    : null;
  if (chart) root.querySelector('section.card')?.append(chart.element);

  return () => {
    window.clearTimeout(confirmTimer);
    chart?.destroy();
    map.destroy();
  };
};
