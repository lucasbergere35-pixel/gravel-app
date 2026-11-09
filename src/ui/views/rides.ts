/**
 * Écrans « Mes sorties » (liste) et « Bilan de sortie » (détail, ressenti, export GPX).
 */
import { isReached, isTaken, setTaken, summarizeNutrition, type NutritionSummary } from '../../core/ride/intakes';
import { FEELING_LABELS, rideToGpx, sanitizeFeeling, type FeelingKind } from '../../core/ride/summary';
import { deleteRide, getRide, getRidePoints, listFinishedRides, updateRide, type RideMeta } from '../../services/db';
import { safeFileName, shareOrDownload } from '../../services/files';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { clock, date, int, km } from '../format';
import { icon, type IconName } from '../icons';
import { navigate, type View } from '../router';

const FEELING_ICONS: Record<FeelingKind, IconName> = { bonne: 'face-smile', 'coup-de-mou': 'face-neutral', fringale: 'battery-low' };

const fr1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

function stat(label: string, value: string, unit: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-value' }, value, el('span', { class: 'stat-unit' }, unit)), el('div', { class: 'stat-label' }, label));
}

function rideTitle(r: RideMeta): string {
  return `${r.routeName} · ${date(r.startedAt)}`;
}

// ---------- Liste ----------

export const ridesListView: View = async (root) => {
  const rides = await listFinishedRides();
  append(
    root,
    el('h1', {}, 'Mes sorties'),
    rides.length === 0
      ? el('div', { class: 'empty' }, icon('bike'), el('p', {}, 'Aucune sortie terminée pour l’instant.'), el('p', { class: 'muted' }, 'Lance une sortie (ou une simulation) depuis un itinéraire.'))
      : el(
          'div',
          { class: 'stack' },
          ...rides.map((r) => {
            const s = r.summary;
            const n: NutritionSummary | null = r.nutrition ? summarizeNutrition(r.nutrition, s?.movingTimeS ?? r.movingTimeS) : null;
            return el(
              'a',
              { class: 'card ride-card', href: `#/sorties/${encodeURIComponent(r.id)}` },
              el(
                'div',
                { class: 'route-card-name' },
                el('span', {}, r.routeName),
                r.simulated ? el('span', { class: 'badge warn' }, icon('flask'), 'Simulation') : null,
              ),
              el('div', { class: 'muted', style: 'margin:-4px 0 8px' }, date(r.startedAt)),
              el(
                'div',
                { class: 'chips' },
                el('span', { class: 'chip' }, icon('route'), `${km(s?.distanceM ?? r.distanceM)} km`),
                el('span', { class: 'chip' }, icon('timer'), clock(s?.movingTimeS ?? r.movingTimeS)),
                n && n.taken + n.notTaken > 0 ? el('span', { class: 'chip' }, icon('utensils'), `${n.taken}/${n.taken + n.notTaken}`) : null,
                r.feeling ? el('span', { class: 'chip', title: FEELING_LABELS[r.feeling.kind] }, icon(FEELING_ICONS[r.feeling.kind]), FEELING_LABELS[r.feeling.kind]) : null,
              ),
            );
          }),
        ),
  );
};

// ---------- Bilan ----------

