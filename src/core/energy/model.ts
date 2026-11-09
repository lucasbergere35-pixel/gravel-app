/**
 * Modèle physique de dépense énergétique sur un itinéraire.
 *
 * Puissance nécessaire au pédalier, sur chaque tronçon de 10 m du profil :
 *
 *   P · η_transmission = ( m·g·Crr·cos θ  +  m·g·sin θ  +  ½·ρ·CdA·v² ) · v
 *                          roulement          pente          air
 *
 * Hypothèse de rythme : PUISSANCE VARIABLE selon la pente, comme un cycliste
 * réel qui « appuie » davantage en côte :
 *   - jusqu'à 2 % : puissance de base P ;
 *   - à partir de 4 % : P × (1 + bonus montée), par défaut +25 % (réglable) ;
 *   - entre 2 et 4 % : transition progressive ;
 *   - en descente : vitesse plafonnée (40 km/h), on cesse alors de pédaler.
 * On cherche P (par dichotomie) pour que la durée totale corresponde à la
 * vitesse moyenne habituelle du profil.
 *
 * Énergie dépensée = travail mécanique / rendement musculaire brut (~24 %).
 * Le rendement « brut » inclut déjà le métabolisme de repos pendant l'effort.
 * On calcule l'énergie cumulée le long du parcours (energyAt) : elle sert à
 * espacer les prises selon l'effort réel, pas selon le temps.
 *
 * Références des paramètres :
 *  - Crr gravel ≈ 0,008–0,012 (pneus 38–45 mm sur chemin roulant) → 0,010
 *  - CdA ≈ 0,40 m² (cintre gravel, mains sur cocottes, vêtements amples),
 *    ajusté à la surface corporelle (formule de Du Bois)
 *  - ρ air = 1,225 kg/m³ au niveau de la mer, décroît avec l'altitude
 *  - rendement de transmission ≈ 97 % ; rendement musculaire brut ≈ 24 %
 *    (Jeukendrup & Martin 2001, Sports Med 31:559 ; Ettema & Lorås 2009)
 */
import type { ElevationProfile } from '../geo/elevation';

export const G = 9.81;
export const CRR_GRAVEL = 0.01;
export const CDA_REF_M2 = 0.4;
/** Surface corporelle de référence pour CDA_REF_M2 (m², adulte ~1,75 m / 70 kg). */
export const BSA_REF_M2 = 1.85;
export const RHO_SEA_LEVEL = 1.225;
export const DRIVETRAIN_EFFICIENCY = 0.97;
export const MUSCLE_EFFICIENCY = 0.24;
/** Vitesse max en descente sur gravel (m/s) : prudence sur chemin. */
export const MAX_DESCENT_SPEED_MS = 40 / 3.6;
export const J_PER_KCAL = 4184;
/** Bonus de puissance en montée par défaut (+25 %). */
export const CLIMB_BOOST_DEFAULT = 0.25;
/** Pente à partir de laquelle le bonus s'applique entièrement / commence. */
export const CLIMB_BOOST_FULL_GRADE = 0.04;
export const CLIMB_BOOST_START_GRADE = 0.02;

export interface EnergyInput {
  riderKg: number;
  bikeKg: number;
  heightCm: number;
  avgSpeedKmh: number;
  /** Bonus de puissance en montée (0,25 = +25 %). */
  climbBoost?: number;
}

export interface EnergyResult {
  massKg: number;
  cdaM2: number;
  crr: number;
  rhoKgM3: number;
  climbBoost: number;
  /** Puissance de base, sur le plat (W). */
  powerFlatW: number;
  /** Puissance en montée > 4 % (W). */
  powerClimbW: number;
  /** Puissance moyenne réellement fournie (W), descentes en roue libre comprises. */
  powerAvgW: number;
  durationS: number;
  mechanicalKJ: number;
  metabolicKcal: number;
  /** Temps cumulé (s) à chaque échantillon du profil. */
  timeAt: number[];
  /** Énergie métabolique cumulée (kcal) à chaque échantillon du profil. */
  energyAt: number[];
}

/** Surface corporelle (Du Bois & Du Bois, 1916), m². */
export function bodySurfaceArea(weightKg: number, heightCm: number): number {
  return 0.007184 * weightKg ** 0.425 * heightCm ** 0.725;
}

/** Densité de l'air (kg/m³) selon l'altitude (atmosphère standard simplifiée). */
export function airDensity(altitudeM: number): number {
  return RHO_SEA_LEVEL * Math.exp(-Math.max(0, altitudeM) / 8500);
}

/** Multiplicateur de puissance selon la pente (tan θ = grade). */
export function powerFactor(grade: number, boost: number): number {
  if (grade <= CLIMB_BOOST_START_GRADE) return 1;
  if (grade >= CLIMB_BOOST_FULL_GRADE) return 1 + boost;
  return 1 + (boost * (grade - CLIMB_BOOST_START_GRADE)) / (CLIMB_BOOST_FULL_GRADE - CLIMB_BOOST_START_GRADE);
}

/** Force résistante hors air (N) pour une pente donnée. */
function gravityRolling(massKg: number, grade: number, crr: number): number {
  const theta = Math.atan(grade);
  return massKg * G * (crr * Math.cos(theta) + Math.sin(theta));
}

/**
 * Vitesse (m/s) atteinte avec une puissance au pédalier donnée, sur une pente.
 * Résout k·v³ + F·v = P·η par dichotomie (fonction croissante au-delà de son minimum).
 */
