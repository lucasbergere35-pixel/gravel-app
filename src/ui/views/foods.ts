/**
 * Écran « Mes aliments » : base d'aliments modifiable (glucides par portion),
 * et case « J'emporte » utilisée par le plan nutrition.
 * Chaque modification est enregistrée automatiquement.
 */
import { DEFAULT_FOODS, FOOD_KIND_LABELS, sanitizeFoods, type Food, type FoodKind } from '../../core/nutrition/foods';
import { getFoods, newId, saveFoods } from '../../services/db';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { icon } from '../icons';
import type { View } from '../router';

export const foodsView: View = async (root) => {
  let foods = await getFoods();
  const list = el('div', { class: 'stack' });
  let saveTimer: number | undefined;

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const clean = sanitizeFoods(foods);
      if (!clean) return;
      try {
        await saveFoods(clean);
      } catch (err) {
        toast(`Enregistrement impossible : ${errorMessage(err)}`, 'error');
      }
    }, 400);
  }

  function row(food: Food): HTMLElement {
    const check = el('input', { type: 'checkbox', class: 'switch', checked: food.selected, 'aria-label': `J’emporte : ${food.name}` });
    const name = el('input', { type: 'text', value: food.name, maxlength: 60, 'aria-label': 'Nom' });
    const carbs = el('input', { type: 'number', inputmode: 'decimal', min: 0.5, max: 200, step: 0.5, value: food.carbsG, 'aria-label': 'Glucides par portion (g)' });
    const unit = el('input', { type: 'text', value: food.unit, maxlength: 30, 'aria-label': 'Nom d’une portion' });
    const max = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 20, step: 1, value: food.maxPerIntake, 'aria-label': 'Maximum par prise' });
    const kind = el(
      'select',
      { 'aria-label': 'Type d’aliment' },
      ...(Object.keys(FOOD_KIND_LABELS) as FoodKind[]).map((k) => el('option', { value: k, selected: k === food.kind }, FOOD_KIND_LABELS[k])),
    );
    const del = el('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Supprimer ${food.name}` }, icon('trash'));

    const card = el(
      'div',
      { class: `group food-card${food.selected ? ' selected' : ''}` },
      el('div', { class: 'form-row food-head' }, check, name, del),
      el('label', { class: 'form-row' }, el('span', { class: 'row-label' }, 'Glucides / portion'), carbs, el('span', { class: 'unit' }, 'g')),
      el('label', { class: 'form-row' }, el('span', { class: 'row-label' }, 'Portion'), unit),
      el('label', { class: 'form-row' }, el('span', { class: 'row-label' }, 'Max par prise'), max),
      el('label', { class: 'form-row' }, el('span', { class: 'row-label' }, 'Type'), kind),
    );

    const update = () => {
      food.selected = check.checked;
      food.name = name.value.trim() || food.name;
      const c = Number.parseFloat(carbs.value.replace(',', '.'));
      if (Number.isFinite(c) && c > 0) food.carbsG = c;
      const u = unit.value.trim();
      if (u && u !== food.unit) {
        food.unit = u;
        food.unitPlural = u.endsWith('s') || u.endsWith('x') ? u : `${u}s`;
      }
      const m = Number.parseInt(max.value, 10);
      if (Number.isFinite(m) && m >= 1) food.maxPerIntake = Math.min(20, m);
      food.kind = kind.value === 'rapide' ? 'rapide' : 'lent';
      card.classList.toggle('selected', food.selected);
      scheduleSave();
    };
    for (const input of [check, name, carbs, unit, max, kind]) input.addEventListener('change', update);
    del.addEventListener('click', () => {
      foods = foods.filter((f) => f !== food);
      card.remove();
      scheduleSave();
    });
    return card;
  }

  function render(): void {
    list.replaceChildren(...foods.map(row));
  }

  const addBtn = el('button', { type: 'button', class: 'btn btn-block' }, icon('plus'), 'Ajouter un aliment');
  addBtn.addEventListener('click', () => {
    const f: Food = { id: newId(), name: 'Nouvel aliment', carbsG: 20, unit: 'portion', unitPlural: 'portions', kind: 'lent', selected: true, maxPerIntake: 1 };
    foods.push(f);
    const card = row(f);
    list.append(card);
    card.querySelector<HTMLInputElement>('input[type=text]')?.select();
    scheduleSave();
  });

  const resetBtn = el('button', { type: 'button', class: 'btn btn-block btn-danger' }, 'Revenir à la liste par défaut');
  resetBtn.addEventListener('click', () => {
    if (!resetBtn.classList.contains('confirm')) {
      resetBtn.classList.add('confirm');
      resetBtn.textContent = 'Appuie encore pour confirmer';
      window.setTimeout(() => {
        resetBtn.classList.remove('confirm');
        resetBtn.textContent = 'Revenir à la liste par défaut';
      }, 4000);
      return;
    }
    foods = DEFAULT_FOODS.map((f) => ({ ...f }));
    render();
    scheduleSave();
    resetBtn.classList.remove('confirm');
    resetBtn.textContent = 'Revenir à la liste par défaut';
  });

  render();
  root.append(
    el('h1', {}, 'Mes aliments'),
    el(
      'p',
      { class: 'muted' },
      'Active ce que tu emportes. Type « rapide » : avant ou pendant un effort ; « lent » : sur le roulant. Les glucides par portion sont indicatifs : vérifie l’étiquette. Enregistrement automatique.',
    ),
    list,
    el('div', { class: 'stack actions' }, addBtn, resetBtn),
  );

  return () => {
    // Enregistre immédiatement une modification en attente si on quitte l'écran.
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer);
      const clean = sanitizeFoods(foods);
      if (clean) void saveFoods(clean);
    }
  };
};
