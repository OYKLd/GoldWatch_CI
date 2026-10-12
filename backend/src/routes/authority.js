import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, exactLocation } from '../db.js';
import { config } from '../config.js';
import { computeZones } from '../ai/zones.js';
import { authenticateAuthority, requireRole, logAccess, login, logout, changePassword } from '../services/authorities.js';
import { rateLimit } from '../ratelimit.js';
import {
  HttpError, verifyLedger, approveWithdrawal, rejectWithdrawal, runDuePayments, expireInactivePoints,
} from '../services/points.js';
import {
  assignCase, submitVerdict, markTreated, closeCase, expirePendingReports, STATUS_LABELS,
} from '../services/workflow.js';

export const authorityRouter = Router();

const wrapOpen = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

// Routes sans session : connexion (limitée en débit, verrouillage du compte après échecs répétés).
authorityRouter.post('/login',
  rateLimit({ name: 'login', max: config.rateLimit.loginPerHour }),
  wrapOpen((req, res) => res.json(login(req.body?.id, req.body?.password))));

authorityRouter.use((req, _res, next) => {
  try { req.authority = authenticateAuthority(req); next(); } catch (e) { next(e); }
});

const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const VERIFIER = ['agent'];
const READER = ['agent', 'analyste', 'gestionnaire_fonds'];

authorityRouter.get('/me', (req, res) => res.json(req.authority));

authorityRouter.post('/logout', (req, res) => { logout(req); res.json({ ok: true }); });

authorityRouter.post('/password', wrap((req, res) => {
  changePassword(req.authority.id, req.body?.current, req.body?.next);
  logAccess(req.authority, 'password_change');
  res.json({ ok: true, message: 'Mot de passe modifié : reconnectez-vous.' });
}));

authorityRouter.get('/alerts', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  logAccess(req.authority, 'alerts_list');
  const zones = computeZones().map((z) => ({ ...z, reportIds: undefined }));
  res.json({ zones });
}));

authorityRouter.get('/heatmap', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  const points = computeZones().map((z) => [z.lat, z.lng, Math.max(0.1, z.score / 100)]);
  res.json({ points });
}));

function caseSummary(c) {
  const reports = db.prepare('SELECT id, category, created_at, wallet_id FROM reports WHERE case_id = ?').all(c.id);
  const verdicts = db.prepare('SELECT authority_id AS authorityId, verdict, at FROM verdicts WHERE case_id = ?').all(c.id);
  let lat = 0, lng = 0, n = 0;
  for (const r of reports) {
    const l = exactLocation(r.id);
    if (l) { lat += l.lat; lng += l.lng; n += 1; }
  }
  const counts = {};
  reports.forEach((r) => { counts[r.category] = (counts[r.category] || 0) + 1; });
  return {
    id: c.id,
    status: c.status,
    statusLabel: STATUS_LABELS[c.status],
    createdAt: c.created_at,
    assignedTo: c.assigned_to,
    reportCount: reports.length,
    deviceCount: new Set(reports.map((r) => r.wallet_id)).size,
    categories: counts,
    verdicts,
    centroid: n ? { lat: lat / n, lng: lng / n } : null,
  };
}

authorityRouter.get('/cases', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM cases WHERE status = ? ORDER BY created_at DESC').all(String(status))
    : db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  logAccess(req.authority, 'cases_list', String(status || 'all'));
  res.json({ cases: rows.map(caseSummary) });
}));

authorityRouter.get('/cases/:id', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Dossier introuvable');
  // l'accès aux positions exactes est tracé (fuite côté autorités : journalisation des accès)
  logAccess(req.authority, 'exact_positions', c.id);
  const reports = db.prepare('SELECT * FROM reports WHERE case_id = ? ORDER BY created_at').all(c.id).map((r) => ({
    id: r.id,
    category: r.category,
    categoryLabel: config.categories[r.category],
    declaredCategory: r.declared_category,
    aiConfidence: r.ai_confidence,
    aiReasons: JSON.parse(r.ai_reasons),
    description: r.description,
    exact: exactLocation(r.id),
    accuracyM: r.accuracy_m,
    photo: r.photo_file ? `/api/authority/media/${r.photo_file}` : null,
    audio: r.audio_file ? `/api/authority/media/${r.audio_file}` : null,
    imageReused: !!r.image_reused,
    quality: !!r.quality,
    status: r.status,
    createdAt: r.created_at,
    // pseudonyme tronqué : permet de repérer un multi-comptes sans exposer le portefeuille complet
    deviceRef: r.wallet_id.slice(-6),
  }));
  const history = db.prepare('SELECT from_status AS fromStatus, to_status AS toStatus, actor, at FROM status_history WHERE case_id = ? ORDER BY id').all(c.id);
  res.json({ ...caseSummary(c), reports, history, doubleValidation: config.antiFraud.doubleValidation });
}));

authorityRouter.get('/media/:file', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  const file = path.basename(req.params.file);
  const full = path.join(config.dataDir, 'uploads', file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'Média introuvable');
  logAccess(req.authority, 'media', file);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(full);
}));

authorityRouter.post('/cases/:id/assign', wrap((req, res) => {
  requireRole(req.authority, ...VERIFIER);
  assignCase(req.params.id, req.authority.id);
  logAccess(req.authority, 'case_assign', req.params.id);
  res.json({ ok: true });
}));

