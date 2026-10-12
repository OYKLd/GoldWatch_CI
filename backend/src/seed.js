// Données de DÉMONSTRATION FICTIVES (scénario « Zone de Hiré » du dossier de présentation).
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { ensureAuthorities } from './services/authorities.js';
import { createWallet, authenticateWallet, credit } from './services/points.js';
import { createReport, submitVerdict } from './services/workflow.js';

const DAY = 86400000;
const NOW = Date.now();

function reset() {
  for (const t of ['status_history', 'verdicts', 'ledger', 'payments', 'withdrawals', 'exact_locations', 'reports', 'cases', 'access_log', 'wallets']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('UPDATE fund SET balance_fcfa = 1000000 WHERE id = 1');
}

function jitter(base, meters, seed) {
  // décalage déterministe d'au plus `meters` mètres
  const a = (Math.sin(seed * 12.9898) * 43758.5453) % 1;
  const b = (Math.sin(seed * 78.233) * 12345.6789) % 1;
  return [base[0] + (a * meters) / 111000, base[1] + (b * meters) / 111000];
}

export function seed() {
  reset();
  const creds = ensureAuthorities() || {};
  const wallets = Array.from({ length: 7 }, () => {
    const w = createWallet();
    return { ...w, row: authenticateWallet(`Wallet ${w.walletId}:${w.recoveryCode}`) };
  });
  const wal = (i) => db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallets[i].walletId);

  // Scénario 1 — Hiré : 12 signalements d'orpaillage/pollution en ~5 semaines, 6 déclarants, près d'un cours d'eau et d'une forêt classée
  const hire = [5.735, -5.31];
  const descr = [
    'Eau de la rivière devenue jaune et boueuse, poissons morts en aval',
    'Des hommes avec une motopompe et des tamis au bord du cours d\'eau',
    'Trous creusés dans la forêt, une excavatrice entendue la nuit',
    'Pollution forte de la rivière après le passage des orpailleurs',
    'Site d\'orpaillage clandestin avec machine et dragage',
    'Arbres abattus près de la berge, sol à nu',
    '',
    'Eau marron, odeur de carburant, galamsey actif',
    'Concasseur et puits creusés derrière la plantation',
    'Eau trouble depuis deux semaines',
    'Chercheurs d\'or avec drague sur le marigot',
    'Orpaillage illégal, mercure suspecté, eau rouge',
  ];
  const cats = ['pollution_eau', 'orpaillage', 'orpaillage', 'pollution_eau', 'orpaillage', 'deforestation', 'orpaillage', 'pollution_eau', 'orpaillage', 'pollution_eau', 'orpaillage', 'orpaillage'];
  descr.forEach((d, i) => {
    const [lat, lng] = jitter(hire, 700, i + 1);
    createReport(wal(i % 6), {
      category: cats[i], description: d, lat, lng, accuracyM: 30,
      now: NOW - (35 - i * 3) * DAY,
    });
  });

  // Scénario 2 — secteur de Divo : 3 déclarants, dossier transmis puis confirmé par un agent (points distribués)
  const divo = [5.842, -5.352];
  for (let i = 0; i < 3; i++) {
    const [lat, lng] = jitter(divo, 400, i + 40);
    createReport(wal(i), {
      category: 'orpaillage', description: 'Site d\'orpaillage avec motopompe et trous creusés près de la route', lat, lng, accuracyM: 25,
      now: NOW - (12 - i) * DAY,
    });
  }
  const divoCase = db.prepare('SELECT DISTINCT case_id AS id FROM reports WHERE case_id IS NOT NULL AND public_lat > 5.82').get();
  if (divoCase) submitVerdict(divoCase.id, { id: 'a_agent1' }, { verdict: 'fonde', note: 'Site actif constaté, matériel saisi (démo).' });

  // Signalements isolés (non corroborés, donc invisibles publiquement pour l'orpaillage)
  createReport(wal(5), { category: 'orpaillage', description: 'Bruit de machine la nuit', lat: 6.45, lng: -6.1, accuracyM: 80, now: NOW - 2 * DAY });
  createReport(wal(6), { category: 'decharge', description: 'Décharge sauvage de plastique et ferraille en lisière de forêt', lat: 5.32, lng: -4.45, accuracyM: 20, now: NOW - 4 * DAY });
  createReport(wal(6), { category: 'deforestation', description: 'Coupe d\'arbres et brûlis en bordure de la forêt', lat: 5.8, lng: -5.33, accuracyM: 40, now: NOW - 6 * DAY });

  // Portefeuille de démonstration avec de quoi tester le retrait simulé (≥ 500 points)
  const demo = createWallet();
  credit(demo.walletId, 620, 'dotation_demo');
  creds.demoWallet = demo;
  if (config.dbPath !== ':memory:') {
    const f = path.join(config.dataDir, 'credentials.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* premier lancement */ }
    fs.writeFileSync(f, JSON.stringify({ ...existing, ...creds }, null, 2), { mode: 0o600 });
  }
  return { reports: db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, demoWallet: demo };
}

if (process.argv[1]?.endsWith('seed.js')) {
  const r = seed();
  console.log(`Données de démonstration chargées : ${r.reports} signalements, ${r.cases} dossiers.`);
  console.log('Clés autorités et portefeuille de démo : backend/data/credentials.json');
}
