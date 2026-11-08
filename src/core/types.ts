/**
 * Types de base partagés par tous les modules.
 * Le dossier core/ ne dépend ni du DOM affiché ni des API du navigateur
 * (sauf DOMParser pour le XML), ce qui permet de le tester facilement.
 */

/** Un point de trace (GPX ou GPS). */
export interface TrackPoint {
  lat: number;
  lon: number;
  /** Altitude en mètres, ou null si absente. */
  ele: number | null;
  /** Horodatage (ms depuis 1970), si connu. */
  time?: number;
}

/** Point d'intérêt nommé d'un GPX (<wpt>). */
export interface Waypoint {
  lat: number;
  lon: number;
  name: string;
}
