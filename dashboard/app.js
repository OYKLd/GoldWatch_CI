/* Dashboard autorités GoldWatch CI — JS sans dépendance (hors Leaflet). La clé d'accès reste en sessionStorage. */
const API = location.origin + '/api/authority';
let TOKEN = '';
try { TOKEN = sessionStorage.getItem('gw_token') || ''; } catch { /* stockage indisponible */ }
let ME = null;
let map, layerGroup;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && TOKEN) { endSession(); throw new Error('Session expirée : reconnectez-vous'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function endSession() {
  TOKEN = '';
  try { sessionStorage.removeItem('gw_token'); } catch { /* ignoré */ }
  $('#login').hidden = false; $('#app').hidden = true; $('#tabs').hidden = true; $('#logoutBtn').hidden = true; $('#who').textContent = '';
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; setTimeout(() => (t.hidden = true), 3200); }

async function login() {
  try {
    ME = await api('/me');
    $('#logoutBtn').hidden = false;
    $('#login').hidden = true; $('#app').hidden = false; $('#tabs').hidden = false;
    $('#who').textContent = `${ME.name} — ${ME.organisation} (${ME.roleLabel})`;
    document.querySelectorAll('nav [data-role]').forEach((b) => { if (ME.role !== 'admin' && b.dataset.role !== ME.role) b.hidden = true; });
    show('alerts');
  } catch (e) {
    $('#loginErr').textContent = e.message;
  }
}
$('#loginBtn').onclick = async () => {
  $('#loginErr').textContent = '';
  try {
    const r = await api('/login', { method: 'POST', body: { id: $('#ident').value.trim(), password: $('#pwd').value } });
    TOKEN = r.token;
    $('#pwd').value = '';
    try { sessionStorage.setItem('gw_token', TOKEN); } catch { /* ignoré */ }
    login();
  } catch (e) { $('#loginErr').textContent = e.message; }
};
$('#pwd').addEventListener('keydown', (e) => e.key === 'Enter' && $('#loginBtn').click());
$('#logoutBtn').onclick = async () => { try { await api('/logout', { method: 'POST' }); } catch { /* ignoré */ } endSession(); };
if (TOKEN) login();

document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
function show(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ['alerts', 'cases', 'stats', 'fund', 'audit'].forEach((t) => ($('#tab-' + t).hidden = t !== tab));
  ({ alerts: loadAlerts, cases: loadCases, stats: loadStats, fund: loadFund, audit: loadAudit })[tab]().catch((e) => toast(e.message));
}

// ---- Alertes + carte des zones à risque -----------------------------------------------------------------
const COLORS = { haute: '#b3261e', moyenne: '#d97706', faible: '#2d6a4f' };
async function loadAlerts() {
  if (!map) {
    map = L.map('map').setView([5.75, -5.31], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);
    fetch(location.origin + '/api/layers').then((r) => r.json()).then((fc) => L.geoJSON(fc, {
      style: (f) => (f.properties.kind === 'river' ? { color: '#2b6cb0', weight: 3 } : { color: '#2d6a4f', weight: 1, fillOpacity: 0.12 }),
      onEachFeature: (f, l) => l.bindTooltip(f.properties.name),
    }).addTo(map));
  }
  const { zones } = await api('/alerts');
  layerGroup.clearLayers();
  $('#alertList').innerHTML = zones.length ? '' : '<div class="card">Aucune zone détectée.</div>';
  for (const z of zones) {
    const c = COLORS[z.level];
    L.circle([z.lat, z.lng], { radius: 400 + z.score * 12, color: c, fillColor: c, fillOpacity: 0.28, weight: 2 })
      .bindPopup(`<b>${esc(z.name)}</b><br>Score ${z.score}/100 — priorité ${z.level}<br>${z.reportCount} signalements`).addTo(layerGroup);
    const el = document.createElement('div');
    el.className = `item ${z.level}`;
    el.innerHTML = `<span class="score">${z.score}</span><h3>${esc(z.name)} <span class="tag ${z.level}">priorité ${z.level}</span>${z.corroborated ? '' : ' <span class="tag">en veille</span>'}</h3>
      <p>${esc(z.summary)}</p>
      <details><summary>Pourquoi cette priorité ?</summary><ul>${z.explanation.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>
      <p>Dossiers : ${z.caseIds.length ? z.caseIds.map((id) => `<a href="#" data-case="${esc(id)}">${esc(id.slice(-6))}</a>`).join(', ') : '—'} · dernier signalement ${fmt(z.lastReportAt)}</p>`;
    el.onclick = (ev) => {
      if (ev.target.dataset.case) { ev.preventDefault(); show('cases'); openCase(ev.target.dataset.case); return; }
      map.setView([z.lat, z.lng], 13);
    };
    $('#alertList').appendChild(el);
  }
  if (zones[0]) map.setView([zones[0].lat, zones[0].lng], 11);
  setTimeout(() => map.invalidateSize(), 50);
}

// ---- Dossiers + validation Fondé / Infondé ---------------------------------------------------------------
$('#caseFilter').onchange = () => loadCases();
async function loadCases() {
  const f = $('#caseFilter').value;
  const { cases } = await api('/cases' + (f ? `?status=${encodeURIComponent(f)}` : ''));
  $('#caseList').innerHTML = cases.length ? '' : '<div class="card">Aucun dossier.</div>';
  for (const c of cases) {
    const el = document.createElement('div');
    el.className = 'item';
    el.style.marginBottom = '10px';
    el.innerHTML = `<h3>Dossier ${esc(c.id.slice(-6))} <span class="tag">${esc(c.statusLabel)}</span></h3>
      <p>${c.reportCount} signalements · ${c.deviceCount} déclarants distincts · ${fmt(c.createdAt)}</p>`;
    el.onclick = () => openCase(c.id);
    $('#caseList').appendChild(el);
  }
}
async function openCase(id) {
  const c = await api(`/cases/${encodeURIComponent(id)}`);
  const canVerify = ME.role === 'agent' || ME.role === 'admin';
  const reports = c.reports.map((r) => `
    <div class="rep">
      <b>${esc(r.categoryLabel)}</b> <span class="tag">IA ${Math.round(r.aiConfidence * 100)} %</span>
      ${r.imageReused ? '<span class="tag haute">photo déjà vue</span>' : ''} <small>appareil …${esc(r.deviceRef)} · ${fmt(r.createdAt)}</small>
      <p>${esc(r.description) || '<i>Sans description</i>'}</p>
      <small>Position exacte : ${r.exact ? r.exact.lat.toFixed(5) + ', ' + r.exact.lng.toFixed(5) : '—'} (±${esc(r.accuracyM ?? '?')} m)</small>
      <details><summary>Analyse IA</summary><ul>${r.aiReasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>
      ${r.photo ? `<img data-src="${esc(r.photo)}" alt="photo">` : ''}
      ${r.audio ? `<audio controls data-src="${esc(r.audio)}"></audio>` : ''}
      ${canVerify && c.status === 'en_verification' ? `<label><input type="checkbox" class="mal" value="${esc(r.id)}" style="width:auto"> Signalement malveillant constaté</label>` : ''}
    </div>`).join('');
  const box = $('#caseDetail');
  box.innerHTML = `<h2>Dossier ${esc(c.id.slice(-6))} <span class="tag">${esc(c.statusLabel)}</span></h2>
    <p>${c.reportCount} signalements · ${c.deviceCount} déclarants distincts${c.centroid ? ` · centre ${c.centroid.lat.toFixed(4)}, ${c.centroid.lng.toFixed(4)}` : ''}</p>
    <div class="note">Les positions exactes ne sont jamais publiques. Cet accès est journalisé. Pour votre sécurité : ne pas intervenir sans escorte.${c.doubleValidation ? ' Double validation active : deux agents doivent rendre le même verdict.' : ''}</div>
    ${c.verdicts.length ? `<p>Verdicts : ${c.verdicts.map((v) => `${esc(v.verdict)} (${esc(v.authorityId)})`).join(', ')}</p>` : ''}
    ${reports}
    <textarea id="note" placeholder="Note de vérification (facultatif)"></textarea>
    <div class="actions">${actionsFor(c, canVerify)}</div>
    <h3>Historique</h3><ul>${c.history.map((h) => `<li>${fmt(h.at)} — ${esc(h.fromStatus || '∅')} → <b>${esc(h.toStatus)}</b> (${esc(h.actor)})</li>`).join('')}</ul>`;
  // médias chargés avec la clé d'accès (en-tête) puis exposés en blob
  box.querySelectorAll('[data-src]').forEach(async (el) => {
    const r = await fetch(location.origin + el.dataset.src, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.ok) el.src = URL.createObjectURL(await r.blob());
  });
  box.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(c.id, b.dataset.act)));
}
function actionsFor(c, canVerify) {
  if (!canVerify) return '<i>Lecture seule</i>';
  if (c.status === 'transmis') return '<button class="primary" data-act="assign">Prendre en charge</button>';
  if (c.status === 'en_verification') return '<button class="primary" data-act="fonde">Déclarer FONDÉ</button><button class="warn" data-act="infonde">Déclarer INFONDÉ</button>';
  if (c.status === 'fonde') return '<button class="primary" data-act="treated">Intervention menée (Traité)</button>';
  if (c.status === 'traite') return '<button class="primary" data-act="close">Clôturer</button>';
  return '';
}
async function act(id, a) {
  const base = `/cases/${encodeURIComponent(id)}`;
  try {
    if (a === 'assign') await api(`${base}/assign`, { method: 'POST' });
    else if (a === 'treated') await api(`${base}/treated`, { method: 'POST' });
    else if (a === 'close') await api(`${base}/close`, { method: 'POST' });
    else {
      const maliciousReportIds = [...document.querySelectorAll('.mal:checked')].map((x) => x.value);
      const r = await api(`${base}/verdict`, { method: 'POST', body: { verdict: a, note: $('#note').value, maliciousReportIds } });
      toast(r.finalized ? 'Verdict enregistré — points attribués si fondé' : r.message);
    }
    await openCase(id);
    loadCases();
  } catch (e) { toast(e.message); }
}

