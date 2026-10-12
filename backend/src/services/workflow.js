import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, newId, nowIso, encryptLocation, exactLocation } from '../db.js';
import { config } from '../config.js';
import { haversine, snapToGrid } from '../geo.js';
import { sanitizePhoto, audioExtension } from '../anonymize.js';
import { classify } from '../ai/classifier.js';
import { HttpError, credit, trustMultiplier } from './points.js';

const DAY = 86400000;
const uploadDir = path.join(config.dataDir, 'uploads');

// ---- machine d'états (section 6 du document) ------------------------------------------------
export const TRANSITIONS = {
  recu: ['attente_corroboration'],
  attente_corroboration: ['corrobore', 'expire'],
  corrobore: ['transmis'],
  transmis: ['en_verification'],
  en_verification: ['fonde', 'infonde'],
  fonde: ['traite'],
  infonde: ['cloture'],
  traite: ['cloture'],
  cloture: [],
  expire: [],
};
export const STATUS_LABELS = {
  recu: 'Reçu',
  attente_corroboration: 'En attente de corroboration',
  corrobore: 'Corroboré',
  transmis: 'Transmis aux autorités',
  en_verification: 'En vérification',
  fonde: 'Fondé',
  infonde: 'Infondé',
  traite: 'Traité',
  cloture: 'Clôturé',
  expire: 'Expiré',
};
const OPEN_CASE = ['transmis', 'en_verification'];
const PENDING = ['attente_corroboration'];

function nextPath(from, to) {
  // la machine est quasi linéaire : recherche en largeur
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const p = queue.shift();
    const last = p[p.length - 1];
    if (last === to) return p;
    for (const n of TRANSITIONS[last] || []) {
      if (!seen.has(n)) { seen.add(n); queue.push([...p, n]); }
    }
  }
  return null;
}

function setReportStatus(reportId, to, actor) {
  const r = db.prepare('SELECT status FROM reports WHERE id = ?').get(reportId);
  if (!TRANSITIONS[r.status].includes(to)) throw new HttpError(409, `Transition interdite : ${r.status} → ${to}`);
  db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(to, reportId);
  db.prepare('INSERT INTO status_history(report_id, from_status, to_status, actor, at) VALUES (?,?,?,?,?)').run(reportId, r.status, to, actor, nowIso());
}

function walkReportTo(reportId, target, actor) {
  const cur = db.prepare('SELECT status FROM reports WHERE id = ?').get(reportId).status;
  if (cur === target) return;
  const p = nextPath(cur, target);
  if (!p) throw new HttpError(409, `Aucun chemin ${cur} → ${target}`);
  for (const s of p.slice(1)) setReportStatus(reportId, s, actor);
}

function setCaseStatus(caseId, to, actor) {
  const c = db.prepare('SELECT status FROM cases WHERE id = ?').get(caseId);
  if (!c) throw new HttpError(404, 'Dossier introuvable');
  if (c.status !== to && !TRANSITIONS[c.status]?.includes(to)) throw new HttpError(409, `Transition interdite : ${c.status} → ${to}`);
  db.prepare('UPDATE cases SET status = ? WHERE id = ?').run(to, caseId);
  db.prepare('INSERT INTO status_history(case_id, from_status, to_status, actor, at) VALUES (?,?,?,?,?)').run(caseId, c.status, to, actor, nowIso());
  for (const r of db.prepare('SELECT id FROM reports WHERE case_id = ?').all(caseId)) walkReportTo(r.id, to, actor);
}

