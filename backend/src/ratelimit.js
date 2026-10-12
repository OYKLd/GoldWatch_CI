// Limiteur de débit en mémoire. Les adresses ne sont jamais écrites sur disque ni journalisées :
// elles vivent le temps de la fenêtre (1 h) dans un compteur volatil, haché pour ne pas rester lisibles en mémoire.
import crypto from 'node:crypto';

const SALT = crypto.randomBytes(16); // propre à chaque démarrage

export function rateLimit({ name, max, windowMs = 3600000 }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, 60000);
  timer.unref();

  return (req, res, next) => {
    const key = crypto.createHash('sha256').update(SALT).update(req.ip || '').digest('hex');
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Trop de requêtes, réessayez plus tard', code: `rate_${name}` });
    }
    next();
  };
}
