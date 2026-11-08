# Gravel Compagnon — contexte projet

PWA (application web installable) pour préparer et suivre des sorties en vélo gravel,
utilisée sur iPhone via Safari → « Sur l'écran d'accueil ». Interface en **français**.

Utilisateur : débutant en développement web, sur **Windows, sans Mac**. Expliquer chaque
étape simplement, donner les commandes exactes, dire précisément quoi tester sur l'iPhone.

## Priorités
Robustesse et code clair > nombre de fonctionnalités. Mobile d'abord, lisible en plein soleil
(thème clair fort contraste, gros chiffres, boutons ≥ 52 px). Aucun backend, aucune clé API payante.

## Stack
- Vite + TypeScript strict, **sans framework** (DOM via le helper `el()` de `src/ui/dom.ts`, jamais `innerHTML` avec des données).
- Leaflet ; fonds **CyclOSM** (défaut) et OpenTopoMap, attribution visible, pas de pré-téléchargement de tuiles.
- IndexedDB via `idb`.
- vite-plugin-pwa (manifest + service worker Workbox), `registerType: 'prompt'` : pas de rechargement automatique pendant une sortie, bannière « Mettre à jour ».
- Vitest (+ happy-dom pour les tests qui ont besoin de DOMParser).
- Hébergement : GitHub Pages via GitHub Actions (`.github/workflows/deploy.yml`), base `/gravel-app/` (= nom du dépôt, voir `vite.config.ts`).

## Architecture
```
src/
  core/        logique pure, sans UI, testée (tests/)
    types.ts           TrackPoint, Waypoint
    geo/distance.ts    haversine, distances cumulées
    geo/elevation.ts   profil : interpolation → ré-échantillonnage 10 m → moyenne glissante 100 m → hystérésis 4 m
    geo/stats.ts       RouteStats + STATS_VERSION (incrémenter si l'algo change → recalcul auto)
    geo/track.ts       pointAtDistance
    geo/trackMatch.ts  RouteMatcher : progression + écart au tracé, recherche locale (−200 m/+1,5 km) puis globale
    gps/filter.ts      GpsFilter : précision > 30 m, temps non croissant, vitesse > 90 km/h (marge = précisions)
    ride/tracker.ts    RideTracker : distance, vitesse lissée, temps en mouvement (pause auto 3 / 1,5 km/h), trous > 15 s
    gpx/parse.ts       GPX 1.0/1.1, trk puis rte, ignore les namespaces (getElementsByTagNameNS('*'))
    gpx/write.ts       GPX 1.1
  services/    accès aux API du navigateur
    db.ts              IndexedDB v2 : routes, routeTracks, settings, rides (résumé), ridePoints (positions filtrées, ajout par lots)
    files.ts           lecture fichier, export via Web Share (iOS « Enregistrer dans Fichiers ») ou téléchargement
    geolocation.ts     PositionSource + DeviceGps (watchPosition haute précision, relancé au retour premier plan)
    simulator.ts       SimulatedGps : rejoue un itinéraire (bruit, points imprécis, arrêt km 1, écart 80 m km 2, trou km 3)
    wakeLock.ts        ScreenWakeLock (redemandé au retour au premier plan)
  map/mapView.ts       classe MapView (Leaflet) ; mode sortie : position, précision, trace bleue, suivi/recentrer
  ui/
    router.ts          routeur par hash (#/, #/itineraire/:id, #/profil, #/sortie/:id, #/simulation/:id)
    views/             écrans ; ride.ts = mode sortie (masque en-tête et onglets via body.ride-mode)
    components/        profil altimétrique SVG, toasts
  main.ts              coquille (en-tête, onglets), routeur, service worker
scripts/make-icons.mjs génère les PNG d'icônes dans public/ (npm run icons)
docs/GUIDE.md          guide pas à pas pour l'utilisateur (installation, test, mise en ligne, iPhone)
```

## Règles
- Toute la logique de calcul va dans `core/` avec des tests ; pas d'accès DOM/IndexedDB dans `core/` (sauf DOMParser pour le GPX).
- Base de données : pour une évolution, incrémenter `DB_VERSION` et ajouter un bloc `if (oldVersion < N)` dans `upgrade()`, rendu idempotent (`objectStoreNames.contains`). Ne jamais modifier un bloc existant. Attention en dev : le rechargement à chaud peut appliquer un `DB_VERSION` modifié avant le bloc de migration → écrire le bloc AVANT d'incrémenter la version.
- Mode sortie : les positions acceptées sont enregistrées toutes les 15 s / 30 points et au passage en arrière-plan ; une sortie avec `endedAt === null` est proposée à la reprise (bannière dans la liste) et rejouée dans RideTracker. Les simulations sont supprimées à la fin et ne sont jamais reprises.
- Dans le mode sortie, l'heure de référence vient de `PositionSource.now()` (accélérée en simulation), jamais directement de `Date.now()`.
- Import de fichier : **ne pas mettre d'attribut `accept`** sur l'input (sinon les .gpx sont grisés dans Fichiers sur iOS).
- iOS : pas de vibration ; le son est coupé par le bouton silencieux et doit être « débloqué » par un geste ; GPS suspendu écran verrouillé ; Wake Lock en mode écran d'accueil seulement depuis iOS 18.4 environ.
- Pas de `Math.min(...grosTableau)` (limite d'arguments de Safari).

## Commandes
```
npm install        # une fois, après clonage
npm run dev        # serveur local http://localhost:5173
npm test           # tests unitaires
npm run build      # vérification TypeScript + build dans dist/
npm run preview    # sert dist/ (tester le service worker)
npm run icons      # regénérer les icônes
```
Déploiement : `git push` sur `main` → GitHub Actions → https://<pseudo>.github.io/gravel-app/

## Feuille de route
- [x] Étape 1 : projet, import GPX, carte, stats, profil altimétrique, liste (renommer/supprimer), export GPX, PWA, déploiement
- [x] Étape 2 : mode sortie GPS (filtre, recalage, alerte hors tracé > 50 m / levée < 40 m, distance/D+ restants, temps total + temps en mouvement avec pause auto, Wake Lock, reprise au premier plan, enregistrement incrémental + reprise après fermeture, simulation)
- [ ] Étape 3 : profil complet + modèle énergie (Crr 0,010, CdA ~0,40, rendement 24 %, puissance constante calée sur la vitesse moyenne) + plan nutrition (sources : Thomas/Erdman/Burke 2016 ACSM ; Jeukendrup 2014 ; Sawka 2007 ACSM) + **export/import de toutes les données en JSON**
- [ ] Étape 4 : alertes nutrition en sortie (bannière, son, « Fait », rappel boisson ~20 min), export GPX de la sortie
- Plus tard : BRouter, points d'eau OSM (Overpass), météo Open-Meteo, cartes hors ligne (autre source de tuiles), type de surface, bilan après sortie
