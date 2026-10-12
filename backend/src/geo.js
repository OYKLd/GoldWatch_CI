const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Centre de la cellule de grille contenant le point : tous les points d'une cellule sont publiés au même endroit. */
export function snapToGrid(lat, lng, cell) {
  const s = (v) => Math.round((Math.floor(v / cell) + 0.5) * cell * 1e5) / 1e5;
  return [s(lat), s(lng)];
}

export function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (m) d'un point à une polyligne [[lng,lat],…], projection équirectangulaire locale. */
export function distanceToLine(lat, lng, line) {
  const kx = Math.cos(rad(lat)) * 111320;
  const ky = 110540;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - lng) * kx, ay = (line[i][1] - lat) * ky;
    const bx = (line[i + 1][0] - lng) * kx, by = (line[i + 1][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

export function distanceToRing(lat, lng, ring) {
  if (pointInRing(lat, lng, ring)) return 0;
  return distanceToLine(lat, lng, ring);
}
