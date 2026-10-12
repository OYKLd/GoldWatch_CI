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
  relation["boundary"="protected_area"](${b});
  relation["leisure"="nature_reserve"](${b});
  relation["landuse"="forest"]["name"](${b});
);
out geom;`;

// Overpass est un service communautaire souvent saturé (504) : plusieurs miroirs et nouvelles tentatives.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
let elements;
for (let attempt = 0; attempt < 3 && !elements; attempt++) {
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'GoldWatchCI-hackathon/0.1' },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ elements } = await res.json());
      console.log(`Réponse de ${url}`);
      break;
    } catch (e) {
      console.warn(`${url} : ${e.message}`);
    }
  }
  if (!elements) await new Promise((r) => setTimeout(r, 5000));
}
if (!elements) throw new Error('Overpass injoignable ou saturé : réessayez plus tard (ou avec une zone plus petite)');

/** Assemble des segments (ways) en anneaux fermés en les raccordant bout à bout. */
function stitchRings(segments) {
  const segs = segments.map((s) => s.slice());
  const rings = [];
  const same = (p, q) => p[0] === q[0] && p[1] === q[1];
  while (segs.length) {
    let ring = segs.shift();
    let grown = true;
    while (grown && !same(ring[0], ring.at(-1))) {
      grown = false;
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        if (same(ring.at(-1), sg[0])) ring = ring.concat(sg.slice(1));
        else if (same(ring.at(-1), sg.at(-1))) ring = ring.concat(sg.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

const features = [];
const nameOf = (t = {}) => t.name || t['name:fr'] || '(sans nom)';
for (const el of elements) {
  const tags = el.tags || {};
  if (el.type === 'way' && el.geometry?.length >= 2) {
    const coords = el.geometry.map((p) => [p.lon, p.lat]);
    if (tags.waterway) {
      features.push({ type: 'Feature', properties: { kind: 'river', name: nameOf(tags), osm: el.id }, geometry: { type: 'LineString', coordinates: coords } });
    } else if (coords.length >= 4 && coords[0].join() === coords.at(-1).join()) {
      features.push({ type: 'Feature', properties: { kind: 'protected', name: nameOf(tags), osm: el.id }, geometry: { type: 'Polygon', coordinates: [coords] } });
    }
  } else if (el.type === 'relation') {
    const outers = (el.members || []).filter((m) => m.role === 'outer' && m.geometry?.length >= 2).map((m) => m.geometry.map((p) => [p.lon, p.lat]));
    for (const ring of stitchRings(outers)) {
      features.push({ type: 'Feature', properties: { kind: 'protected', name: nameOf(tags), osm: el.id }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
  }
}

// lieux-dits de repère conservés depuis le fichier de démonstration
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data', 'layers.geojson'), 'utf8'));
features.push(...demo.features.filter((f) => f.properties.kind === 'place'));

const out = path.join(root, 'data', 'layers.osm.geojson');
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', name: 'OpenStreetMap (c) contributeurs ODbL', features }));
console.log(`${features.length} éléments écrits dans ${out}`);
