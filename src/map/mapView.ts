/**
 * Carte (MapLibre GL JS) : fonds CyclOSM / OpenTopoMap, tracé, curseur,
 * et en mode sortie : position, flèche de direction, carte orientée dans le
 * sens de la marche.
 *
 * Pourquoi MapLibre et pas Leaflet : Leaflet ne sait pas faire pivoter la carte.
 * Les plugins de rotation (leaflet-rotate) modifient l'intérieur de Leaflet et
 * se comportent mal avec le tactile et certains contrôles. MapLibre gère la
 * rotation nativement (GPU, animations fluides) et sait décaler le centre
 * (option `padding`) pour placer la position dans le tiers bas de l'écran.
 * Il ouvre aussi la voie aux cartes hors ligne (PMTiles) plus tard.
 *
 * Conditions d'utilisation des tuiles (respectées ici) :
 *  - attribution visible en permanence (contrôle en bas à droite) ;
 *  - pas de pré-téléchargement de tuiles ; seulement l'affichage normal.
 *  CyclOSM : https://www.cyclosm.org (serveurs OSM France)
 *  OpenTopoMap : https://opentopomap.org/about (zoom max 17)
 */
import {
  AttributionControl,
  LngLatBounds,
  Map as MlMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre prépare les données dans un « worker » (script en arrière-plan).
// On donne son adresse explicitement : Vite déplace la librairie et elle ne
// le retrouverait pas seule. « ?url » = Vite copie le fichier et fournit son URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

setWorkerUrl(workerUrl);
import type { LayerSpecification, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Feature, FeatureCollection } from 'geojson';
import type { TrackPoint } from '../core/types';

const OSM = '© <a href="https://www.openstreetmap.org/copyright">Contributeurs OpenStreetMap</a>';

const BASE_LAYERS = {
  cyclosm: {
    label: 'CyclOSM',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    maxzoom: 20,
    attribution: `<a href="https://www.cyclosm.org">CyclOSM</a> | Données ${OSM}`,
  },
  opentopomap: {
    label: 'OpenTopoMap',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution: `Données ${OSM}, SRTM | Style <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
  },
} as const;

type BaseLayerKey = keyof typeof BASE_LAYERS;
const PREF_KEY = 'gc.baseLayer';

function loadPreferredLayer(): BaseLayerKey {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v && v in BASE_LAYERS) return v as BaseLayerKey;
  } catch {
    /* stockage indisponible */
  }
  return 'cyclosm';
}

function savePreferredLayer(key: BaseLayerKey): void {
  try {
    localStorage.setItem(PREF_KEY, key);
  } catch {
    /* sans importance */
  }
}


const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const point = (lon: number, lat: number, props: Record<string, string> = {}): Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Point', coordinates: [lon, lat] },
});
const line = (coords: number[][]): Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });

/** Cercle de rayon donné (m) autour d'un point, en polygone (pour la précision GPS). */
function circlePolygon(lon: number, lat: number, radiusM: number): Feature {
  const coords: number[][] = [];
  const dLat = radiusM / 111_195;
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    coords.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
}

/** Petit contrôle « bouton » MapLibre. */
class ButtonControl implements IControl {
  readonly button: HTMLButtonElement;
  private container: HTMLElement;
  constructor(className: string, title: string, onClick: () => void) {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = className;
    this.button.title = title;
    this.button.setAttribute('aria-label', title);
    this.button.addEventListener('click', onClick);
    this.container.append(this.button);
  }
  onAdd(): HTMLElement {
    return this.container;
  }
  onRemove(): void {
    this.container.remove();
  }
}

export type OrientationMode = 'heading' | 'north';

/**
 * Crée la carte, ou affiche un message si c'est impossible (WebGL indisponible…).
 * Le reste de l'écran (chiffres, suivi GPS) continue de fonctionner sans carte.
 */
export function createMapView(container: HTMLElement): MapView | null {
  try {
    return new MapView(container);
  } catch (err) {
    console.error(err);
    const msg = document.createElement('div');
    msg.className = 'map-unavailable';
    msg.textContent = 'Carte indisponible sur cet appareil (WebGL désactivé ?). Le suivi fonctionne quand même.';
    container.replaceChildren(msg);
    return null;
  }
}

export class MapView {
  private readonly map: MlMap;
  private readonly ready: Promise<void>;
  private destroyed = false;
  private trackBounds: LngLatBounds | null = null;
  private baseLayer: BaseLayerKey;

  // Mode sortie
  private positionMarker: Marker | null = null;
  private positionEl: HTMLElement | null = null;
  private compass: ButtonControl | null = null;
  private ridePoints: number[][] = [];
  private following = true;
  private orientation: OrientationMode = 'heading';
  private heading: number | null = null;
  private lastPos: { lat: number; lon: number } | null = null;
  private lastCameraUpdate = 0;
  private onFollowChange: (following: boolean) => void = () => {};
  private onOrientationToggle: () => void = () => {};

  constructor(container: HTMLElement) {
    this.baseLayer = loadPreferredLayer();
    const sources: Record<string, SourceSpecification> = {};
    const layers: LayerSpecification[] = [];
    for (const key of Object.keys(BASE_LAYERS) as BaseLayerKey[]) {
      const b = BASE_LAYERS[key];
      sources[key] = { type: 'raster', tiles: [...b.tiles], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
      layers.push({ id: `base-${key}`, type: 'raster', source: key, layout: { visibility: key === this.baseLayer ? 'visible' : 'none' } });
    }
    for (const id of ['track', 'endpoints', 'ride', 'accuracy', 'cursor']) sources[id] = { type: 'geojson', data: EMPTY };
    layers.push(
      { id: 'track-outline', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9 } },
      { id: 'track-line', type: 'line', source: 'track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#c2185b', 'line-width': 5 } },
      { id: 'ride-line', type: 'line', source: 'ride', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1565c0', 'line-width': 5, 'line-opacity': 0.9 } },
      { id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#1565c0', 'fill-opacity': 0.12 } },
      {
        id: 'endpoints',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 8,
          'circle-color': ['match', ['get', 'kind'], 'start', '#2e7d32', '#111111'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      },
      { id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 9, 'circle-color': '#ff6f00', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } },
    );

    this.map = new MlMap({
      container,
      style: { version: 8, sources, layers },
      center: [2.4, 46.6],
      zoom: 5,
      attributionControl: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      dragRotate: false, // la rotation est pilotée par l'appli, pas par les doigts
    });
    // En développement seulement : accès à la carte depuis la console pour déboguer.
    if (import.meta.env.DEV) (window as unknown as { __gcMap: MlMap }).__gcMap = this.map;
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();

    this.map.addControl(new AttributionControl({ compact: false }), 'bottom-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    const layerBtn = new ButtonControl('ctrl-layers', 'Changer de fond de carte', () => this.toggleBaseLayer(layerBtn.button));
    layerBtn.button.textContent = BASE_LAYERS[this.baseLayer].label;
    this.map.addControl(layerBtn, 'top-right');

    this.ready = new Promise((resolve) => {
      if (this.map.loaded()) resolve();
      else this.map.once('load', () => resolve());
    });
  }

  private toggleBaseLayer(button: HTMLButtonElement): void {
    const keys = Object.keys(BASE_LAYERS) as BaseLayerKey[];
    const next = keys[(keys.indexOf(this.baseLayer) + 1) % keys.length];
    for (const k of keys) this.map.setLayoutProperty(`base-${k}`, 'visibility', k === next ? 'visible' : 'none');
    this.baseLayer = next;
    button.textContent = BASE_LAYERS[next].label;
    savePreferredLayer(next);
  }

  /** Exécute fn une fois le style chargé (les sources n'existent pas avant). */
  private whenReady(fn: () => void): void {
    void this.ready.then(() => {
      if (!this.destroyed) fn();
    });
  }

  private setData(sourceId: string, data: FeatureCollection): void {
    this.whenReady(() => (this.map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(data));
  }

  showTrack(points: readonly TrackPoint[]): void {
    if (points.length === 0) return;
    const coords = points.map((p) => [p.lon, p.lat]);
    const bounds = new LngLatBounds();
    for (const c of coords) bounds.extend(c as [number, number]);
    this.trackBounds = bounds;
    this.setData('track', collection([line(coords)]));
    const first = points[0];
    const last = points[points.length - 1];
    this.setData('endpoints', collection([point(last.lon, last.lat, { kind: 'end' }), point(first.lon, first.lat, { kind: 'start' })]));
  }

  fitTrack(): void {
    // En sortie, une fois la position connue, on reste centré sur elle (zoom conservé).
    if (this.destroyed || !this.trackBounds || this.lastPos) return;
    this.map.fitBounds(this.trackBounds, { padding: 24, animate: false, maxZoom: 16 });
  }

  /** Affiche (ou masque avec null) un point repère, par ex. survol du profil. */
  setCursor(pos: { lat: number; lon: number } | null): void {
    this.setData('cursor', pos ? collection([point(pos.lon, pos.lat)]) : EMPTY);
  }

  // ---------- Mode sortie ----------

  /**
   * Prépare le mode sortie.
   * onFollowChange(false) : l'utilisateur a déplacé la carte au doigt (le suivi s'arrête).
   * onOrientationToggle : appui sur la boussole.
   */
  enableRideMode(options: { onFollowChange: (following: boolean) => void; onOrientationToggle: () => void; orientation: OrientationMode }): void {
    this.onFollowChange = options.onFollowChange;
    this.onOrientationToggle = options.onOrientationToggle;
    this.orientation = options.orientation;
    this.map.on('dragstart', () => {
      if (!this.following) return;
      this.following = false;
      this.onFollowChange(false);
    });
    // Boussole : l'aiguille pointe vers le nord ; un appui change de mode.
    this.compass = new ButtonControl('ctrl-compass', 'Orientation de la carte', () => this.onOrientationToggle());
    this.compass.button.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 2 L16 12 L8 12 Z" fill="#d32f2f"/><path d="M12 22 L8 12 L16 12 Z" fill="#555"/><text x="12" y="9.5" font-size="5" text-anchor="middle" fill="#fff" font-weight="700">N</text></svg>';
    this.map.addControl(this.compass, 'top-right');
    this.map.on('rotate', () => this.updateCompass());

    // Flèche de position : alignée sur la carte, elle pointe vers le cap réel.
    this.positionEl = document.createElement('div');
    this.positionEl.className = 'position-marker no-heading';
    this.positionEl.innerHTML =
      '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><circle class="pm-dot" cx="20" cy="20" r="9"/><path class="pm-arrow" d="M20 3 L32 33 L20 26 L8 33 Z"/></svg>';
    this.positionMarker = new Marker({ element: this.positionEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  }

  setOrientation(mode: OrientationMode): void {
    this.orientation = mode;
    this.updateCamera(true);
  }

  setFollowing(follow: boolean): void {
    this.following = follow;
    if (follow) this.updateCamera(true);
  }

  /** Cap (degrés, 0 = nord) ou null s'il est inconnu. */
  setHeading(heading: number | null): void {
    this.heading = heading;
    if (heading !== null) this.positionMarker?.setRotation(heading);
    this.positionEl?.classList.toggle('no-heading', heading === null);
  }

  setPosition(lat: number, lon: number, accuracyM: number): void {
    if (this.destroyed) return;
    const first = this.lastPos === null;
    this.lastPos = { lat, lon };
    this.setData('accuracy', collection([circlePolygon(lon, lat, accuracyM)]));
    if (this.positionMarker) {
      this.positionMarker.setLngLat([lon, lat]);
      if (first) this.positionMarker.addTo(this.map);
    }
    if (first) this.map.jumpTo({ center: [lon, lat], zoom: 15 });
    this.updateCamera(first);
  }

  /**
   * Place la caméra : centrée sur la position ; en « sens de la marche », la
   * carte tourne selon le cap et la position descend au tiers inférieur
   * (marge haute = 1/3 de la hauteur → le centre visible est à 2/3).
   */
  private updateCamera(immediate: boolean): void {
    if (this.destroyed || !this.following || !this.lastPos) return;
    const headingUp = this.orientation === 'heading';
    const h = this.map.getContainer().clientHeight;
    const bearing = headingUp ? (this.heading ?? this.map.getBearing()) : 0;
    const padding = { top: headingUp ? Math.round(h / 3) : 0, bottom: 0, left: 0, right: 0 };
    const now = performance.now();
    // Animation d'environ la durée entre deux positions (fluide, sans retard cumulé).
    const duration = immediate ? 300 : Math.min(1000, Math.max(0, now - this.lastCameraUpdate));
    this.lastCameraUpdate = now;
    this.map.easeTo({ center: [this.lastPos.lon, this.lastPos.lat], bearing, padding, duration, easing: (t) => t });
  }

  private updateCompass(): void {
    const svg = this.compass?.button.firstElementChild as SVGElement | null;
    if (svg) svg.style.transform = `rotate(${-this.map.getBearing()}deg)`;
  }

  setRideLine(points: ReadonlyArray<{ lat: number; lon: number }>): void {
    this.ridePoints = points.map((p) => [p.lon, p.lat]);
    this.setData('ride', collection([line(this.ridePoints)]));
  }

  private rideLineTimer: number | undefined;

  /**
   * Ajoute un point à la trace. Le redessin est regroupé (au plus toutes les 2 s) :
   * renvoyer des milliers de points à chaque position serait coûteux.
   */
  extendRideLine(lat: number, lon: number): void {
    this.ridePoints.push([lon, lat]);
    if (this.rideLineTimer !== undefined) return;
    this.rideLineTimer = window.setTimeout(() => {
      this.rideLineTimer = undefined;
      this.setData('ride', collection([line(this.ridePoints)]));
    }, 2000);
  }

  /** À appeler si la taille du conteneur change. */
  invalidateSize(): void {
    if (!this.destroyed) this.map.resize();
  }

  /** Après un déplacement de la carte dans la page : nouvelle taille + recadrage sur la position. */
  relayout(): void {
    if (this.destroyed) return;
    this.map.resize();
    this.updateCamera(true);
  }

  /** Après destroy(), toutes les méthodes deviennent sans effet (appels différés tardifs). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.rideLineTimer);
    this.map.remove();
  }
}
