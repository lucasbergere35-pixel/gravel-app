/**
 * Écran « Mode sortie » : suivi GPS en temps réel sur un itinéraire.
 *
 * Flux d'une position :
 *   source (GPS ou simulation) → GpsFilter (rejette les points douteux)
 *   → RideTracker (distance, vitesse, temps en mouvement)
 *   → RouteMatcher (progression sur le tracé, écart au tracé)
 *   → carte + affichage, et mise en file pour l'enregistrement (IndexedDB).
 *
 * Robustesse :
 *  - les positions sont enregistrées toutes les 15 s et dès que l'appli passe
 *    en arrière-plan : si iOS ferme l'appli, la sortie peut être reprise ;
 *  - au retour au premier plan, le GPS et le maintien d'écran sont relancés.
 */
import { cumulativeDistances } from '../../core/geo/distance';
import { buildElevationProfile, cumulativeClimb, remainingClimb } from '../../core/geo/elevation';
import { RouteMatcher, type MatchResult } from '../../core/geo/trackMatch';
import { GpsFilter } from '../../core/gps/filter';
import type { GpsFix } from '../../core/gps/types';
import { RideTracker, STALE_FIX_S } from '../../core/ride/tracker';
import { MapView } from '../../map/mapView';
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
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import { clock, int, km } from '../format';
import { navigate, type View } from '../router';

/** Alerte hors tracé au-delà de OFF_TRACK_ON_M, levée sous OFF_TRACK_OFF_M (hystérésis). */
const OFF_TRACK_ON_M = 50;
const OFF_TRACK_OFF_M = 40;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_MAX_PENDING = 30;

/** Une tuile de chiffre : retourne l'élément et une fonction pour changer la valeur. */
function tile(label: string, unit: string, extraClass = ''): { node: HTMLElement; set: (v: string) => void; note: HTMLElement } {
  const value = el('span', {}, '—');
  const note = el('span', { class: 'ride-note' });
  const node = el(
    'div',
    { class: `ride-tile ${extraClass}` },
    el('div', { class: 'ride-value' }, value, unit ? el('span', { class: 'ride-unit' }, unit) : null),
    el('div', { class: 'ride-label' }, label, note),
  );
  return { node, set: (v) => (value.textContent = v), note };
}

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
    const climbs = elevation ? cumulativeClimb(elevation.elevations) : null;

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

    // ---------- Interface ----------
    const offTrackBanner = el('div', { class: 'offtrack-banner', hidden: true, role: 'alert' });
    const gpsStatus = el('div', { class: 'gps-status' }, 'GPS en attente');
    const mapEl = el('div', { class: 'map map-ride' });
    const recenterBtn = el('button', { type: 'button', class: 'btn btn-small recenter', hidden: true }, '◎ Recentrer');

    const tSpeed = tile('Vitesse', ' km/h', 'ride-tile-speed');
    const tDone = tile('Parcouru', ' km');
    const tLeft = tile('Restant', ' km');
    const tClimbLeft = tile('D+ restant', ' m');
    const tAvg = tile('Moyenne', ' km/h');
    const tMoving = tile('En mouvement', '');
    const tTotal = tile('Temps total', '');
    if (!climbs) tClimbLeft.set('n/d');

    const wakeBtn = el('button', { type: 'button', class: 'btn btn-block' }, 'Écran allumé : NON');
    const finishBtn = el('button', { type: 'button', class: 'btn btn-danger btn-block' }, 'Terminer la sortie');
    const quitLink = el('a', { href: `#/itineraire/${encodeURIComponent(route.id)}`, class: 'back-link' }, '‹ Quitter (la sortie reste en cours)');

    const live = el(
      'div',
      { class: 'ride-live', hidden: true },
      offTrackBanner,
      gpsStatus,
      el('div', { class: 'map-wrap' }, mapEl, recenterBtn),
      el('div', { class: 'ride-grid' }, tSpeed.node, tDone.node, tLeft.node, tClimbLeft.node, tAvg.node, tMoving.node, tTotal.node),
      el('div', { class: 'stack' }, wakeBtn, finishBtn),
      quitLink,
    );

    // Écran de départ
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
      el('p', {}, `${km(totalM)} km`),
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
      startBtn,
    );

    root.append(intro, live);

    // ---------- Logique ----------
    const filter = new GpsFilter();
    const matcher = new RouteMatcher(track.points, cum);
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
      wakeBtn.textContent = `Écran allumé : ${activeLock ? 'OUI' : 'NON'}`;
      wakeBtn.classList.toggle('btn-on', activeLock);
    });
    if (!ScreenWakeLock.supported) {
      wakeBtn.textContent = 'Écran allumé : non disponible';
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

    function render(): void {
      if (!tracker || !source) return;
      const now = source.now();
      const snap = tracker.snapshot(now);

      tSpeed.set(snap.speedMs === null ? '—' : (snap.speedMs * 3.6).toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
      tDone.set(km(snap.distanceM));
      tMoving.set(clock(snap.movingTimeS));
      tTotal.set(clock(snap.totalTimeS));
      tAvg.set(snap.movingTimeS > 30 ? ((snap.distanceM / snap.movingTimeS) * 3.6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—');
      // « Pause auto » seulement si on a une position récente qui dit qu'on est arrêté
      // (pas pendant une coupure GPS, où l'on ne sait rien).
      tMoving.note.textContent = snap.speedMs !== null && !snap.isMoving ? ' · ⏸ pause auto' : '';
      if (lastMatch) {
        tLeft.set(km(Math.max(0, totalM - lastMatch.alongM)));
        if (elevation && climbs) tClimbLeft.set(int(remainingClimb(elevation, climbs, lastMatch.alongM)));
      }

      // État GPS
      const age = snap.lastFix ? (now - snap.lastFix.time) / 1000 : Infinity;
      gpsStatus.className = 'gps-status';
      if (fatalError) {
        gpsStatus.textContent = fatalError;
        gpsStatus.classList.add('bad');
      } else if (!snap.lastFix) {
        gpsStatus.textContent = lastRejected ? `Signal GPS trop imprécis (±${int(lastRejected.accuracy)} m), patiente…` : 'Recherche du signal GPS…';
        gpsStatus.classList.add('warn');
      } else if (age > STALE_FIX_S) {
        gpsStatus.textContent = `Pas de position depuis ${clock(age)}`;
        gpsStatus.classList.add('warn');
      } else {
        gpsStatus.textContent = `GPS ±${int(snap.lastFix.accuracy)} m${source.simulated ? ' · SIMULATION' : ''}`;
        gpsStatus.classList.add('ok');
      }

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
        map = new MapView(mapEl);
        map.showTrack(track.points);
        map.enableRideMode((follow) => (recenterBtn.hidden = follow));
        requestAnimationFrame(() => {
          map?.invalidateSize();
          if (resumeFixes.length === 0) map?.fitTrack();
        });

        // Reprise : on rejoue les positions déjà enregistrées.
        for (const f of resumeFixes) {
          tracker.addFix(f);
          lastMatch = matcher.match(f.lat, f.lon);
        }
        const lastFix = resumeFixes[resumeFixes.length - 1] ?? null;
        filter.prime(lastFix);
        map.setRideLine(resumeFixes);
        if (lastFix) map.setPosition(lastFix.lat, lastFix.lon, lastFix.accuracy);
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
        finishBtn.textContent = 'Appuie encore pour terminer';
        confirmTimer = window.setTimeout(() => {
          finishBtn.classList.remove('confirm');
          finishBtn.textContent = 'Terminer la sortie';
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
      map?.destroy();
    };
  };
}
