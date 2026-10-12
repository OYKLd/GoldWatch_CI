import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// Le MVP utilise SQLite embarqué pour être exécutable sans serveur. Le schéma PostgreSQL/PostGIS
// cible est fourni dans docs/schema.postgis.sql ; les requêtes géographiques sont isolées
// (geo.js, ai/zones.js) pour pouvoir être déléguées à PostGIS (ST_DWithin, ST_ClusterDBSCAN).
if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  discreet INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  assigned_to TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  declared_category TEXT NOT NULL,
  category TEXT NOT NULL,
  ai_confidence REAL NOT NULL,
  ai_reasons TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  public_lat REAL NOT NULL,
  public_lng REAL NOT NULL,
  accuracy_m REAL,
  photo_file TEXT,
  audio_file TEXT,
  image_hash TEXT,
  image_reused INTEGER NOT NULL DEFAULT 0,
  quality INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  case_id TEXT REFERENCES cases(id),
  created_at TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  corroborated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_wallet ON reports(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_hash ON reports(image_hash);

-- Position exacte : table séparée, chiffrée au repos (AES-256-GCM). La table reports ne la contient jamais.
CREATE TABLE IF NOT EXISTS exact_locations (
  report_id TEXT PRIMARY KEY REFERENCES reports(id),
  ciphertext TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT,
  case_id TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  authority_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  malicious_report_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  at TEXT NOT NULL
);
-- Journal d'audit chaîné par hachage : toute modification d'une ligne passée est détectable.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  case_id TEXT,
  report_id TEXT,
  at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  points INTEGER NOT NULL,
  amount_fcfa INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  reviewed_by TEXT
);
-- Service de paiement (simulé) : ne connaît que « portefeuille X, montant Y », jamais un signalement.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  amount_fcfa INTEGER NOT NULL,
  mode TEXT NOT NULL,
  paid_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organisation TEXT NOT NULL,
  role TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  authority_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fund (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance_fcfa INTEGER NOT NULL
);
INSERT OR IGNORE INTO fund(id, balance_fcfa) VALUES (1, 1000000);
`);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const nowIso = () => new Date().toISOString();

let txDepth = 0;
/** Transaction synchrone ; les appels imbriqués rejoignent la transaction englobante. */
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth = 0;
  }
}

// ---- chiffrement des positions exactes -------------------------------------------------------
function loadKey() {
  if (process.env.GOLDWATCH_KEY) return Buffer.from(process.env.GOLDWATCH_KEY, 'hex');
  const f = path.join(config.dataDir, 'secret.key');
  if (config.dbPath === ':memory:' && !fs.existsSync(f)) return crypto.randomBytes(32);
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

export function encryptLocation(lat, lng) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify([lat, lng]), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decryptLocation(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const out = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  return JSON.parse(out);
}

export function exactLocation(reportId) {
  const row = db.prepare('SELECT ciphertext FROM exact_locations WHERE report_id = ?').get(reportId);
  if (!row) return null;
  const [lat, lng] = decryptLocation(row.ciphertext);
  return { lat, lng };
}