authorityRouter.post('/cases/:id/verdict', wrap((req, res) => {
  requireRole(req.authority, ...VERIFIER);
  const out = submitVerdict(req.params.id, req.authority, req.body || {});
  logAccess(req.authority, `verdict_${req.body?.verdict}`, req.params.id);
  res.json(out);
}));

authorityRouter.post('/cases/:id/treated', wrap((req, res) => {
  requireRole(req.authority, ...VERIFIER);
  markTreated(req.params.id, req.authority.id);
  logAccess(req.authority, 'case_treated', req.params.id);
  res.json({ ok: true });
}));

authorityRouter.post('/cases/:id/close', wrap((req, res) => {
  requireRole(req.authority, ...VERIFIER);
  closeCase(req.params.id, req.authority.id);
  logAccess(req.authority, 'case_close', req.params.id);
  res.json({ ok: true });
}));

authorityRouter.get('/stats', wrap((req, res) => {
  requireRole(req.authority, ...READER);
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all().map((r) => [r.status, r.n]));
  const byCategory = Object.fromEntries(db.prepare('SELECT category, COUNT(*) AS n FROM reports GROUP BY category').all().map((r) => [r.category, r.n]));
  const delay = db.prepare(
    `SELECT AVG((julianday(h.at) - julianday(c.created_at)) * 24) AS hours
       FROM cases c JOIN status_history h ON h.case_id = c.id AND h.to_status = 'fonde'`,
  ).get().hours;
  res.json({
    reports: count('SELECT COUNT(*) AS n FROM reports'),
    byStatus: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v])),
    byCategory,
    cases: count('SELECT COUNT(*) AS n FROM cases'),
    casesOpen: count("SELECT COUNT(*) AS n FROM cases WHERE status IN ('transmis','en_verification')"),
    confirmed: count("SELECT COUNT(*) AS n FROM cases WHERE status IN ('fonde','traite','cloture') AND id IN (SELECT case_id FROM verdicts WHERE verdict='fonde')"),
    unfounded: count("SELECT COUNT(*) AS n FROM cases WHERE id IN (SELECT case_id FROM verdicts WHERE verdict='infonde')"),
    meanHoursToVerification: delay === null ? null : Math.round(delay * 10) / 10,
    activeWallets: count('SELECT COUNT(*) AS n FROM wallets'),
    pointsDistributed: count('SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE delta > 0'),
    rewardsPaidFcfa: count('SELECT COALESCE(SUM(amount_fcfa),0) AS n FROM payments'),
  });
}));

// ---- fonds de récompenses ---------------------------------------------------------------------------
authorityRouter.get('/fund', wrap((req, res) => {
  requireRole(req.authority, 'gestionnaire_fonds');
  const fund = db.prepare('SELECT balance_fcfa AS balanceFcfa FROM fund WHERE id = 1').get();
  const withdrawals = db.prepare('SELECT id, wallet_id AS walletRef, points, amount_fcfa AS amountFcfa, mode, status, requested_at AS requestedAt, scheduled_for AS scheduledFor FROM withdrawals ORDER BY requested_at DESC LIMIT 100').all()
    .map((w) => ({ ...w, walletRef: w.walletRef.slice(-6) }));
  res.json({ ...fund, withdrawals, humanReviewAboveFcfa: config.withdrawal.humanReviewAboveFcfa });
}));

authorityRouter.post('/withdrawals/:id/approve', wrap((req, res) => {
  requireRole(req.authority, 'gestionnaire_fonds');
  approveWithdrawal(req.params.id, req.authority.id);
  logAccess(req.authority, 'withdrawal_approve', req.params.id);
  res.json({ ok: true });
}));

authorityRouter.post('/withdrawals/:id/reject', wrap((req, res) => {
  requireRole(req.authority, 'gestionnaire_fonds');
  rejectWithdrawal(req.params.id, req.authority.id);
  logAccess(req.authority, 'withdrawal_reject', req.params.id);
  res.json({ ok: true });
}));

authorityRouter.post('/payments/run', wrap((req, res) => {
  requireRole(req.authority, 'gestionnaire_fonds');
  // `force=1` : démonstration, exécute aussi les retraits dont l'échéance n'est pas arrivée. Aucun paiement réel.
  const now = req.body?.force ? new Date(Date.now() + 365 * 86400000) : new Date();
  res.json(runDuePayments(now));
}));

// ---- audit -------------------------------------------------------------------------------------------
authorityRouter.get('/audit/ledger', wrap((req, res) => {
  requireRole(req.authority, 'admin', 'gestionnaire_fonds', 'analyste');
  res.json(verifyLedger());
}));

authorityRouter.get('/audit/access-log', wrap((req, res) => {
  requireRole(req.authority, 'admin');
  res.json({ entries: db.prepare('SELECT authority_id AS authorityId, action, target, at FROM access_log ORDER BY id DESC LIMIT 200').all() });
}));

authorityRouter.post('/maintenance/run', wrap((req, res) => {
  requireRole(req.authority, 'admin');
  res.json({ expiredReports: expirePendingReports(), expiredWallets: expireInactivePoints(), payments: runDuePayments() });
}));