export function speedForPower(powerW: number, grade: number, massKg: number, cdaM2: number, rho: number, crr = CRR_GRAVEL): number {
  const k = 0.5 * rho * cdaM2;
  const F = gravityRolling(massKg, grade, crr);
  const target = powerW * DRIVETRAIN_EFFICIENCY;
  const f = (v: number) => k * v * v * v + F * v;
  let lo = F < 0 ? Math.sqrt(-F / (3 * k)) : 0; // minimum de f si la pente aide
  let hi = 30;
  if (f(hi) < target) return hi;
  if (f(lo) >= target) return Math.min(lo, MAX_DESCENT_SPEED_MS);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return Math.min((lo + hi) / 2, MAX_DESCENT_SPEED_MS);
}

/** Puissance au pédalier (W) nécessaire à une vitesse donnée, ≥ 0 (pas de puissance négative). */
export function powerForSpeed(v: number, grade: number, massKg: number, cdaM2: number, rho: number, crr = CRR_GRAVEL): number {
  const p = (0.5 * rho * cdaM2 * v * v + gravityRolling(massKg, grade, crr)) * v;
  return Math.max(0, p / DRIVETRAIN_EFFICIENCY);
}

interface RideSim {
  time: number;
  work: number;
  timeAt: number[];
  workAt: number[];
}

/** Simule le parcours avec une puissance de base donnée (variable selon la pente). */
function ride(profile: ElevationProfile, baseW: number, boost: number, massKg: number, cdaM2: number, rhos: number[], crr: number): RideSim {
  const { distances: d, elevations: e } = profile;
  let time = 0;
  let work = 0;
  const timeAt = new Array<number>(d.length);
  const workAt = new Array<number>(d.length);
  timeAt[0] = 0;
  workAt[0] = 0;
  for (let i = 1; i < d.length; i++) {
    const len = d[i] - d[i - 1];
    if (len > 0) {
      const grade = (e[i] - e[i - 1]) / len;
      const target = baseW * powerFactor(grade, boost);
      const v = speedForPower(target, grade, massKg, cdaM2, rhos[i], crr);
      const dt = len / v;
      // Puissance réellement fournie : la cible, sauf si la vitesse est plafonnée (descente).
      const p = Math.min(target, powerForSpeed(v, grade, massKg, cdaM2, rhos[i], crr));
      time += dt;
      work += p * dt;
    }
    timeAt[i] = time;
    workAt[i] = work;
  }
  return { time, work, timeAt, workAt };
}

export function estimateEnergy(profile: ElevationProfile, input: EnergyInput, crr = CRR_GRAVEL): EnergyResult {
  const boost = Math.max(0, input.climbBoost ?? CLIMB_BOOST_DEFAULT);
  const massKg = input.riderKg + input.bikeKg;
  const cdaM2 = CDA_REF_M2 * (bodySurfaceArea(input.riderKg, input.heightCm) / BSA_REF_M2);
  const rhos = profile.elevations.map(airDensity);
  const total = profile.distances[profile.distances.length - 1] ?? 0;
  const targetTime = total / (input.avgSpeedKmh / 3.6);

  // Dichotomie sur la puissance de base : plus de puissance → durée plus courte.
  let lo = 5;
  let hi = 1500;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ride(profile, mid, boost, massKg, cdaM2, rhos, crr).time > targetTime) lo = mid;
    else hi = mid;
  }
  const baseW = (lo + hi) / 2;
  const r = ride(profile, baseW, boost, massKg, cdaM2, rhos, crr);
  const rhoMean = rhos.reduce((a, b) => a + b, 0) / Math.max(1, rhos.length);
  const toKcal = (joules: number) => joules / MUSCLE_EFFICIENCY / J_PER_KCAL;
  return {
    massKg,
    cdaM2,
    crr,
    rhoKgM3: rhoMean,
    climbBoost: boost,
    powerFlatW: baseW,
    powerClimbW: baseW * (1 + boost),
    powerAvgW: r.time > 0 ? r.work / r.time : 0,
    durationS: r.time,
    mechanicalKJ: r.work / 1000,
    metabolicKcal: toKcal(r.work),
    timeAt: r.timeAt,
    energyAt: r.workAt.map(toKcal),
  };
}

/** Valeur d'une série cumulée (temps, énergie…) à une distance donnée, par interpolation. */
export function seriesAtDistance(profile: ElevationProfile, series: readonly number[], alongM: number): number {
  const n = series.length;
  if (n === 0) return 0;
  if (n === 1) return series[0];
  const i = Math.min(n - 2, Math.max(0, Math.floor(alongM / profile.step)));
  const d0 = profile.distances[i];
  const d1 = profile.distances[i + 1];
  const t = d1 > d0 ? Math.min(1, Math.max(0, (alongM - d0) / (d1 - d0))) : 0;
  return series[i] + (series[i + 1] - series[i]) * t;
}

/** Distance (m) où une série cumulée croissante atteint une valeur (inverse de seriesAtDistance). */
export function distanceAtSeries(profile: ElevationProfile, series: readonly number[], value: number): number {
  const n = series.length;
  if (n === 0) return 0;
  if (value <= series[0]) return 0;
  if (value >= series[n - 1]) return profile.distances[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid] <= value) lo = mid;
    else hi = mid;
  }
  const span = series[hi] - series[lo];
  const t = span > 0 ? (value - series[lo]) / span : 0;
  return profile.distances[lo] + (profile.distances[hi] - profile.distances[lo]) * t;
}

/** Temps (s) au passage d'une distance donnée. */
export function timeAtDistance(profile: ElevationProfile, timeAt: readonly number[], alongM: number): number {
  return seriesAtDistance(profile, timeAt, alongM);
}

/** Distance (m) atteinte à un temps donné. */
export function distanceAtTime(profile: ElevationProfile, timeAt: readonly number[], timeS: number): number {
  return distanceAtSeries(profile, timeAt, timeS);
}
