/** Messages temporaires en haut de l'écran (succès, erreur). */
import { el } from '../dom';

let container: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', durationMs = 4000): void {
  if (!container) {
    container = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  const node = el('div', { class: `toast toast-${kind}` }, message);
  node.addEventListener('click', () => node.remove());
  container.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? Math.max(durationMs, 7000) : durationMs);
}
