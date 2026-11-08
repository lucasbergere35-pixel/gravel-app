/**
 * Sources de position : le vrai GPS de l'appareil, ou une simulation (voir simulator.ts).
 * Les deux respectent la même interface, l'écran « sortie » ne fait pas la différence.
 */
import type { GpsFix } from '../core/gps/types';

export interface PositionSource {
  readonly simulated: boolean;
  /** onError(message, fatal) : fatal = le suivi ne peut pas continuer (permission refusée…). */
  start(onFix: (fix: GpsFix) => void, onError: (message: string, fatal: boolean) => void): void;
  stop(): void;
  /** Relance le suivi (au retour au premier plan : iOS peut avoir figé le précédent). */
  restart(): void;
  /** Horloge de référence (ms) : réelle, ou accélérée en simulation. */
  now(): number;
}

export class DeviceGps implements PositionSource {
  readonly simulated = false;
  private watchId: number | null = null;
  private onFix: ((fix: GpsFix) => void) | null = null;
  private onError: ((message: string, fatal: boolean) => void) | null = null;

  start(onFix: (fix: GpsFix) => void, onError: (message: string, fatal: boolean) => void): void {
    this.onFix = onFix;
    this.onError = onError;
    if (!('geolocation' in navigator)) {
      onError('La géolocalisation n’est pas disponible sur cet appareil.', true);
      return;
    }
    this.watch();
  }

  private watch(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.onFix?.({
          lat: c.latitude,
          lon: c.longitude,
          accuracy: c.accuracy,
          altitude: c.altitude ?? null,
          speed: c.speed !== null && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
          time: pos.timestamp || Date.now(),
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          this.onError?.(
            'Localisation refusée. Sur iPhone : Réglages › Confidentialité et sécurité › Service de localisation › Sites web Safari › « Lorsque l’app est active », puis relance la sortie.',
            true,
          );
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          this.onError?.('Position indisponible (pas de signal GPS ?). Nouvelle tentative…', false);
        } else {
          this.onError?.('Le GPS met du temps à répondre…', false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  restart(): void {
    if (this.onFix) this.watch();
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.onFix = null;
    this.onError = null;
  }

  now(): number {
    return Date.now();
  }
}
