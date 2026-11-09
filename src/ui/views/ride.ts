/**
 * Écran « Mode sortie » : suivi GPS en temps réel sur un itinéraire.
 *
 * Flux d'une position :
 *   source (GPS ou simulation) → GpsFilter (rejette les points douteux)
 *   → RideTracker (distance, vitesse, temps en mouvement)
 *   → RouteMatcher (progression sur le tracé, écart au tracé)
 *   → carte + affichage, et mise en file pour l'enregistrement (IndexedDB).
 *
 * Affichage : 3 pages (Tableau de bord, Carte, Profil) + bandeau fixe en bas
 * (voir components/ridePager.ts). Une seule carte MapLibre, déplacée entre la
 * page 1 et la page 2 (deux cartes coûteraient deux fois plus de mémoire).
 *
 * Robustesse :
 *  - les positions sont enregistrées toutes les 15 s et dès que l'appli passe
 *    en arrière-plan : si iOS ferme l'appli, la sortie peut être reprise ;
 *  - au retour au premier plan, le GPS et le maintien d'écran sont relancés.
 */
import { climbStatus, detectClimbs } from '../../core/geo/climbs';
import { cumulativeDistances } from '../../core/geo/distance';
import { buildElevationProfile, cumulativeClimb, remainingClimb } from '../../core/geo/elevation';
import { RouteMatcher, type MatchResult } from '../../core/geo/trackMatch';
import { GpsFilter } from '../../core/gps/filter';
import { FIRST_INTAKE_S } from '../../core/nutrition/plan';
import { computeRouteNutrition, type RouteNutrition } from '../../core/nutrition/routePlan';
import {
  announcedIntake,
  drinkDue,
  emptyPlan,
  freezePlan,
  initNutritionState,
  markDrink,
  summarizeNutrition,
  updateIntakes,
  type RideNutritionState,
  type RidePosition,
} from '../../core/ride/intakes';
import { buildRideSummary } from '../../core/ride/summary';
import { HeadingEstimator } from '../../core/gps/heading';
import type { GpsFix } from '../../core/gps/types';
import { RideTracker, STALE_FIX_S } from '../../core/ride/tracker';
import { createMapView, type MapView, type OrientationMode } from '../../map/mapView';
import {
  appendRidePoints,
  createRide,
  deleteRide,
  getActiveRide,
  getFoods,
  getNutritionPrefs,
  getProfile,
  getRideSettings,
  getRidePoints,
  getRoute,
  saveRideSettings,
  updateRide,
  type RideMeta,
} from '../../services/db';
import { DeviceGps, type PositionSource } from '../../services/geolocation';
import { SimulatedGps } from '../../services/simulator';
import { AlertSound } from '../../services/sound';
import { ScreenWakeLock } from '../../services/wakeLock';
import { createOfflinePackCard } from '../components/offlinePackCard';
import { createRideAlerts } from '../components/rideAlerts';
import { createRidePager } from '../components/ridePager';
import { createRideProfile } from '../components/rideProfile';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { clock, int, km } from '../format';
import { icon, type IconName } from '../icons';
import { navigate, type View } from '../router';

/** Alerte hors tracé au-delà de OFF_TRACK_ON_M, levée sous OFF_TRACK_OFF_M (hystérésis). */
const OFF_TRACK_ON_M = 50;
const OFF_TRACK_OFF_M = 40;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_MAX_PENDING = 30;
const PAGE_DASHBOARD = 0;
const PAGE_MAP = 1;

/** Une tuile de chiffre : retourne l'élément et une fonction pour changer la valeur. */
function tile(label: string, unit: string, ic: IconName): { node: HTMLElement; set: (v: string) => void; note: HTMLElement } {
  const value = el('span', {}, '—');
  const note = el('span', { class: 'ride-note' });
  const node = el(
    'div',
    { class: 'ride-tile' },
    el('div', { class: 'ride-value' }, value, unit ? el('span', { class: 'ride-unit' }, unit) : null),
    el('div', { class: 'ride-label' }, icon(ic), label, note),
  );
  return { node, set: (v) => (value.textContent = v), note };
}

