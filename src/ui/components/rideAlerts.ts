/**
 * Bannières du mode sortie : pré-alerte de prise (discrète), alerte de prise
 * (grande, avec « Fait » / « Plus tard » / « Passer ») et rappel boisson.
 *
 * Les bannières de prise et de boisson sont dans la zone « prioritaire » du
 * pager, AU-DESSUS du voile du cadenas : elles restent utilisables écran
 * verrouillé. Pour éviter un appui involontaire (sacoche, pluie), quand le
 * cadenas est actif il faut MAINTENIR le bouton HOLD_MS au lieu de le toucher.
 */
import type { FrozenIntake } from '../../core/ride/intakes';
import { el } from '../dom';
import { int } from '../format';

const HOLD_MS = 600;

export interface RideAlertsHandlers {
  isLocked(): boolean;
  onDone(id: string): void;
  onLater(id: string): void;
  onSkip(id: string): void;
  onDrinkOk(): void;
}

export interface RideAlerts {
  /** Met à jour l'affichage (ne reconstruit les bannières que si elles changent). */
  update(active: FrozenIntake | null, announced: FrozenIntake | null, drink: boolean, alongM: number | null): void;
  destroy(): void;
}

/** Bouton qui réagit à un simple appui, ou à un appui maintenu si l'écran est verrouillé. */
function actionButton(label: string, cls: string, isLocked: () => boolean, action: () => void): HTMLButtonElement {
  const btn = el('button', { type: 'button', class: `btn ${cls}` }, label);
  let timer: number | undefined;
  const cancel = () => {
    window.clearTimeout(timer);
    btn.classList.remove('holding');
  };
  btn.addEventListener('click', () => {
    if (!isLocked()) action();
  });
  btn.addEventListener('pointerdown', () => {
    if (!isLocked()) return;
    btn.classList.add('holding');
    timer = window.setTimeout(() => {
      cancel();
      action();
    }, HOLD_MS);
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel'] as const) btn.addEventListener(t, cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}

export function createRideAlerts(priority: HTMLElement, alerts: HTMLElement, h: RideAlertsHandlers): RideAlerts {
  const preBar = el('div', { class: 'pre-alert', hidden: true });
  alerts.append(preBar);
  const intakeBox = el('div', { class: 'intake-banner', hidden: true, role: 'alertdialog' });
  const drinkBox = el('div', { class: 'drink-banner', hidden: true, role: 'alert' });
  priority.append(intakeBox, drinkBox);

  let shownIntakeId: string | null = null;
  let shownDrink = false;

  function renderIntake(i: FrozenIntake): void {
    intakeBox.replaceChildren(
      el('div', { class: 'ib-title' }, `🍌 Km ${int(i.distanceM / 1000)} : ${i.label}`),
      el('div', { class: 'ib-why' }, `${i.reason === 'preClimb' ? '⛰ ' : ''}${i.why} · ${int(i.carbsG)} g`),
      el(
        'div',
        { class: 'ib-actions' },
        actionButton('✓ Fait', 'btn-primary ib-done', h.isLocked, () => h.onDone(i.id)),
        actionButton('Plus tard', 'ib-later', h.isLocked, () => h.onLater(i.id)),
        actionButton('Passer', 'ib-skip', h.isLocked, () => h.onSkip(i.id)),
      ),
      el('div', { class: 'ib-lock-hint' }, '🔒 Écran verrouillé : maintiens le bouton ½ seconde'),
    );
  }

  function renderDrink(): void {
    drinkBox.replaceChildren(
      el('span', { class: 'db-text' }, '💧 Pense à boire quelques gorgées'),
      actionButton('OK', 'btn-small db-ok', h.isLocked, () => h.onDrinkOk()),
    );
  }

  return {
    update(active, announced, drink, alongM) {
      // Alerte de prise (prioritaire sur la boisson)
      if (active) {
        if (shownIntakeId !== active.id) {
          renderIntake(active);
          shownIntakeId = active.id;
        }
        intakeBox.hidden = false;
      } else {
        intakeBox.hidden = true;
        shownIntakeId = null;
      }
      intakeBox.classList.toggle('locked', h.isLocked());

      const showDrink = drink && !active;
      if (showDrink && !shownDrink) renderDrink();
      shownDrink = showDrink;
      drinkBox.hidden = !showDrink;
      drinkBox.classList.toggle('locked', h.isLocked());

      // Pré-alerte discrète
      if (announced && !active) {
        const left = alongM !== null ? Math.max(0, announced.distanceM - alongM) : null;
        const when = left !== null ? `dans ${int(Math.round(left / 50) * 50)} m` : 'dans ~2 min';
        preBar.textContent = `🍌 Prise ${when} : ${announced.label}`;
        preBar.hidden = false;
      } else {
        preBar.hidden = true;
      }
    },
    destroy() {
      preBar.remove();
      intakeBox.remove();
      drinkBox.remove();
    },
  };
}
