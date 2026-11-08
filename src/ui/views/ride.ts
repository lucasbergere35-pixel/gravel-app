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
import { HeadingEstimator } from '../../core/gps/heading';
import type { GpsFix } from '../../core/gps/types';
import { RideTracker, STALE_FIX_S } from '../../core/ride/tracker';
import { createMapView, type MapView, type OrientationMode } from '../../map/mapView';
import {
  appendRidePoints,
  createRide,
  deleteRide,
  getActiveRide,
  getProfile,
  getRidePoints,
  getRoute,
  updateRide,
  type RideMeta,
} from '../../services/db';
import { DeviceGps, type PositionSource } from '../../services/geolocation';
import { SimulatedGps } from '../../services/simulator';
import { ScreenWakeLock } from '../../services/wakeLock';
import { createRidePager } from '../components/ridePager';
import { createRideProfile } from '../components/rideProfile';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { clock, int, km } from '../format';
import { navigate, type View } from '../router';

/** Alerte hors tracé au-delà de OFF_TRACK_ON_M, levée sous OFF_TRACK_OFF_M (hystérésis). */
const OFF_TRACK_ON_M = 50;
const OFF_TRACK_OFF_M = 40;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_MAX_PENDING = 30;
const PAGE_DASHBOARD = 0;
const PAGE_MAP = 1;

/** Une tuile de chiffre : retourne l'élément et une fonction pour changer la valeur. */
function tile(label: string, unit: string): { node: HTMLElement; set: (v: string) => void; note: HTMLElement } {
  const value = el('span', {}, '—');
  const note = el('span', { class: 'ride-note' });
  const node = el(
    'div',
    { class: 'ride-tile' },
    el('div', { class: 'ride-value' }, value, unit ? el('span', { class: 'ride-unit' }, unit) : null),
    el('div', { class: 'ride-label' }, label, note),
  );
  return { node, set: (v) => (value.textContent = v), note };
}

