import crypto from 'node:crypto';
import { db, tx, sha256, newId, nowIso } from '../db.js';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- portefeuille pseudonyme ---------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function recoveryCode() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

/** Crée un portefeuille sans nom ni numéro. Le code de récupération n'est montré qu'une seule fois. */
export function createWallet() {
  const id = `w_${crypto.randomBytes(8).toString('hex')}`;
  const code = recoveryCode();
  const now = nowIso();
  db.prepare('INSERT INTO wallets(id, secret_hash, created_at, last_activity_at) VALUES (?,?,?,?)').run(id, sha256(code), now, now);
  return { walletId: id, recoveryCode: code };
}

export function authenticateWallet(header) {
  const m = /^Wallet ([\w]+):([A-Z0-9-]+)$/.exec(header || '');
  if (!m) throw new HttpError(401, 'Portefeuille non authentifié', 'wallet_auth');
  const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(m[1]);
  if (!w || w.secret_hash !== sha256(m[2])) throw new HttpError(401, 'Portefeuille inconnu ou code invalide', 'wallet_auth');
  return w;
}

// ---- journal de points inaltérable (chaîne de hachage) ---------------------------------------
export function credit(walletId, delta, reason, { caseId = null, reportId = null } = {}) {
  return tx(() => {
    const w = db.prepare('SELECT points FROM wallets WHERE id = ?').get(walletId);
    if (!w) throw new HttpError(404, 'Portefeuille introuvable');
    const actual = delta < 0 ? -Math.min(w.points, -delta) : delta;
    if (actual === 0) return 0;
    const last = db.prepare('SELECT hash FROM ledger ORDER BY id DESC LIMIT 1').get();
    const prev = last ? last.hash : 'GENESIS';
    const at = nowIso();
    const hash = sha256([prev, walletId, actual, reason, caseId, reportId, at].join('|'));
    db.prepare('INSERT INTO ledger(wallet_id, delta, reason, case_id, report_id, at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)')
      .run(walletId, actual, reason, caseId, reportId, at, prev, hash);
    db.prepare('UPDATE wallets SET points = points + ?, last_activity_at = ? WHERE id = ?').run(actual, at, walletId);
    return actual;
  });
}

