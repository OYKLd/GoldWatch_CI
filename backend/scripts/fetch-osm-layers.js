// Télécharge zones protégées et cours d'eau depuis OpenStreetMap (Overpass API) pour une boîte englobante
// et écrit data/layers.osm.geojson, au même format que data/layers.geojson (copier par-dessus pour l'utiliser,
// ou pointer LAYERS_FILE vers ce fichier).
//   node scripts/fetch-osm-layers.js [sud,ouest,nord,est]      ex. 5.3,-5.9,6.2,-4.9
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bbox = (process.argv[2] || '5.3,-5.9,6.2,-4.9').split(',').map(Number);
if (bbox.length !== 4 || bbox.some(Number.isNaN)) throw new Error('bbox attendue : sud,ouest,nord,est');
const b = bbox.join(',');

const query = `[out:json][timeout:60];
(
  way["boundary"="protected_area"](${b});
  way["leisure"="nature_reserve"](${b});
  way["landuse"="forest"]["name"](${b});
  way["waterway"="river"](${b});
);
out geom;`;

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  body: new URLSearchParams({ data: query }),
  headers: { 'User-Agent': 'GoldWatchCI-hackathon/0.1' },
});
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const { elements } = await res.json();

const features = [];
for (const el of elements) {
  if (!el.geometry || el.geometry.length < 2) continue;
  const coords = el.geometry.map((p) => [p.lon, p.lat]);
  const name = el.tags?.name || el.tags?.['name:fr'] || '(sans nom)';
  if (el.tags?.waterway) {
    features.push({ type: 'Feature', properties: { kind: 'river', name, osm: el.id }, geometry: { type: 'LineString', coordinates: coords } });
  } else if (coords.length >= 4) {
    const ring = coords[0].join() === coords.at(-1).join() ? coords : [...coords, coords[0]];
    features.push({ type: 'Feature', properties: { kind: 'protected', name, osm: el.id }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
}

// lieux-dits de repère conservés depuis le fichier de démonstration
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data', 'layers.geojson'), 'utf8'));
features.push(...demo.features.filter((f) => f.properties.kind === 'place'));

const out = path.join(root, 'data', 'layers.osm.geojson');
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', name: 'OpenStreetMap (c) contributeurs ODbL', features }));
console.log(`${features.length} éléments écrits dans ${out}`);
