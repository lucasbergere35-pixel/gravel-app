/**
 * Écran « Plan nutrition » d'un itinéraire :
 * dépense énergétique (modèle physique détaillé), glucides avant / pendant,
 * hydratation, aliments emportés et prises réparties par km.
 */
import { detectClimbs } from '../../core/geo/climbs';
import { cumulativeDistances } from '../../core/geo/distance';
import { buildElevationProfile, PROFILE_STEP_M, type ElevationProfile } from '../../core/geo/elevation';
import { DRIVETRAIN_EFFICIENCY, estimateEnergy, MUSCLE_EFFICIENCY } from '../../core/energy/model';
import type { Food } from '../../core/nutrition/foods';
import { planNutrition } from '../../core/nutrition/plan';
import { duringRideCarbs, LEVEL_LABELS, preRideCarbs, preRideExamples } from '../../core/nutrition/recommendations';
import { getFoods, getProfile, getRoute, saveFoods } from '../../services/db';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { duration, int, km } from '../format';
import { describeHelp } from '../help';
import { navigate, type View } from '../router';

const BOTTLE_ML = 750;
const fr = (n: number, digits = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });

/** Profil plat de secours quand le GPX n'a pas d'altitude. */
function flatProfile(totalM: number): ElevationProfile {
  const distances: number[] = [];
  for (let d = 0; d < totalM; d += PROFILE_STEP_M) distances.push(d);
  distances.push(totalM);
  return { step: PROFILE_STEP_M, distances, elevations: distances.map(() => 0) };
}

function row(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, el('span', {}, label), el('strong', {}, value));
}

