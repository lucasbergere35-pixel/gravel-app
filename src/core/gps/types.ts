/** Une position GPS brute (appareil ou simulation). */
export interface GpsFix {
  lat: number;
  lon: number;
  /** Précision horizontale annoncée (m, rayon à ~68 %). */
  accuracy: number;
  /** Altitude GPS (m), souvent imprécise ; null si inconnue. */
  altitude: number | null;
  /** Vitesse mesurée par le GPS (m/s), null si inconnue. */
  speed: number | null;
  /** Horodatage (ms). */
  time: number;
}
