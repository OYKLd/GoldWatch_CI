import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// Toutes les valeurs métier du document « Acteurs, logique métier, récompenses » sont des
// hypothèses de travail (annexe) : elles sont centralisées ici et surchargeables par variable d'environnement.
export const config = {
  root,
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'goldwatch.db'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  dashboardDir: path.resolve(root, '..', 'dashboard'),

  categories: {
    orpaillage: 'Activité d\'orpaillage suspecte',
    deforestation: 'Déforestation',
    pollution_eau: 'Pollution de cours d\'eau',
    decharge: 'Décharge en zone naturelle',
  },
  // catégories corrélées entre elles pour la corroboration et le clustering (règle R6)
  riskFamily: ['orpaillage', 'pollution_eau', 'deforestation'],

  corroboration: {
    minDistinctDevices: num(process.env.CORROBORATION_MIN, 3),
    radiusM: num(process.env.CORROBORATION_RADIUS_M, 1000),
    windowDays: num(process.env.CORROBORATION_WINDOW_DAYS, 42),
  },
  clustering: {
    linkRadiusM: num(process.env.CLUSTER_RADIUS_M, 2500),
    windowDays: num(process.env.CLUSTER_WINDOW_DAYS, 42),
  },
  privacy: {
    // cellule de ~1 km : l'erreur de position publique est comprise entre 0 et ~700 m (R2)
    gridDeg: 0.009,
    // délai aléatoire avant publication publique (décorrélation temporelle). 0 = mode démo.
    publishDelayMinMin: num(process.env.PUBLISH_DELAY_MIN, 0),
    publishDelayMaxMin: num(process.env.PUBLISH_DELAY_MAX, 0),
  },
  antiFraud: {
    maxReportsPerDay: num(process.env.MAX_REPORTS_PER_DAY, 5),
    duplicateRadiusM: 200,
    maxRewardedPerDay: 3,
    strikesBeforeBlock: 3,
    newcomerConfirmations: 3, // en dessous : points x 0.5
    doubleValidation: process.env.DOUBLE_VALIDATION === '1',
  },
  points: {
    corroborated: 10,
    confirmed: 50,
    firstReporter: 100,
    quality: 20,
    malicious: -50,
    newSiteRadiusM: 1500,
  },
  withdrawal: {
    fcfaPerPoint: 10,
    minPoints: 500,
    monthlyCapFcfa: 50000,
    humanReviewAboveFcfa: 30000,
    delayDaysMin: 3,
    delayDaysMax: 10,
    pointsExpireMonths: 12,
    modes: {
      mobile_money: 'Mobile money (trace chez l\'opérateur)',
      credit_communication: 'Crédit de communication',
      bon_agent: 'Bon retirable chez un agent partenaire',
      fonds_communautaire: 'Versement à un fonds communautaire',
    },
  },
  // Côte d'Ivoire (boîte englobante) : refuse les positions manifestement fantaisistes
  bounds: { minLat: 4.3, maxLat: 10.8, minLng: -8.7, maxLng: -2.4 },
  maxPhotoBytes: 8 * 1024 * 1024,
  maxAudioBytes: 5 * 1024 * 1024,
};