export const nutritionView: View = async (root, params) => {
  const [data, profile, allFoods] = await Promise.all([getRoute(params.id), getProfile(), getFoods()]);
  if (!data) {
    toast('Itinéraire introuvable', 'error');
    navigate('/');
    return;
  }
  const { meta: route, track } = data;
  const cum = cumulativeDistances(track.points);
  const realProfile = buildElevationProfile(track.points, cum);
  const elevation = realProfile ?? flatProfile(cum[cum.length - 1] ?? 0);
  const climbs = realProfile ? detectClimbs(realProfile) : [];

  const energy = estimateEnergy(elevation, {
    riderKg: profile.weightKg,
    bikeKg: profile.bikeKg,
    heightCm: profile.heightCm,
    avgSpeedKmh: profile.avgSpeedKmh,
  });
  const pre = preRideCarbs(energy.durationS, profile.weightKg);
  const during = duringRideCarbs(energy.durationS, profile.level);

  // ---------- Dépense ----------
  const energyCard = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Dépense estimée'),
    el('div', { class: 'big-figure' }, `≈ ${int(Math.round(energy.metabolicKcal / 10) * 10)} kcal`),
    el('p', {}, `Durée ${duration(energy.durationS)} à ${fr(profile.avgSpeedKmh)} km/h de moyenne, soit une puissance de pédalage d’environ ${int(energy.powerW)} W.`),
    realProfile ? null : el('p', { class: 'muted' }, 'Ce GPX n’a pas d’altitude : calcul fait comme si le parcours était plat.'),
    el(
      'details',
      { class: 'calc-details' },
      el('summary', {}, 'Détail du calcul'),
      el('p', {}, 'Sur chaque tronçon de 10 m, la puissance au pédalier vaut :'),
      el('p', { class: 'formula' }, 'P × ηtrans = (m·g·Crr·cos θ + m·g·sin θ + ½·ρ·CdA·v²) × v'),
      el('p', {}, 'On cherche la puissance constante qui donne ta vitesse moyenne sur tout le parcours (lent en montée, plus rapide sur le plat, vitesse plafonnée à 40 km/h en descente où l’on peut cesser de pédaler).'),
      row('Masse totale m (toi + vélo équipé)', `${fr(energy.massKg)} kg`),
      row('Résistance au roulement Crr (gravel)', fr(energy.crr, 3)),
      row('Traînée CdA (ajustée à ta taille et ton poids)', `${fr(energy.cdaM2, 2)} m²`),
      row('Densité de l’air ρ (selon l’altitude)', `${fr(energy.rhoKgM3, 2)} kg/m³`),
      row('Rendement de transmission ηtrans', `${int(DRIVETRAIN_EFFICIENCY * 100)} %`),
      row('Puissance constante trouvée', `${int(energy.powerW)} W`),
      row('Travail mécanique', `${int(energy.mechanicalKJ)} kJ`),
      row('Rendement musculaire', `${int(MUSCLE_EFFICIENCY * 100)} %`),
      row('Énergie dépensée = travail ÷ rendement', `${int(energy.metabolicKcal)} kcal`),
      el('p', { class: 'muted' }, 'Le vent, l’état du chemin, les arrêts et ta forme du jour peuvent faire varier ce chiffre de ±20 % ou plus.'),
    ),
  );

  // ---------- Avant ----------
  const examples = preRideExamples(pre.totalG);
  const preCard = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Avant la sortie'),
    el('p', {}, el('strong', {}, `${pre.totalG} g de glucides`), ` (${pre.gPerKg} g/kg), ${pre.hoursBefore[0]} à ${pre.hoursBefore[1]} h avant le départ.`),
    el('p', { class: 'muted' }, 'Par exemple, au total :'),
    el(
      'ul',
      { class: 'plain-list' },
      ...examples.map((x) => el('li', {}, x.pieces ? `${x.pieces} ${x.name}${x.pieces > 1 ? 's' : ''} (≈ ${x.grams} g)` : `≈ ${x.grams} g de ${x.name}`)),
    ),
    el('p', { class: 'muted' }, 'Privilégie des aliments que tu digères bien, peu gras et peu riches en fibres juste avant l’effort.'),
  );

  // ---------- Pendant ----------
  const bottles = Math.ceil(during.waterTotalMl / BOTTLE_ML);
  const duringCard = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Pendant la sortie'),
    during.optional
      ? el('p', {}, el('strong', {}, 'Glucides facultatifs'), ' : sortie de moins de 1 h 30. Emporte quand même un en-cas de secours.')
      : el(
          'p',
          {},
          el('strong', {}, `${during.targetGPerH} g de glucides par heure`),
          ` (recommandation ${during.rangeGPerH[0]}–${during.rangeGPerH[1]} g/h, niveau ${LEVEL_LABELS[profile.level].toLowerCase()}), soit ${during.totalG} g au total.`,
        ),
    el(
      'p',
      {},
      el('strong', {}, `Boire ${during.waterRangeMlPerH[0]}–${during.waterRangeMlPerH[1]} mL par heure`),
      ` : environ ${fr(during.waterTotalMl / 1000)} L sur la sortie (${bottles} bidon${bottles > 1 ? 's' : ''} de 750 mL, ou des points d’eau). Plus s’il fait chaud.`,
    ),
  );

  // ---------- J'emporte + plan ----------
  const packCard = el('section', { class: 'card' });
  const planCard = el('section', { class: 'card' });
  const foods: Food[] = allFoods;

  function renderPlan(): void {
    const plan = planNutrition({ profile: elevation, timeAt: energy.timeAt, durationS: energy.durationS, targetGPerH: during.targetGPerH, foods, climbs });

    packCard.replaceChildren(
      el('h2', {}, 'J’emporte'),
      el(
        'div',
        { class: 'pack-list' },
        ...foods.map((f) => {
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
          return el('label', { class: 'pack-item' }, box, el('span', {}, f.name), el('span', { class: 'muted' }, `${fr(f.carbsG)} g`));
        }),
      ),
      el('a', { href: '#/aliments', class: 'btn btn-small' }, 'Modifier mes aliments'),
    );

    if (plan.emptyReason) {
      planCard.replaceChildren(el('h2', {}, 'Plan des prises'), el('p', {}, plan.emptyReason));
      return;
    }
    planCard.replaceChildren(
      el('h2', {}, 'Plan des prises'),
      el('p', { class: 'muted' }, 'Placées environ toutes les 25 min, en évitant les fortes montées et les descentes.'),
      el(
        'ol',
        { class: 'intake-list' },
        ...plan.intakes.map((i) =>
          el(
            'li',
            { class: `intake${i.onSlope ? ' on-slope' : ''}` },
            el('div', { class: 'intake-km' }, `Km ${int(i.distanceM / 1000)}`),
            el(
              'div',
              { class: 'intake-body' },
              el('div', { class: 'intake-what' }, i.label),
              el('div', { class: 'muted' }, `vers ${duration(i.timeS)} · ${int(i.carbsG)} g${i.onSlope ? ' · ⚠ en pente : attends le replat' : ''}`),
            ),
          ),
        ),
      ),
      el('h3', {}, 'À emporter'),
      el('ul', { class: 'plain-list' }, ...plan.packing.map((p) => el('li', {}, p.label))),
      el('p', {}, `Total prévu : ${plan.plannedTotalG} g de glucides (objectif ${plan.targetTotalG} g).`),
      el('p', { class: 'muted' }, 'Ajoute une petite marge (une barre ou un gel de plus) en cas d’imprévu.'),
    );
  }
  renderPlan();

  append(
    root,
    el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'back-link' }, `‹ ${route.name}`),
    el('h1', {}, 'Plan nutrition'),
    el('p', {}, `${km(cum[cum.length - 1] ?? 0)} km · ${int(route.stats.gainM)} m D+`),
    profile.complete ? null : el('div', { class: 'card notice' }, 'Profil incomplet : calcul fait avec des valeurs par défaut (70 kg…). ', el('a', { href: '#/profil' }, 'Compléter mon profil')),
    el('div', { class: 'card disclaimer' }, el('strong', {}, 'ℹ À lire : '), describeHelp.medical),
    energyCard,
    preCard,
    duringCard,
    packCard,
    planCard,
    el(
      'p',
      { class: 'muted sources' },
      'Sources : Thomas, Erdman & Burke, ACSM/AND/DC 2016 (glucides avant et pendant) ; Jeukendrup 2014 (glucides par heure selon la durée) ; Sawka et al., ACSM 2007 (hydratation).',
    ),
  );
};
