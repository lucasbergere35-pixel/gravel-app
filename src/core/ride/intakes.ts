/**
 * Suivi des prises pendant la sortie (logique pure, testée).
 *
 * Le plan nutrition est FIGÉ au démarrage (copié dans la sortie) : changer un
 * réglage pendant la sortie ne le modifie pas.
 *
 * Déclenchement d'une prise :
 *  - sur le tracé : selon la position LE LONG DU TRACÉ (recalage), pas selon la
 *    distance parcourue → reste juste en cas de détour ;
 *  - hors tracé (ou sans position recalée) : au temps en mouvement estimé par
 *    le plan, pour ne jamais sauter une prise.
 * Pré-alerte discrète PRE_ALERT_M avant (ou PRE_ALERT_S avant au temps).
 *
 * Pas de bouton pendant la sortie : une prise déclenchée est considérée comme
 * FAITE par défaut. Dans le bilan, on peut décocher celles qui n'ont pas été
 * prises (setTaken).
 *
 * Rappel boisson : toutes les drinkIntervalS de temps en mouvement, jamais
 * dans les DRINK_QUIET_AFTER_INTAKE_S qui suivent une prise. Le rappel est
 * compté dès qu'il est affiché.
 */
import type { NutritionPlan } from '../nutrition/plan';

export const PRE_ALERT_M = 500;
export const PRE_ALERT_S = 90;
export const DRINK_QUIET_AFTER_INTAKE_S = 5 * 60;
export const DEFAULT_DRINK_INTERVAL_S = 20 * 60;

export interface FrozenIntake {
  id: string;
  distanceM: number;
  /** Temps en mouvement estimé (s) au passage de la prise. */
  timeS: number;
  label: string;
  carbsG: number;
  why: string;
  reason: 'preClimb' | 'regular';
}

export interface FrozenPlan {
  intakes: FrozenIntake[];
  targetGPerH: number;
  plannedTotalG: number;
  fuelStartS: number;
  frozenAt: number;
}

/**
 * pending : pas encore atteinte ; done : déclenchée (faite par défaut) ;
 * skipped : décochée dans le bilan (pas prise).
 * (Les sorties enregistrées avec une version précédente peuvent contenir « due » :
 * traité comme « done ».)
 */
export type IntakeStatus = 'pending' | 'done' | 'skipped';

export interface IntakeState {
  id: string;
  status: IntakeStatus | 'due';
  preAlerted: boolean;
  /** Temps en mouvement (s) au déclenchement. */
  dueAtS: number | null;
  /** Champs d'anciennes versions, ignorés. */
  laterCount?: number;
  snoozeUntilM?: number | null;
  snoozeUntilS?: number | null;
  doneAtS?: number | null;
}

export interface RideNutritionState {
  plan: FrozenPlan;
  states: IntakeState[];
  drinkIntervalS: number;
  lastDrinkAtS: number;
  lastIntakeAtS: number | null;
  drinkCount: number;
}

export interface RidePosition {
  /** Distance le long du tracé (m), ou null si inconnue. */
  alongM: number | null;
  /** Vrai si la position est récente et à moins de ~50 m du tracé. */
  onTrack: boolean;
  movingTimeS: number;
}

export type IntakeEvent = { kind: 'pre'; intake: FrozenIntake } | { kind: 'due'; intake: FrozenIntake };

export function freezePlan(plan: NutritionPlan, targetGPerH: number, now = Date.now()): FrozenPlan {
  return {
    intakes: plan.intakes.map((i, k) => ({
      id: `p${k}`,
      distanceM: i.distanceM,
      timeS: i.timeS,
      label: i.label,
      carbsG: i.carbsG,
      why: i.why,
      reason: i.reason,
    })),
    targetGPerH,
    plannedTotalG: plan.plannedTotalG,
    fuelStartS: plan.fuelStartS,
    frozenAt: now,
  };
}

export function emptyPlan(fuelStartS: number, now = Date.now()): FrozenPlan {
  return { intakes: [], targetGPerH: 0, plannedTotalG: 0, fuelStartS, frozenAt: now };
}

export function initNutritionState(plan: FrozenPlan, drinkIntervalS = DEFAULT_DRINK_INTERVAL_S): RideNutritionState {
  return {
    plan,
    states: plan.intakes.map((i) => ({ id: i.id, status: 'pending', preAlerted: false, dueAtS: null })),
    drinkIntervalS,
    lastDrinkAtS: 0,
    lastIntakeAtS: null,
    drinkCount: 0,
  };
}

/** Prise atteinte (déclenchée), qu'elle ait été prise ou non. */
export function isReached(st: IntakeState): boolean {
  return st.status !== 'pending';
}

/** Prise comptée comme prise (faite par défaut, sauf si décochée). */
export function isTaken(st: IntakeState): boolean {
  return st.status === 'done' || st.status === 'due';
}

