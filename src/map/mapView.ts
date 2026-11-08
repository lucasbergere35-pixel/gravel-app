/**
 * Carte Leaflet : fonds CyclOSM / OpenTopoMap, tracé, curseur.
 *
 * Conditions d'utilisation des tuiles (respectées ici) :
 *  - attribution visible en permanence (contrôle Leaflet en bas à droite) ;
 *  - pas de pré-téléchargement massif de tuiles ; seulement l'affichage normal.
 *  CyclOSM : https://www.cyclosm.org (serveurs OSM France)
 *  OpenTopoMap : https://opentopomap.org/about (zoom max 17)
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { TrackPoint } from '../core/types';

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">Contributeurs OpenStreetMap</a>';

const BASE_LAYERS = {
  cyclosm: {
    label: 'CyclOSM (vélo)',
    create: () =>
      L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
        subdomains: 'abc',
        maxZoom: 20,
        attribution: `<a href="https://www.cyclosm.org">CyclOSM</a> | Données ${OSM_ATTRIBUTION}`,
      }),
  },
  opentopomap: {
    label: 'OpenTopoMap (relief)',
    create: () =>
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc',
        maxZoom: 17,
        attribution: `Données ${OSM_ATTRIBUTION}, SRTM | Style <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
      }),
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

export class MapView {
  private readonly map: L.Map;
  private trackGroup: L.LayerGroup | null = null;
  private trackBounds: L.LatLngBounds | null = null;
  private cursor: L.CircleMarker | null = null;

  constructor(container: HTMLElement) {
    this.map = L.map(container, { zoomControl: true, attributionControl: true });
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    const layers: Record<string, L.TileLayer> = {};
    const preferred = loadPreferredLayer();
    for (const key of Object.keys(BASE_LAYERS) as BaseLayerKey[]) {
      const layer = BASE_LAYERS[key].create();
      layers[BASE_LAYERS[key].label] = layer;
      if (key === preferred) layer.addTo(this.map);
      layer.on('add', () => savePreferredLayer(key));
    }
    L.control.layers(layers, undefined, { position: 'topright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);

    this.map.setView([46.6, 2.4], 6); // France entière par défaut
  }

  showTrack(points: readonly TrackPoint[]): void {
    this.trackGroup?.remove();
    const latlngs = points.map((p) => L.latLng(p.lat, p.lon));
    if (latlngs.length === 0) return;
    // Liseré blanc + trait magenta : bien visible sur tous les fonds de carte.
    const outline = L.polyline(latlngs, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false });
    const line = L.polyline(latlngs, { color: '#c2185b', weight: 5, opacity: 1, interactive: false });
    const start = L.circleMarker(latlngs[0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2e7d32', fillOpacity: 1 });
    const end = L.circleMarker(latlngs[latlngs.length - 1], { radius: 8, color: '#fff', weight: 3, fillColor: '#111', fillOpacity: 1 });
    start.bindTooltip('Départ');
    end.bindTooltip('Arrivée');
    this.trackGroup = L.layerGroup([outline, line, end, start]).addTo(this.map);
    this.trackBounds = line.getBounds();
  }

  fitTrack(): void {
    if (!this.destroyed && this.trackBounds?.isValid()) this.map.fitBounds(this.trackBounds, { padding: [24, 24] });
  }

  /** Affiche (ou masque avec null) un point repère, par ex. survol du profil. */
  setCursor(pos: { lat: number; lon: number } | null): void {
    if (!pos) {
      this.cursor?.remove();
      this.cursor = null;
      return;
    }
    if (!this.cursor) {
      this.cursor = L.circleMarker([pos.lat, pos.lon], {
        radius: 9,
        color: '#fff',
        weight: 3,
        fillColor: '#ff6f00',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.cursor.setLatLng([pos.lat, pos.lon]);
    }
  }

  // ---------- Mode sortie ----------

  private position: L.CircleMarker | null = null;
  private accuracyCircle: L.Circle | null = null;
  private rideLine: L.Polyline | null = null;
  private following = true;

  /**
   * Active le suivi de position. onFollowChange(false) est appelé quand
   * l'utilisateur déplace la carte au doigt (le centrage auto s'arrête).
   */
  enableRideMode(onFollowChange: (following: boolean) => void): void {
    this.map.on('dragstart', () => {
      this.following = false;
      onFollowChange(false);
    });
    this.rideLine = L.polyline([], { color: '#1565c0', weight: 5, opacity: 0.9, interactive: false }).addTo(this.map);
  }

  setFollowing(follow: boolean): void {
    this.following = follow;
    if (follow && this.position) this.map.setView(this.position.getLatLng(), Math.max(this.map.getZoom(), 15));
  }

  setPosition(lat: number, lon: number, accuracyM: number): void {
    if (this.destroyed) return;
    const ll = L.latLng(lat, lon);
    if (!this.position) {
      this.accuracyCircle = L.circle(ll, { radius: accuracyM, color: '#1565c0', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(this.map);
      this.position = L.circleMarker(ll, { radius: 10, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1, interactive: false }).addTo(this.map);
      this.map.setView(ll, 16);
      return;
    }
    this.position.setLatLng(ll);
    this.accuracyCircle?.setLatLng(ll).setRadius(accuracyM);
    if (this.following) this.map.panTo(ll, { animate: true, duration: 0.5 });
  }

  setRideLine(points: ReadonlyArray<{ lat: number; lon: number }>): void {
    this.rideLine?.setLatLngs(points.map((p) => L.latLng(p.lat, p.lon)));
  }

  extendRideLine(lat: number, lon: number): void {
    this.rideLine?.addLatLng([lat, lon]);
  }

  /** À appeler si la taille du conteneur change. */
  invalidateSize(): void {
    if (!this.destroyed) this.map.invalidateSize();
  }

  /** Après destroy(), toutes les méthodes deviennent sans effet (appels différés tardifs). */
  private destroyed = false;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.map.remove();
  }
}
