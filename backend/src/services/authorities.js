import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, sha256, nowIso } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './points.js';

const ROLES = {
  agent: 'Agent vérificateur',
  analyste: 'Analyste',
  gestionnaire_fonds: 'Gestionnaire du fonds',
  admin: 'Administrateur',
};

const DEMO = [
  ['a_agent1', 'Agent vérificateur 1', 'Police environnementale', 'agent'],
  ['a_agent2', 'Agent vérificateur 2', 'ANDE', 'agent'],
  ['a_analyste', 'Analyste', 'Ministère de l\'Environnement', 'analyste'],
  ['a_fonds', 'Gestionnaire du fonds', 'Fonds de récompenses', 'gestionnaire_fonds'],
  ['a_admin', 'Administrateur', 'Équipe technique', 'admin'],
];

// ---- mots de passe (scrypt, sel aléatoire) ------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}

const randomPassword = () => crypto.randomBytes(15).toString('base64url');

/**
 * Crée les comptes de démonstration au premier lancement et attribue un mot de passe aux comptes
 * qui n'en ont pas (migration depuis les anciennes clés d'accès). Écrit data/credentials.json.
 */
export function ensureAuthorities() {
  const creds = {};
  if (db.prepare('SELECT COUNT(*) AS n FROM authorities').get().n === 0) {
    for (const [id, name, organisation, role] of DEMO) {
      const pw = randomPassword();
      // key_hash est conservé pour compatibilité de schéma ; il n'ouvre plus aucun accès.
      db.prepare('INSERT INTO authorities(id, name, organisation, role, key_hash, password_hash) VALUES (?,?,?,?,?,?)')
        .run(id, name, organisation, role, sha256(crypto.randomBytes(24)), hashPassword(pw));
      creds[id] = { name, role, password: pw };
    }
  } else {
    for (const a of db.prepare('SELECT id, name, role FROM authorities WHERE password_hash IS NULL').all()) {
      const pw = randomPassword();
      db.prepare('UPDATE authorities SET password_hash = ? WHERE id = ?').run(hashPassword(pw), a.id);
      creds[a.id] = { name: a.name, role: a.role, password: pw };
    }
  }
  if (!Object.keys(creds).length) return null;
  if (config.dbPath !== ':memory:') {
    const f = path.join(config.dataDir, 'credentials.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* premier lancement */ }
    for (const [id, c] of Object.entries(creds)) existing[id] = c; // remplace les anciennes clés d'accès
    fs.writeFileSync(f, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }
  return creds;
}

// ---- connexion / sessions --------------------------------------------------------------------------
export function login(authorityId, password) {
  const now = new Date();
  const att = db.prepare('SELECT failures, locked_until FROM login_attempts WHERE authority_id = ?').get(authorityId);
  if (att?.locked_until && new Date(att.locked_until) > now) {
    throw new HttpError(429, `Compte verrouillé après trop d'échecs. Réessayez dans ${config.auth.lockMinutes} minutes.`, 'locked');
  }
  // l'identifiant technique (a_admin) ou le nom affiché (Administrateur), sans tenir compte de la casse
  const ident = String(authorityId || '').trim();
  const a = db.prepare('SELECT * FROM authorities WHERE lower(id) = lower(?) OR lower(name) = lower(?)').get(ident, ident);
  // même temps de calcul et même message que le compte existe ou non
  const ok = verifyPassword(String(password || ''), a?.password_hash ?? 'aa:bb');
  if (!a || !ok) {
    const failures = (att?.failures || 0) + 1;
    const lock = failures >= config.auth.maxFailures ? new Date(now.getTime() + config.auth.lockMinutes * 60000).toISOString() : null;
    db.prepare(
      `INSERT INTO login_attempts(authority_id, failures, locked_until) VALUES (?,?,?)
       ON CONFLICT(authority_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
    ).run(String(authorityId || ''), lock ? 0 : failures, lock);
    throw new HttpError(401, 'Identifiant ou mot de passe invalide', 'bad_credentials');
  }
  db.prepare('DELETE FROM login_attempts WHERE authority_id = ?').run(authorityId);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + config.auth.sessionHours * 3600000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, authority_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256(token), a.id, nowIso(), expires);
  return { token, expiresAt: expires, authority: { id: a.id, name: a.name, organisation: a.organisation, role: a.role, roleLabel: ROLES[a.role] } };
}

export function bearerToken(req) {
  const m = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  return m ? m[1] : null;
}

export function logout(req) {
  const t = bearerToken(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
}

export function authenticateAuthority(req) {
  const t = bearerToken(req);
  if (!t) throw new HttpError(401, 'Connexion requise', 'authority_auth');
  const a = db.prepare(
    `SELECT a.id, a.name, a.organisation, a.role FROM sessions s JOIN authorities a ON a.id = s.authority_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha256(t), nowIso());
  if (!a) throw new HttpError(401, 'Session expirée ou invalide : reconnectez-vous', 'authority_auth');
  return { ...a, roleLabel: ROLES[a.role] };
}

export function changePassword(authorityId, current, next) {
  const a = db.prepare('SELECT password_hash FROM authorities WHERE id = ?').get(authorityId);
  if (!verifyPassword(String(current || ''), a?.password_hash)) throw new HttpError(401, 'Mot de passe actuel incorrect', 'bad_credentials');
  if (String(next || '').length < config.auth.minPasswordLength) {
    throw new HttpError(422, `Le nouveau mot de passe doit faire au moins ${config.auth.minPasswordLength} caractères`);
  }
  db.prepare('UPDATE authorities SET password_hash = ? WHERE id = ?').run(hashPassword(String(next)), authorityId);
  // les autres sessions de ce compte sont fermées
  db.prepare('DELETE FROM sessions WHERE authority_id = ?').run(authorityId);
}

export function requireRole(authority, ...roles) {
  if (authority.role === 'admin') return;
  if (!roles.includes(authority.role)) throw new HttpError(403, 'Rôle insuffisant pour cette action', 'forbidden');
}

export function logAccess(authority, action, target = null) {
  db.prepare('INSERT INTO access_log(authority_id, action, target, at) VALUES (?,?,?,?)').run(authority.id, action, target, nowIso());
}
