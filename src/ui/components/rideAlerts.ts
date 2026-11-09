/**
 * Bannières du mode sortie, SANS bouton :
 *  - pré-alerte discrète ~500 m avant une prise ;
 *  - bannière de prise (contenu, raison, son) ;
 *  - bannière boisson (plus discrète).
 * Elles disparaissent seules après BANNER_MS, ou plus tôt d'un simple appui.
 *
 * Elles sont dans la zone « prioritaire » du pager, au-dessus du voile du
 * cadenas : l'appui pour fermer marche même écran verrouillé (il ne valide rien).
 *
 * Écran éteint / appli en arrière-plan : une bannière n'est jamais « consommée »
 * hors de la vue. Elle attend le retour de l'appli, puis s'affiche 40 s.
 * Plusieurs prises arrivées pendant ce temps sont regroupées en une bannière.
 */
import { describeIntakes, type FrozenIntake } from '../../core/ride/intakes';
import type { SoundKind } from '../../services/sound';
import { el } from '../dom';
import { int } from '../format';

export const BANNER_MS = 40_000;

export interface RideAlerts {
  /** Prises déclenchées (une ou plusieurs) : affichées ensemble. */
  showIntakes(intakes: readonly FrozenIntake[]): void;
  showDrink(): void;
  /** Pré-alerte : prise annoncée (ou null), et position sur le tracé pour la distance restante. */
  setAnnounced(intake: FrozenIntake | null, alongM: number | null): void;
  /** À appeler quand l'appli revient au premier plan. */
  onVisible(): void;
  destroy(): void;
}

interface Banner {
  box: HTMLElement;
  timer: number | undefined;
  /** Contenu en attente d'affichage (appli en arrière-plan). */
  pending: boolean;
}

export function createRideAlerts(priority: HTMLElement, alerts: HTMLElement, play: (kind: SoundKind) => void): RideAlerts {
  const preBar = el('div', { class: 'pre-alert', hidden: true });
  alerts.append(preBar);

  const intake: Banner = { box: el('div', { class: 'intake-banner', hidden: true, role: 'alert' }), timer: undefined, pending: false };
  const drink: Banner = { box: el('div', { class: 'drink-banner', hidden: true, role: 'alert' }), timer: undefined, pending: false };
  priority.append(intake.box, drink.box);

  /** Prises affichées (ou en attente) dans la bannière en cours. */
  let intakeGroup: FrozenIntake[] = [];

  const visible = () => document.visibilityState === 'visible';

  function hide(b: Banner): void {
    window.clearTimeout(b.timer);
    b.box.hidden = true;
    b.pending = false;
    if (b === intake) intakeGroup = [];
  }

  for (const b of [intake, drink]) b.box.addEventListener('click', () => hide(b));

  /** Affiche la bannière pour BANNER_MS, avec une barre qui se vide. */
  function display(b: Banner, sound: SoundKind): void {
    if (!visible()) {
      b.pending = true; // affichée au retour de l'appli
      return;
    }
    b.pending = false;
    window.clearTimeout(b.timer);
    b.box.hidden = false;
    // Relance l'animation de la barre de temps.
    const bar = b.box.querySelector<HTMLElement>('.banner-timer');
    if (bar) {
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.animation = '';
    }
    b.timer = window.setTimeout(() => hide(b), BANNER_MS);
    play(sound);
  }

  function renderIntake(): void {
    const t = describeIntakes(intakeGroup);
    intake.box.replaceChildren(
      el('div', { class: 'ib-title' }, `🍌 ${t.title}`),
      ...t.lines.map((l) => el('div', { class: 'ib-why' }, l)),
      el('div', { class: 'banner-hint' }, 'Touche pour fermer'),
      el('div', { class: 'banner-timer' }),
    );
  }

  return {
    showIntakes(intakes) {
      if (intakes.length === 0) return;
      // Regroupe seulement avec des prises PAS ENCORE VUES (en attente, appli en
      // arrière-plan). Une bannière déjà vue est remplacée par la nouvelle prise.
      const keep = intake.pending ? intakeGroup : [];
      intakeGroup = [...keep, ...intakes.filter((i) => !keep.some((k) => k.id === i.id))];
      renderIntake();
      display(intake, 'intake');
    },
    showDrink() {
      drink.box.replaceChildren(
        el('div', { class: 'db-text' }, '💧 Pense à boire quelques gorgées'),
        el('div', { class: 'banner-hint' }, 'Touche pour fermer'),
        el('div', { class: 'banner-timer' }),
      );
      display(drink, 'drink');
    },
    setAnnounced(next, alongM) {
      if (next && intake.box.hidden) {
        const left = alongM !== null ? Math.max(0, next.distanceM - alongM) : null;
        const when = left !== null ? `dans ${int(Math.round(left / 50) * 50)} m` : 'dans ~2 min';
        preBar.textContent = `🍌 Prise ${when} : ${next.label}`;
        preBar.hidden = false;
      } else {
        preBar.hidden = true;
      }
    },
    onVisible() {
      if (intake.pending) display(intake, 'intake');
      if (drink.pending) display(drink, 'drink');
    },
    destroy() {
      window.clearTimeout(intake.timer);
      window.clearTimeout(drink.timer);
      preBar.remove();
      intake.box.remove();
      drink.box.remove();
    },
  };
}
