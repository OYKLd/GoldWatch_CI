// Citizen AI, étape 2 : détection de clusters géo-temporels et score de priorité explicable (règle R6).
import { db, exactLocation } from '../db.js';
import { config } from '../config.js';
import { haversine, snapToGrid } from '../geo.js';
import { contextAt, placeName } from '../layers.js';

const DAY = 86400000;

function activeRiskReports(now) {
  const since = new Date(now - config.clustering.windowDays * DAY).toISOString();
  const marks = config.riskFamily.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, wallet_id, category, created_at, status, case_id, image_reused, quality, ai_confidence
       FROM reports
      WHERE category IN (${marks}) AND created_at >= ? AND image_reused = 0
        AND status NOT IN ('infonde','expire')`,
  ).all(...config.riskFamily, since);
  const out = [];
  for (const r of rows) {
    const loc = exactLocation(r.id);
    if (loc) out.push({ ...r, lat: loc.lat, lng: loc.lng });
  }
  return out;
}

function unionFind(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (p[x] === x ? x : (p[x] = find(p[x])));
  return { find, union: (a, b) => { p[find(a)] = find(b); } };
}

const level = (score) => (score >= 65 ? 'haute' : score >= 40 ? 'moyenne' : 'faible');

function score(cluster, now) {
  const rs = cluster.reports;
  const devices = new Set(rs.map((r) => r.wallet_id)).size;
  const recent = rs.filter((r) => now - Date.parse(r.created_at) <= 14 * DAY).length / rs.length;
  const orp = rs.filter((r) => r.category === 'orpaillage').length / rs.length;
  const ctx = contextAt(cluster.lat, cluster.lng);
  const nearRiver = ctx.river && ctx.river.distanceM <= 1000;
  const nearProtected = ctx.protectedArea && ctx.protectedArea.distanceM <= 3000;
  const confirmed = rs.filter((r) => ['fonde', 'traite', 'cloture'].includes(r.status)).length > 0;

  const parts = {
    volume: Math.min(45, Math.round(devices * 4 + rs.length * 1.5)),
    recence: Math.round(recent * 20),
    orpaillage: Math.round(orp * 20),
    cours_eau: nearRiver ? 10 : 0,
    zone_protegee: nearProtected ? 10 : 0,
  };
  const trust = rs.reduce((s, r) => s + (r.ai_confidence || 0.5), 0) / rs.length;
  let total = Object.values(parts).reduce((a, b) => a + b, 0) * (0.75 + 0.25 * trust);
  if (confirmed) total = Math.max(total, 70);
  total = Math.min(100, Math.round(total));

  const explanation = [
    `${devices} déclarants distincts, ${rs.length} signalement(s) sur ${config.clustering.windowDays} jours`,
    `${Math.round(orp * 100)} % des signalements concernent l'orpaillage`,
    `${Math.round(recent * 100)} % datent de moins de 14 jours`,
  ];
  if (nearRiver) explanation.push(`Cours d'eau à ${ctx.river.distanceM} m (${ctx.river.name})`);
  if (nearProtected) explanation.push(
    ctx.protectedArea.distanceM === 0
      ? `Dans une zone protégée (${ctx.protectedArea.name})`
      : `Zone protégée à ${ctx.protectedArea.distanceM} m (${ctx.protectedArea.name})`,
  );
  if (confirmed) explanation.push('Au moins un signalement confirmé sur le terrain');

  return { score: total, level: level(total), parts, explanation, context: ctx, nearRiver, devices };
}

/**
 * Retourne les zones à risque. Une zone n'est « mise en avant » (corroborée) que si elle compte au moins
 * `minDistinctDevices` déclarants distincts ; les autres restent en veille côté autorités.
 */
export function computeZones(now = Date.now()) {
  const reports = activeRiskReports(now);
  const uf = unionFind(reports.length);
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      if (haversine(reports[i].lat, reports[i].lng, reports[j].lat, reports[j].lng) <= config.clustering.linkRadiusM) uf.union(i, j);
    }
  }
  const groups = new Map();
  reports.forEach((r, i) => {
    const k = uf.find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const zones = [];
  for (const rs of groups.values()) {
    const lat = rs.reduce((s, r) => s + r.lat, 0) / rs.length;
    const lng = rs.reduce((s, r) => s + r.lng, 0) / rs.length;
    const cluster = { reports: rs, lat, lng };
    const sc = score(cluster, now);
    const first = Math.min(...rs.map((r) => Date.parse(r.created_at)));
    const weeks = Math.max(1, Math.round((now - first) / (7 * DAY)));
    const name = placeName(lat, lng);
    const priorityLabel = { haute: 'haute', moyenne: 'moyenne', faible: 'faible' }[sc.level];
    const summary =
      `${name.startsWith('secteur') ? `Zone du ${name}` : `Zone de ${name}`} : ${rs.length} signalement${rs.length > 1 ? 's' : ''} lié${rs.length > 1 ? 's' : ''} à l'orpaillage / pollution en ${weeks} semaine${weeks > 1 ? 's' : ''}` +
      ` → ${sc.nearRiver ? 'probable site actif en amont' : 'probable site actif'}. Priorité d'intervention : ${priorityLabel}.`;
    const caseIds = [...new Set(rs.map((r) => r.case_id).filter(Boolean))];
    zones.push({
      id: `z_${Math.round(lat * 1000)}_${Math.round(lng * 1000)}`,
      name,
      lat,
      lng,
      reportCount: rs.length,
      deviceCount: sc.devices,
      corroborated: sc.devices >= config.corroboration.minDistinctDevices,
      score: sc.score,
      level: sc.level,
      parts: sc.parts,
      explanation: sc.explanation,
      summary,
      caseIds,
      reportIds: rs.map((r) => r.id),
      lastReportAt: new Date(Math.max(...rs.map((r) => Date.parse(r.created_at)))).toISOString(),
      river: sc.context.river,
      protectedArea: sc.context.protectedArea,
    });
  }
  return zones.sort((a, b) => b.score - a.score || b.deviceCount - a.deviceCount);
}

/** Version publique : position floutée sur la grille, aucun identifiant de signalement. */
export function publicZone(z) {
  const [lat, lng] = snapToGrid(z.lat, z.lng, config.privacy.gridDeg);
  return {
    id: z.id.replace(/^z_.*/, `pz_${Math.round(lat * 1000)}_${Math.round(lng * 1000)}`),
    name: z.name,
    lat,
    lng,
    radiusM: Math.max(1000, Math.ceil((Math.sqrt(z.reportCount) * 600) / 500) * 500),
    reportCount: z.reportCount,
    level: z.level,
    score: z.score,
    summary: z.summary,
    lastReportAt: z.lastReportAt,
  };
}
