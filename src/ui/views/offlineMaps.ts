/**
 * Écran « Cartes hors ligne » : cartes téléchargées, taille, espace utilisé,
 * protection du stockage par iOS, suppression.
 */
import { deletePack, listPacks, packBytes, requestPersistence, storageInfo } from '../../services/offlineMaps';
import { mb } from '../components/offlinePackCard';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { date, int } from '../format';
import { icon } from '../icons';
import type { View } from '../router';

const STATUS_LABELS = { complete: 'complète', partial: 'incomplète', limit: 'partielle (limite 50 Mo)' } as const;

export const offlineMapsView: View = async (root) => {
  const summary = el('section', { class: 'card stack' });
  const list = el('div', { class: 'stack' });
  const timers: number[] = [];

  async function renderSummary(): Promise<void> {
    const info = await storageInfo();
    const protectBtn = el('button', { type: 'button', class: 'btn btn-small' }, 'Demander la protection');
    protectBtn.addEventListener('click', async () => {
      const ok = await requestPersistence();
      toast(ok ? 'Stockage protégé' : 'iOS n’a pas accordé la protection (il le fait souvent pour les applis de l’écran d’accueil utilisées régulièrement).', ok ? 'success' : 'info', 6000);
      void renderSummary();
    });
    summary.replaceChildren();
    append(
      summary,
      el('h2', {}, icon('hard-drive'), 'Espace utilisé'),
      el('div', { class: 'big-figure' }, mb(info.tilesBytes)),
      el('p', { class: 'muted' }, `${int(info.tilesCount)} tuiles de carte. Les zones communes à plusieurs itinéraires ne sont stockées qu’une fois.`),
      info.usageBytes !== null && info.quotaBytes !== null
        ? el('p', {}, `Toute l’appli (données + cartes) : ${mb(info.usageBytes)}, sur ${mb(info.quotaBytes)} disponibles pour elle.`)
        : null,
      el(
        'p',
        {},
        'Stockage protégé par iOS : ',
        el('strong', {}, info.persisted === true ? 'oui' : info.persisted === false ? 'non' : 'inconnu'),
        info.persisted === true ? null : el('span', { class: 'muted' }, ' (sans protection, iOS peut effacer les données si le téléphone manque de place)'),
      ),
      info.persisted === true ? null : protectBtn,
    );
  }

  async function renderList(): Promise<void> {
    const packs = await listPacks();
    list.replaceChildren();
    if (packs.length === 0) {
      list.append(el('div', { class: 'empty' }, icon('cloud-download'), el('p', {}, 'Aucune carte téléchargée.'), el('p', { class: 'muted' }, 'Depuis la fiche d’un itinéraire : « Hors ligne », puis « Télécharger ».')));
      return;
    }
    for (const p of packs) {
      const del = el('button', { type: 'button', class: 'btn btn-small btn-danger' }, 'Supprimer');
      del.addEventListener('click', async () => {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.textContent = 'Confirmer ?';
          timers.push(
            window.setTimeout(() => {
              del.classList.remove('confirm');
              del.textContent = 'Supprimer';
            }, 4000),
          );
          return;
        }
        try {
          await deletePack(p.routeId);
          toast('Carte supprimée', 'success');
          await Promise.all([renderSummary(), renderList()]);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      });
      list.append(
        el(
          'div',
          { class: 'card offline-pack' },
          el('a', { href: `#/itineraire/${encodeURIComponent(p.routeId)}`, class: 'route-card-name' }, p.routeName),
          el(
            'div',
            { class: 'route-card-stats' },
            el('span', {}, el('strong', {}, mb(packBytes(p)))),
            el('span', {}, `${int(p.done)} / ${int(p.keys.length)} tuiles`),
            el('span', { class: p.status === 'complete' ? 'badge' : 'badge warn' }, icon(p.status === 'complete' ? 'cloud-check' : 'warning'), STATUS_LABELS[p.status]),
            el('span', { class: 'muted' }, date(p.updatedAt)),
          ),
          del,
        ),
      );
    }
  }

  append(
    root,
    el('a', { href: '#/profil', class: 'back-link' }, icon('chevron-left'), 'Profil'),
    el('h1', {}, 'Cartes hors ligne'),
    el(
      'p',
      { class: 'muted' },
      'Fond de carte « Gravel » (OpenFreeMap, données OpenStreetMap) téléchargé autour de tes itinéraires : il s’affiche même sans réseau. La taille d’une carte compte toutes ses tuiles, y compris celles partagées avec une autre.',
    ),
    summary,
    list,
  );
  await Promise.all([renderSummary(), renderList()]);
  return () => timers.forEach((t) => window.clearTimeout(t));
};