// ---- création d'un signalement ---------------------------------------------------------------
function inBounds(lat, lng) {
  const b = config.bounds;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

export function createReport(wallet, input) {
  const { category: declared, description = '', lat, lng, accuracyM, photo, audio } = input;
  if (!config.categories[declared]) throw new HttpError(422, 'Catégorie inconnue', 'bad_category');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inBounds(lat, lng)) {
    throw new HttpError(422, 'Position invalide ou hors de la Côte d\'Ivoire', 'bad_position');
  }
  if (wallet.blocked) throw new HttpError(403, 'Portefeuille bloqué suite à des signalements abusifs', 'blocked');

  const now = input.now ?? Date.now();
  const since24 = new Date(now - DAY).toISOString();
  const perDay = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE wallet_id = ? AND created_at >= ?').get(wallet.id, since24).n;
  if (perDay >= config.antiFraud.maxReportsPerDay) {
    throw new HttpError(429, 'Limite quotidienne de signalements atteinte', 'daily_cap');
  }
  const recentSame = db.prepare('SELECT id FROM reports WHERE wallet_id = ? AND category = ? AND created_at >= ?').all(wallet.id, declared, since24);
  for (const r of recentSame) {
    const loc = exactLocation(r.id);
    if (loc && haversine(lat, lng, loc.lat, loc.lng) <= config.antiFraud.duplicateRadiusM) {
      throw new HttpError(409, 'Vous avez déjà signalé ce lieu aujourd\'hui : doublon ignoré', 'duplicate');
    }
  }

  // Anonymisation des médias : EXIF/GPS retirés, noms de fichiers aléatoires.
  let photoFile = null;
  let imageHash = null;
  let imageReused = 0;
  if (photo) {
    const clean = sanitizePhoto(photo.buffer);
    if (!clean) throw new HttpError(415, 'Format de photo non pris en charge (JPEG ou PNG)', 'bad_photo');
    photoFile = `${crypto.randomBytes(12).toString('hex')}.${clean.ext}`;
    fs.writeFileSync(path.join(uploadDir, photoFile), clean.buffer);
    imageHash = clean.hash;
    imageReused = db.prepare('SELECT 1 FROM reports WHERE image_hash = ? LIMIT 1').get(imageHash) ? 1 : 0;
  }
  let audioFile = null;
  if (audio) {
    const ext = audioExtension(audio.mimetype, audio.originalname);
    if (!ext) throw new HttpError(415, 'Format audio non pris en charge', 'bad_audio');
    audioFile = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, audioFile), audio.buffer);
  }

  const ai = classify({ declared, description, hasPhoto: !!photo, hasAudio: !!audio });
  const quality = photo && description.trim().length >= 20 && Number(accuracyM) <= 50 ? 1 : 0;
  const [plat, plng] = snapToGrid(lat, lng, config.privacy.gridDeg);
  const { publishDelayMinMin: dmin, publishDelayMaxMin: dmax } = config.privacy;
  const delayMin = dmax > 0 ? dmin + Math.random() * (dmax - dmin) : 0;
  const id = newId('r');
  const created = new Date(now).toISOString();

  tx(() => {
    db.prepare(
      `INSERT INTO reports(id, wallet_id, declared_category, category, ai_confidence, ai_reasons, description, public_lat, public_lng,
                           accuracy_m, photo_file, audio_file, image_hash, image_reused, quality, status, created_at, publish_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, wallet.id, declared, ai.category, ai.confidence, JSON.stringify(ai.reasons), description.trim().slice(0, 1000), plat, plng,
      Number.isFinite(Number(accuracyM)) ? Number(accuracyM) : null, photoFile, audioFile, imageHash, imageReused, quality, 'recu', created,
      new Date(now + delayMin * 60000).toISOString());
    db.prepare('INSERT INTO exact_locations(report_id, ciphertext) VALUES (?,?)').run(id, encryptLocation(lat, lng));
    db.prepare('INSERT INTO status_history(report_id, from_status, to_status, actor, at) VALUES (?,?,?,?,?)').run(id, null, 'recu', 'system', created);
    db.prepare('UPDATE wallets SET last_activity_at = ? WHERE id = ?').run(created, wallet.id);
    setReportStatus(id, 'attente_corroboration', 'citizen-ai');
    runCorroboration(id);
  });

  const r = db.prepare('SELECT status, case_id FROM reports WHERE id = ?').get(id);
  return {
    id,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status],
    category: ai.category,
    categoryLabel: config.categories[ai.category],
    aiConfidence: ai.confidence,
    publicPosition: { lat: plat, lng: plng, approxRadiusM: 750 },
    imageReused: !!imageReused,
    message: imageReused
      ? 'Photo déjà reçue : le signalement est conservé mais ne sera ni corroboré ni récompensé.'
      : 'Merci. Votre signalement est anonymisé et transmis. Ne vous approchez jamais du site.',
  };
}

// ---- corroboration (règle R4) ------------------------------------------------------------------
function activeNeighbours(report, loc) {
  const fam = config.riskFamily.includes(report.category) ? config.riskFamily : [report.category];
  const since = new Date(Date.now() - config.corroboration.windowDays * DAY).toISOString();
  const rows = db.prepare(
    `SELECT id, wallet_id, status, case_id, created_at FROM reports
      WHERE category IN (${fam.map(() => '?').join(',')}) AND id != ? AND created_at >= ? AND image_reused = 0
        AND status IN ('attente_corroboration','transmis','en_verification')`,
  ).all(...fam, report.id, since);
  const out = [];
  for (const n of rows) {
    const nl = exactLocation(n.id);
    if (!nl) continue;
    const d = haversine(loc.lat, loc.lng, nl.lat, nl.lng);
    if (d <= config.corroboration.radiusM) out.push({ ...n, distance: d });
  }
  return out;
}

function dailyRewardableCount(walletId) {
  const since = new Date(Date.now() - DAY).toISOString();
  return db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE wallet_id = ? AND at >= ? AND reason = 'signalement_corrobore'").get(walletId, since).n;
}

function awardCorroboration(walletId, reportId, caseId) {
  if (dailyRewardableCount(walletId) >= config.antiFraud.maxRewardedPerDay) return;
  const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (w.blocked) return;
  const pts = Math.round(config.points.corroborated * trustMultiplier(w));
  credit(walletId, pts, 'signalement_corrobore', { caseId, reportId });
}

function runCorroboration(reportId) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (r.image_reused) return;
  const loc = exactLocation(reportId);
  const neighbours = activeNeighbours(r, loc);
  const now = nowIso();

  // 1. un dossier ouvert existe déjà à proximité : le signalement le rejoint
  const openCase = neighbours.filter((n) => n.case_id && OPEN_CASE.includes(db.prepare('SELECT status FROM cases WHERE id = ?').get(n.case_id).status))
    .sort((a, b) => a.distance - b.distance)[0];
  if (openCase) {
    const c = db.prepare('SELECT status FROM cases WHERE id = ?').get(openCase.case_id);
    db.prepare('UPDATE reports SET case_id = ?, corroborated_at = ? WHERE id = ?').run(openCase.case_id, now, reportId);
    walkReportTo(reportId, c.status, 'citizen-ai');
    const already = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE case_id = ? AND wallet_id = ? AND id != ?').get(openCase.case_id, r.wallet_id, reportId).n;
    if (!already) awardCorroboration(r.wallet_id, reportId, openCase.case_id);
    return;
  }

  // 2. sinon : N déclarants distincts dans le rayon et la fenêtre ⇒ nouveau dossier
  const pending = neighbours.filter((n) => PENDING.includes(n.status));
  const wallets = new Set([r.wallet_id, ...pending.map((n) => n.wallet_id)]);
  if (wallets.size < config.corroboration.minDistinctDevices) return;

  const caseId = newId('c');
  db.prepare('INSERT INTO cases(id, status, created_at) VALUES (?,?,?)').run(caseId, 'transmis', now);
  db.prepare('INSERT INTO status_history(case_id, from_status, to_status, actor, at) VALUES (?,?,?,?,?)').run(caseId, null, 'transmis', 'citizen-ai', now);
  const members = [reportId, ...pending.map((n) => n.id)];
  const rewarded = new Set();
  for (const id of members) {
    db.prepare('UPDATE reports SET case_id = ?, corroborated_at = ? WHERE id = ?').run(caseId, now, id);
    walkReportTo(id, 'transmis', 'citizen-ai');
    const w = db.prepare('SELECT wallet_id FROM reports WHERE id = ?').get(id).wallet_id;
    if (!rewarded.has(w)) { rewarded.add(w); awardCorroboration(w, id, caseId); }
  }
}

// ---- vérification par les autorités ------------------------------------------------------------
export function assignCase(caseId, authorityId) {
  return tx(() => {
    const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!c) throw new HttpError(404, 'Dossier introuvable');
    if (c.status !== 'transmis') throw new HttpError(409, 'Dossier déjà pris en charge ou clôturé');
    setCaseStatus(caseId, 'en_verification', authorityId);
    db.prepare('UPDATE cases SET assigned_to = ? WHERE id = ?').run(authorityId, caseId);
  });
}

function isNewSite(caseId, lat, lng) {
  const prior = db.prepare(
    `SELECT DISTINCT v.case_id FROM verdicts v JOIN cases c ON c.id = v.case_id
      WHERE v.verdict = 'fonde' AND v.case_id != ? AND c.status IN ('fonde','traite','cloture')`,
  ).all(caseId);
  for (const p of prior) {
    const r = db.prepare('SELECT id FROM reports WHERE case_id = ? LIMIT 1').get(p.case_id);
    const l = r && exactLocation(r.id);
    if (l && haversine(lat, lng, l.lat, l.lng) <= config.points.newSiteRadiusM) return false;
  }
  return true;
}

export function submitVerdict(caseId, authority, { verdict, note = '', maliciousReportIds = [] }) {
  if (!['fonde', 'infonde'].includes(verdict)) throw new HttpError(422, 'Verdict attendu : fonde ou infonde');
  return tx(() => {
    let c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!c) throw new HttpError(404, 'Dossier introuvable');
    if (c.status === 'transmis') { setCaseStatus(caseId, 'en_verification', authority.id); db.prepare('UPDATE cases SET assigned_to = ? WHERE id = ?').run(authority.id, caseId); c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId); }
    if (c.status !== 'en_verification') throw new HttpError(409, 'Le dossier n\'est pas en vérification');
    if (db.prepare('SELECT 1 FROM verdicts WHERE case_id = ? AND authority_id = ?').get(caseId, authority.id)) {
      throw new HttpError(409, 'Vous avez déjà rendu un verdict sur ce dossier');
    }
    const members = db.prepare('SELECT id FROM reports WHERE case_id = ?').all(caseId).map((r) => r.id);
    const mal = maliciousReportIds.filter((id) => members.includes(id));
    db.prepare('INSERT INTO verdicts(case_id, authority_id, verdict, malicious_report_ids, note, at) VALUES (?,?,?,?,?,?)')
      .run(caseId, authority.id, verdict, JSON.stringify(mal), String(note).slice(0, 500), nowIso());

    if (config.antiFraud.doubleValidation) {
      const all = db.prepare('SELECT verdict FROM verdicts WHERE case_id = ?').all(caseId);
      const same = all.filter((v) => v.verdict === verdict).length;
      if (all.some((v) => v.verdict !== verdict)) return { finalized: false, conflict: true, message: 'Verdicts contradictoires : arbitrage requis' };
      if (same < 2) return { finalized: false, message: 'Seconde validation par un autre agent requise' };
    }
    return finalizeVerdict(caseId, verdict, authority.id, mal);
  });
}

function finalizeVerdict(caseId, verdict, actor, maliciousIds) {
  setCaseStatus(caseId, verdict, actor);
  const reports = db.prepare('SELECT * FROM reports WHERE case_id = ? ORDER BY created_at').all(caseId);
  const awards = [];

  if (verdict === 'fonde') {
    const eligible = reports.filter((r) => !r.image_reused && !maliciousIds.includes(r.id));
    const seen = new Set();
    for (const r of eligible) {
      const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(r.wallet_id);
      if (w.blocked) continue;
      const mult = trustMultiplier(w);
      if (!seen.has(r.wallet_id)) {
        seen.add(r.wallet_id);
        awards.push(credit(r.wallet_id, Math.round(config.points.confirmed * mult), 'signalement_confirme', { caseId, reportId: r.id }));
        db.prepare('UPDATE wallets SET confirmed_count = confirmed_count + 1 WHERE id = ?').run(r.wallet_id);
      }
      if (r.quality) awards.push(credit(r.wallet_id, Math.round(config.points.quality * mult), 'bonus_qualite', { caseId, reportId: r.id }));
    }
    const first = eligible[0];
    const loc = first && exactLocation(first.id);
    if (first && loc && isNewSite(caseId, loc.lat, loc.lng)) {
      const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(first.wallet_id);
      if (!w.blocked) credit(first.wallet_id, Math.round(config.points.firstReporter * trustMultiplier(w)), 'bonus_premier_signaleur', { caseId, reportId: first.id });
    }
  } else {
    // infondé de bonne foi : 0 point, aucune sanction ; malveillant constaté : retrait de points + sanction progressive
    for (const id of maliciousIds) {
      const r = reports.find((x) => x.id === id);
      credit(r.wallet_id, config.points.malicious, 'signalement_malveillant', { caseId, reportId: id });
      db.prepare('UPDATE wallets SET strikes = strikes + 1 WHERE id = ?').run(r.wallet_id);
      db.prepare('UPDATE wallets SET blocked = 1 WHERE id = ? AND strikes >= ?').run(r.wallet_id, config.antiFraud.strikesBeforeBlock);
    }
    setCaseStatus(caseId, 'cloture', actor);
  }
  return { finalized: true, status: db.prepare('SELECT status FROM cases WHERE id = ?').get(caseId).status };
}

export function markTreated(caseId, authorityId) {
  return tx(() => setCaseStatus(caseId, 'traite', authorityId));
}
export function closeCase(caseId, authorityId) {
  return tx(() => setCaseStatus(caseId, 'cloture', authorityId));
}

// ---- maintenance ----------------------------------------------------------------------------------
export function expirePendingReports(now = Date.now()) {
  const cutoff = new Date(now - config.corroboration.windowDays * DAY).toISOString();
  const rows = db.prepare("SELECT id FROM reports WHERE status = 'attente_corroboration' AND created_at < ?").all(cutoff);
  tx(() => rows.forEach((r) => setReportStatus(r.id, 'expire', 'system')));
  return rows.length;
}

export function stripReportForOwner(r) {
  return {
    id: r.id,
    category: r.category,
    categoryLabel: config.categories[r.category],
    status: r.status,
    statusLabel: STATUS_LABELS[r.status],
    createdAt: r.created_at,
  };
}
