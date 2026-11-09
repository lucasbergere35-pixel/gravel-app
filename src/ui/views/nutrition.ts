/**
 * Écran « Plan nutrition » d'un itinéraire :
 * réglages (objectif g/h, effort en montée), dépense énergétique (modèle
 * physique détaillé), glucides avant / pendant, hydratation, aliments emportés
 * et prises réparties par km avec leur raison.
 */
import { CLIMB_BOOST_FULL_GRADE, DRIVETRAIN_EFFICIENCY, MUSCLE_EFFICIENCY, type EnergyResult } from '../../core/energy/model';
import { FOOD_KIND_LABELS, type Food } from '../../core/nutrition/foods';
import { FIRST_INTAKE_S, isBigClimb } from '../../core/nutrition/plan';
import { computeEnergy, computePlan, prepareRoute } from '../../core/nutrition/routePlan';
import {
  duringRideCarbs,
  LEVEL_LABELS,
  preRideCarbs,
  preRideExamples,
  TARGET_MAX_G_PER_H,
  TARGET_MIN_G_PER_H,
} from '../../core/nutrition/recommendations';
import { getFoods, getNutritionPrefs, getProfile, getRoute, saveFoods, saveNutritionPrefs } from '../../services/db';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { duration, int, km } from '../format';
import { describeHelp } from '../help';
import { icon } from '../icons';
import { navigate, type View } from '../router';

const BOTTLE_ML = 750;
const BOOST_CHOICES = [0, 10, 15, 20, 25, 30, 40];
const fr = (n: number, digits = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });

/** Vide un élément puis le remplit (les null sont ignorés). */
function fill(node: HTMLElement, ...children: Parameters<typeof append>[1][]): void {
  node.replaceChildren();
  append(node, ...children);
}

function row(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, el('span', {}, label), el('strong', {}, value));
}

