/**
 * Recommandations générales de nutrition sportive (endurance, vélo).
 * ESTIMATIONS GÉNÉRALES, PAS UN AVIS MÉDICAL.
 *
 * Sources :
 *  - Avant l'effort : 1 à 4 g de glucides par kg de poids, 1 à 4 h avant.
 *    Thomas DT, Erdman KA, Burke LM. « Nutrition and Athletic Performance »,
 *    position commune ACSM / Academy of Nutrition and Dietetics / Dietitians
 *    of Canada. Med Sci Sports Exerc. 2016;48(3):543-568.
 *  - Pendant l'effort (selon la durée) : < 1 h 15–1 h 30 : facultatif ;
 *    1–2,5 h : 30–60 g/h ; > 2,5 h : jusqu'à 90 g/h (mélange glucose + fructose,
 *    nécessite un « entraînement de l'intestin »). Ces chiffres visent la
 *    performance ; pour une sortie loisir on retient des objectifs plus bas
 *    (LEVEL_TARGET_RANGES), modifiables par l'utilisateur.
 *    Jeukendrup A. « A step towards personalized sports nutrition: carbohydrate
 *    intake during exercise ». Sports Med. 2014;44(Suppl 1):S25-S33.
 *  - Hydratation : environ 0,4 à 0,8 L/h selon la chaleur et la transpiration,
 *    sans dépasser les pertes. Sawka MN et al. « American College of Sports
 *    Medicine position stand. Exercise and fluid replacement ».
 *    Med Sci Sports Exerc. 2007;39(2):377-390. Ici : 500–750 mL/h.
 */

export type Level = 'debutant' | 'intermediaire' | 'confirme';

export const LEVEL_LABELS: Record<Level, string> = {
  debutant: 'Débutant',
  intermediaire: 'Intermédiaire',
  confirme: 'Confirmé',
};

export interface PreRideAdvice {
  gPerKg: number;
  totalG: number;
  /** Fenêtre conseillée avant le départ (heures). */
  hoursBefore: [number, number];
}

/** Avant la sortie : plus la sortie est longue, plus la recharge est importante. */
export function preRideCarbs(durationS: number, weightKg: number): PreRideAdvice {
  const h = durationS / 3600;
  const gPerKg = h < 1.5 ? 1 : h < 2.5 ? 2 : h < 4 ? 3 : 4;
  return { gPerKg, totalG: Math.round(gPerKg * weightKg), hoursBefore: [2, 4] };
}

/**
 * Objectifs « sortie loisir » par niveau (g/h). Volontairement dans le bas des
 * fourchettes scientifiques (30–60 g/h jusqu'à 2 h 30, 60–90 g/h au-delà, qui
 * visent la performance en compétition) : en balade sportive, l'intensité est
 * plus faible et un intestin non entraîné tolère mal les grosses quantités.
 */
export const LEVEL_TARGET_RANGES: Record<Level, [number, number]> = {
  debutant: [30, 45],
  intermediaire: [40, 60],
  confirme: [60, 80],
};

/** Limites acceptées pour un objectif saisi à la main (g/h). */
export const TARGET_MIN_G_PER_H = 10;
export const TARGET_MAX_G_PER_H = 120;

export interface DuringRideAdvice {
  /** Fourchette par défaut pour le niveau (g/h). */
  rangeGPerH: [number, number];
  /** Objectif retenu (g/h) ; 0 = facultatif (sortie courte). */
  targetGPerH: number;
  /** Objectif calculé automatiquement (g/h), avant un éventuel réglage manuel. */
  autoTargetGPerH: number;
  /** Vrai si l'objectif vient du réglage manuel. */
  manual: boolean;
  optional: boolean;
  /** Hydratation (mL/h) : fourchette et objectif. */
  waterRangeMlPerH: [number, number];
  waterTargetMlPerH: number;
  waterTotalMl: number;
}

/**
 * Pendant la sortie. Moins de 1 h 30 : facultatif. Jusqu'à 2 h 30 : bas de la
 * fourchette du niveau ; au-delà : milieu de la fourchette. Un objectif saisi
 * à la main (manualGPerH) remplace toujours le calcul automatique.
 */
export function duringRideCarbs(durationS: number, level: Level, manualGPerH: number | null = null): DuringRideAdvice {
  const h = durationS / 3600;
  const range = LEVEL_TARGET_RANGES[level];
  const optional = h < 1.5;
  const auto = optional ? 0 : h <= 2.5 ? range[0] : Math.round((range[0] + range[1]) / 2 / 5) * 5;
  const manual = manualGPerH !== null && Number.isFinite(manualGPerH);
  const target = manual ? Math.min(TARGET_MAX_G_PER_H, Math.max(TARGET_MIN_G_PER_H, Math.round(manualGPerH!))) : auto;
  const waterTarget = 600;
  return {
    rangeGPerH: range,
    targetGPerH: target,
    autoTargetGPerH: auto,
    manual,
    optional: optional && !manual,
    waterRangeMlPerH: [500, 750],
    waterTargetMlPerH: waterTarget,
    waterTotalMl: Math.round((waterTarget * h) / 50) * 50,
  };
}

/** Repas avant la sortie : traduction des grammes en exemples d'aliments courants. */
export const PRE_RIDE_FOODS = [
  { name: 'pâtes ou riz cuits', carbsPer100g: 30, share: 0.5, unit: 'g' },
  { name: 'pain', carbsPer100g: 50, share: 0.2, unit: 'g' },
  { name: 'banane', carbsPer100g: 22, share: 0.15, unit: 'g', pieceG: 120 },
  { name: 'miel ou confiture', carbsPer100g: 75, share: 0.15, unit: 'g' },
] as const;

export interface PreRideExample {
  name: string;
  grams: number;
  pieces?: number;
}

/** Exemple de répartition des glucides d'avant-sortie entre aliments courants. */
export function preRideExamples(totalCarbsG: number): PreRideExample[] {
  return PRE_RIDE_FOODS.map((f) => {
    const grams = Math.round(((totalCarbsG * f.share) / f.carbsPer100g) * 100 / 10) * 10;
    const pieces = 'pieceG' in f ? Math.max(1, Math.round(grams / f.pieceG)) : undefined;
    return { name: f.name, grams, pieces };
  });
}