/** Met à jour les prises selon la position ; retourne les nouvelles pré-alertes et prises déclenchées. */
export function updateIntakes(state: RideNutritionState, pos: RidePosition): IntakeEvent[] {
  const events: IntakeEvent[] = [];
  const useTrack = pos.onTrack && pos.alongM !== null;
  state.plan.intakes.forEach((intake, k) => {
    const st = state.states[k];
    if (st.status !== 'pending') return;
    const reached = useTrack ? pos.alongM! >= intake.distanceM : pos.movingTimeS >= intake.timeS;
    if (reached) {
      st.status = 'done'; // faite par défaut
      st.dueAtS = pos.movingTimeS;
      state.lastIntakeAtS = pos.movingTimeS;
      events.push({ kind: 'due', intake });
    } else if (!st.preAlerted) {
      const near = useTrack ? pos.alongM! >= intake.distanceM - PRE_ALERT_M : pos.movingTimeS >= intake.timeS - PRE_ALERT_S;
      if (near) {
        st.preAlerted = true;
        events.push({ kind: 'pre', intake });
      }
    }
  });
  return events;
}

export interface IntakeBannerText {
  title: string;
  lines: string[];
  /** Prise unique placée avant une montée (l'interface affiche une icône de montagne). */
  preClimb: boolean;
}

/**
 * Texte de la bannière pour une ou plusieurs prises déclenchées ensemble
 * (plusieurs = prises passées pendant que l'écran était éteint).
 */
export function describeIntakes(intakes: readonly FrozenIntake[]): IntakeBannerText {
  const km = (m: number) => Math.round(m / 1000);
  const g = (n: number) => `${Math.round(n)} g`;
  if (intakes.length === 1) {
    const i = intakes[0];
    return { title: `Km ${km(i.distanceM)} : ${i.label}`, lines: [`${i.why} · ${g(i.carbsG)}`], preClimb: i.reason === 'preClimb' };
  }
  const total = intakes.reduce((s, i) => s + i.carbsG, 0);
  return {
    title: `${intakes.length} prises à rattraper`,
    lines: [...intakes.map((i) => `Km ${km(i.distanceM)} : ${i.label} (${g(i.carbsG)})`), `Total ${g(total)}, en une ou deux fois`],
    preClimb: false,
  };
}

/** Prochaine prise annoncée par une pré-alerte (non encore déclenchée). */
export function announcedIntake(state: RideNutritionState): FrozenIntake | null {
  const k = state.states.findIndex((s) => s.status === 'pending' && s.preAlerted);
  return k < 0 ? null : state.plan.intakes[k];
}

/** Bilan : cocher / décocher une prise atteinte (prise ou pas). */
export function setTaken(state: RideNutritionState, id: string, taken: boolean): void {
  const k = state.plan.intakes.findIndex((i) => i.id === id);
  if (k < 0 || !isReached(state.states[k])) return;
  state.states[k].status = taken ? 'done' : 'skipped';
}

/** Rappel boisson à afficher maintenant ? (Pas dans les 5 min qui suivent une prise.) */
export function drinkDue(state: RideNutritionState, movingTimeS: number): boolean {
  if (state.drinkIntervalS <= 0) return false;
  if (movingTimeS - state.lastDrinkAtS < state.drinkIntervalS) return false;
  return state.lastIntakeAtS === null || movingTimeS - state.lastIntakeAtS >= DRINK_QUIET_AFTER_INTAKE_S;
}

/** Le rappel boisson a été affiché : on repart pour un intervalle. */
export function markDrink(state: RideNutritionState, movingTimeS: number): void {
  state.lastDrinkAtS = movingTimeS;
  state.drinkCount++;
}

export interface NutritionSummary {
  /** Prises atteintes et comptées comme prises. */
  taken: number;
  /** Prises atteintes mais décochées. */
  notTaken: number;
  /** Prises non atteintes (sortie arrêtée avant). */
  notReached: number;
  takenG: number;
  /** Glucides prévus jusqu'au point atteint. */
  plannedG: number;
  /** Durée « à couvrir » réellement roulée (h) : temps en mouvement après la 45e minute. */
  fuelHours: number;
  /** g/h réellement pris ; null si la durée couverte est trop courte (< MIN_FUEL_HOURS) pour être parlante. */
  takenGPerH: number | null;
  targetGPerH: number;
  drinks: number;
}

/** En dessous, un g/h n'a pas de sens (ex. 45 g pris en 3 min → 900 g/h). */
export const MIN_FUEL_HOURS = 0.25;

export function summarizeNutrition(state: RideNutritionState, movingTimeS: number): NutritionSummary {
  let taken = 0;
  let notTaken = 0;
  let notReached = 0;
  let takenG = 0;
  let plannedG = 0;
  state.plan.intakes.forEach((intake, k) => {
    const st = state.states[k];
    if (!isReached(st)) {
      notReached++;
      return;
    }
    plannedG += intake.carbsG;
    if (isTaken(st)) {
      taken++;
      takenG += intake.carbsG;
    } else notTaken++;
  });
  const fuelHours = Math.max(0, (movingTimeS - state.plan.fuelStartS) / 3600);
  return {
    taken,
    notTaken,
    notReached,
    takenG,
    plannedG,
    fuelHours,
    takenGPerH: fuelHours >= MIN_FUEL_HOURS ? takenG / fuelHours : null,
    targetGPerH: state.plan.targetGPerH,
    drinks: state.drinkCount,
  };
}
