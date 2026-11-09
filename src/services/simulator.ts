/**
 * Simulation GPS : rejoue un itinéraire comme si on roulait, pour tester le mode
 * sortie sur PC ou sur l'iPhone sans pédaler. Le temps peut être accéléré.
 *
 * Scénario volontairement « difficile », pour vérifier chaque protection :
 *  - bruit de ±3 m sur chaque position ;
 *  - une position sur 15 très imprécise (±60 m) → doit être ignorée ;
 *  - arrêt de 45 s au km 1 → pause auto (le temps en mouvement s'arrête) ;
 *  - écart de 80 m entre km 2 et km 2,4 → alerte « hors tracé » ;
 *  - aucune position entre km 3 et km 3,5 → simule un écran éteint (trou).
 * La vitesse varie un peu autour de la vitesse choisie.
 */
import { pointAtDistance } from '../core/geo/track';
import { elevationAt } from '../core/geo/climbs';
import type { ElevationProfile } from '../core/geo/elevation';
import type { GpsFix } from '../core/gps/types';
import type { TrackPoint } from '../core/types';
import type { PositionSource } from './geolocation';

const M_PER_DEG = 111_195;

export interface SimulationOptions {
  speedKmh: number;
  /** Facteur d'accélération du temps (10 = 10 s simulées par seconde réelle). */
  timeFactor: number;
  /** Profil de l'itinéraire : fournit une altitude GPS simulée (± 2 m de bruit). */
  elevation?: ElevationProfile | null;
}

export class SimulatedGps implements PositionSource {
  readonly simulated = true;
  private timer: number | null = null;
  private simTime = Date.now();
  private along = 0;
  private tick = 0;
  private stopLeftS = 0;
  private stopDone = false;
  private onFix: ((fix: GpsFix) => void) | null = null;

  constructor(
    private readonly points: readonly TrackPoint[],
    private readonly cum: readonly number[],
    private readonly options: SimulationOptions,
  ) {}

  start(onFix: (fix: GpsFix) => void): void {
    this.onFix = onFix;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.step(), 1000 / this.options.timeFactor);
  }

  private step(): void {
    this.simTime += 1000;
    this.tick++;
    const total = this.cum[this.cum.length - 1] ?? 0;

    let speed = 0;
    if (!this.stopDone && this.along >= 1000) {
      this.stopDone = true;
      this.stopLeftS = 45;
    }
    if (this.stopLeftS > 0) {
      this.stopLeftS--;
    } else if (this.along < total) {
      speed = (this.options.speedKmh / 3.6) * (0.85 + 0.3 * Math.abs(Math.sin(this.tick / 40)));
      this.along = Math.min(total, this.along + speed);
    }

    if (this.along > 3000 && this.along < 3500) return; // trou : « écran éteint »

    const p = pointAtDistance(this.points, this.cum, this.along);
    if (!p) return;
    const cosLat = Math.cos((p.lat * Math.PI) / 180);
    let north = (Math.random() - 0.5) * 6;
    let east = (Math.random() - 0.5) * 6;
    if (this.along > 2000 && this.along < 2400) east += 80;
    const bad = this.tick % 15 === 0;
    if (bad) north += 60;

    this.onFix?.({
      lat: p.lat + north / M_PER_DEG,
      lon: p.lon + east / (M_PER_DEG * cosLat),
      accuracy: bad ? 60 : 5 + Math.random() * 4,
      altitude: this.options.elevation ? elevationAt(this.options.elevation, this.along) + (Math.random() - 0.5) * 4 : null,
      speed,
      time: this.simTime,
    });
  }

  restart(): void {
    if (this.onFix) this.schedule();
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.onFix = null;
  }

  now(): number {
    return this.simTime;
  }
}
