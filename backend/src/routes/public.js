import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { snapToGrid, haversine } from '../geo.js';
import { publicLayers } from '../layers.js';
import { computeZones, publicZone } from '../ai/zones.js';
import { createWallet, authenticateWallet, requestWithdrawal, HttpError } from '../services/points.js';
import { createReport, stripReportForOwner, STATUS_LABELS } from '../services/workflow.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(config.maxPhotoBytes, config.maxAudioBytes), files: 2, fields: 10 },
});

const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const AFTER_CORROBORATION = ['corrobore', 'transmis', 'en_verification', 'fonde', 'traite', 'cloture'];

export const publicRouter = Router();

publicRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'goldwatch-ci', time: new Date().toISOString() }));

publicRouter.get('/config', (_req, res) => {
  const w = config.withdrawal;
  res.json({
    categories: config.categories,
    corroborationMin: config.corroboration.minDistinctDevices,
    points: config.points,
    withdrawal: {
      fcfaPerPoint: w.fcfaPerPoint, minPoints: w.minPoints, monthlyCapFcfa: w.monthlyCapFcfa,
      delayDays: [w.delayDaysMin, w.delayDaysMax], modes: w.modes,
    },
    privacy: { publicPositionErrorM: '500 à 1 000', note: 'Les signalements d\'orpaillage ne sont affichés qu\'après corroboration.' },
  });
});

publicRouter.get('/layers', (_req, res) => res.json(publicLayers));

/** Carte publique : cellules floutées. L'orpaillage n'apparaît qu'une fois corroboré (pas d'affichage temps réel). */
publicRouter.get('/public/reports', (_req, res) => {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT public_lat AS lat, public_lng AS lng, category, status, created_at FROM reports
      WHERE publish_at <= ? AND created_at >= ? AND image_reused = 0 AND status NOT IN ('infonde','expire','recu')`,
  ).all(new Date().toISOString(), since);
  const cells = new Map();
  for (const r of rows) {
    if (r.category === 'orpaillage' && !AFTER_CORROBORATION.includes(r.status)) continue;
    const k = `${r.lat},${r.lng}`;
    if (!cells.has(k)) cells.set(k, { lat: r.lat, lng: r.lng, count: 0, categories: {}, lastAt: r.created_at, corroborated: false, confirmed: false });
    const c = cells.get(k);
    c.count += 1;
    c.categories[r.category] = (c.categories[r.category] || 0) + 1;
    if (r.created_at > c.lastAt) c.lastAt = r.created_at;
    if (AFTER_CORROBORATION.includes(r.status)) c.corroborated = true;
    if (['fonde', 'traite', 'cloture'].includes(r.status)) c.confirmed = true;
  }
  res.json({ approxRadiusM: 750, cells: [...cells.values()] });
});

/** Zones à risque détectées par l'IA, version publique (positions floutées, niveau haut/moyen uniquement). */
publicRouter.get('/public/zones', (_req, res) => {
  const zones = computeZones().filter((z) => z.corroborated && z.level !== 'faible').map(publicZone);
  res.json({ zones });
});

/** Fiche d'un point touché sur la carte : statut de la zone, signalements récents, niveau d'alerte IA. */
publicRouter.get('/public/area', wrap((req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(422, 'lat/lng requis');
  const [clat, clng] = snapToGrid(lat, lng, config.privacy.gridDeg);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT category, status FROM reports WHERE public_lat = ? AND public_lng = ? AND created_at >= ? AND publish_at <= ?
        AND image_reused = 0 AND status NOT IN ('infonde','expire','recu')`,
  ).all(clat, clng, since, new Date().toISOString())
    .filter((r) => r.category !== 'orpaillage' || AFTER_CORROBORATION.includes(r.status));
  const zones = computeZones().filter((z) => z.corroborated).map(publicZone);
  const near = zones.map((z) => ({ z, d: haversine(clat, clng, z.lat, z.lng) })).sort((a, b) => a.d - b.d)[0];
  const zone = near && near.d <= Math.max(near.z.radiusM, 1500) ? near.z : null;
  const categories = {};
  rows.forEach((r) => { categories[r.category] = (categories[r.category] || 0) + 1; });
  res.json({
    lat: clat, lng: clng,
    approxRadiusM: 750,
    recentReports: rows.length,
    categories,
    status: zone ? 'Zone à risque corroborée' : rows.length ? 'Signalements en cours de corroboration' : 'Aucun signalement récent',
    aiAlertLevel: zone ? zone.level : 'aucune',
    summary: zone ? zone.summary : null,
  });
}));

// ---- portefeuille pseudonyme --------------------------------------------------------------------
publicRouter.post('/wallets', (_req, res) => res.status(201).json(createWallet()));

function walletView(w) {
  const ledger = db.prepare('SELECT delta, reason, at FROM ledger WHERE wallet_id = ? ORDER BY id DESC LIMIT 100').all(w.id);
  const reports = db.prepare('SELECT * FROM reports WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 100').all(w.id).map(stripReportForOwner);
  const withdrawals = db.prepare('SELECT id, points, amount_fcfa AS amountFcfa, mode, status, requested_at AS requestedAt, scheduled_for AS scheduledFor FROM withdrawals WHERE wallet_id = ? ORDER BY requested_at DESC LIMIT 50').all(w.id);
  const cfg = config.withdrawal;
  return {
    walletId: w.id,
    points: w.points,
    valueFcfa: w.points * cfg.fcfaPerPoint,
    thresholdPoints: cfg.minPoints,
    canWithdraw: w.points >= cfg.minPoints && !w.blocked,
    blocked: !!w.blocked,
    discreet: !!w.discreet,
    trustLevel: w.confirmed_count >= config.antiFraud.newcomerConfirmations ? 'confirmé' : 'nouveau',
    confirmedCount: w.confirmed_count,
    history: ledger,
    reports,
    withdrawals,
  };
}

publicRouter.get('/wallet', wrap((req, res) => {
  const w = authenticateWallet(req.get('authorization'));
  res.json(walletView(w));
}));

publicRouter.patch('/wallet/settings', wrap((req, res) => {
  const w = authenticateWallet(req.get('authorization'));
  if (typeof req.body?.discreet === 'boolean') db.prepare('UPDATE wallets SET discreet = ? WHERE id = ?').run(req.body.discreet ? 1 : 0, w.id);
  res.json(walletView(db.prepare('SELECT * FROM wallets WHERE id = ?').get(w.id)));
}));

publicRouter.post('/wallet/withdrawals', wrap((req, res) => {
  const w = authenticateWallet(req.get('authorization'));
  res.status(201).json(requestWithdrawal(w, req.body || {}));
}));

// ---- signalement ---------------------------------------------------------------------------------
publicRouter.post('/reports', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), wrap((req, res) => {
  const wallet = authenticateWallet(req.get('authorization'));
  const photo = req.files?.photo?.[0];
  const audio = req.files?.audio?.[0];
  if (photo && photo.size > config.maxPhotoBytes) throw new HttpError(413, 'Photo trop volumineuse');
  if (audio && audio.size > config.maxAudioBytes) throw new HttpError(413, 'Note vocale trop volumineuse');
  const body = req.body || {};
  const result = createReport(wallet, {
    category: body.category,
    description: body.description || '',
    lat: Number(body.lat),
    lng: Number(body.lng),
    accuracyM: body.accuracyM,
    photo,
    audio,
  });
  res.status(201).json(result);
}));

export { STATUS_LABELS };
