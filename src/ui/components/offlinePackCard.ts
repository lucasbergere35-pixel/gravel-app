/**
 * Encart « Carte hors ligne » d'un itinéraire : taille estimée, bouton de
 * téléchargement, barre de progression, reprise, « ✓ disponible hors ligne ».
 * Utilisé dans la fiche itinéraire et sur l'écran de départ d'une sortie.
 */
import type { PackPlan } from '../../core/offline/tiles';
import type { OfflinePack } from '../../services/db';
import {
  cancelDownload,
  deletePack,
  getPack,
  isDownloading,
  packBytes,
  planForPoints,
  startDownload,
  subscribeDownload,
  type DownloadProgress,
} from '../../services/offlineMaps';
import { toast } from './toast';
import { append, el, errorMessage } from '../dom';
import { int } from '../format';
import { icon } from '../icons';

export const mb = (bytes: number): string => `${(bytes / 1_048_576).toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Mo`;

export interface OfflinePackCard {
  element: HTMLElement;
  destroy(): void;
}

export function createOfflinePackCard(
  routeId: string,
  routeName: string,
  points: readonly { lat: number; lon: number }[],
  options: { compact?: boolean; onChange?: (pack: OfflinePack | null) => void } = {},
): OfflinePackCard {
  const element = el('div', { class: 'offline-card' });
  let plan: PackPlan | null = null;
  let unsubscribe: () => void = () => {};
  let confirmTimer: number | undefined;
  let destroyed = false;

  function progressView(p: DownloadProgress): HTMLElement {
    const pct = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0;
    const stop = el('button', { type: 'button', class: 'btn btn-small' }, 'Interrompre');
    stop.addEventListener('click', () => cancelDownload(routeId));
    return el(
      'div',
      { class: 'stack-tight' },
      el('div', { class: 'offline-title' }, icon('download'), `Téléchargement… ${pct} %`),
      el('div', { class: 'progress' }, el('div', { class: 'progress-bar', style: `width:${pct}%` })),
      el('div', { class: 'muted' }, `${int(p.done)} / ${int(p.total)} tuiles · ${mb(p.bytes)}. Tu peux changer d’écran, ça continue.`),
      stop,
    );
  }

  async function render(): Promise<void> {
    if (destroyed) return;
    const pack = await getPack(routeId);
    options.onChange?.(pack);
    if (isDownloading(routeId)) return; // la progression s'affiche via subscribeDownload

    const children: (HTMLElement | null)[] = [];
    if (pack?.status === 'complete') {
      children.push(el('div', { class: 'offline-title ok' }, icon('cloud-check'), `Disponible hors ligne · ${mb(packBytes(pack))}`));
      if (pack.narrow) children.push(el('p', { class: 'muted' }, 'Couloir réduit (±1 km) car l’itinéraire est long.'));
      if (!options.compact) {
        const del = el('button', { type: 'button', class: 'btn btn-small btn-danger' }, 'Supprimer la carte');
        del.addEventListener('click', async () => {
          if (!del.classList.contains('confirm')) {
            del.classList.add('confirm');
            del.textContent = 'Appuie encore pour supprimer';
            confirmTimer = window.setTimeout(() => {
              del.classList.remove('confirm');
              del.textContent = 'Supprimer la carte';
            }, 4000);
            return;
          }
          window.clearTimeout(confirmTimer);
          await deletePack(routeId).catch((err: unknown) => toast(errorMessage(err), 'error'));
          toast('Carte hors ligne supprimée', 'success');
          void render();
        });
        children.push(del);
      }
    } else {
      plan ??= planForPoints(points);
      const start = el('button', { type: 'button', class: 'btn btn-primary btn-block' });
      start.addEventListener('click', () => {
        if (!navigator.onLine) {
          toast('Pas de connexion : télécharge la carte avant de partir, avec du réseau (Wi-Fi de préférence).', 'error');
          return;
        }
        startDownload(routeId, routeName, points);
        follow();
      });
      if (pack?.status === 'limit') {
        children.push(
          el('div', { class: 'offline-title warn' }, icon('warning'), `Carte partielle · ${mb(packBytes(pack))}`),
          el('p', { class: 'muted' }, 'La limite de 50 Mo par téléchargement (OpenFreeMap) a été atteinte : le début du parcours est couvert, pas la fin.'),
        );
      } else if (pack && pack.status === 'partial') {
        start.append(icon('download'), 'Reprendre le téléchargement');
        children.push(
          el('div', { class: 'offline-title warn' }, `Carte incomplète : ${int(pack.done)} / ${int(pack.keys.length)} tuiles (${mb(packBytes(pack))})`),
          start,
        );
      } else if (!plan.withinLimits) {
        children.push(
          el('div', { class: 'offline-title warn' }, icon('warning'), 'Carte hors ligne indisponible'),
          el('p', { class: 'muted' }, `Itinéraire trop long pour un seul téléchargement (≈ ${mb(plan.estimatedBytes)}, ${int(plan.keys.length)} tuiles ; limite OpenFreeMap : 50 Mo ou 3 000 tuiles).`),
        );
      } else {
        start.append(icon('download'), `Télécharger (≈ ${mb(plan.estimatedBytes)})`);
        children.push(
          start,
          el(
            'p',
            { class: 'muted' },
            `${int(plan.keys.length)} tuiles : couloir de ±${plan.narrow ? 1 : 2} km autour du tracé + vue d’ensemble. Wi-Fi conseillé. Taille réelle plus forte en ville.`,
          ),
        );
      }
    }
    element.replaceChildren();
    append(element, ...children);
  }

  function follow(): void {
    unsubscribe();
    unsubscribe = subscribeDownload(routeId, (p) => {
      if (destroyed) return;
      if (p.status === 'running') {
        element.replaceChildren(progressView(p));
        return;
      }
      if (p.status === 'complete') toast('Carte hors ligne prête', 'success');
      else if (p.message) toast(p.message, p.status === 'cancelled' ? 'info' : 'error', 6000);
      unsubscribe();
      void render();
    });
  }

  if (isDownloading(routeId)) follow();
  void render();

  return {
    element,
    destroy() {
      destroyed = true;
      window.clearTimeout(confirmTimer);
      unsubscribe();
    },
  };
}
