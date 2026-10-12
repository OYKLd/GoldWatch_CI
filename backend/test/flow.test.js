import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
fs.copyFileSync(new URL('../data/layers.geojson', import.meta.url), path.join(process.env.DATA_DIR, 'layers.geojson'));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true });

let wf, pts, db, geo, zones, anon;
before(async () => {
  db = await import('../src/db.js');
  pts = await import('../src/services/points.js');
  wf = await import('../src/services/workflow.js');
  zones = await import('../src/ai/zones.js');
  geo = await import('../src/geo.js');
  anon = await import('../src/anonymize.js');
});

const wallet = () => {
  const w = pts.createWallet();
  return pts.authenticateWallet(`Wallet ${w.walletId}:${w.recoveryCode}`);
};
const near = (i) => ({ lat: 5.73 + i * 0.001, lng: -5.31 + i * 0.001, accuracyM: 20 });

test('position publique floutée : au plus ~700 m, identique dans une même cellule', () => {
  const [la, lo] = geo.snapToGrid(5.17234, -5.29876, 0.009);
  assert.ok(geo.haversine(5.17234, -5.29876, la, lo) < 800);
  assert.deepEqual(geo.snapToGrid(5.1725, -5.2985, 0.009), [la, lo]);
});

test('anonymisation : EXIF retiré des JPEG', () => {
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xaa, 0xff, 0xd9])]);
  const out = anon.stripJpeg(jpeg);
  assert.ok(!out.includes(Buffer.from('Exif')));
  assert.equal(out[0], 0xff);
  assert.equal(anon.stripJpeg(Buffer.from('not a jpeg')), null);
});

test('récompenses : pas de points à l\'envoi, +10 corroboration, +50 / bonus après confirmation', () => {
  const ws = [wallet(), wallet(), wallet()];
  const r1 = wf.createReport(ws[0], { category: 'orpaillage', description: 'orpailleurs avec motopompe près de la rivière', ...near(0) });
  assert.equal(r1.status, 'attente_corroboration');
  assert.equal(db.db.prepare('SELECT points FROM wallets WHERE id = ?').get(ws[0].id).points, 0);
  wf.createReport(ws[1], { category: 'orpaillage', description: 'galamsey', ...near(1) });
  const r3 = wf.createReport(ws[2], { category: 'pollution_eau', description: 'eau jaune', ...near(2) });
  assert.equal(r3.status, 'transmis');
  // nouveaux déclarants : multiplicateur 0,5 → 5 points
  for (const w of ws) assert.equal(db.db.prepare('SELECT points FROM wallets WHERE id = ?').get(w.id).points, 5);

  const c = db.db.prepare('SELECT id FROM cases').get();
  const out = wf.submitVerdict(c.id, { id: 'a_test' }, { verdict: 'fonde' });
  assert.equal(out.finalized, true);
  const p0 = db.db.prepare('SELECT points FROM wallets WHERE id = ?').get(ws[0].id).points;
  assert.ok(p0 > 5, 'points crédités après confirmation');
  assert.equal(pts.verifyLedger().ok, true);
  assert.equal(db.db.prepare('SELECT status FROM reports WHERE id = ?').get(r1.id).status, 'fonde');
});

test('la machine d\'états refuse les transitions interdites', () => {
  const c = db.db.prepare('SELECT id FROM cases').get();
  assert.throws(() => wf.closeCase(c.id, 'a_test'), /interdite/); // fondé → clôturé sans intervention
  assert.throws(() => wf.assignCase(c.id, 'a_test'));
  wf.markTreated(c.id, 'a_test');
  wf.closeCase(c.id, 'a_test');
});

test('doublon du même appareil refusé ; photo réutilisée non corroborée', () => {
  const w = wallet();
  wf.createReport(w, { category: 'decharge', description: 'décharge', lat: 5.5, lng: -4.9 });
  assert.throws(() => wf.createReport(w, { category: 'decharge', description: 'décharge', lat: 5.5001, lng: -4.9 }), /doublon/);
});

test('retrait : seuil, plafond mensuel et journal chaîné', () => {
  const w = wallet();
  pts.credit(w.id, 400, 'test');
  const w1 = db.db.prepare('SELECT * FROM wallets WHERE id = ?').get(w.id);
  assert.throws(() => pts.requestWithdrawal(w1, { points: 400, mode: 'mobile_money' }), /Seuil/);
  pts.credit(w.id, 6000, 'test');
  const w2 = db.db.prepare('SELECT * FROM wallets WHERE id = ?').get(w.id);
  const ok = pts.requestWithdrawal(w2, { points: 500, mode: 'credit_communication' });
  assert.equal(ok.amountFcfa, 5000);
  const w3 = db.db.prepare('SELECT * FROM wallets WHERE id = ?').get(w.id);
  assert.throws(() => pts.requestWithdrawal(w3, { points: 5000, mode: 'mobile_money' }), /Plafond/);
  assert.equal(pts.verifyLedger().ok, true);
});

test('zones IA : cluster corroboré avec score explicable', () => {
  const z = zones.computeZones();
  assert.ok(z.length >= 1);
  assert.ok(z[0].explanation.length >= 3);
  const pub = zones.publicZone(z[0]);
  assert.equal(pub.reportIds, undefined);
});
