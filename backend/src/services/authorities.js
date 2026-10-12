import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, sha256 } from '../db.js';
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

/** Crée les comptes autorités de démonstration au premier lancement et écrit les clés dans data/credentials.json. */
export function ensureAuthorities() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM authorities').get().n;
  if (n > 0) return null;
  const creds = {};
  for (const [id, name, organisation, role] of DEMO) {
    const key = `gw_${crypto.randomBytes(18).toString('base64url')}`;
    db.prepare('INSERT INTO authorities(id, name, organisation, role, key_hash) VALUES (?,?,?,?,?)').run(id, name, organisation, role, sha256(key));
    creds[id] = { name, role, apiKey: key };
  }
  if (config.dbPath !== ':memory:') {
    fs.writeFileSync(path.join(config.dataDir, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
  }
  return creds;
}

export function authenticateAuthority(req) {
  const key = req.get('x-api-key');
  if (!key) throw new HttpError(401, 'Clé d\'accès requise', 'authority_auth');
  const a = db.prepare('SELECT id, name, organisation, role FROM authorities WHERE key_hash = ?').get(sha256(key));
  if (!a) throw new HttpError(401, 'Clé d\'accès invalide', 'authority_auth');
  return { ...a, roleLabel: ROLES[a.role] };
}

export function requireRole(authority, ...roles) {
  if (authority.role === 'admin') return;
  if (!roles.includes(authority.role)) throw new HttpError(403, 'Rôle insuffisant pour cette action', 'forbidden');
}

export function logAccess(authority, action, target = null) {
  db.prepare('INSERT INTO access_log(authority_id, action, target, at) VALUES (?,?,?,?)').run(authority.id, action, target, new Date().toISOString());
}
