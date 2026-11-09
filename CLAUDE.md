# Gravel Compagnon — contexte projet

PWA (application web installable) pour préparer et suivre des sorties en vélo gravel,
utilisée sur iPhone via Safari → « Sur l'écran d'accueil ». Interface en **français**.

Utilisateur : débutant en développement web, sur **Windows, sans Mac**. Expliquer chaque
étape simplement, donner les commandes exactes, dire précisément quoi tester sur l'iPhone.

## Priorités
Robustesse et code clair > nombre de fonctionnalités. Mobile d'abord, lisible en plein soleil
(gros chiffres, boutons ≥ 52 px). Aucun backend, aucune clé API payante.

## Design (direction « Épuré clair », inspirée de Komoot sans le copier)
- Police système (-apple-system / SF Pro), espace, coins arrondis (18 px), ombres légères, accent vert #3d8b37.
- Couleurs = variables CSS (`--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--line`, `--accent`…) en tête de
  `src/styles.css`. Mode sombre AUTOMATIQUE (`prefers-color-scheme`), SAUF en sortie : `body.ride-mode` force les couleurs claires
  très contrastées (plein soleil, pas de gris clair, chiffres noirs).
- AUCUN émoji : icônes Lucide via `icon('nom')` de `src/ui/icons.ts` (n'importe que les icônes listées ; en ajouter une = l'importer
  et l'ajouter à ICONS). Lucide 1.x : Trash (pas Trash2), TriangleExclamationPoint, FaceSlightlySmiling…
- Composants CSS : `.card`, `.chips/.chip`, `.badge`, `.btn(-primary/-danger/-small/-block/-huge)`, `.icon-btn`,
  formulaires type Réglages iOS (`.group-title` + `.group` de `.form-row` avec `.row-label`, `input.switch`, `.segmented`,
  `.group-footer`), `.timeline/.tl-item` (plan nutrition), fiche itinéraire = `.detail` (carte collante) + `.sheet` (panneau).
- Barre d'onglets en bas (Itinéraires, Sorties, Aliments, Profil), marges `env(safe-area-inset-*)` ; plus d'en-tête global.

## Stack
- Vite + TypeScript strict, **sans framework** (DOM via le helper `el()` de `src/ui/dom.ts`, jamais `innerHTML` avec des données).
- **MapLibre GL JS** (rotation native, `padding` pour décaler le centre) : fond « Gravel » vectoriel (OpenFreeMap, téléchargeable hors ligne) et tuiles raster CyclOSM / OpenTopoMap (en ligne), attribution visible. Leaflet a été abandonné : pas de rotation (plugins fragiles). Le worker MapLibre est fourni via `setWorkerUrl(...?url)` (sinon introuvable avec Vite) et doit rester dans le précache (`mjs` dans globPatterns).
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
    geo/slope.ts       classes de pente du profil (vert < 3 %, jaune 3–6 %, orange 6–9 %, rouge > 9 %, valeur absolue sur 100 m), slopeRuns
    geo/preview.ts     aperçu miniature du tracé (≤ 80 points dans un carré 0…1) → RouteMeta.preview (calculé à la volée pour les anciens)
    geo/climbs.ts      détection des montées (montée dès +8 m, fin à −10 m sous le sommet, rognage < 2 %, garde ≥ 20 m et ≥ 3 %), climbStatus (en cours / prochaine), gradeAt
    geo/trackMatch.ts  RouteMatcher : progression + écart au tracé, recherche locale (−200 m/+1,5 km) puis globale
    gps/heading.ts     HeadingEstimator : cap depuis les déplacements, > 5 km/h et ≥ 10 m, lissage circulaire, gardé à l'arrêt
    gps/filter.ts      GpsFilter : précision > 30 m, temps non croissant, vitesse > 90 km/h (marge = précisions)
    ride/tracker.ts    RideTracker : distance, vitesse lissée, temps en mouvement (pause auto 3 / 1,5 km/h), trous > 15 s
    gpx/parse.ts       GPX 1.0/1.1, trk puis rte, ignore les namespaces (getElementsByTagNameNS('*'))
    gpx/write.ts       GPX 1.1
    energy/model.ts    modèle physique : puissance VARIABLE (base P jusqu'à 2 %, P × (1 + bonus) dès 4 %, bonus réglable,
                       défaut +25 %) ; P trouvée par dichotomie pour tenir la vitesse moyenne ; Crr 0,010, CdA 0,40 × (surface
                       corporelle Du Bois / 1,85), ρ selon altitude, transmission 97 %, 40 km/h max en descente, rendement 24 % ;
                       timeAt[] (s) et energyAt[] (kcal) cumulés par échantillon ; seriesAtDistance / distanceAtSeries.
                       NB : à vitesse moyenne égale, le bonus montée réduit un peu la dépense totale (moins d'air sur le plat).
    nutrition/recommendations.ts  avant (1–4 g/kg selon durée, 2–4 h avant) ; pendant : objectifs LOISIR par niveau
                       (débutant 30–45, intermédiaire 40–60, confirmé 60–80 g/h ; < 1h30 facultatif ; ≤ 2h30 bas de
                       fourchette, au-delà milieu) ; objectif manuel prioritaire (10–120 g/h) ; eau 500–750 mL/h ; sources en tête
    nutrition/foods.ts aliments par défaut (glucides/portion, max par prise, type « rapide »/« lent »), sanitizeFoods
                       (déduit le type des anciennes données)
    nutrition/plan.ts  total = objectif g/h × (durée − 45 min : le repas d'avant couvre le début) ; prises régulières à
                       intervalles d'ÉNERGIE égaux, nombre = ⌊durée couverte / (portion type ÷ objectif)⌋ (≥ 1 portion
                       principale par prise, intervalle 20–45 min, écart mini ½ intervalle) ; prise RAPIDE 10–20 min (sinon
                       5–25) avant chaque montée importante (> 50 m D+ ou > 1 km à > 4 %), qui remplace la prise régulière la
                       plus proche ; pas de prise régulière dans les 10 min avant le pied (préférence) ; points « calmes »
                       (−3…+4 %, hors montée, recherche ±1 km puis ±3 km) ; glucides ∝ énergie jusqu'à la prise suivante ;
                       portions arrondies VERS LE BAS (écart reporté) ; lents sur le roulant, rapides avant montée/vallonné ;
                       chaque prise a un « why » (raison affichée). Test clé : total ≤ objectif + 10 %.
    nutrition/routePlan.ts  prepareRoute / computeEnergy / computePlan / computeRouteNutrition : calcul du plan PARTAGÉ
                       par l'écran nutrition et le démarrage d'une sortie (même plan garanti)
    ride/intakes.ts    prises en sortie : plan FIGÉ (freezePlan), états pending → done (FAITE PAR DÉFAUT au déclenchement)
                       → skipped (décochée dans le bilan, setTaken) ; « due » (ancienne version) = done ; déclenchement sur la
                       position LE LONG DU TRACÉ (recalage), ou au temps en mouvement estimé si hors tracé/sans position ;
                       pré-alerte 500 m (90 s) ; rappel boisson toutes les N min de temps en mouvement, pas < 5 min après une
                       prise, compté dès l'affichage (markDrink) ; describeIntakes (texte, regroupement « N prises à
                       rattraper ») ; summarizeNutrition (g/h seulement si ≥ 15 min couvertes)
    ride/summary.ts    bilan (D+ GPS lissé, vitesse moyenne), ressenti (bonne / coup de mou / fringale + km), GPX de la sortie
    offline/tiles.ts   tuiles d'un itinéraire : z5–8 rectangle englobant, z9–11 couloir ±8 km, z12–14 couloir ±2 km
                       (couloir réduit ±5/±1 km si trop gros) ; ordre = vue d'ensemble puis le long du parcours ;
                       limites OpenFreeMap OFM_MAX_TILES 3000 / OFM_MAX_BYTES 50 Mo / 4 en parallèle ; tilesToDelete (dédup)
    backup.ts          format JSON de sauvegarde (app, version, stores), parseBackup (vérifie tout avant d'écrire), describeBackup
  services/    accès aux API du navigateur
    db.ts              IndexedDB v3 (+ tiles, offlinePacks, mapAssets) : routes, routeTracks, settings (clés 'profile', 'foods', 'nutritionPrefs' = objectif g/h + bonus montée,
                       'rideSettings' = son + intervalle boisson) ; RideMeta.nutrition (plan figé + états), .summary, .feeling, rides (résumé), ridePoints (positions
                       filtrées, ajout par lots) ; dumpAll / restoreAll (FUSION par identifiant, une transaction, positions
                       d'une sortie remplacées pour éviter les doublons)
    files.ts           lecture fichier, export via Web Share (iOS « Enregistrer dans Fichiers ») ou téléchargement
    geolocation.ts     PositionSource + DeviceGps (watchPosition haute précision, relancé au retour premier plan)
    simulator.ts       SimulatedGps : rejoue un itinéraire (bruit, points imprécis, arrêt km 1, écart 80 m km 2, trou km 3),
                       altitude simulée depuis le profil
    offlineMaps.ts     cartes hors ligne : TileJSON OpenFreeMap (URL versionnée chaque semaine, mémorisée), téléchargement
                       reprenable (seules les tuiles absentes), arrêt net aux limites (statut 'limit'), polices Noto Sans
                       (mapAssets), loadTileForMap (copie locale → réseau SANS stocker → tuile vide), deletePack (dédup),
                       storageInfo / requestPersistence ; gestionnaire global (le téléchargement continue si on change d'écran)
    sound.ts           AlertSound (Web Audio, sons « prise » et « boisson » ; unlock() pendant l'appui sur Démarrer)
    wakeLock.ts        ScreenWakeLock (redemandé au retour au premier plan)
  map/gravelStyle.ts   style « Gravel » maison (OpenMapTiles) : goudronné blanc/jaune/orange bordé gris, non revêtu brun tireté
                       épais (track ou surface=unpaved), sentiers pointillés, cyclables bleu, points d'eau (poi drinking_water),
                       noms de lieux ; source « gcofm://tiles/… », polices « gcofm://fonts/… »
  map/mapView.ts       MapView (MapLibre) + createMapView({ base }) ; protocole gcofm (addProtocol) ; fonds : gravel (vectoriel,
                       hors ligne) / CyclOSM / OpenTopoMap (raster, en ligne) ; sortie = « gravel » imposé (message si WebGL indisponible) ; mode sortie : flèche (Marker rotationAlignment map), boussole (tap = bascule), « sens de la marche » (bearing = cap, position au tiers bas via padding top = h/3) ou « nord en haut », trace bleue regroupée toutes les 2 s, suivi/recentrer ; en dev, `window.__gcMap`
  ui/
    router.ts          routeur par hash (#/, #/itineraire/:id, #/nutrition/:id, #/profil, #/aliments, #/sortie/:id, #/simulation/:id,
                       #/sorties, #/sorties/:id, #/cartes)
    help.ts            textes réutilisés (avertissement médical, aide sauvegarde)
    icons.ts           icônes Lucide (icon(nom, classe?) → <svg class="ico">)
    pager.ts           logique pure de pagination (glissement, page mémorisée) — testée
    views/             écrans ; ride.ts = mode sortie (masque en-tête et onglets via body.ride-mode) en 3 pages :
                       0 Tableau de bord (carte + chiffres + commandes), 1 Carte plein écran, 2 Profil (montées) ;
                       profile.ts (formulaire complet + Mes données export/import), foods.ts (enregistrement auto),
                       nutrition.ts (plan des prises en tête avec total prévu et g/h réels, j'emporte, réglages objectif g/h +
                       effort en montée, pendant, avant, dépense + détail du calcul)
    components/        elevationChart (fiche itinéraire, aire colorée par pente + légende), rideProfile (profil en sortie : parcouru bleu via clipPath, montée orange),
                       ridePager (pages 3/4 + bandeau 1/4 : vitesse, km, cadenas, points ; glissement UNIQUEMENT sur le bandeau ;
                       cadenas = voile plein écran, appui long 1 s pour déverrouiller ; zone d’alertes commune ; zone « priority »
                       AU-DESSUS du voile), rideAlerts (pré-alerte ; bannières de prise et de boisson SANS BOUTON : son + 40 s
                       (BANNER_MS) ou un appui pour fermer, même cadenas actif ; appli en arrière-plan → bannière en
                       attente, affichée 40 s au retour (onVisible), prises non vues regroupées), toasts
                       views/rides.ts : « Mes sorties » + bilan (stats, bilan nutrition avec cases à décocher → recalcul et
                       enregistrement, ressenti, export GPX, suppression)
  main.ts              coquille (en-tête, onglets), routeur, service worker
scripts/make-icons.mjs génère les PNG d'icônes dans public/ (npm run icons)
docs/GUIDE.md          guide pas à pas pour l'utilisateur (installation, test, mise en ligne, iPhone)
```

## Règles
- Toute la logique de calcul va dans `core/` avec des tests ; pas d'accès DOM/IndexedDB dans `core/` (sauf DOMParser pour le GPX).
- Base de données : pour une évolution, incrémenter `DB_VERSION` et ajouter un bloc `if (oldVersion < N)` dans `upgrade()`, rendu idempotent (`objectStoreNames.contains`). Ne jamais modifier un bloc existant. Attention en dev : le rechargement à chaud peut appliquer un `DB_VERSION` modifié avant le bloc de migration → écrire le bloc AVANT d'incrémenter la version.
- Mode sortie : les positions acceptées sont enregistrées toutes les 15 s / 30 points et au passage en arrière-plan ; une sortie avec `endedAt === null` est proposée à la reprise (bannière dans la liste) et rejouée dans RideTracker. Les simulations terminées sont gardées (étiquette « Simulation », supprimables) ; une simulation non terminée est supprimée et jamais reprise.
- Ravitaillement : le plan est figé au DÉMARRAGE (pas à la reprise) ; l'état des prises est sauvegardé via la même file d'écriture que les positions (`flushing`) pour éviter les conflits. Fin de sortie → `ride.summary` puis `#/sorties/:id`.
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

## Hors connexion
- Service worker (Workbox) : précache de TOUTE l'appli (html, js, css, worker MapLibre .mjs, icônes, manifest) + navigation →
  index.html. L'appli démarre en mode Avion si elle a été ouverte une fois en ligne depuis la dernière mise à jour.
- Données (IndexedDB), GPS, calculs, alertes, sons, import/export de fichiers : fonctionnent sans réseau.
- Fond « Gravel » : tuiles OpenFreeMap téléchargées par itinéraire (bouton « ⬇ Carte hors ligne ») → affiché sans réseau.
  Tuiles vues en ligne sans téléchargement : NON stockées (conditions OpenFreeMap). CyclOSM/OpenTopoMap : en ligne seulement,
  jamais téléchargés en masse (conditions OSM France / OpenTopoMap).
- Conditions OpenFreeMap (https://openfreemap.org/tos/, lues en nov. 2026) : ≤ 3 000 tuiles ou 50 Mo par téléchargement, ≤ 4 requêtes
  parallèles, User-Agent unique — ce dernier point est impossible depuis une appli web (Safari interdit de changer le User-Agent ;
  l'en-tête Origin identifie le site). Ne pas contourner les limites en enchaînant plusieurs téléchargements pour un même itinéraire.

## Feuille de route
- [x] Étape 1 : projet, import GPX, carte, stats, profil altimétrique, liste (renommer/supprimer), export GPX, PWA, déploiement
- [x] Étape 2 (+ carte orientée dans le sens de la marche, MapLibre) : mode sortie GPS (filtre, recalage, alerte hors tracé > 50 m / levée < 40 m, distance/D+ restants, temps total + temps en mouvement avec pause auto, Wake Lock, reprise au premier plan, enregistrement incrémental + reprise après fermeture, simulation)
- [x] Mode sortie en 3 pages (tableau de bord / carte / profil avec montées), bandeau fixe, cadenas
- [x] Étape 3 : profil complet + modèle énergie + plan nutrition (sources : Thomas/Erdman/Burke 2016 ACSM ; Jeukendrup 2014 ; Sawka 2007 ACSM) + export/import de toutes les données en JSON. Toujours afficher l'avertissement « pas un avis médical » (`describeHelp.medical`).
- [x] Refonte visuelle (direction A) : icônes Lucide, onglets en bas, cartes avec aperçu, fiche carte + panneau, profil par pente,
  plan en frise, formulaires type iOS, mode sombre automatique (sauf sortie)
- [x] Étape 4 : alertes de prise en sortie (plan figé, position sur le tracé, pré-alerte, son, Fait/Plus tard/Passer, utilisables cadenas actif), rappel boisson, bilan de fin + ressenti, « Mes sorties », export GPX de la sortie
- Plus tard : BRouter, points d'eau OSM (Overpass), météo Open-Meteo, cartes hors ligne (autre source de tuiles), type de surface, bilan après sortie