export const nutritionView: View = async (root, params) => {
  const [data, profile, foods, prefs] = await Promise.all([getRoute(params.id), getProfile(), getFoods(), getNutritionPrefs()]);
  if (!data) {
    toast('Itinéraire introuvable', 'error');
    navigate('/');
    return;
  }
  const { meta: route, track } = data;
  const prepared = prepareRoute(track.points);
  const { cum, realProfile } = prepared;
  const bigClimbs = prepared.climbs.filter(isBigClimb).length;
  let energy: EnergyResult = computeEnergy(prepared, profile, prefs);

  const settingsCard = el('section', {});
  const energyCard = el('section', { class: 'card' });
  const preCard = el('section', { class: 'card' });
  const duringCard = el('section', { class: 'card' });
  const packCard = el('section', { class: 'card' });
  const planCard = el('section', { class: 'card' });

  async function persistPrefs(): Promise<void> {
    try {
      await saveNutritionPrefs(prefs);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---------- Réglages ----------
  function renderSettings(): void {
    const during = duringRideCarbs(energy.durationS, profile.level, prefs.targetGPerH);
    const target = el('input', {
      type: 'number',
      id: 'target-gph',
      inputmode: 'numeric',
      min: TARGET_MIN_G_PER_H,
      max: TARGET_MAX_G_PER_H,
      step: 5,
      value: prefs.targetGPerH ?? '',
      placeholder: `auto (${during.autoTargetGPerH || '—'})`,
      'aria-label': 'Objectif de glucides en grammes par heure',
    });
    target.addEventListener('change', () => {
      const v = Number.parseFloat(target.value.replace(',', '.'));
      if (target.value.trim() === '') prefs.targetGPerH = null;
      else if (!Number.isFinite(v) || v < TARGET_MIN_G_PER_H || v > TARGET_MAX_G_PER_H) {
        toast(`Indique un objectif entre ${TARGET_MIN_G_PER_H} et ${TARGET_MAX_G_PER_H} g/h (ou laisse vide pour « auto »).`, 'error');
        return;
      } else prefs.targetGPerH = Math.round(v);
      void persistPrefs();
      renderAll();
    });
    const autoBtn = el('button', { type: 'button', class: 'btn btn-small', hidden: prefs.targetGPerH === null }, 'Auto');
    autoBtn.addEventListener('click', () => {
      prefs.targetGPerH = null;
      void persistPrefs();
      renderAll();
    });
    const boost = el(
      'select',
      { id: 'climb-boost', 'aria-label': 'Effort en montée' },
      ...BOOST_CHOICES.map((b) => el('option', { value: b, selected: b === prefs.climbBoostPct }, b === 0 ? 'Aucun' : `+${b} %`)),
    );
    boost.addEventListener('change', () => {
      prefs.climbBoostPct = Number(boost.value);
      void persistPrefs();
      energy = computeEnergy(prepared, profile, prefs);
      renderAll();
    });

    settingsCard.replaceChildren(
      el('div', { class: 'group-title' }, 'Réglages du plan'),
      el(
        'div',
        { class: 'group' },
        el('label', { class: 'form-row', for: 'target-gph' }, el('span', { class: 'row-label' }, icon('zap'), 'Glucides'), autoBtn, target, el('span', { class: 'unit' }, 'g/h')),
        el(
          'label',
          { class: 'form-row', for: 'climb-boost' },
          el('span', { class: 'row-label' }, icon('trending-up'), `Effort > ${int(CLIMB_BOOST_FULL_GRADE * 100)} %`),
          boost,
        ),
      ),
      el(
        'p',
        { class: 'group-footer' },
        prefs.targetGPerH === null
          ? `Automatique : ${during.autoTargetGPerH ? `${during.autoTargetGPerH} g/h` : 'facultatif (sortie < 1 h 30)'} pour le niveau ${LEVEL_LABELS[profile.level].toLowerCase()} (fourchette ${during.rangeGPerH[0]}–${during.rangeGPerH[1]} g/h).`
          : `Réglé à la main. Valeur automatique : ${during.autoTargetGPerH || 'facultatif'} g/h.`,
      ),
      el('p', { class: 'group-footer' }, 'Effort en montée : de combien tu appuies plus fort en côte qu’à plat. Ta vitesse moyenne totale reste la même.'),
    );
  }

  // ---------- Dépense ----------
  function renderEnergy(): void {
    fill(energyCard,
      el('h2', {}, icon('zap'), 'Dépense estimée'),
      el('div', { class: 'big-figure' }, `≈ ${int(Math.round(energy.metabolicKcal / 10) * 10)} kcal`),
      el(
        'p',
        {},
        `Durée ${duration(energy.durationS)} à ${fr(profile.avgSpeedKmh)} km/h de moyenne. Puissance ≈ ${int(energy.powerFlatW)} W à plat`,
        energy.climbBoost > 0 ? `, ${int(energy.powerClimbW)} W en montée` : '',
        ` (moyenne ${int(energy.powerAvgW)} W, descentes en roue libre comprises).`,
      ),
      realProfile ? null : el('p', { class: 'muted' }, 'Ce GPX n’a pas d’altitude : calcul fait comme si le parcours était plat.'),
      el(
        'details',
        { class: 'calc-details' },
        el('summary', {}, 'Détail du calcul'),
        el('p', {}, 'Sur chaque tronçon de 10 m, la puissance au pédalier vaut :'),
        el('p', { class: 'formula' }, 'P × ηtrans = (m·g·Crr·cos θ + m·g·sin θ + ½·ρ·CdA·v²) × v'),
        el(
          'p',
          {},
          `La puissance varie avec la pente : P à plat (jusqu’à 2 %), P × ${fr(1 + energy.climbBoost, 2)} au-delà de 4 %, transition progressive entre les deux. En descente, la vitesse est plafonnée à 40 km/h et l’on cesse de pédaler. On cherche P pour que la durée totale corresponde à ta vitesse moyenne.`,
        ),
        row('Masse totale m (toi + vélo équipé)', `${fr(energy.massKg)} kg`),
        row('Résistance au roulement Crr (gravel)', fr(energy.crr, 3)),
        row('Traînée CdA (ajustée à ta taille et ton poids)', `${fr(energy.cdaM2, 2)} m²`),
        row('Densité de l’air ρ (selon l’altitude)', `${fr(energy.rhoKgM3, 2)} kg/m³`),
        row('Rendement de transmission ηtrans', `${int(DRIVETRAIN_EFFICIENCY * 100)} %`),
        row('Puissance à plat', `${int(energy.powerFlatW)} W`),
        row(`Puissance en montée (+${int(energy.climbBoost * 100)} %)`, `${int(energy.powerClimbW)} W`),
        row('Puissance moyenne', `${int(energy.powerAvgW)} W`),
        row('Travail mécanique', `${int(energy.mechanicalKJ)} kJ`),
        row('Rendement musculaire', `${int(MUSCLE_EFFICIENCY * 100)} %`),
        row('Énergie dépensée = travail ÷ rendement', `${int(energy.metabolicKcal)} kcal`),
        el('h3', {}, 'Placement des prises'),
        el(
          'p',
          {},
          `Les ${int(FIRST_INTAKE_S / 60)} premières minutes sont couvertes par le repas d’avant. Ensuite, quantité totale = objectif g/h × durée restante. Les prises sont espacées selon l’énergie dépensée (plus rapprochées quand ça grimpe), environ une portion principale par prise. Avant chaque montée importante (> 50 m de D+, ou > 1 km à plus de 4 %), une prise rapide 10–20 min avant le pied. Portions arrondies vers le bas.`,
        ),
        el('p', { class: 'muted' }, 'Le vent, l’état du chemin, les arrêts et ta forme du jour peuvent faire varier ces chiffres de ±20 % ou plus.'),
      ),
    );
  }

  // ---------- Avant / pendant ----------
  function renderPreAndDuring(): void {
    const pre = preRideCarbs(energy.durationS, profile.weightKg);
    const during = duringRideCarbs(energy.durationS, profile.level, prefs.targetGPerH);
    preCard.replaceChildren(
      el('h2', {}, icon('clock'), 'Avant la sortie'),
      el('p', {}, el('strong', {}, `${pre.totalG} g de glucides`), ` (${pre.gPerKg} g/kg), ${pre.hoursBefore[0]} à ${pre.hoursBefore[1]} h avant le départ.`),
      el('p', { class: 'muted' }, 'Par exemple, au total :'),
      el(
        'ul',
        { class: 'plain-list' },
        ...preRideExamples(pre.totalG).map((x) => el('li', {}, x.pieces ? `${x.pieces} ${x.name}${x.pieces > 1 ? 's' : ''} (≈ ${x.grams} g)` : `≈ ${x.grams} g de ${x.name}`)),
      ),
      el('p', { class: 'muted' }, 'Ce repas couvre aussi les premières 45 minutes de la sortie.'),
    );
    const bottles = Math.ceil(during.waterTotalMl / BOTTLE_ML);
    duringCard.replaceChildren(
      el('h2', {}, icon('droplet'), 'Pendant la sortie'),
      during.optional
        ? el('p', {}, el('strong', {}, 'Glucides facultatifs'), ' : sortie de moins de 1 h 30. Emporte quand même un en-cas de secours.')
        : el('p', {}, el('strong', {}, `${during.targetGPerH} g de glucides par heure`), ` à partir de la ${int(FIRST_INTAKE_S / 60)}e minute.`),
      el(
        'p',
        {},
        el('strong', {}, `Boire ${during.waterRangeMlPerH[0]}–${during.waterRangeMlPerH[1]} mL par heure`),
        ` : environ ${fr(during.waterTotalMl / 1000)} L sur la sortie (${bottles} bidon${bottles > 1 ? 's' : ''} de 750 mL, ou des points d’eau). Plus s’il fait chaud.`,
      ),
    );
  }

  // ---------- J'emporte + plan ----------
  function renderPlan(): void {
    // Même calcul que celui figé au démarrage d'une sortie.
    const { during, plan } = computePlan(prepared, energy, profile, prefs, foods);

    fill(packCard,
      el('h2', {}, icon('utensils'), 'J’emporte'),
      el(
        'div',
        { class: 'pack-list' },
        ...foods.map((f: Food) => {
          const box = el('input', { type: 'checkbox', checked: f.selected });
          box.addEventListener('change', async () => {
            f.selected = box.checked;
            renderPlan();
            try {
              await saveFoods(foods);
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          });
          return el(
            'label',
            { class: 'pack-item' },
            box,
            el('span', {}, f.name, el('span', { class: `kind-tag kind-${f.kind}` }, FOOD_KIND_LABELS[f.kind])),
            el('span', { class: 'muted' }, `${fr(f.carbsG)} g`),
          );
        }),
      ),
      foods.some((f) => f.selected && f.kind === 'rapide') || bigClimbs === 0
        ? null
        : el('p', { class: 'notice-inline' }, icon('warning'), 'Aucun aliment rapide coché : les prises avant les montées utiliseront ce que tu as.'),
      el('a', { href: '#/aliments', class: 'btn btn-small' }, icon('pencil'), 'Modifier mes aliments'),
    );

    if (plan.emptyReason) {
      planCard.replaceChildren(el('h2', {}, icon('flag'), 'Plan des prises'), el('p', {}, plan.emptyReason));
      return;
    }
    const intervalMin = Math.round((plan.fuelHours * 60) / Math.max(1, plan.intakes.length));
    const overshoot = plan.plannedTotalG > plan.targetTotalG * 1.1;
    planCard.replaceChildren();
    append(
      planCard,
      el('h2', {}, icon('flag'), 'Plan des prises'),
      el(
        'div',
        { class: `plan-summary${overshoot ? ' warn' : ''}` },
        el('div', { class: 'plan-total' }, `${plan.plannedTotalG} g de glucides prévus`),
        el(
          'div',
          {},
          `soit ${int(plan.plannedGPerH)} g/h réels pendant ${duration(plan.fuelHours * 3600)} (de la ${int(plan.fuelStartS / 60)}e minute à l’arrivée)`,
        ),
        el('div', { class: 'muted' }, `Objectif ${during.targetGPerH} g/h → ${plan.targetTotalG} g · ${plan.intakes.length} prises, environ toutes les ${intervalMin} min en moyenne`),
      ),
    );
    append(
      planCard,
      el(
        'ol',
        { class: 'timeline' },
        ...plan.intakes.map((i) =>
          el(
            'li',
            { class: `tl-item${i.reason === 'preClimb' ? ' pre-climb' : ''}${i.onSlope ? ' on-slope' : ''}` },
            el('div', { class: 'tl-km' }, 'km', el('br'), int(i.distanceM / 1000)),
            el('div', { class: 'tl-dot' }),
            el(
              'div',
              { class: 'tl-body' },
              el('div', { class: 'tl-what' }, i.label, el('span', { class: 'muted' }, ` · ${fr(i.carbsG)} g`)),
              el('div', { class: 'tl-why' }, i.reason === 'preClimb' ? icon('mountain') : null, i.why),
              el('div', { class: 'tl-when' }, `vers ${duration(i.timeS)}`),
              i.onSlope ? el('div', { class: 'notice-inline tl-when' }, icon('warning'), 'En pente : attends le replat') : null,
            ),
          ),
        ),
      ),
      el('h3', {}, 'À emporter'),
      el('ul', { class: 'plain-list' }, ...plan.packing.map((p) => el('li', {}, p.label))),
      el('p', { class: 'muted' }, 'Ajoute une petite marge (une barre ou un gel de plus) en cas d’imprévu.'),
    );
  }

  function renderAll(): void {
    renderSettings();
    renderEnergy();
    renderPreAndDuring();
    renderPlan();
  }
  renderAll();

  append(
    root,
    el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'back-link' }, icon('chevron-left'), route.name),
    el('h1', {}, 'Plan nutrition'),
    el(
      'div',
      { class: 'chips' },
      el('span', { class: 'chip' }, icon('route'), `${km(cum[cum.length - 1] ?? 0)} km`),
      el('span', { class: 'chip' }, icon('trending-up'), `${int(route.stats.gainM)} m`),
      el('span', { class: 'chip' }, icon('mountain'), `${bigClimbs} montée${bigClimbs > 1 ? 's' : ''} importante${bigClimbs > 1 ? 's' : ''}`),
    ),
    profile.complete ? null : el('div', { class: 'card notice' }, icon('warning'), el('div', {}, 'Profil incomplet : calcul fait avec des valeurs par défaut (70 kg…). ', el('a', { href: '#/profil' }, 'Compléter mon profil'))),
    el('div', { class: 'card disclaimer' }, icon('info'), el('div', {}, el('strong', {}, 'À lire : '), describeHelp.medical)),
    planCard,
    packCard,
    settingsCard,
    duringCard,
    preCard,
    energyCard,
    el(
      'p',
      { class: 'muted sources' },
      'Sources : Thomas, Erdman & Burke, ACSM/AND/DC 2016 (glucides avant et pendant) ; Jeukendrup 2014 (glucides par heure selon la durée) ; Sawka et al., ACSM 2007 (hydratation). Les objectifs « loisir » par niveau sont volontairement plus bas que ces recommandations de performance.',
    ),
  );
};
