/**
 * Style de carte « Gravel » maison, sur les tuiles vectorielles OpenFreeMap
 * (schéma OpenMapTiles). Pensé pour le plein soleil : fond clair, traits épais,
 * fort contraste, et trois familles de voies bien distinctes :
 *
 *   ▬ goudronné     : blanc/jaune/orange avec bordure grise (comme une carte routière)
 *   ▬ non revêtu    : brun épais, tirets longs (chemins, pistes, routes « unpaved »)
 *   ··· sentier     : pointillé brun foncé (path, footway, bridleway…)
 *   ▬ piste cyclable : bleu
 *   ● point d'eau   : rond bleu « Eau » (si présent dans les données OSM)
 *
 * Les tuiles passent par le protocole « gcofm:// » (voir mapView.ts) : copie
 * locale si la carte a été téléchargée, sinon réseau, sinon tuile vide.
 * Le texte reste toujours droit quand la carte tourne (étiquettes vectorielles).
 */
import type { ExpressionSpecification, LayerSpecification, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';

export const GRAVEL_SOURCE_ID = 'ofm';
export const GRAVEL_GLYPHS = 'gcofm://fonts/{fontstack}/{range}';

export const GRAVEL_ATTRIBUTION =
  '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Données © <a href="https://www.openstreetmap.org/copyright">Contributeurs OpenStreetMap</a>';

export const gravelSource: SourceSpecification = {
  type: 'vector',
  tiles: ['gcofm://tiles/{z}/{x}/{y}'],
  minzoom: 0,
  maxzoom: 14,
  attribution: GRAVEL_ATTRIBUTION,
};

const S = GRAVEL_SOURCE_ID;
const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'];
const isUnpavedSurface: ExpressionSpecification = ['==', ['get', 'surface'], 'unpaved'];
const isRoadClass: ExpressionSpecification = ['match', ['get', 'class'], ROAD_CLASSES, true, false];
const isLine: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];

/** Routes goudronnées (classes routières, revêtement non « unpaved »). */
const PAVED: ExpressionSpecification = ['all', isLine, isRoadClass, ['!', isUnpavedSurface]];
/** Non revêtu : pistes (track) et routes déclarées « unpaved ». */
const UNPAVED: ExpressionSpecification = ['all', isLine, ['any', ['==', ['get', 'class'], 'track'], ['all', isRoadClass, isUnpavedSurface]]];
const CYCLEWAY: ExpressionSpecification = ['all', isLine, ['==', ['get', 'class'], 'path'], ['==', ['get', 'subclass'], 'cycleway']];
const TRAIL: ExpressionSpecification = ['all', isLine, ['==', ['get', 'class'], 'path'], ['!=', ['get', 'subclass'], 'cycleway']];

/** Largeur selon le zoom (z12 → z16), de la plus fine à la plus épaisse. */
const width = (z12: number, z16: number): ExpressionSpecification => ['interpolate', ['exponential', 1.4], ['zoom'], 10, z12 * 0.5, 12, z12, 16, z16, 18, z16 * 1.6];

/** Largeur de la bordure / du remplissage des routes goudronnées selon leur importance. */
function roadWidth(casing: boolean): ExpressionSpecification {
  const extra = casing ? 2 : 0;
  return [
    'interpolate',
    ['exponential', 1.4],
    ['zoom'],
    8,
    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 1.5 + extra / 2, 0.5],
    12,
    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 4 + extra, ['secondary', 'tertiary'], 3 + extra, 1.8 + extra],
    16,
    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 12 + extra, ['secondary', 'tertiary'], 10 + extra, 7 + extra],
  ];
}

const placeName: ExpressionSpecification = ['coalesce', ['get', 'name:fr'], ['get', 'name:latin'], ['get', 'name']];
const HALO = { 'text-halo-color': '#ffffff', 'text-halo-width': 2.5, 'text-halo-blur': 0.5 };

