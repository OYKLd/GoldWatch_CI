// Classification automatique des signalements (Citizen AI, étape 1).
// Approche volontairement explicable : lexique pondéré FR/« français local » + catégorie déclarée.
// Le document signale l'absence de données d'entraînement pour des photos réelles : l'interface
// `classify()` est stable et pourra être remplacée par un modèle vision/texte une fois un jeu de
// données labellisé disponible.

const LEXICON = {
  orpaillage: [
    'orpaill', 'galamsey', 'chercheur d\'or', 'chercheurs d\'or', 'or ', 'sluice', 'drague', 'dragage', 'pelle', 'excavatrice',
    'concasseur', 'motopompe', 'pompe', 'creus', 'trou', 'puits', 'tamis', 'mercure', 'cyanure', 'placer', 'site minier',
    'machine', 'clandestin', 'orpailleur', 'lavage', 'laverie',
  ],
  pollution_eau: [
    'eau', 'rivière', 'riviere', 'fleuve', 'marigot', 'boueu', 'trouble', 'jaune', 'marron', 'rouge', 'poisson', 'mort',
    'pollu', 'huile', 'carburant', 'mousse', 'odeur', 'sédiment', 'sediment', 'couleur',
  ],
  deforestation: [
    'forêt', 'foret', 'arbre', 'abattu', 'coupe', 'tronc', 'défrich', 'defrich', 'brûlis', 'brulis', 'tronçonn', 'tronconn',
    'déboisement', 'deboisement', 'végétation', 'vegetation', 'déforest', 'deforest',
  ],
  decharge: ['décharge', 'decharge', 'ordure', 'déchet', 'dechet', 'plastique', 'dépôt', 'depot', 'poubelle', 'ferraille'],
};

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function classify({ declared, description = '', hasPhoto = false, hasAudio = false }) {
  const text = ` ${plain(description)} `;
  const scores = {};
  const hits = {};
  for (const [cat, words] of Object.entries(LEXICON)) {
    hits[cat] = words.filter((w) => text.includes(plain(w)));
    scores[cat] = hits[cat].length;
  }
  // La catégorie choisie par le citoyen est un indice fort ; le texte peut la corriger s'il est sans ambiguïté.
  scores[declared] = (scores[declared] || 0) + 1.5;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topCat, topScore] = ranked[0];
  const total = ranked.reduce((s, [, v]) => s + v, 0) || 1;
  let confidence = topScore / total;
  if (hasPhoto) confidence = Math.min(1, confidence + 0.1);
  if (hasAudio) confidence = Math.min(1, confidence + 0.05);

  const reasons = [];
  if (topCat === declared) reasons.push('Catégorie choisie par le déclarant');
  else reasons.push(`Description plus proche de « ${topCat} » que de la catégorie choisie (« ${declared} »)`);
  if (hits[topCat].length) reasons.push(`Indices dans la description : ${hits[topCat].slice(0, 4).join(', ')}`);
  if (hasPhoto) reasons.push('Photo jointe');
  if (hasAudio) reasons.push('Note vocale jointe');

  // On ne remplace la catégorie déclarée que si le texte la contredit nettement.
  const final = topCat !== declared && hits[topCat].length >= 2 && hits[topCat].length > hits[declared].length ? topCat : declared;
  return { category: final, confidence: Math.round(confidence * 100) / 100, reasons };
}