// ---- Statistiques / Fonds / Audit -----------------------------------------------------------------------------
async function loadStats() {
  const s = await api('/stats');
  const k = (v, l) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  $('#statsBox').innerHTML = [
    k(s.reports, 'Signalements'), k(s.cases, 'Dossiers corroborés'), k(s.casesOpen, 'Dossiers à traiter'), k(s.confirmed, 'Confirmés (fondés)'),
    k(s.unfounded, 'Infondés'), k(s.meanHoursToVerification ?? '—', 'Délai moyen de vérification (h)'), k(s.activeWallets, 'Déclarants actifs'),
    k(s.pointsDistributed, 'Points distribués'), k(s.rewardsPaidFcfa + ' FCFA', 'Récompenses versées (simulées)'),
  ].join('') + `<div class="kpi" style="grid-column:1/-1"><span>Par statut</span><br>${Object.entries(s.byStatus).map(([a, b]) => `<span class="tag">${esc(a)} : ${esc(b)}</span> `).join('')}</div>`;
}
async function loadFund() {
  const f = await api('/fund');
  $('#fundBox').innerHTML = `<div class="grid"><div class="kpi"><b>${f.balanceFcfa.toLocaleString('fr-FR')} FCFA</b><span>Solde du fonds de récompenses</span></div></div>
    <p class="note">Paiements simulés : aucun virement réel n'est émis. Les retraits au-dessus de ${esc(f.humanReviewAboveFcfa)} FCFA passent par une revue humaine. Le service de paiement ne reçoit que « portefeuille, montant ».</p>
    <div class="actions"><button class="primary" id="runPay">Exécuter les paiements (démo : tous)</button></div>
    <table><tr><th>Réf.</th><th>Portefeuille</th><th>Points</th><th>FCFA</th><th>Mode</th><th>Statut</th><th>Échéance</th><th></th></tr>
    ${f.withdrawals.map((w) => `<tr><td>${esc(w.id.slice(-6))}</td><td>…${esc(w.walletRef)}</td><td>${esc(w.points)}</td><td>${esc(w.amountFcfa)}</td><td>${esc(w.mode)}</td><td>${esc(w.status)}</td><td>${fmt(w.scheduledFor)}</td>
      <td>${w.status === 'revue_humaine' ? `<button class="ghost" data-ok="${esc(w.id)}">Approuver</button> <button class="ghost" data-no="${esc(w.id)}">Rejeter</button>` : ''}</td></tr>`).join('')}</table>`;
  $('#runPay').onclick = async () => { const r = await api('/payments/run', { method: 'POST', body: { force: true } }); toast(`${r.paid} paiement(s) simulé(s)`); loadFund(); };
  document.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => { await api(`/withdrawals/${encodeURIComponent(b.dataset.ok)}/approve`, { method: 'POST' }); loadFund(); }));
  document.querySelectorAll('[data-no]').forEach((b) => (b.onclick = async () => { await api(`/withdrawals/${encodeURIComponent(b.dataset.no)}/reject`, { method: 'POST' }); loadFund(); }));
}
async function loadAudit() {
  const [l, a] = await Promise.all([api('/audit/ledger'), api('/audit/access-log')]);
  $('#auditBox').innerHTML = `<div class="kpi"><b>${l.ok ? 'Intègre' : 'ALTÉRÉ (ligne ' + esc(l.brokenAt) + ')'}</b><span>Journal des points : ${esc(l.entries)} écritures chaînées par hachage</span></div>
    <h3>Accès autorités (positions exactes, médias, verdicts)</h3>
    <table><tr><th>Date</th><th>Autorité</th><th>Action</th><th>Cible</th></tr>
    ${a.entries.map((e) => `<tr><td>${fmt(e.at)}</td><td>${esc(e.authorityId)}</td><td>${esc(e.action)}</td><td>${esc(e.target || '')}</td></tr>`).join('')}</table>`;
}
