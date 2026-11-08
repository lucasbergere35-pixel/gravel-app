/**
 * Logique de pagination du mode sortie (sans DOM, testée).
 */

/** Distance horizontale minimale (px) pour qu'un glissement change de page. */
export const SWIPE_MIN_PX = 40;

/**
 * Page après un glissement de (dx, dy) pixels.
 * Glisser vers la gauche (dx < 0) → page suivante ; vers la droite → précédente.
 * Un geste surtout vertical, ou trop court, ne change rien. Pas de boucle.
 */
export function pageAfterSwipe(current: number, dx: number, dy: number, pageCount: number): number {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return current;
  const next = current + (dx < 0 ? 1 : -1);
  return Math.min(pageCount - 1, Math.max(0, next));
}

/** Lit un numéro de page mémorisé, en retombant sur 0 s'il est invalide. */
export function parseStoredPage(value: string | null, pageCount: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < pageCount ? n : 0;
}
