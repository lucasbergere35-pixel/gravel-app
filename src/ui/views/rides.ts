/**
 * Écrans « Mes sorties » (liste) et « Bilan de sortie » (détail, ressenti, export GPX).
 */
import type { IntakeStatus } from '../../core/ride/intakes';
import { FEELING_LABELS, rideToGpx, sanitizeFeeling, type FeelingKind } from '../../core/ride/summary';
import { deleteRide, getRide, getRidePoints, listFinishedRides, updateRide, type RideMeta } from '../../services/db';
import { safeFileName, shareOrDownload } from '../../services/files';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { clock, date, int, km } from '../format';
import { navigate, type View } from '../router';

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
      ? el('div', { class: 'empty' }, el('p', {}, 'Aucune sortie terminée pour l’instant.'), el('p', { class: 'muted' }, 'Lance une sortie (ou une simulation) depuis un itinéraire.'))
      : el(
          'div',
          { class: 'stack' },
          ...rides.map((r) => {
            const s = r.summary;
            const n = s?.nutrition;
            return el(
              'a',
              { class: 'card route-card', href: `#/sorties/${encodeURIComponent(r.id)}` },
              el('div', { class: 'route-card-name' }, r.routeName, r.simulated ? el('span', { class: 'kind-tag kind-rapide' }, 'Simulation') : null),
              el(
                'div',
                { class: 'route-card-stats' },
                el('span', {}, el('strong', {}, km(s?.distanceM ?? r.distanceM)), ' km'),
                el('span', {}, el('strong', {}, clock(s?.movingTimeS ?? r.movingTimeS)), ' en mvt'),
                n && n.done + n.skipped + n.missed > 0 ? el('span', {}, `🍌 ${n.done}/${n.done + n.skipped + n.missed}`) : null,
                r.feeling ? el('span', {}, FEELING_LABELS[r.feeling.kind].split(' ')[0]) : null,
                el('span', { class: 'muted' }, date(r.startedAt)),
              ),
            );
          }),
        ),
  );
};

// ---------- Bilan ----------

const STATUS_LABELS: Record<IntakeStatus, string> = {
  done: '✓ faite',
  skipped: '✗ passée',
  due: '… non traitée',
  pending: '— non atteinte',
};

export const rideSummaryView: View = async (root, params) => {
  const ride = await getRide(params.id);
  if (!ride || ride.endedAt === null) {
    toast('Sortie introuvable', 'error');
    navigate('/sorties');
    return;
  }
  const s = ride.summary;
  const n = s?.nutrition ?? null;
  const nut = ride.nutrition;

  // ---------- Statistiques ----------
  const stats = el(
    'div',
    { class: 'stats-grid' },
    stat('Distance', km(s?.distanceM ?? ride.distanceM), ' km'),
    stat('Vitesse moyenne', s ? fr1(s.avgSpeedKmh) : '—', ' km/h'),
    stat('En mouvement', clock(s?.movingTimeS ?? ride.movingTimeS), ''),
    stat('Temps total', s ? clock(s.totalTimeS) : '—', ''),
    stat('Dénivelé + (GPS)', s?.gainM !== null && s?.gainM !== undefined ? int(s.gainM) : 'n/d', s?.gainM !== null && s?.gainM !== undefined ? ' m' : ''),
    n ? stat('Boissons (rappels OK)', int(n.drinks), '') : null,
  );

  // ---------- Bilan nutrition ----------
  const nutritionCard = el('section', { class: 'card' }, el('h2', {}, '🍌 Bilan nutrition'));
  if (!n || !nut || nut.plan.intakes.length === 0) {
    nutritionCard.append(el('p', { class: 'muted' }, 'Pas de plan de ravitaillement pour cette sortie.'));
  } else {
    // Comparaison principale : grammes pris / grammes prévus jusqu'au point atteint.
    const ratio = n.plannedG > 0 ? Math.round((n.takenG / n.plannedG) * 100) : null;
    append(
      nutritionCard,
      el(
        'div',
        { class: `plan-summary${ratio !== null && ratio < 75 ? ' warn' : ''}` },
        el('div', { class: 'plan-total' }, `${int(n.takenG)} g de glucides pris`),
        el(
          'div',
          {},
          `sur ${int(n.plannedG)} g prévus jusqu’où tu es allé${ratio !== null ? ` (${ratio} %)` : ''} · plan complet : ${int(nut.plan.plannedTotalG)} g`,
        ),
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
        el('span', {}, el('strong', {}, `${n.done}`), ' faites'),
        el('span', {}, el('strong', {}, `${n.postponed}`), ' repoussées'),
        el('span', {}, el('strong', {}, `${n.skipped}`), ' passées'),
        n.missed > 0 ? el('span', {}, el('strong', {}, `${n.missed}`), ' non traitées') : null,
        n.notReached > 0 ? el('span', {}, el('strong', {}, `${n.notReached}`), ' non atteintes') : null,
      ),
      el(
        'ol',
        { class: 'intake-list' },
        ...nut.plan.intakes.map((i, k) => {
          const st = nut.states[k];
          return el(
            'li',
            { class: `intake status-${st.status}` },
            el('div', { class: 'intake-km' }, `Km ${int(i.distanceM / 1000)}`),
            el(
              'div',
              { class: 'intake-body' },
              el('div', { class: 'intake-what' }, i.label, el('span', { class: 'muted' }, ` · ${fr1(i.carbsG)} g`)),
              el('div', { class: 'intake-why' }, `${STATUS_LABELS[st.status]}${st.laterCount > 0 ? ` · repoussée ${st.laterCount}×` : ''}${st.doneAtS !== null ? ` · à ${clock(st.doneAtS)}` : ''}`),
            ),
          );
        }),
      ),
    );
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
    el('h2', {}, 'Ressenti'),
    el('fieldset', { class: 'choices' }, ...kinds.map((k, i) => el('label', { for: `feel-${k}`, class: 'choice' }, radios[i], el('span', {}, FEELING_LABELS[k])))),
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
  const exportBtn = el('button', { type: 'button', class: 'btn btn-block' }, '⬇ Exporter la sortie en GPX');
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
    el('a', { href: '#/sorties', class: 'back-link' }, '‹ Mes sorties'),
    el('h1', {}, 'Bilan de sortie'),
    el('p', {}, rideTitle(ride), ride.simulated ? el('span', { class: 'kind-tag kind-rapide' }, 'Simulation') : null),
    stats,
    nutritionCard,
    feelingForm,
    el(
      'div',
      { class: 'stack actions' },
      exportBtn,
      el('a', { href: `#/itineraire/${encodeURIComponent(ride.routeId)}`, class: 'btn btn-block' }, 'Voir l’itinéraire'),
      deleteBtn,
    ),
  );

  return () => window.clearTimeout(confirmTimer);
};
