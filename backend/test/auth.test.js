import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-auth-'));
process.env.RATE_WALLETS_PER_HOUR = '3';
process.env.LOGIN_MAX_FAILURES = '5';
fs.copyFileSync(new URL('../data/layers.geojson', import.meta.url), path.join(process.env.DATA_DIR, 'layers.geojson'));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true });
process.env.LAYERS_FILE = path.join(process.env.DATA_DIR, 'layers.geojson');

let server, base, creds;
before(async () => {
  const { createApp } = await import('../src/app.js');
  const auth = await import('../src/services/authorities.js');
  const app = createApp();
  creds = auth.ensureAuthorities(); // déjà créés par createApp : on relit via un changement de mot de passe contrôlé
  const { db } = await import('../src/db.js');
  const set = (id, pw) => db.prepare('UPDATE authorities SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), id);
  set('a_agent1', 'motdepasse-agent-1');
  set('a_analyste', 'motdepasse-analyste');
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
});
const login = async (id, password) => post('/authority/login', { id, password });

test('accès refusé sans session et avec l\'ancienne clé x-api-key', async () => {
  assert.equal((await fetch(base + '/authority/alerts')).status, 401);
  assert.equal((await fetch(base + '/authority/alerts', { headers: { 'x-api-key': 'gw_quelconque' } })).status, 401);
});

test('connexion, rôle et déconnexion', async () => {
  const r = await login('a_analyste', 'motdepasse-analyste');
  assert.equal(r.status, 200);
  const { token } = await r.json();
  const h = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(base + '/authority/alerts', { headers: h })).status, 200);
  assert.equal((await post('/authority/cases/c_x/verdict', { verdict: 'fonde' }, h)).status, 403);
  await post('/authority/logout', {}, h);
  assert.equal((await fetch(base + '/authority/alerts', { headers: h })).status, 401);
});

test('verrouillage après 5 échecs, même avec le bon mot de passe', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('a_agent1', 'mauvais')).status, 401);
  assert.equal((await login('a_agent1', 'motdepasse-agent-1')).status, 429);
});

test('changement de mot de passe : refus du mot de passe faible, sessions fermées', async () => {
  const { token } = await (await login('a_analyste', 'motdepasse-analyste')).json();
  const h = { authorization: `Bearer ${token}` };
  assert.equal((await post('/authority/password', { current: 'motdepasse-analyste', next: 'court' }, h)).status, 422);
  assert.equal((await post('/authority/password', { current: 'faux', next: 'nouveau-mot-de-passe' }, h)).status, 401);
  assert.equal((await post('/authority/password', { current: 'motdepasse-analyste', next: 'nouveau-mot-de-passe' }, h)).status, 200);
  assert.equal((await fetch(base + '/authority/alerts', { headers: h })).status, 401);
  assert.equal((await login('a_analyste', 'nouveau-mot-de-passe')).status, 200);
});

test('limitation de débit : création de portefeuilles', async () => {
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post('/wallets', {})).status);
  assert.deepEqual(codes, [201, 201, 201, 429]);
});
