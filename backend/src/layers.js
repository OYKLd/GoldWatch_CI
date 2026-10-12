import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { distanceToLine, distanceToRing, haversine } from './geo.js';

const file = process.env.LAYERS_FILE || path.join(config.dataDir, 'layers.geojson');
const fc = JSON.parse(fs.readFileSync(file, 'utf8'));

const byKind = (k) => fc.features.filter((f) => f.properties.kind === k);
const protectedAreas = byKind('protected');
const rivers = byKind('river');
const places = byKind('place');

/** GeoJSON public (hors lieux-dits) pour les couches de la carte. */
export const publicLayers = {
  type: 'FeatureCollection',
  features: [...protectedAreas, ...rivers],
};

/** Contexte écologique d'un point : cours d'eau et zone protégée les plus proches. */
export function contextAt(lat, lng) {
  let river = null;
  for (const f of rivers) {
    const d = distanceToLine(lat, lng, f.geometry.coordinates);
    if (!river || d < river.distanceM) river = { name: f.properties.name, distanceM: Math.round(d) };
  }
  let area = null;
  for (const f of protectedAreas) {
    const d = distanceToRing(lat, lng, f.geometry.coordinates[0]);
    if (!area || d < area.distanceM) area = { name: f.properties.name, distanceM: Math.round(d) };
  }
  return { river, protectedArea: area };
}

export function placeName(lat, lng) {
  let best = null;
  for (const f of places) {
    const [plng, plat] = f.geometry.coordinates;
    const d = haversine(lat, lng, plat, plng);
    if (!best || d < best.d) best = { d, name: f.properties.name };
  }
  return best && best.d < 25000 ? best.name : `secteur ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
}
