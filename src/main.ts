/**
 * Point d'entrée : structure de l'écran (en-tête, contenu, onglets),
 * routeur, service worker (mise à jour/hors ligne), stockage persistant.
 */
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { requestPersistentStorage } from './services/db';
import { toast } from './ui/components/toast';
import { el, errorMessage } from './ui/dom';
import { startRouter } from './ui/router';
import { foodsView } from './ui/views/foods';
import { nutritionView } from './ui/views/nutrition';
import { profileView } from './ui/views/profile';
import { rideSummaryView, ridesListView } from './ui/views/rides';
import { createRideView } from './ui/views/ride';
import { routeDetailView } from './ui/views/routeDetail';
import { routesListView } from './ui/views/routesList';

const TABS = [
  { id: 'routes', href: '#/', label: 'Itinéraires', icon: '🗺️' },
  { id: 'rides', href: '#/sorties', label: 'Sorties', icon: '🚴' },
  { id: 'foods', href: '#/aliments', label: 'Aliments', icon: '🍌' },
  { id: 'profile', href: '#/profil', label: 'Profil', icon: '👤' },
] as const;

function buildShell(): { main: HTMLElement; setTab: (id: string) => void } {
  const app = document.getElementById('app')!;
  const main = el('main', { id: 'view' });
  const tabLinks = TABS.map((t) =>
    el('a', { href: t.href, class: 'tab', 'data-tab': t.id }, el('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon), el('span', {}, t.label)),
  );
  app.append(
    el('header', { class: 'app-header' }, el('span', { class: 'app-title' }, 'Gravel Compagnon')),
    main,
    el('nav', { class: 'tabbar', 'aria-label': 'Navigation' }, ...tabLinks),
  );
  return {
    main,
    setTab: (id) => tabLinks.forEach((a) => a.classList.toggle('active', a.dataset.tab === id)),
  };
}

function setupServiceWorker(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      const banner = el(
        'div',
        { class: 'update-banner' },
        el('span', {}, 'Nouvelle version disponible'),
        el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => void updateSW(true) }, 'Mettre à jour'),
      );
      document.body.append(banner);
    },
    onOfflineReady() {
      toast('Appli prête à fonctionner hors connexion', 'success');
    },
  });
}

const { main, setTab } = buildShell();
startRouter(
  main,
  [
    { path: '/', view: routesListView, tab: 'routes' },
    { path: '/itineraire/:id', view: routeDetailView, tab: 'routes' },
    { path: '/profil', view: profileView, tab: 'profile' },
    { path: '/aliments', view: foodsView, tab: 'foods' },
    { path: '/sorties', view: ridesListView, tab: 'rides' },
    { path: '/sorties/:id', view: rideSummaryView, tab: 'rides' },
    { path: '/nutrition/:id', view: nutritionView, tab: 'routes' },
    { path: '/sortie/:id', view: createRideView(false), tab: 'routes' },
    { path: '/simulation/:id', view: createRideView(true), tab: 'routes' },
  ],
  setTab,
  (err) => {
    console.error(err);
    toast(errorMessage(err), 'error');
  },
);

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(errorMessage(e.reason), 'error');
});

void requestPersistentStorage();
setupServiceWorker();