export const rideSummaryView: View = async (root, params) => {
  const ride = await getRide(params.id);
  if (!ride || ride.endedAt === null) {
    toast('Sortie introuvable', 'error');
    navigate('/sorties');
    return;
  }
  const s = ride.summary;
  const nut = ride.nutrition;
  const movingTimeS = s?.movingTimeS ?? ride.movingTimeS;

  // ---------- Statistiques ----------
  const stats = el(
    'div',
    { class: 'stats-grid' },
    stat('Distance', km(s?.distanceM ?? ride.distanceM), ' km'),
    stat('Moyenne', s ? fr1(s.avgSpeedKmh) : '—', ' km/h'),
    stat('En mouvement', clock(s?.movingTimeS ?? ride.movingTimeS), ''),
    stat('Temps total', s ? clock(s.totalTimeS) : '—', ''),
    stat('D+ (GPS)', s?.gainM !== null && s?.gainM !== undefined ? int(s.gainM) : 'n/d', s?.gainM !== null && s?.gainM !== undefined ? ' m' : ''),
    nut ? stat('Rappels boisson', int(nut.drinkCount), '') : null,
  );

  // ---------- Bilan nutrition ----------
  // Chaque prise atteinte est « faite » par défaut ; décocher celles non prises
  // met à jour les grammes et le g/h (enregistré dans la sortie).
  const nutritionCard = el('section', { class: 'card' });
  const summaryBox = el('div', {});

  function renderTotals(): void {
    if (!nut) return;
    const n = summarizeNutrition(nut, movingTimeS);
    const ratio = n.plannedG > 0 ? Math.round((n.takenG / n.plannedG) * 100) : null;
    summaryBox.replaceChildren(
      el(
        'div',
        { class: `plan-summary${ratio !== null && ratio < 75 ? ' warn' : ''}` },
        el('div', { class: 'plan-total' }, `${int(n.takenG)} g de glucides pris`),
        el('div', {}, `sur ${int(n.plannedG)} g prévus jusqu’où tu es allé${ratio !== null ? ` (${ratio} %)` : ''} · plan complet : ${int(nut.plan.plannedTotalG)} g`),
        el(
          'div',
          {},
          n.takenGPerH !== null
            ? `soit ${int(n.takenGPerH)} g/h réels pour ${int(n.targetGPerH)} g/h visés (après la 45e minute)`
            : `g/h non calculé : moins de 15 min roulées après la 45e minute (objectif ${int(n.targetGPerH)} g/h).`,
        ),
      ),
      el(
        'div',
        { class: 'route-card-stats' },
        el('span', {}, el('strong', {}, `${n.taken}`), ' prises'),
        n.notTaken > 0 ? el('span', {}, el('strong', {}, `${n.notTaken}`), ' pas prises') : null,
        n.notReached > 0 ? el('span', {}, el('strong', {}, `${n.notReached}`), ' non atteintes') : null,
      ),
    );
  }

  if (!nut || nut.plan.intakes.length === 0) {
    nutritionCard.append(el('h2', {}, icon('utensils'), 'Bilan nutrition'), el('p', { class: 'muted' }, 'Pas de plan de ravitaillement pour cette sortie.'));
  } else {
    let saving: Promise<void> = Promise.resolve();
    const rows = nut.plan.intakes.map((i, k) => {
      const st = nut.states[k];
      const reached = isReached(st);
      const box = el('input', { type: 'checkbox', checked: isTaken(st), disabled: !reached, 'aria-label': `Prise du km ${int(i.distanceM / 1000)} prise` });
      box.addEventListener('change', () => {
        setTaken(nut, i.id, box.checked);
        row.classList.toggle('not-taken', !box.checked);
        renderTotals();
        ride.nutrition = nut;
        ride.summary = s ? { ...s, nutrition: summarizeNutrition(nut, movingTimeS) } : s;
        saving = saving.then(() => updateRide(ride)).catch((err: unknown) => toast(errorMessage(err), 'error'));
      });
      const row = el(
        'li',
        { class: `intake intake-check${reached ? '' : ' status-pending'}${reached && !isTaken(st) ? ' not-taken' : ''}` },
        el('label', { class: 'intake-km' }, box, el('span', {}, `Km ${int(i.distanceM / 1000)}`)),
        el(
          'div',
          { class: 'intake-body' },
          el('div', { class: 'intake-what' }, i.label, el('span', { class: 'muted' }, ` · ${fr1(i.carbsG)} g`)),
          el('div', { class: 'intake-why' }, reached ? (st.dueAtS !== null ? `alerte à ${clock(st.dueAtS)} de temps en mouvement` : 'atteinte') : '— non atteinte'),
        ),
      );
      return row;
    });
    append(
      nutritionCard,
      el('h2', {}, icon('utensils'), 'Bilan nutrition'),
      summaryBox,
      el('p', { class: 'muted' }, 'Chaque prise est comptée comme faite. Décoche celles que tu n’as pas prises : le bilan se met à jour.'),
      el('ol', { class: 'intake-list' }, ...rows),
    );
    renderTotals();
  }

  // ---------- Ressenti ----------
  const feeling = ride.feeling ?? null;
  const kinds = Object.keys(FEELING_LABELS) as FeelingKind[];
  const radios = kinds.map((k) => el('input', { type: 'radio', name: 'feeling', value: k, id: `feel-${k}`, checked: feeling?.kind === k }));
  const kmInput = el('input', { type: 'number', id: 'feel-km', inputmode: 'decimal', min: 0, step: 1, value: feeling?.km ?? '', placeholder: 'ex. 42' });
  const noteInput = el('input', { type: 'text', id: 'feel-note', maxlength: 500, value: feeling?.note ?? '', placeholder: 'ex. pas assez mangé avant la grosse côte' });
  const kmField = el('div', { class: 'field' }, el('label', { for: 'feel-km', class: 'field-label' }, 'Vers quel km ?'), kmInput);
  const refreshKm = () => {
    const k = radios.find((r) => r.checked)?.value;
    kmField.hidden = !k || k === 'bonne';
  };
  radios.forEach((r) => r.addEventListener('change', refreshKm));
  refreshKm();
  const saveFeeling = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Enregistrer le ressenti');
  const feelingForm = el(
    'form',
    { class: 'card stack' },
    el('h2', {}, icon('activity'), 'Ressenti'),
    el('fieldset', { class: 'choices' }, ...kinds.map((k, i) => el('label', { for: `feel-${k}`, class: 'choice' }, radios[i], icon(FEELING_ICONS[k]), el('span', {}, FEELING_LABELS[k])))),
    kmField,
    el('div', { class: 'field' }, el('label', { for: 'feel-note', class: 'field-label' }, 'Remarque (facultatif)'), noteInput),
    el('p', { class: 'muted' }, 'Ces notes serviront plus tard à ajuster tes besoins (objectif g/h, placement des prises).'),
    saveFeeling,
  );
  feelingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = radios.find((r) => r.checked)?.value;
    const clean = sanitizeFeeling({ kind, km: kind === 'bonne' ? null : kmInput.value.replace(',', '.'), note: noteInput.value });
    if (!clean) {
      toast('Choisis : bonne sortie, coup de mou ou fringale.', 'error');
      return;
    }
    try {
      await updateRide({ ...ride, feeling: clean });
      ride.feeling = clean;
      toast('Ressenti enregistré', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  // ---------- Actions ----------
  const exportBtn = el('button', { type: 'button', class: 'btn btn-block' }, icon('share'), 'Exporter la sortie en GPX');
  exportBtn.addEventListener('click', async () => {
    try {
      const fixes = await getRidePoints(ride.id);
      if (fixes.length < 2) {
        toast('Pas assez de positions enregistrées pour exporter.', 'error');
        return;
      }
      const name = `${ride.routeName} – ${date(ride.startedAt)}`;
      await shareOrDownload(safeFileName(`sortie ${name}`, 'gpx'), rideToGpx(name, fixes), 'application/gpx+xml');
    } catch (err) {
      toast(`Export impossible : ${errorMessage(err)}`, 'error');
    }
  });
  const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger btn-block' }, 'Supprimer cette sortie');
  let confirmTimer: number | undefined;
  deleteBtn.addEventListener('click', async () => {
    if (!deleteBtn.classList.contains('confirm')) {
      deleteBtn.classList.add('confirm');
      deleteBtn.textContent = 'Appuie encore pour confirmer la suppression';
      confirmTimer = window.setTimeout(() => {
        deleteBtn.classList.remove('confirm');
        deleteBtn.textContent = 'Supprimer cette sortie';
      }, 4000);
      return;
    }
    window.clearTimeout(confirmTimer);
    try {
      await deleteRide(ride.id);
      toast('Sortie supprimée', 'success');
      navigate('/sorties');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  append(
    root,
    el('a', { href: '#/sorties', class: 'back-link' }, icon('chevron-left'), 'Mes sorties'),
    el('h1', {}, 'Bilan de sortie'),
    el('p', { class: 'muted' }, rideTitle(ride), ride.simulated ? el('span', { class: 'badge warn', style: 'margin-left:8px' }, icon('flask'), 'Simulation') : null),
    stats,
    nutritionCard,
    feelingForm,
    el(
      'div',
      { class: 'stack actions' },
      exportBtn,
      el('a', { href: `#/itineraire/${encodeURIComponent(ride.routeId)}`, class: 'btn btn-block' }, icon('map'), 'Voir l’itinéraire'),
      deleteBtn,
    ),
  );

  return () => window.clearTimeout(confirmTimer);
};
