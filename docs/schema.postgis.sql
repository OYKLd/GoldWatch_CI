-- Schéma cible PostgreSQL + PostGIS (architecture du dossier de présentation, section 7).
-- Le MVP local utilise SQLite embarqué (backend/src/db.js) avec la même structure logique ;
-- ce fichier sert de base pour la migration. Les requêtes géographiques du MVP (haversine,
-- union-find) correspondent à ST_DWithin / ST_ClusterDBSCAN ci-dessous.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,                       -- pseudonyme aléatoire, aucun nom ni numéro
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  points INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_to TEXT
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  category TEXT NOT NULL,
  ai_confidence REAL NOT NULL,
  status TEXT NOT NULL,
  case_id TEXT REFERENCES cases(id),
  public_geom geography(Point, 4326) NOT NULL,   -- centre de cellule ~1 km : seule position publique
  image_hash TEXT,
  image_reused BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  publish_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX reports_public_gix ON reports USING GIST (public_geom);

-- Canal sécurisé : position exacte dans une table (et idéalement un schéma/rôle) séparée.
CREATE TABLE exact_locations (
  report_id TEXT PRIMARY KEY REFERENCES reports(id),
  geom geography(Point, 4326) NOT NULL
);
CREATE INDEX exact_locations_gix ON exact_locations USING GIST (geom);

-- Corroboration : déclarants distincts dans 1 km et 42 jours
-- SELECT COUNT(DISTINCT r2.wallet_id) FROM reports r2 JOIN exact_locations e2 USING (report_id) ...
--   WHERE ST_DWithin(e2.geom, :point, 1000) AND r2.created_at > now() - interval '42 days';

-- Clustering géo-temporel (R6) : ST_ClusterDBSCAN(geom::geometry, eps := 0.0225, minpoints := 3) OVER ()

CREATE TABLE ledger (               -- append-only, chaîne de hachage
  id BIGSERIAL PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  case_id TEXT,
  report_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
REVOKE UPDATE, DELETE ON ledger FROM PUBLIC;

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  points INTEGER NOT NULL,
  amount_fcfa INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for TIMESTAMPTZ NOT NULL,
  reviewed_by TEXT
);

-- Couches contextuelles (OpenStreetMap / Overpass)
CREATE TABLE protected_areas (id BIGSERIAL PRIMARY KEY, name TEXT, geom geography(MultiPolygon, 4326));
CREATE TABLE rivers          (id BIGSERIAL PRIMARY KEY, name TEXT, geom geography(LineString, 4326));
CREATE INDEX protected_areas_gix ON protected_areas USING GIST (geom);
CREATE INDEX rivers_gix ON rivers USING GIST (geom);
