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
- **MapLibre GL JS** (rotation native, `padding` pour décaler le centre) avec tuiles raster CyclOSM (défaut) et OpenTopoMap, attribution visible, pas de pré-téléchargement de tuiles. Leaflet a été abandonné : pas de rotation (plugins fragiles). Le worker MapLibre est fourni via `setWorkerUrl(...?url)` (sinon introuvable avec Vite) et doit rester dans le précache (`mjs` dans globPatterns).
- IndexedDB via `idb`.
- vite-plugin-pwa (manifest + service worker Workbox), `registerType: 'prompt'` : pas de rechargement automatique pendant une sortie, bannière « Mettre à jour ».
- Vitest (+ jsdom pour les tests qui ont besoin de DOMParser ; happy-dom lit mal le XML).
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
    geo/climbs.ts      détection des montées (montée dès +8 m, fin à −10 m sous le sommet, rognage < 2 %, garde ≥ 20 m et ≥ 3 %), climbStatus (en cours / prochaine), gradeAt
    geo/trackMatch.ts  RouteMatcher : progression + écart au tracé, recherche locale (−200 m/+1,5 km) puis globale
    gps/heading.ts     HeadingEstimator : cap depuis les déplacements, > 5 km/h et ≥ 10 m, lissage circulaire, gardé à l'arrêt
    gps/filter.ts      GpsFilter : précision > 30 m, temps non croissant, vitesse > 90 km/h (marge = précisions)
    ride/tracker.ts    RideTracker : distance, vitesse lissée, temps en mouvement (pause auto 3 / 1,5 km/h), trous > 15 s
    gpx/parse.ts       GPX 1.0/1.1, trk puis rte, ignore les namespaces (getElementsByTagNameNS('*'))
    gpx/write.ts       GPX 1.1
    energy/model.ts    modèle physique : puissance CONSTANTE trouvée par dichotomie pour tenir la vitesse moyenne du profil ;
                       Crr 0,010, CdA 0,40 × (surface corporelle Du Bois / 1,85), ρ selon altitude, transmission 97 %,
                       vitesse plafonnée 40 km/h en descente, rendement musculaire brut 24 % ; timeAt[] = temps cumulé par échantillon
    nutrition/recommendations.ts  avant (1–4 g/kg selon durée, 2–4 h avant), pendant (<1h30 facultatif ; ≤2h30 30–60 g/h ;
                       >2h30 60–90 g/h ; objectif bas/milieu/haut selon niveau), eau 500–750 mL/h ; sources citées en tête
    nutrition/foods.ts aliments par défaut (glucides/portion, max par prise), sanitizeFoods
    nutrition/plan.ts  prises : 1re à 30 min, puis ≤ 25 min d'écart, dernière ≥ 15 min avant la fin ; décalées (±1 km) vers un
                       point « calme » (pente −3…+4 %, hors montée) ; portions : aliments principaux en rotation + petits en complément
    backup.ts          format JSON de sauvegarde (app, version, stores), parseBackup (vérifie tout avant d'écrire), describeBackup
  services/    accès aux API du navigateur
    db.ts              IndexedDB v2 : routes, routeTracks, settings (clés 'profile', 'foods'), rides (résumé), ridePoints (positions
                       filtrées, ajout par lots) ; dumpAll / restoreAll (FUSION par identifiant, une transaction, positions
                       d'une sortie remplacées pour éviter les doublons)
    files.ts           lecture fichier, export via Web Share (iOS « Enregistrer dans Fichiers ») ou téléchargement
    geolocation.ts     PositionSource + DeviceGps (watchPosition haute précision, relancé au retour premier plan)
    simulator.ts       SimulatedGps : rejoue un itinéraire (bruit, points imprécis, arrêt km 1, écart 80 m km 2, trou km 3)
    wakeLock.ts        ScreenWakeLock (redemandé au retour au premier plan)
  map/mapView.ts       MapView (MapLibre) + createMapView (message si WebGL indisponible) ; mode sortie : flèche (Marker rotationAlignment map), boussole (tap = bascule), « sens de la marche » (bearing = cap, position au tiers bas via padding top = h/3) ou « nord en haut », trace bleue regroupée toutes les 2 s, suivi/recentrer ; en dev, `window.__gcMap`
  ui/
    router.ts          routeur par hash (#/, #/itineraire/:id, #/nutrition/:id, #/profil, #/aliments, #/sortie/:id, #/simulation/:id)
    help.ts            textes réutilisés (avertissement médical, aide sauvegarde)
    pager.ts           logique pure de pagination (glissement, page mémorisée) — testée
    views/             écrans ; ride.ts = mode sortie (masque en-tête et onglets via body.ride-mode) en 3 pages :
                       0 Tableau de bord (carte + chiffres + commandes), 1 Carte plein écran, 2 Profil (montées) ;
                       profile.ts (formulaire complet + Mes données export/import), foods.ts (enregistrement auto),
                       nutrition.ts (dépense + détail du calcul, avant/pendant, j'emporte, plan des prises, à emporter)
    components/        elevationChart (fiche itinéraire), rideProfile (profil en sortie : parcouru bleu via clipPath, montée orange),
                       ridePager (pages 3/4 + bandeau 1/4 : vitesse, km, cadenas, points ; glissement UNIQUEMENT sur le bandeau ;
                       cadenas = voile plein écran, appui long 1 s pour déverrouiller ; zone d’alertes commune), toasts
  main.ts              coquille (en-tête, onglets), routeur, service worker
scripts/make-icons.mjs génère les PNG d'icônes dans public/ (npm run icons)
docs/GUIDE.md          guide pas à pas pour l'utilisateur (installation, test, mise en ligne, iPhone)
```

## Règles
- Toute la logique de calcul va dans `core/` avec des tests ; pas d'accès DOM/IndexedDB dans `core/` (sauf DOMParser pour le GPX).
- Base de données : pour une évolution, incrémenter `DB_VERSION` et ajouter un bloc `if (oldVersion < N)` dans `upgrade()`, rendu idempotent (`objectStoreNames.contains`). Ne jamais modifier un bloc existant. Attention en dev : le rechargement à chaud peut appliquer un `DB_VERSION` modifié avant le bloc de migration → écrire le bloc AVANT d'incrémenter la version.
- Mode sortie : les positions acceptées sont enregistrées toutes les 15 s / 30 points et au passage en arrière-plan ; une sortie avec `endedAt === null` est proposée à la reprise (bannière dans la liste) et rejouée dans RideTracker. Les simulations sont supprimées à la fin et ne sont jamais reprises.
- Mode sortie : UNE seule carte MapLibre, déplacée entre les emplacements des pages 0 et 1 (puis `relayout()`). La page affichée est mémorisée dans localStorage `gc.ride.page`. Les alertes (hors tracé, GPS) vont dans `pager.alerts`, jamais dans une page.
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
npm run preview    # sert dist/ sous /gravel-app/ (comme en ligne)
npm run icons      # regénérer les icônes
```
Déploiement : `git push` sur `main` → GitHub Actions → https://lucasbergere35-pixel.github.io/gravel-app/ (dépôt lucasbergere35-pixel/gravel-app). Le premier push demande une connexion GitHub interactive : le lancer dans un onglet Terminal de l'utilisateur.

## Feuille de route
- [x] Étape 1 : projet, import GPX, carte, stats, profil altimétrique, liste (renommer/supprimer), export GPX, PWA, déploiement
- [x] Étape 2 (+ carte orientée dans le sens de la marche, MapLibre) : mode sortie GPS (filtre, recalage, alerte hors tracé > 50 m / levée < 40 m, distance/D+ restants, temps total + temps en mouvement avec pause auto, Wake Lock, reprise au premier plan, enregistrement incrémental + reprise après fermeture, simulation)
- [x] Mode sortie en 3 pages (tableau de bord / carte / profil avec montées), bandeau fixe, cadenas
- [x] Étape 3 : profil complet + modèle énergie + plan nutrition (sources : Thomas/Erdman/Burke 2016 ACSM ; Jeukendrup 2014 ; Sawka 2007 ACSM) + export/import de toutes les données en JSON. Toujours afficher l'avertissement « pas un avis médical » (`describeHelp.medical`).
- [ ] Étape 4 : alertes nutrition en sortie (bannière, son, « Fait », rappel boisson ~20 min), export GPX de la sortie
- Plus tard : BRouter, points d'eau OSM (Overpass), météo Open-Meteo, cartes hors ligne (autre source de tuiles), type de surface, bilan après sortie
