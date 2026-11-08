/**
 * Profil altimétrique en SVG, dessiné à la largeur réelle de l'écran.
 * Glisser le doigt horizontalement affiche distance/altitude et
 * déclenche onHover(distance) (pour placer un repère sur la carte).
 */
import type { ElevationProfile } from '../../core/geo/elevation';
import { el } from '../dom';
import { int, km } from '../format';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 200;
const M = { top: 12, right: 12, bottom: 26, left: 46 };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Pas de graduation « rond » donnant au plus maxTicks graduations. */
function niceStep(range: number, maxTicks: number, candidates: number[]): number {
  for (const c of candidates) if (range / c <= maxTicks) return c;
  return candidates[candidates.length - 1];
}

export interface ElevationChart {
  element: HTMLElement;
  destroy(): void;
}

export function createElevationChart(
  profile: ElevationProfile,
  onHover?: (distanceM: number | null) => void,
): ElevationChart {
  const wrapper = el('div', { class: 'elevation-chart' });
  const readout = el('div', { class: 'chart-readout', 'aria-live': 'off' }, 'Glisse le doigt sur le profil');
  wrapper.append(readout);

  const { distances, elevations } = profile;
  const total = distances[distances.length - 1] || 1;
  // Boucle plutôt que Math.min(...tab) : Safari limite le nombre d'arguments.
  let minE = Infinity;
  let maxE = -Infinity;
  for (const e of elevations) {
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
  }
  if (maxE - minE < 50) {
    const mid = (maxE + minE) / 2;
    minE = mid - 25;
    maxE = mid + 25;
  }
  const pad = (maxE - minE) * 0.08;
  minE -= pad;
  maxE += pad;

  let currentSvg: SVGSVGElement | null = null;

  function draw(width: number): void {
    const w = Math.max(200, Math.floor(width));
    const plotW = w - M.left - M.right;
    const plotH = HEIGHT - M.top - M.bottom;
    const x = (d: number) => M.left + (d / total) * plotW;
    const y = (e: number) => M.top + (1 - (e - minE) / (maxE - minE)) * plotH;

    const root = svg('svg', { width: w, height: HEIGHT, viewBox: `0 0 ${w} ${HEIGHT}`, role: 'img', 'aria-label': 'Profil altimétrique' });

    // Graduations horizontales (altitude)
    const eStep = niceStep(maxE - minE, 4, [10, 20, 25, 50, 100, 200, 250, 500, 1000]);
    for (let e = Math.ceil(minE / eStep) * eStep; e <= maxE; e += eStep) {
      root.append(svg('line', { x1: M.left, x2: w - M.right, y1: y(e), y2: y(e), class: 'grid' }));
      const t = svg('text', { x: M.left - 6, y: y(e) + 4, 'text-anchor': 'end', class: 'tick' });
      t.textContent = `${int(e)}`;
      root.append(t);
    }
    // Graduations verticales (km)
    const kStep = niceStep(total / 1000, 5, [0.5, 1, 2, 5, 10, 20, 25, 50, 100]) * 1000;
    for (let d = 0; d <= total; d += kStep) {
      if (x(d) > w - M.right - 30) break; // laisse la place au libellé « km »
      const t = svg('text', { x: x(d), y: HEIGHT - 8, 'text-anchor': 'middle', class: 'tick' });
      t.textContent = `${int(d / 1000)}`;
      root.append(t);
    }
    const unit = svg('text', { x: w - M.right, y: HEIGHT - 8, 'text-anchor': 'end', class: 'tick unit' });
    unit.textContent = 'km';
    root.append(unit);

    // Courbe (sous-échantillonnée à ~2 points par pixel)
    const n = distances.length;
    const m = Math.min(n, plotW * 2);
    let line = '';
    for (let k = 0; k < m; k++) {
      const i = m === 1 ? 0 : Math.round((k * (n - 1)) / (m - 1));
      line += `${k === 0 ? 'M' : 'L'}${x(distances[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`;
    }
    const baseY = M.top + plotH;
    root.append(svg('path', { d: `${line}L${x(total)},${baseY}L${x(0)},${baseY}Z`, class: 'area' }));
    root.append(svg('path', { d: line, class: 'line' }));

    // Curseur
    const cursorLine = svg('line', { y1: M.top, y2: baseY, class: 'cursor', visibility: 'hidden' });
    const cursorDot = svg('circle', { r: 5, class: 'cursor-dot', visibility: 'hidden' });
    root.append(cursorLine, cursorDot);

    function showAt(clientX: number): void {
      const rect = root.getBoundingClientRect();
      const px = Math.min(Math.max(clientX - rect.left, M.left), M.left + plotW);
      const d = ((px - M.left) / plotW) * total;
      const i = Math.min(n - 1, Math.max(0, Math.round(d / profile.step)));
      const cx = x(distances[i]);
      const cy = y(elevations[i]);
      cursorLine.setAttribute('x1', String(cx));
      cursorLine.setAttribute('x2', String(cx));
      cursorDot.setAttribute('cx', String(cx));
      cursorDot.setAttribute('cy', String(cy));
      cursorLine.setAttribute('visibility', 'visible');
      cursorDot.setAttribute('visibility', 'visible');
      readout.textContent = `km ${km(distances[i])} · ${int(elevations[i])} m`;
      onHover?.(distances[i]);
    }

    root.addEventListener('pointerdown', (e) => showAt(e.clientX));
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || e.buttons > 0 || e.pressure > 0) showAt(e.clientX);
    });
    root.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        cursorLine.setAttribute('visibility', 'hidden');
        cursorDot.setAttribute('visibility', 'hidden');
        onHover?.(null);
      }
    });

    if (currentSvg) currentSvg.replaceWith(root);
    else wrapper.append(root);
    currentSvg = root;
  }

  let lastWidth = 0;
  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (width > 0 && Math.abs(width - lastWidth) > 1) {
      lastWidth = width;
      draw(width);
    }
  });
  observer.observe(wrapper);

  return { element: wrapper, destroy: () => observer.disconnect() };
}
