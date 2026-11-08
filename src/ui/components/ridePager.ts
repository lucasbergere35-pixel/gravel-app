/**
 * Structure de l'écran de sortie :
 *
 *   ┌──────────────────────────┐
 *   │ alertes (toutes pages)   │
 *   │   pages (3/4 haut)       │ ← la carte s'y déplace au doigt librement
 *   ├──────────────────────────┤
 *   │ vitesse   km   🔓        │ ← bandeau fixe (1/4 bas) : seul endroit où
 *   │   ●   ○   ○              │   glisser change de page
 *   └──────────────────────────┘
 *
 * Cadenas : un appui verrouille ; un voile transparent bloque alors tous les
 * appuis, et seul un appui long (UNLOCK_HOLD_MS) déverrouille.
 */
import { el } from '../dom';
import { pageAfterSwipe, parseStoredPage } from '../pager';

const UNLOCK_HOLD_MS = 1000;
const PAGE_KEY = 'gc.ride.page';

export interface RidePager {
  element: HTMLElement;
  /** Conteneur de chaque page (à remplir par l'appelant). */
  pages: HTMLElement[];
  /** Zone d'alertes, visible sur toutes les pages. */
  alerts: HTMLElement;
  current(): number;
  setPage(index: number): void;
  setBand(speed: string, distance: string): void;
  destroy(): void;
}

export function createRidePager(pageTitles: string[], onPageChange: (index: number) => void): RidePager {
  const count = pageTitles.length;
  const pages = pageTitles.map((title) => el('section', { class: 'ride-page', 'aria-label': title }));
  const track = el('div', { class: 'ride-track' }, ...pages);
  track.style.width = `${count * 100}%`;
  for (const p of pages) p.style.width = `${100 / count}%`;
  const alerts = el('div', { class: 'ride-alerts', 'aria-live': 'assertive' });
  const pagesArea = el('div', { class: 'ride-pages' }, track, alerts);

  // ---------- Bandeau ----------
  const speedValue = el('span', {}, '—');
  const distValue = el('span', {}, '0,0');
  const lockBtn = el('button', { type: 'button', class: 'band-lock', 'aria-label': 'Verrouiller l’écran' }, '🔓');
  const dots = pageTitles.map((title, i) =>
    el('button', { type: 'button', class: 'band-dot', 'aria-label': `Page ${i + 1} : ${title}` }, el('span', { class: 'dot' }), el('span', { class: 'dot-label' }, title)),
  );
  const band = el(
    'div',
    { class: 'ride-band' },
    el(
      'div',
      { class: 'band-values' },
      el('div', { class: 'band-value' }, el('div', { class: 'band-number' }, speedValue), el('div', { class: 'band-unit' }, 'km/h')),
      el('div', { class: 'band-value' }, el('div', { class: 'band-number' }, distValue), el('div', { class: 'band-unit' }, 'km parcourus')),
      lockBtn,
    ),
    el('div', { class: 'band-dots' }, ...dots),
  );

  // ---------- Verrouillage ----------
  const progress = el('div', { class: 'lock-progress' });
  const lockOverlay = el(
    'div',
    { class: 'lock-overlay', hidden: true },
    el('div', { class: 'lock-badge' }, el('strong', {}, '🔒 Écran verrouillé'), el('span', {}, 'Maintiens le doigt 1 s n’importe où pour déverrouiller'), progress),
  );

  const element = el('div', { class: 'ride-shell' }, pagesArea, band, lockOverlay);

  // ---------- Pages ----------
  let page = 0;
  try {
    page = parseStoredPage(localStorage.getItem(PAGE_KEY), count);
  } catch {
    page = 0;
  }

  function setPage(index: number): void {
    page = Math.min(count - 1, Math.max(0, index));
    track.style.transform = `translateX(${(-100 * page) / count}%)`;
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === page);
      d.setAttribute('aria-current', i === page ? 'page' : 'false');
    });
    try {
      localStorage.setItem(PAGE_KEY, String(page));
    } catch {
      /* sans importance */
    }
    onPageChange(page);
  }

  dots.forEach((d, i) => d.addEventListener('click', () => setPage(i)));

  // Glissement uniquement sur le bandeau.
  let start: { x: number; y: number; id: number } | null = null;
  band.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  band.addEventListener('pointerup', (e) => {
    if (!start || start.id !== e.pointerId) return;
    const next = pageAfterSwipe(page, e.clientX - start.x, e.clientY - start.y, count);
    start = null;
    if (next !== page) setPage(next);
  });
  band.addEventListener('pointercancel', () => (start = null));

  // Verrouiller / déverrouiller
  let holdTimer: number | undefined;
  function setLocked(locked: boolean): void {
    lockOverlay.hidden = !locked;
    element.classList.toggle('locked', locked);
    lockBtn.textContent = locked ? '🔒' : '🔓';
  }
  lockBtn.addEventListener('click', () => setLocked(true));
  const cancelHold = () => {
    window.clearTimeout(holdTimer);
    progress.classList.remove('running');
  };
  lockOverlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cancelHold();
    progress.classList.add('running');
    holdTimer = window.setTimeout(() => {
      cancelHold();
      setLocked(false);
    }, UNLOCK_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) lockOverlay.addEventListener(type, cancelHold);
  lockOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    element,
    pages,
    alerts,
    current: () => page,
    setPage,
    setBand(speed, distance) {
      speedValue.textContent = speed;
      distValue.textContent = distance;
    },
    destroy: () => window.clearTimeout(holdTimer),
  };
}
