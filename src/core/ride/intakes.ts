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
 * « Plus tard » : nouveau rappel SNOOZE_M plus loin (ou SNOOZE_S hors tracé).
 * Une prise déclenchée reste « due » tant qu'elle n'est pas traitée.
 *
 * Rappel boisson : toutes les drinkIntervalS de temps en mouvement, jamais
 * dans les DRINK_QUIET_AFTER_INTAKE_S qui suivent une prise, ni pendant
 * qu'une prise est affichée.
 */
import type { NutritionPlan } from '../nutrition/plan';

export const PRE_ALERT_M = 500;
export const PRE_ALERT_S = 90;
export const SNOOZE_M = 1000;
export const SNOOZE_S = 4 * 60;
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

export type IntakeStatus = 'pending' | 'due' | 'done' | 'skipped';

export interface IntakeState {
  id: string;
  status: IntakeStatus;
  preAlerted: boolean;
  snoozeUntilM: number | null;
  snoozeUntilS: number | null;
  laterCount: number;
  dueAtS: number | null;
  doneAtS: number | null;
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

export function initNutritionState(plan: FrozenPlan, drinkIntervalS = DEFAULT_DRINK_INTERVAL_S): RideNutritionState {
  return {
    plan,
    states: plan.intakes.map((i) => ({
      id: i.id,
      status: 'pending',
      preAlerted: false,
      snoozeUntilM: null,
      snoozeUntilS: null,
      laterCount: 0,
      dueAtS: null,
      doneAtS: null,
    })),
    drinkIntervalS,
    lastDrinkAtS: 0,
    lastIntakeAtS: null,
    drinkCount: 0,
  };
}

function find(state: RideNutritionState, id: string): { intake: FrozenIntake; st: IntakeState } | null {
  const k = state.plan.intakes.findIndex((i) => i.id === id);
  return k < 0 ? null : { intake: state.plan.intakes[k], st: state.states[k] };
}

/** Met à jour les prises selon la position ; retourne les nouvelles pré-alertes et alertes. */
export function updateIntakes(state: RideNutritionState, pos: RidePosition): IntakeEvent[] {
  const events: IntakeEvent[] = [];
  const useTrack = pos.onTrack && pos.alongM !== null;
  state.plan.intakes.forEach((intake, k) => {
    const st = state.states[k];
    if (st.status !== 'pending') return;
    const snoozed = st.snoozeUntilM !== null || st.snoozeUntilS !== null;
    const triggerM = snoozed && st.snoozeUntilM !== null ? st.snoozeUntilM : intake.distanceM;
    const triggerS = snoozed && st.snoozeUntilS !== null ? st.snoozeUntilS : intake.timeS;
    const reached = useTrack ? pos.alongM! >= triggerM : pos.movingTimeS >= triggerS;
    if (reached) {
      st.status = 'due';
      st.dueAtS = pos.movingTimeS;
      state.lastIntakeAtS = pos.movingTimeS;
      events.push({ kind: 'due', intake });
    } else if (!st.preAlerted && !snoozed) {
      const near = useTrack ? pos.alongM! >= triggerM - PRE_ALERT_M : pos.movingTimeS >= triggerS - PRE_ALERT_S;
      if (near) {
        st.preAlerted = true;
        events.push({ kind: 'pre', intake });
      }
    }
  });
  return events;
}

/** Prise à afficher (la plus ancienne déclenchée et non traitée). */
export function activeIntake(state: RideNutritionState): FrozenIntake | null {
  const k = state.states.findIndex((s) => s.status === 'due');
  return k < 0 ? null : state.plan.intakes[k];
}

/** Prochaine prise annoncée par une pré-alerte (non encore déclenchée). */
export function announcedIntake(state: RideNutritionState): FrozenIntake | null {
  const k = state.states.findIndex((s) => s.status === 'pending' && s.preAlerted && s.snoozeUntilM === null && s.snoozeUntilS === null);
  return k < 0 ? null : state.plan.intakes[k];
}

export function markDone(state: RideNutritionState, id: string, movingTimeS: number): void {
  const f = find(state, id);
  if (!f) return;
  f.st.status = 'done';
  f.st.doneAtS = movingTimeS;
  state.lastIntakeAtS = movingTimeS;
}

export function markSkipped(state: RideNutritionState, id: string): void {
  const f = find(state, id);
  if (f) f.st.status = 'skipped';
}

/** « Plus tard » : nouveau rappel 1 km plus loin sur le tracé (ou 4 min hors tracé). */
export function markLater(state: RideNutritionState, id: string, pos: RidePosition): void {
  const f = find(state, id);
  if (!f) return;
  f.st.status = 'pending';
  f.st.laterCount++;
  f.st.preAlerted = true;
  f.st.snoozeUntilM = Math.max(pos.alongM ?? f.intake.distanceM, f.intake.distanceM) + SNOOZE_M;
  f.st.snoozeUntilS = pos.movingTimeS + SNOOZE_S;
}

export function drinkDue(state: RideNutritionState, movingTimeS: number): boolean {
  if (state.drinkIntervalS <= 0) return false;
  if (activeIntake(state)) return false;
  if (movingTimeS - state.lastDrinkAtS < state.drinkIntervalS) return false;
  return state.lastIntakeAtS === null || movingTimeS - state.lastIntakeAtS >= DRINK_QUIET_AFTER_INTAKE_S;
}

export function markDrink(state: RideNutritionState, movingTimeS: number): void {
  state.lastDrinkAtS = movingTimeS;
  state.drinkCount++;
}

export interface NutritionSummary {
  done: number;
  /** Prises repoussées au moins une fois (« Plus tard »). */
  postponed: number;
  skipped: number;
  /** Prises atteintes mais jamais traitées. */
  missed: number;
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
  let done = 0;
  let postponed = 0;
  let skipped = 0;
  let missed = 0;
  let notReached = 0;
  let takenG = 0;
  let plannedG = 0;
  state.plan.intakes.forEach((intake, k) => {
    const st = state.states[k];
    if (st.laterCount > 0) postponed++;
    const reached = st.status !== 'pending' || st.laterCount > 0;
    if (reached) plannedG += intake.carbsG;
    if (st.status === 'done') {
      done++;
      takenG += intake.carbsG;
    } else if (st.status === 'skipped') skipped++;
    else if (st.status === 'due' || st.laterCount > 0) missed++;
    else notReached++;
  });
  const fuelHours = Math.max(0, (movingTimeS - state.plan.fuelStartS) / 3600);
  return {
    done,
    postponed,
    skipped,
    missed,
    notReached,
    takenG,
    plannedG,
    fuelHours,
    takenGPerH: fuelHours >= MIN_FUEL_HOURS ? takenG / fuelHours : null,
    targetGPerH: state.plan.targetGPerH,
    drinks: state.drinkCount,
  };
}