const fmt1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function createRideView(simulated: boolean): View {
  return async (root, params) => {
    const [data, profile] = await Promise.all([getRoute(params.id), getProfile()]);
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
    const recenterBtn = el('button', { type: 'button', class: 'btn btn-small recenter', hidden: true }, '◎ Recentrer');
    const mapWrap = el('div', { class: 'map-wrap' }, mapEl, recenterBtn);

    // ---------- Page 1 : tableau de bord ----------
    const tLeft = tile('Restant', ' km');
    const tClimbLeft = tile('D+ restant', ' m');
    const tAvg = tile('Moyenne', ' km/h');
    const tMoving = tile('En mouvement', '');
    const tTotal = tile('Temps total', '');
    const tGps = tile('GPS', '');
    if (!cumClimb) tClimbLeft.set('n/d');

    const orientBtn = el('button', { type: 'button', class: 'btn ctrl-btn' });
    const wakeBtn = el('button', { type: 'button', class: 'btn ctrl-btn' }, 'Écran : NON');
    const finishBtn = el('button', { type: 'button', class: 'btn btn-danger ctrl-btn' }, 'Terminer');
    const quitLink = el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'btn ctrl-btn' }, 'Quitter');
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
      el('div', { class: 'ride-controls' }, orientBtn, wakeBtn, finishBtn, quitLink),
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
      { id: 'sim-factor', class: 'select' },
      el('option', { value: '1' }, 'Temps réel (×1)'),
      el('option', { value: '10', selected: true }, 'Accéléré ×10'),
      el('option', { value: '30' }, 'Accéléré ×30'),
    );
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-block btn-huge' }, ride ? '▶ Reprendre la sortie' : '▶ Démarrer');
    const intro = el(
      'div',
      { class: 'ride-intro' },
      el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'back-link' }, '‹ Retour'),
      el('h1', {}, simulated ? `Simulation : ${route.name}` : route.name),
      el('p', {}, `${km(totalM)} km · ${climbList.length} montée${climbList.length > 1 ? 's' : ''} repérée${climbList.length > 1 ? 's' : ''}`),
      simulated
        ? el(
            'div',
            { class: 'card stack' },
            el('p', {}, `Rejoue l’itinéraire à ${int(profile.avgSpeedKmh)} km/h avec un arrêt au km 1, un écart de 80 m au km 2 et une coupure GPS au km 3. Rien n’est conservé.`),
            el('label', { for: 'sim-factor', class: 'field-label' }, 'Vitesse de la simulation'),
            factorSelect,
          )
        : el(
            'div',
            { class: 'card' },
            el('p', {}, 'Garde l’appli ouverte au premier plan. Si l’écran s’éteint, l’enregistrement s’interrompt et reprend au rallumage (un trait droit relie les deux points).'),
            ride ? el('p', { class: 'muted' }, 'Une sortie non terminée a été trouvée sur cet itinéraire : elle va être reprise.') : null,
          ),
      el('p', { class: 'muted' }, 'En sortie : glisse sur le bandeau du bas (ou touche ● ○ ○) pour changer de page. 🔓 verrouille l’écran.'),
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
    orientBtn.textContent = ORIENT_LABELS[orientation];
    function toggleOrientation(): void {
      orientation = orientation === 'heading' ? 'north' : 'heading';
      orientBtn.textContent = ORIENT_LABELS[orientation];
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

    const wakeLock = new ScreenWakeLock((activeLock) => {
      if (!ScreenWakeLock.supported) return;
      wakeBtn.textContent = `Écran : ${activeLock ? 'OUI' : 'NON'}`;
      wakeBtn.classList.toggle('btn-on', activeLock);
    });
    if (!ScreenWakeLock.supported) {
      wakeBtn.textContent = 'Écran : n/d';
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
          el('div', { class: 'climb-title' }, '⛰ Montée en cours'),
          el('div', { class: 'climb-big' }, `Sommet dans ${c.remainingM >= 1000 ? `${km(c.remainingM)} km` : `${int(c.remainingM)} m`}`),
          el('div', { class: 'climb-figures' }, el('span', {}, `+${int(c.remainingGainM)} m`), el('span', {}, `pente ${int(c.gradePct)} %`)),
        );
      } else if (status.next) {
        const n = status.next;
        main = el(
          'div',
          { class: 'climb-box' },
          el('div', { class: 'climb-title' }, 'Prochaine montée'),
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
      tMoving.note.textContent = snap.speedMs !== null && !snap.isMoving ? ' ⏸ pause' : '';
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
      if (offTrack && lastMatch) offTrackBanner.textContent = `⚠ Hors tracé : ${int(lastMatch.offTrackM)} m`;
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
        void wakeLock.handleVisible();
        render();
      }
    }

    async function start(): Promise<void> {
      startBtn.disabled = true;
      try {
        source = simulated
          ? new SimulatedGps(track.points, cum, { speedKmh: profile.avgSpeedKmh, timeFactor: Number(factorSelect.value) })
          : new DeviceGps();

        if (!ride) {
          // Une autre sortie restée ouverte (autre itinéraire) est clôturée.
          const other = await getActiveRide();
          if (other && !other.simulated) await updateRide({ ...other, endedAt: Date.now() });
          ride = await createRide({ routeId: route.id, routeName: route.name, startedAt: source.now(), simulated });
        }
        tracker = new RideTracker(ride.startedAt);

        intro.hidden = true;
        live.hidden = false;
        // Page mémorisée (ou tableau de bord) ; place la carte au bon endroit.
        mapSlotDashboard.append(mapWrap);
        pager.setPage(pager.current());
        map = createMapView(mapEl);
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
        finishBtn.textContent = 'Confirmer ?';
        confirmTimer = window.setTimeout(() => {
          finishBtn.classList.remove('confirm');
          finishBtn.textContent = 'Terminer';
        }, 4000);
        return;
      }
      window.clearTimeout(confirmTimer);
      finishBtn.disabled = true;
      const snap = tracker?.snapshot(source?.now() ?? Date.now());
      stopTracking();
      try {
        await flush();
        if (ride) {
          if (ride.simulated) await deleteRide(ride.id);
          else await updateRide({ ...ride, endedAt: source?.now() ?? Date.now() });
        }
        if (snap) toast(`Sortie terminée : ${km(snap.distanceM)} km, ${clock(snap.movingTimeS)} en mouvement`, 'success', 6000);
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
      pager.destroy();
      profileChart?.destroy();
      map?.destroy();
    };
  };
}