/** Bouton de commande : icône + libellé court. */
function setCtrl(btn: HTMLElement, ic: IconName, label: string): void {
  btn.replaceChildren(icon(ic), el('span', {}, label));
}

const fmt1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function createRideView(simulated: boolean): View {
  return async (root, params) => {
    const [data, profile, foods, nutritionPrefs, rideSettings] = await Promise.all([
      getRoute(params.id),
      getProfile(),
      getFoods(),
      getNutritionPrefs(),
      getRideSettings(),
    ]);
    if (!data) {
      toast('Itinéraire introuvable', 'error');
      navigate('/');
      return;
    }
    const { meta: route, track } = data;
    const cum = cumulativeDistances(track.points);
    const totalM = cum[cum.length - 1] ?? 0;
    const elevation = buildElevationProfile(track.points, cum);
    const cumClimb = elevation ? cumulativeClimb(elevation.elevations) : null;
    const climbList = elevation ? detectClimbs(elevation) : [];

    // Sortie à reprendre ? (uniquement les vraies sorties, pas les simulations)
    let ride: RideMeta | null = null;
    let resumeFixes: GpsFix[] = [];
    const active = await getActiveRide();
    if (active) {
      if (active.simulated) {
        await deleteRide(active.id);
      } else if (!simulated && active.routeId === route.id) {
        ride = active;
        resumeFixes = await getRidePoints(active.id);
      }
    }

    document.body.classList.add('ride-mode');

    // ---------- Éléments communs ----------
    const offTrackBanner = el('div', { class: 'offtrack-banner', hidden: true, role: 'alert' });
    const gpsAlert = el('div', { class: 'gps-alert', hidden: true, role: 'alert' });
    const mapEl = el('div', { class: 'map map-ride' });
    const recenterBtn = el('button', { type: 'button', class: 'btn btn-small recenter', hidden: true }, icon('locate'), 'Recentrer');
    const mapWrap = el('div', { class: 'map-wrap' }, mapEl, recenterBtn);

    // ---------- Page 1 : tableau de bord ----------
    const tLeft = tile('Restant', ' km', 'flag');
    const tClimbLeft = tile('D+ restant', ' m', 'trending-up');
    const tAvg = tile('Moyenne', ' km/h', 'gauge');
    const tMoving = tile('En mouvement', '', 'timer');
    const tTotal = tile('Temps total', '', 'clock');
    const tGps = tile('GPS', '', 'satellite');
    if (!cumClimb) tClimbLeft.set('n/d');

    const orientBtn = el('button', { type: 'button', class: 'btn ctrl-btn' });
    const wakeBtn = el('button', { type: 'button', class: 'btn ctrl-btn' });
    setCtrl(wakeBtn, 'sun', 'Écran : non');
    const soundBtn = el('button', { type: 'button', class: 'btn ctrl-btn' });
    const finishBtn = el('button', { type: 'button', class: 'btn btn-danger ctrl-btn' });
    setCtrl(finishBtn, 'square', 'Terminer');
    const quitLink = el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'btn ctrl-btn' });
    setCtrl(quitLink, 'log-out', 'Quitter');
    const mapSlotDashboard = el('div', { class: 'map-slot map-slot-dashboard' });
    const mapSlotFull = el('div', { class: 'map-slot map-slot-full' });

    // ---------- Page 3 : profil ----------
    const profileInfo = el('div', { class: 'climb-info' });
    const profileChart = elevation ? createRideProfile(elevation) : null;

    const pager = createRidePager(['Tableau de bord', 'Carte', 'Profil'], (page) => {
      // La carte suit la page affichée (tableau de bord ou carte plein écran).
      const slot = page === PAGE_MAP ? mapSlotFull : page === PAGE_DASHBOARD ? mapSlotDashboard : null;
      if (slot && mapWrap.parentElement !== slot) {
        slot.append(mapWrap);
        requestAnimationFrame(() => map?.relayout());
      }
      if (page === 2 && tracker) renderProfilePage(lastMatch ? lastMatch.alongM : null);
    });
    pager.alerts.append(offTrackBanner, gpsAlert);
    pager.pages[0].append(
      mapSlotDashboard,
      el('div', { class: 'ride-grid' }, tLeft.node, tClimbLeft.node, tAvg.node, tMoving.node, tTotal.node, tGps.node),
      el('div', { class: 'ride-controls' }, orientBtn, wakeBtn, soundBtn, finishBtn, quitLink),
    );
    pager.pages[1].append(mapSlotFull);
    pager.pages[2].append(
      profileInfo,
      profileChart ? profileChart.element : el('p', { class: 'muted' }, 'Ce GPX ne contient pas d’altitude : profil indisponible.'),
    );
    const live = el('div', { class: 'ride-live', hidden: true }, pager.element);

    // ---------- Écran de départ ----------
    const factorSelect = el(
      'select',
      { id: 'sim-factor' },
      el('option', { value: '1' }, 'Temps réel (×1)'),
      el('option', { value: '10', selected: true }, 'Accéléré ×10'),
      el('option', { value: '30' }, 'Accéléré ×30'),
    );
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-block btn-huge' }, icon('play'), ride ? 'Reprendre la sortie' : 'Démarrer');

    // Plan nutrition : celui de l'écran « Plan nutrition », figé au démarrage.
    // (Pour une sortie reprise, on garde celui figé au départ.)
    const resumedNutrition = ride?.nutrition ?? null;
    let routeNutrition: RouteNutrition | null = null;
    if (!resumedNutrition) {
      try {
        routeNutrition = computeRouteNutrition(track.points, profile, nutritionPrefs, foods);
      } catch (err) {
        console.error(err);
      }
    }
    const planLine = resumedNutrition
      ? `Plan figé au départ : ${resumedNutrition.plan.intakes.length} prises, ${resumedNutrition.states.filter((x) => x.status === 'done').length} déjà faites.`
      : routeNutrition && routeNutrition.plan.intakes.length > 0
        ? `${routeNutrition.plan.intakes.length} prises, ${routeNutrition.plan.plannedTotalG} g de glucides (${routeNutrition.during.targetGPerH} g/h). Le plan sera figé au démarrage.`
        : `Pas de prise prévue${routeNutrition?.plan.emptyReason ? ` : ${routeNutrition.plan.emptyReason}` : '.'}`;

    const soundCheck = el('input', { type: 'checkbox', class: 'switch', id: 'ride-sound', checked: rideSettings.sound });
    const drinkSelect = el(
      'select',
      { id: 'ride-drink' },
      ...[0, 15, 20, 25, 30].map((m) => el('option', { value: m, selected: m === rideSettings.drinkIntervalMin }, m === 0 ? 'Désactivé' : `Toutes les ${m} min`)),
    );
    const testSoundBtn = el('button', { type: 'button', class: 'btn btn-small' }, icon('volume'), 'Tester');
    // Carte hors ligne : avertissement + bouton si elle manque pour cet itinéraire.
    const offlineWarning = el('p', { class: 'notice-inline', hidden: true }, icon('warning'), 'Pas de carte hors ligne pour cet itinéraire : en zone blanche, le fond de carte restera vide (le tracé, ta position et les alertes fonctionnent quand même).');
    const offlineCard = createOfflinePackCard(route.id, route.name, track.points, {
      compact: true,
      onChange: (pack) => (offlineWarning.hidden = pack?.status === 'complete'),
    });
    const offlineBox = el('div', { class: 'card stack' }, el('h2', {}, icon('cloud-download'), 'Carte hors ligne'), offlineWarning, offlineCard.element);

    const alertsCard = el(
      'div',
      {},
      el('div', { class: 'group-title' }, 'Ravitaillement'),
      el(
        'div',
        { class: 'group' },
        el('div', { class: 'form-row' }, el('span', { class: 'row-label' }, icon('utensils'), planLine)),
        el('a', { href: `#/nutrition/${encodeURIComponent(route.id)}`, class: 'form-row' }, el('span', { class: 'row-label' }, 'Voir / modifier le plan nutrition'), el('span', { class: 'row-value' }, icon('chevron-right'))),
        el('label', { class: 'form-row', for: 'ride-sound' }, el('span', { class: 'row-label' }, icon('volume'), 'Son des alertes'), testSoundBtn, soundCheck),
        el('label', { class: 'form-row', for: 'ride-drink' }, el('span', { class: 'row-label' }, icon('droplet'), 'Rappel boisson'), drinkSelect),
      ),
      el('p', { class: 'group-footer' }, 'Rappel boisson compté en temps en mouvement.'),
      el('p', { class: 'notice-inline', style: 'margin-top:10px' }, icon('warning'), 'Le bouton silencieux de l’iPhone (sur le côté) coupe le son de l’appli : laisse-le côté « son » (pas d’orange visible) et monte le volume.'),
    );
    const intro = el(
      'div',
      { class: 'ride-intro' },
      el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'back-link' }, icon('chevron-left'), 'Retour'),
      el('h1', {}, simulated ? `Simulation : ${route.name}` : route.name),
      el(
        'div',
        { class: 'chips' },
        el('span', { class: 'chip' }, icon('route'), `${km(totalM)} km`),
        el('span', { class: 'chip' }, icon('mountain'), `${climbList.length} montée${climbList.length > 1 ? 's' : ''} repérée${climbList.length > 1 ? 's' : ''}`),
      ),
      simulated
        ? el(
            'div',
            { class: 'card stack' },
            el('p', {}, `Rejoue l’itinéraire à ${int(profile.avgSpeedKmh)} km/h avec un arrêt au km 1, un écart de 80 m au km 2 et une coupure GPS au km 3. La sortie simulée apparaît ensuite dans « Mes sorties » (tu peux la supprimer).`),
            el('label', { for: 'sim-factor', class: 'form-row group' }, el('span', { class: 'row-label' }, icon('flask'), 'Vitesse'), factorSelect),
          )
        : el(
            'div',
            { class: 'card' },
            el('p', {}, 'Garde l’appli ouverte au premier plan. Si l’écran s’éteint, l’enregistrement s’interrompt et reprend au rallumage (un trait droit relie les deux points).'),
            ride ? el('p', { class: 'muted' }, 'Une sortie non terminée a été trouvée sur cet itinéraire : elle va être reprise.') : null,
          ),
      offlineBox,
      alertsCard,
      el('p', { class: 'muted', style: 'margin-top:16px' }, 'En sortie : glisse sur le bandeau du bas (ou touche les points) pour changer de page. Le cadenas verrouille l’écran.'),
      startBtn,
    );

    root.append(intro, live);

    // ---------- Logique ----------
    const filter = new GpsFilter();
    const matcher = new RouteMatcher(track.points, cum);
    const headingEstimator = new HeadingEstimator();
    // « Sens de la marche » par défaut en sortie ; le bouton ou la boussole basculent.
    let orientation: OrientationMode = 'heading';
    const ORIENT_LABELS: Record<OrientationMode, string> = { heading: 'Carte : marche', north: 'Carte : nord' };
    setCtrl(orientBtn, 'compass', ORIENT_LABELS[orientation]);
    function toggleOrientation(): void {
      orientation = orientation === 'heading' ? 'north' : 'heading';
      setCtrl(orientBtn, 'compass', ORIENT_LABELS[orientation]);
      map?.setOrientation(orientation);
    }
    orientBtn.addEventListener('click', toggleOrientation);
    let tracker: RideTracker | null = null;
    let source: PositionSource | null = null;
    let lastMatch: MatchResult | null = null;
    let offTrack = false;
    let lastRejected: { accuracy: number } | null = null;
    let fatalError: string | null = null;
    let pending: GpsFix[] = [];
    let flushing: Promise<void> = Promise.resolve();
    let uiTimer: number | undefined;
    let flushTimer: number | undefined;
    let confirmTimer: number | undefined;
    let map: MapView | null = null;
    let stopped = false;
    let nut: RideNutritionState | null = null;
    const sound = new AlertSound(rideSettings.sound);

    function saveSettings(): void {
      void saveRideSettings(rideSettings).catch((err: unknown) => toast(errorMessage(err), 'error'));
    }
    function refreshSoundBtn(): void {
      setCtrl(soundBtn, rideSettings.sound ? 'volume' : 'volume-off', rideSettings.sound ? 'Son' : 'Muet');
      soundBtn.classList.toggle('btn-on', rideSettings.sound);
    }
    refreshSoundBtn();
    soundCheck.addEventListener('change', () => {
      rideSettings.sound = soundCheck.checked;
      sound.enabled = rideSettings.sound;
      refreshSoundBtn();
      saveSettings();
    });
    soundBtn.addEventListener('click', () => {
      rideSettings.sound = !rideSettings.sound;
      sound.enabled = rideSettings.sound;
      if (rideSettings.sound) {
        sound.unlock();
        sound.play('drink');
      }
      refreshSoundBtn();
      saveSettings();
    });
    drinkSelect.addEventListener('change', () => {
      rideSettings.drinkIntervalMin = Number(drinkSelect.value);
      saveSettings();
    });
    testSoundBtn.addEventListener('click', () => {
      sound.unlock();
      sound.play('intake', true);
      window.setTimeout(() => sound.play('drink', true), 1600);
    });

    /** Enregistre l'état des prises (dans la file d'écriture, sans conflit). */
    function saveNutrition(): void {
      if (!ride || !nut) return;
      ride.nutrition = nut;
      const target = ride;
      flushing = flushing.then(() => updateRide(target)).catch((err: unknown) => console.error(err));
    }

    // Bannières sans bouton : 40 s ou un appui ; le son est joué à l'affichage.
    const alertsUi = createRideAlerts(pager.priority, pager.alerts, (kind) => sound.play(kind));

    const wakeLock = new ScreenWakeLock((activeLock) => {
      if (!ScreenWakeLock.supported) return;
      setCtrl(wakeBtn, 'sun', `Écran : ${activeLock ? 'oui' : 'non'}`);
      wakeBtn.classList.toggle('btn-on', activeLock);
    });
    if (!ScreenWakeLock.supported) {
      setCtrl(wakeBtn, 'sun', 'Écran : n/d');
      wakeBtn.disabled = true;
    }

    function flush(): Promise<void> {
      if (!ride || !tracker || pending.length === 0) return flushing;
      const batch = pending;
      pending = [];
      const snap = tracker.snapshot(source?.now() ?? Date.now());
      ride.distanceM = snap.distanceM;
      ride.movingTimeS = snap.movingTimeS;
      const target = ride;
      flushing = flushing
        .then(() => appendRidePoints(target, batch))
        .catch((err: unknown) => {
          pending = batch.concat(pending); // on réessaiera
          console.error(err);
          toast(`Enregistrement impossible : ${errorMessage(err)}`, 'error');
        });
      return flushing;
    }

    function renderProfilePage(alongM: number | null): void {
      if (!elevation || !cumClimb) {
        profileInfo.replaceChildren();
        return;
      }
      if (alongM === null) {
        profileChart?.update(null, climbList[0] ?? null);
        profileInfo.replaceChildren(el('div', { class: 'climb-line muted' }, 'En attente de la position…'));
        return;
      }
      const status = climbStatus(climbList, elevation, alongM);
      const left = el('div', { class: 'climb-line' }, 'D+ restant ', el('strong', {}, `${int(remainingClimb(elevation, cumClimb, alongM))} m`));
      let main: HTMLElement;
      if (status.current) {
        const c = status.current;
        main = el(
          'div',
          { class: 'climb-box climbing' },
          el('div', { class: 'climb-title' }, icon('mountain'), 'Montée en cours'),
          el('div', { class: 'climb-big' }, `Sommet dans ${c.remainingM >= 1000 ? `${km(c.remainingM)} km` : `${int(c.remainingM)} m`}`),
          el('div', { class: 'climb-figures' }, el('span', {}, `+${int(c.remainingGainM)} m`), el('span', {}, `pente ${int(c.gradePct)} %`)),
        );
      } else if (status.next) {
        const n = status.next;
        main = el(
          'div',
          { class: 'climb-box' },
          el('div', { class: 'climb-title' }, icon('mountain'), 'Prochaine montée'),
          el('div', { class: 'climb-big' }, `dans ${km(n.distanceToStartM)} km`),
          el(
            'div',
            { class: 'climb-figures' },
            el('span', {}, `${km(n.climb.lengthM)} km`),
            el('span', {}, `${fmt1(n.climb.avgGradePct)} %`),
            el('span', {}, `+${int(n.climb.gainM)} m`),
          ),
        );
      } else {
        main = el('div', { class: 'climb-box' }, el('div', { class: 'climb-big' }, 'Plus de montée jusqu’à l’arrivée'));
      }
      profileInfo.replaceChildren(main, left);
      profileChart?.update(alongM, status.current?.climb ?? status.next?.climb ?? null);
    }

    function render(): void {
      if (!tracker || !source) return;
      const now = source.now();
      const snap = tracker.snapshot(now);

      pager.setBand(snap.speedMs === null ? '—' : fmt1(snap.speedMs * 3.6), km(snap.distanceM));
      tMoving.set(clock(snap.movingTimeS));
      tTotal.set(clock(snap.totalTimeS));
      tAvg.set(snap.movingTimeS > 30 ? fmt1((snap.distanceM / snap.movingTimeS) * 3.6) : '—');
      // « Pause auto » seulement si on a une position récente qui dit qu'on est arrêté
      // (pas pendant une coupure GPS, où l'on ne sait rien).
      tMoving.note.textContent = snap.speedMs !== null && !snap.isMoving ? ' · pause' : '';
      if (lastMatch) {
        tLeft.set(km(Math.max(0, totalM - lastMatch.alongM)));
        if (elevation && cumClimb) tClimbLeft.set(int(remainingClimb(elevation, cumClimb, lastMatch.alongM)));
      }
      if (pager.current() === 2) renderProfilePage(lastMatch ? lastMatch.alongM : null);

      // État GPS : discret dans le tableau de bord, alerte visible partout si problème.
      const age = snap.lastFix ? (now - snap.lastFix.time) / 1000 : Infinity;
      let alert: string | null = null;
      if (fatalError) alert = fatalError;
      else if (!snap.lastFix) alert = lastRejected ? `Signal GPS trop imprécis (±${int(lastRejected.accuracy)} m), patiente…` : 'Recherche du signal GPS…';
      else if (age > STALE_FIX_S) alert = `Pas de position depuis ${clock(age)}`;
      gpsAlert.hidden = alert === null;
      gpsAlert.textContent = alert ?? '';
      gpsAlert.classList.toggle('bad', fatalError !== null);
      tGps.set(snap.lastFix && age <= STALE_FIX_S ? `±${int(snap.lastFix.accuracy)} m` : '—');
      tGps.note.textContent = source.simulated ? ' simulation' : '';

      // Hors tracé (seulement avec une position récente)
      if (lastMatch && age <= STALE_FIX_S) {
        if (!offTrack && lastMatch.offTrackM > OFF_TRACK_ON_M) offTrack = true;
        else if (offTrack && lastMatch.offTrackM < OFF_TRACK_OFF_M) offTrack = false;
      }
      offTrackBanner.hidden = !offTrack;
      if (offTrack && lastMatch) offTrackBanner.replaceChildren(icon('warning'), `Hors tracé : ${int(lastMatch.offTrackM)} m`);

      // Ravitaillement : position sur le tracé si on y est, sinon temps estimé.
      if (nut) {
        const fresh = age <= STALE_FIX_S;
        const pos: RidePosition = {
          alongM: lastMatch && fresh ? lastMatch.alongM : null,
          onTrack: lastMatch !== null && fresh && !offTrack,
          movingTimeS: snap.movingTimeS,
        };
        const events = updateIntakes(nut, pos);
        // Toutes les prises déclenchées ensemble (ex. écran éteint) → une seule bannière.
        const due = events.filter((e) => e.kind === 'due').map((e) => e.intake);
        if (due.length > 0) alertsUi.showIntakes(due);
        let changed = events.length > 0;
        if (drinkDue(nut, snap.movingTimeS)) {
          markDrink(nut, snap.movingTimeS);
          alertsUi.showDrink();
          changed = true;
        }
        if (changed) saveNutrition();
        alertsUi.setAnnounced(announcedIntake(nut), pos.onTrack ? pos.alongM : null);
      }
    }

    function onFix(fix: GpsFix): void {
      if (stopped || !tracker) return;
      const verdict = filter.check(fix);
      if (!verdict.ok) {
        if (verdict.reason === 'accuracy') lastRejected = { accuracy: fix.accuracy };
        render();
        return;
      }
      lastRejected = null;
      fatalError = null;
      tracker.addFix(fix);
      lastMatch = matcher.match(fix.lat, fix.lon);
      map?.setHeading(headingEstimator.update(fix));
      map?.setPosition(fix.lat, fix.lon, fix.accuracy);
      map?.extendRideLine(fix.lat, fix.lon);
      pending.push(fix);
      if (pending.length >= FLUSH_MAX_PENDING) void flush();
      render();
    }

    function onError(message: string, fatal: boolean): void {
      if (fatal) fatalError = message;
      else toast(message, 'info', 3000);
      render();
    }

    function onVisibility(): void {
      if (document.visibilityState === 'hidden') {
        void flush();
      } else if (source && !stopped) {
        source.restart();
        sound.resume();
        void wakeLock.handleVisible();
        render();
        alertsUi.onVisible(); // bannières arrivées écran éteint : affichées maintenant, 40 s
      }
    }

    async function start(): Promise<void> {
      sound.unlock(); // doit se faire pendant l'appui sur « Démarrer » (iOS)
      startBtn.disabled = true;
      try {
        source = simulated
          ? new SimulatedGps(track.points, cum, { speedKmh: profile.avgSpeedKmh, timeFactor: Number(factorSelect.value), elevation })
          : new DeviceGps();

        if (!ride) {
          // Une autre sortie restée ouverte (autre itinéraire) est clôturée.
          const other = await getActiveRide();
          if (other && !other.simulated) await updateRide({ ...other, endedAt: Date.now() });
          nut = routeNutrition
            ? initNutritionState(freezePlan(routeNutrition.plan, routeNutrition.during.targetGPerH), rideSettings.drinkIntervalMin * 60)
            : initNutritionState(emptyPlan(FIRST_INTAKE_S), rideSettings.drinkIntervalMin * 60);
          ride = await createRide({ routeId: route.id, routeName: route.name, startedAt: source.now(), simulated, nutrition: nut });
        } else {
          nut =
            resumedNutrition ??
            initNutritionState(emptyPlan(FIRST_INTAKE_S), rideSettings.drinkIntervalMin * 60);
          nut.drinkIntervalS = rideSettings.drinkIntervalMin * 60;
          ride.nutrition = nut;
        }
        tracker = new RideTracker(ride.startedAt);

        intro.hidden = true;
        live.hidden = false;
        // Page mémorisée (ou tableau de bord) ; place la carte au bon endroit.
        mapSlotDashboard.append(mapWrap);
        pager.setPage(pager.current());
        map = createMapView(mapEl, { base: 'gravel' }); // même aspect en ligne et hors ligne
        map?.showTrack(track.points);
        map?.enableRideMode({
          orientation,
          onFollowChange: (follow) => (recenterBtn.hidden = follow),
          onOrientationToggle: toggleOrientation,
        });
        requestAnimationFrame(() => {
          map?.invalidateSize();
          if (resumeFixes.length === 0) map?.fitTrack();
        });

        // Reprise : on rejoue les positions déjà enregistrées.
        for (const f of resumeFixes) {
          tracker.addFix(f);
          lastMatch = matcher.match(f.lat, f.lon);
          headingEstimator.update(f);
        }
        map?.setHeading(headingEstimator.heading);
        const lastFix = resumeFixes[resumeFixes.length - 1] ?? null;
        filter.prime(lastFix);
        map?.setRideLine(resumeFixes);
        if (lastFix) map?.setPosition(lastFix.lat, lastFix.lon, lastFix.accuracy);
        resumeFixes = [];

        if (ScreenWakeLock.supported) {
          const ok = await wakeLock.enable();
          if (!ok) toast('Impossible de garder l’écran allumé. Règle « Verrouillage auto » dans Réglages › Luminosité.', 'info', 6000);
        }

        source.start(onFix, onError);
        document.addEventListener('visibilitychange', onVisibility);
        uiTimer = window.setInterval(render, 1000);
        flushTimer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);
        render();
        renderProfilePage(lastMatch ? lastMatch.alongM : null);
      } catch (err) {
        startBtn.disabled = false;
        toast(errorMessage(err), 'error');
      }
    }

    startBtn.addEventListener('click', () => void start());

    recenterBtn.addEventListener('click', () => {
      map?.setFollowing(true);
      recenterBtn.hidden = true;
    });

    wakeBtn.addEventListener('click', async () => {
      if (wakeLock.enabled) await wakeLock.disable();
      else if (!(await wakeLock.enable())) toast('Le navigateur a refusé de garder l’écran allumé.', 'error');
    });

    finishBtn.addEventListener('click', async () => {
      if (!finishBtn.classList.contains('confirm')) {
        finishBtn.classList.add('confirm');
        setCtrl(finishBtn, 'check', 'Confirmer ?');
        confirmTimer = window.setTimeout(() => {
          finishBtn.classList.remove('confirm');
          setCtrl(finishBtn, 'square', 'Terminer');
        }, 4000);
        return;
      }
      window.clearTimeout(confirmTimer);
      finishBtn.disabled = true;
      const snap = tracker?.snapshot(source?.now() ?? Date.now());
      stopTracking();
      try {
        await flush();
        await flushing;
        if (ride && snap) {
          const fixes = await getRidePoints(ride.id);
          ride.summary = buildRideSummary(fixes, snap, nut ? summarizeNutrition(nut, snap.movingTimeS) : null);
          if (nut) ride.nutrition = nut;
          ride.distanceM = snap.distanceM;
          ride.movingTimeS = snap.movingTimeS;
          ride.endedAt = source?.now() ?? Date.now();
          await updateRide(ride);
          navigate(`/sorties/${encodeURIComponent(ride.id)}`);
          return;
        }
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      navigate(`/itineraire/${encodeURIComponent(route.id)}`);
    });

    function stopTracking(): void {
      if (stopped) return;
      stopped = true;
      source?.stop();
      window.clearInterval(uiTimer);
      window.clearInterval(flushTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      void wakeLock.disable();
    }

    return () => {
      window.clearTimeout(confirmTimer);
      stopTracking();
      void flush();
      document.body.classList.remove('ride-mode');
      offlineCard.destroy();
      pager.destroy();
      alertsUi.destroy();
      sound.close();
      profileChart?.destroy();
      map?.destroy();
    };
  };
}
