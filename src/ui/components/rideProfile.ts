/**
 * Profil altimétrique du mode sortie (page « Profil »).
 *  - partie restante en magenta, partie déjà parcourue en bleu ;
 *  - montée en cours / prochaine montée surlignée en orange ;
 *  - position actuelle : trait vertical + point.
 * Le dessin (coûteux) n'est refait qu'au redimensionnement ; à chaque position,
 * on ne déplace que la découpe « parcouru » et le curseur.
 */
import type { Climb } from '../../core/geo/climbs';
import type { ElevationProfile } from '../../core/geo/elevation';
import { el } from '../dom';
import { int } from '../format';

const SVG_NS = 'http://www.w3.org/2000/svg';
const M = { top: 10, right: 10, bottom: 24, left: 42 };
let uid = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function niceStep(range: number, maxTicks: number, candidates: number[]): number {
  for (const c of candidates) if (range / c <= maxTicks) return c;
  return candidates[candidates.length - 1];
}

export interface RideProfileChart {
  element: HTMLElement;
  /** Position actuelle le long du tracé (m), et montée à surligner. */
  update(alongM: number | null, highlight: Climb | null): void;
  destroy(): void;
}

export function createRideProfile(profile: ElevationProfile): RideProfileChart {
  const wrapper = el('div', { class: 'ride-profile-chart' });
  const { distances, elevations } = profile;
  const n = distances.length;
  const total = distances[n - 1] || 1;
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

  const clipId = `done-clip-${++uid}`;
  let along: number | null = null;
  let highlight: Climb | null = null;
  // Fonctions de placement, mises à jour à chaque dessin.
  let x = (d: number) => d;
  let y = (e: number) => e;
  let plotTop = 0;
  let plotBottom = 0;
  let clipRect: SVGRectElement | null = null;
  let cursorLine: SVGLineElement | null = null;
  let cursorDot: SVGCircleElement | null = null;
  let climbPath: SVGPathElement | null = null;

  function pathBetween(fromM: number, toM: number): string {
    let s = '';
    const i0 = Math.max(0, Math.floor(fromM / profile.step));
    const i1 = Math.min(n - 1, Math.ceil(toM / profile.step));
    for (let i = i0; i <= i1; i++) s += `${i === i0 ? 'M' : 'L'}${x(distances[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`;
    return s;
  }

  function draw(width: number, height: number): void {
    const w = Math.max(200, Math.floor(width));
    const h = Math.max(120, Math.floor(height));
    const plotW = w - M.left - M.right;
    const plotH = h - M.top - M.bottom;
    plotTop = M.top;
    plotBottom = M.top + plotH;
    x = (d) => M.left + (d / total) * plotW;
    y = (e) => M.top + (1 - (e - minE) / (maxE - minE)) * plotH;

    const root = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': 'Profil altimétrique du parcours' });

    const eStep = niceStep(maxE - minE, 4, [10, 20, 25, 50, 100, 200, 250, 500, 1000]);
    for (let e = Math.ceil(minE / eStep) * eStep; e <= maxE; e += eStep) {
      root.append(svg('line', { x1: M.left, x2: w - M.right, y1: y(e), y2: y(e), class: 'grid' }));
      const t = svg('text', { x: M.left - 5, y: y(e) + 4, 'text-anchor': 'end', class: 'tick' });
      t.textContent = int(e);
      root.append(t);
    }
    const kStep = niceStep(total / 1000, 5, [0.5, 1, 2, 5, 10, 20, 25, 50, 100]) * 1000;
    for (let d = 0; d <= total; d += kStep) {
      if (x(d) > w - M.right - 30) break;
      const t = svg('text', { x: x(d), y: h - 6, 'text-anchor': 'middle', class: 'tick' });
      t.textContent = int(d / 1000);
      root.append(t);
    }
    const unit = svg('text', { x: w - M.right, y: h - 6, 'text-anchor': 'end', class: 'tick' });
    unit.textContent = 'km';
    root.append(unit);

    // Courbe sous-échantillonnée (~2 points par pixel)
    const m = Math.min(n, plotW * 2);
    let line = '';
    for (let k = 0; k < m; k++) {
      const i = m === 1 ? 0 : Math.round((k * (n - 1)) / (m - 1));
      line += `${k === 0 ? 'M' : 'L'}${x(distances[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`;
    }
    const area = `${line}L${x(total)},${plotBottom}L${x(0)},${plotBottom}Z`;

    const defs = svg('defs');
    const clip = svg('clipPath', { id: clipId });
    clipRect = svg('rect', { x: 0, y: 0, width: 0, height: h });
    clip.append(clipRect);
    defs.append(clip);
    root.append(defs);

    root.append(svg('path', { d: area, class: 'area-todo' }), svg('path', { d: line, class: 'line-todo' }));
    climbPath = svg('path', { d: '', class: 'line-climb' });
    root.append(climbPath);
    const done = svg('g', { 'clip-path': `url(#${clipId})` });
    done.append(svg('path', { d: area, class: 'area-done' }), svg('path', { d: line, class: 'line-done' }));
    root.append(done);

    cursorLine = svg('line', { y1: plotTop, y2: plotBottom, class: 'cursor', visibility: 'hidden' });
    cursorDot = svg('circle', { r: 7, class: 'cursor-dot', visibility: 'hidden' });
    root.append(cursorLine, cursorDot);

    wrapper.replaceChildren(root);
    place();
  }

  function place(): void {
    if (!clipRect || !cursorLine || !cursorDot || !climbPath) return;
    climbPath.setAttribute('d', highlight ? pathBetween(highlight.startM, highlight.endM) : '');
    if (along === null) {
      clipRect.setAttribute('width', '0');
      cursorLine.setAttribute('visibility', 'hidden');
      cursorDot.setAttribute('visibility', 'hidden');
      return;
    }
    const a = Math.min(total, Math.max(0, along));
    const cx = x(a);
    const i = Math.min(n - 1, Math.max(0, Math.round(a / profile.step)));
    clipRect.setAttribute('width', String(Math.max(0, cx)));
    cursorLine.setAttribute('x1', String(cx));
    cursorLine.setAttribute('x2', String(cx));
    cursorDot.setAttribute('cx', String(cx));
    cursorDot.setAttribute('cy', String(y(elevations[i])));
    cursorLine.setAttribute('visibility', 'visible');
    cursorDot.setAttribute('visibility', 'visible');
  }

  let lastW = 0;
  let lastH = 0;
  const observer = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (!r || r.width <= 0 || r.height <= 0) return;
    if (Math.abs(r.width - lastW) > 1 || Math.abs(r.height - lastH) > 1) {
      lastW = r.width;
      lastH = r.height;
      draw(r.width, r.height);
    }
  });
  observer.observe(wrapper);

  return {
    element: wrapper,
    update(alongM, climb) {
      along = alongM;
      highlight = climb;
      place();
    },
    destroy: () => observer.disconnect(),
  };
}