export function verifyLedger() {
  const rows = db.prepare('SELECT * FROM ledger ORDER BY id').all();
  let prev = 'GENESIS';
  for (const r of rows) {
    const h = sha256([prev, r.wallet_id, r.delta, r.reason, r.case_id, r.report_id, r.at].join('|'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.id, entries: rows.length };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

/** Multiplicateur « nouveau déclarant » : la confiance (et donc le gain) augmente avec les confirmations. */
export function trustMultiplier(wallet) {
  return wallet.confirmed_count >= config.antiFraud.newcomerConfirmations ? 1 : 0.5;
}

// ---- retraits ---------------------------------------------------------------------------------
const startOfMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

export function requestWithdrawal(wallet, { points, mode }) {
  const cfg = config.withdrawal;
  if (!cfg.modes[mode]) throw new HttpError(422, 'Mode de retrait inconnu');
  points = Math.floor(Number(points));
  if (!Number.isFinite(points) || points <= 0) throw new HttpError(422, 'Montant invalide');
  if (wallet.blocked) throw new HttpError(403, 'Portefeuille bloqué', 'blocked');
  if (wallet.points < cfg.minPoints) throw new HttpError(409, `Seuil minimum de retrait : ${cfg.minPoints} points`, 'below_threshold');
  if (points < cfg.minPoints) throw new HttpError(422, `Retrait minimum : ${cfg.minPoints} points`);
  if (points > wallet.points) throw new HttpError(409, 'Solde insuffisant', 'insufficient');

  const amount = points * cfg.fcfaPerPoint;
  const used = db.prepare("SELECT COALESCE(SUM(amount_fcfa),0) AS s FROM withdrawals WHERE wallet_id = ? AND requested_at >= ? AND status NOT IN ('rejete')")
    .get(wallet.id, startOfMonth()).s;
  if (used + amount > cfg.monthlyCapFcfa) {
    throw new HttpError(409, `Plafond mensuel de ${cfg.monthlyCapFcfa} FCFA atteint (déjà ${used} FCFA demandés)`, 'monthly_cap');
  }
  const fund = db.prepare('SELECT balance_fcfa FROM fund WHERE id = 1').get().balance_fcfa;
  if (amount > fund) throw new HttpError(503, 'Fonds de récompenses momentanément épuisé : demande à réessayer plus tard', 'fund_empty');

  // Délai volontairement décorrélé de la date du signalement et de l'intervention.
  const days = cfg.delayDaysMin + Math.random() * (cfg.delayDaysMax - cfg.delayDaysMin);
  const scheduled = new Date(Date.now() + days * 86400000).toISOString();
  const review = amount > cfg.humanReviewAboveFcfa;
  const id = newId('wd');
  tx(() => {
    credit(wallet.id, -points, 'retrait_demande');
    db.prepare('INSERT INTO withdrawals(id, wallet_id, points, amount_fcfa, mode, status, requested_at, scheduled_for) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, wallet.id, points, amount, mode, review ? 'revue_humaine' : 'planifie', nowIso(), scheduled);
  });
  return { id, points, amountFcfa: amount, mode, status: review ? 'revue_humaine' : 'planifie', scheduledFor: scheduled };
}

export function approveWithdrawal(id, authorityId) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w) throw new HttpError(404, 'Retrait introuvable');
  if (w.status !== 'revue_humaine') throw new HttpError(409, 'Ce retrait n\'est pas en revue');
  db.prepare("UPDATE withdrawals SET status = 'planifie', reviewed_by = ? WHERE id = ?").run(authorityId, id);
}

export function rejectWithdrawal(id, authorityId) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
  if (!w) throw new HttpError(404, 'Retrait introuvable');
  if (!['revue_humaine', 'planifie'].includes(w.status)) throw new HttpError(409, 'Retrait déjà traité');
  tx(() => {
    db.prepare("UPDATE withdrawals SET status = 'rejete', reviewed_by = ? WHERE id = ?").run(authorityId, id);
    credit(w.wallet_id, w.points, 'retrait_rejete_remboursement');
  });
}

/** Exécute les virements arrivés à échéance (prestataire de paiement simulé : aucun paiement réel). */
export function runDuePayments(now = new Date()) {
  const due = db.prepare("SELECT * FROM withdrawals WHERE status = 'planifie' AND scheduled_for <= ?").all(now.toISOString());
  let paid = 0;
  for (const w of due) {
    tx(() => {
      const fund = db.prepare('SELECT balance_fcfa FROM fund WHERE id = 1').get().balance_fcfa;
      if (fund < w.amount_fcfa) return;
      db.prepare('UPDATE fund SET balance_fcfa = balance_fcfa - ? WHERE id = 1').run(w.amount_fcfa);
      db.prepare('INSERT INTO payments(id, wallet_id, amount_fcfa, mode, paid_at) VALUES (?,?,?,?,?)')
        .run(newId('pay'), w.wallet_id, w.amount_fcfa, w.mode, nowIso());
      db.prepare("UPDATE withdrawals SET status = 'verse' WHERE id = ?").run(w.id);
      paid += 1;
    });
  }
  return { paid, due: due.length };
}

export function expireInactivePoints(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - config.withdrawal.pointsExpireMonths);
  const rows = db.prepare('SELECT id, points FROM wallets WHERE points > 0 AND last_activity_at < ?').all(cutoff.toISOString());
  for (const w of rows) {
    // On ne rafraîchit pas last_activity_at : l'expiration n'est pas une activité du déclarant.
    const last = db.prepare('SELECT last_activity_at AS a FROM wallets WHERE id = ?').get(w.id).a;
    credit(w.id, -w.points, 'expiration_12_mois');
    db.prepare('UPDATE wallets SET last_activity_at = ? WHERE id = ?').run(last, w.id);
  }
  return rows.length;
}
