import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { publicRouter } from './routes/public.js';
import { authorityRouter } from './routes/authority.js';
import { ensureAuthorities } from './services/authorities.js';
import { expirePendingReports } from './services/workflow.js';
import { expireInactivePoints, runDuePayments } from './services/points.js';

export function createApp() {
  ensureAuthorities();
  const app = express();
  app.disable('x-powered-by');
  // Aucun journal d'accès HTTP (pas d'IP conservées) : « sans compte » ne doit pas signifier « avec traces ».
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    // origine seule (pas de chemin) : les tuiles OpenStreetMap exigent un Referer valide
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use('/api/authority', authorityRouter);
  app.use('/api', publicRouter);

  if (fs.existsSync(config.dashboardDir)) app.use('/dashboard', express.static(config.dashboardDir));
  // Build web de l'appli mobile (flutter build web --base-href /app/) : démo sans émulateur.
  const webApp = path.resolve(config.root, '..', 'mobile', 'build', 'web');
  if (fs.existsSync(webApp)) app.use('/app', express.static(webApp));
  app.get('/', (_req, res) => res.redirect('/dashboard/'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.name === 'MulterError') return res.status(413).json({ error: 'Fichier refusé', code: err.code });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erreur interne' : err.message, code: err.code });
  });
  return app;
}

export function startMaintenance() {
  const run = () => {
    try {
      expirePendingReports();
      expireInactivePoints();
      runDuePayments();
    } catch (e) {
      console.error('maintenance', e);
    }
  };
  const t = setInterval(run, 60 * 60 * 1000);
  t.unref();
  return run;
}
