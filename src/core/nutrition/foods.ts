/**
 * Base d'aliments transportables pendant la sortie (modifiable par l'utilisateur).
 * Valeurs indicatives de glucides par portion : vérifie l'étiquette de tes produits.
 */
export interface Food {
  id: string;
  name: string;
  /** Glucides par portion (g). */
  carbsG: number;
  /** Nom d'une portion au singulier / pluriel (« barre » / « barres »). */
  unit: string;
  unitPlural: string;
  /** Coché = je l'emporte. */
  selected: boolean;
  /** Nombre maximal de portions par prise (évite « 12 gels d'un coup »). */
  maxPerIntake: number;
}

export const DEFAULT_FOODS: Food[] = [
  { id: 'barre', name: 'Barre de céréales', carbsG: 25, unit: 'barre', unitPlural: 'barres', selected: true, maxPerIntake: 1 },
  { id: 'gel', name: 'Gel énergétique', carbsG: 25, unit: 'gel', unitPlural: 'gels', selected: true, maxPerIntake: 1 },
  { id: 'banane', name: 'Banane', carbsG: 25, unit: 'banane', unitPlural: 'bananes', selected: false, maxPerIntake: 1 },
  { id: 'pate-fruits', name: 'Pâte de fruits', carbsG: 15, unit: 'pâte de fruits', unitPlural: 'pâtes de fruits', selected: false, maxPerIntake: 2 },
  { id: 'dragibus', name: 'Dragibus', carbsG: 2.5, unit: 'Dragibus', unitPlural: 'Dragibus', selected: true, maxPerIntake: 8 },
  { id: 'compote', name: 'Compote à boire (90 g)', carbsG: 13, unit: 'compote', unitPlural: 'compotes', selected: false, maxPerIntake: 1 },
  { id: 'pain-epices', name: 'Pain d’épices (tranche)', carbsG: 17, unit: 'tranche', unitPlural: 'tranches', selected: false, maxPerIntake: 2 },
  { id: 'dattes', name: 'Dattes', carbsG: 5, unit: 'datte', unitPlural: 'dattes', selected: false, maxPerIntake: 4 },
];

/** « 1 barre », « 3 Dragibus », « 2 tranches de pain d'épices » → simple : nombre + unité. */
export function portionLabel(food: Food, count: number): string {
  return `${count} ${count > 1 ? food.unitPlural : food.unit}`;
}

/** Vérifie et nettoie une liste d'aliments (saisie ou import). */
export function sanitizeFoods(raw: unknown): Food[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Food[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
    const carbsG = Number(o.carbsG);
    if (!name || !Number.isFinite(carbsG) || carbsG <= 0 || carbsG > 200) continue;
    const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim().slice(0, 30) : 'portion';
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `f-${out.length}-${name}`,
      name,
      carbsG,
      unit,
      unitPlural: typeof o.unitPlural === 'string' && o.unitPlural.trim() ? o.unitPlural.trim().slice(0, 30) : `${unit}s`,
      selected: o.selected === true,
      maxPerIntake: Math.min(20, Math.max(1, Math.round(Number(o.maxPerIntake) || 1))),
    });
  }
  return out;
}