export const gravelLayers: LayerSpecification[] = [
  { id: 'g-background', type: 'background', paint: { 'background-color': '#f4f1ea' } },
  {
    id: 'g-landcover',
    type: 'fill',
    source: S,
    'source-layer': 'landcover',
    paint: {
      'fill-color': ['match', ['get', 'class'], 'wood', '#c9dfb6', 'grass', '#e2ecd0', 'wetland', '#d6e6df', 'sand', '#f1e6c8', 'rock', '#e3ddd4', '#eef1e4'],
      'fill-opacity': 0.9,
    },
  },
  {
    id: 'g-landuse',
    type: 'fill',
    source: S,
    'source-layer': 'landuse',
    filter: ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail'], true, false],
    paint: { 'fill-color': '#e8e1d6' },
  },
  { id: 'g-park', type: 'fill', source: S, 'source-layer': 'park', paint: { 'fill-color': '#d6e9c9', 'fill-opacity': 0.6 } },
  { id: 'g-water', type: 'fill', source: S, 'source-layer': 'water', paint: { 'fill-color': '#9ec9f0' } },
  {
    id: 'g-waterway',
    type: 'line',
    source: S,
    'source-layer': 'waterway',
    paint: { 'line-color': '#5c9fe0', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.6, 17, 3] },
  },
  { id: 'g-building', type: 'fill', source: S, 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': '#d9d0c4', 'fill-outline-color': '#c4b9aa' } },
  {
    id: 'g-rail',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    filter: ['all', isLine, ['==', ['get', 'class'], 'rail']],
    paint: { 'line-color': '#8a8a8a', 'line-width': 1.2, 'line-dasharray': [3, 2] },
  },
  // Sentiers : pointillés brun foncé (dessous, plus fins)
  {
    id: 'g-trail',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 12,
    filter: TRAIL,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#4e342e', 'line-width': width(1, 2.2), 'line-dasharray': [0.6, 1.6] },
  },
  // Non revêtu : brun épais avec liseré blanc, tirets longs
  {
    id: 'g-unpaved-casing',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 11,
    filter: UNPAVED,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': width(3, 7) },
  },
  {
    id: 'g-unpaved',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 11,
    filter: UNPAVED,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#a0521c', 'line-width': width(1.6, 4.5), 'line-dasharray': [4, 1.2] },
  },
  // Pistes cyclables : bleu
  {
    id: 'g-cycleway',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 12,
    filter: CYCLEWAY,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#1565c0', 'line-width': width(1.4, 3.2) },
  },
  // Goudronné : bordure grise + remplissage clair
  {
    id: 'g-road-casing',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 8,
    filter: PAVED,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#5f5f5f', 'line-width': roadWidth(true) },
  },
  {
    id: 'g-road',
    type: 'line',
    source: S,
    'source-layer': 'transportation',
    minzoom: 8,
    filter: PAVED,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], '#f6a04d', ['secondary', 'tertiary'], '#ffe17a', '#ffffff'],
      'line-width': roadWidth(false),
    },
  },
  // Points d'eau (amenity=drinking_water dans OSM)
  {
    id: 'g-water-point',
    type: 'circle',
    source: S,
    'source-layer': 'poi',
    minzoom: 12,
    filter: ['any', ['==', ['get', 'subclass'], 'drinking_water'], ['==', ['get', 'class'], 'drinking_water']],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 8], 'circle-color': '#0277bd', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  },
  {
    id: 'g-water-point-label',
    type: 'symbol',
    source: S,
    'source-layer': 'poi',
    minzoom: 14,
    filter: ['any', ['==', ['get', 'subclass'], 'drinking_water'], ['==', ['get', 'class'], 'drinking_water']],
    layout: { 'text-field': 'Eau', 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#01579b', ...HALO },
  },
  // Noms de lieux
  {
    id: 'g-place-small',
    type: 'symbol',
    source: S,
    'source-layer': 'place',
    minzoom: 12,
    filter: ['match', ['get', 'class'], ['hamlet', 'isolated_dwelling', 'locality', 'suburb', 'neighbourhood'], true, false],
    layout: { 'text-field': placeName, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 15] },
    paint: { 'text-color': '#2b2b2b', ...HALO },
  },
  {
    id: 'g-place-village',
    type: 'symbol',
    source: S,
    'source-layer': 'place',
    minzoom: 10,
    filter: ['==', ['get', 'class'], 'village'],
    layout: { 'text-field': placeName, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 15, 17] },
    paint: { 'text-color': '#1a1a1a', ...HALO },
  },
  {
    id: 'g-place-town',
    type: 'symbol',
    source: S,
    'source-layer': 'place',
    minzoom: 6,
    filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
    layout: { 'text-field': placeName, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 12, 14, 21] },
    paint: { 'text-color': '#000000', ...HALO },
  },
];

export const GRAVEL_LAYER_IDS = gravelLayers.map((l) => l.id);
