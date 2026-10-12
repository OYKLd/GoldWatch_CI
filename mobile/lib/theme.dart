import 'package:flutter/material.dart';

const kGreen = Color(0xFF1B4332);
const kGreenMid = Color(0xFF2D6A4F);
const kGold = Color(0xFFB88A00);
const kHigh = Color(0xFFB3261E);
const kMedium = Color(0xFFD97706);

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: kGreenMid, primary: kGreen, secondary: kGold);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    appBarTheme: const AppBarTheme(backgroundColor: kGreen, foregroundColor: Colors.white),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(backgroundColor: kGold, foregroundColor: Colors.white),
  );
}

Color levelColor(String? level) {
  switch (level) {
    case 'haute':
      return kHigh;
    case 'moyenne':
      return kMedium;
    default:
      return kGreenMid;
  }
}

const categoryIcons = <String, IconData>{
  'orpaillage': Icons.construction,
  'deforestation': Icons.forest,
  'pollution_eau': Icons.water_drop,
  'decharge': Icons.delete_outline,
};

const categoryLabels = <String, String>{
  'orpaillage': 'Activité d\'orpaillage suspecte',
  'deforestation': 'Déforestation',
  'pollution_eau': 'Pollution de cours d\'eau',
  'decharge': 'Décharge en zone naturelle',
};

const statusLabels = <String, String>{
  'recu': 'Reçu',
  'attente_corroboration': 'En attente de corroboration',
  'corrobore': 'Corroboré',
  'transmis': 'Transmis aux autorités',
  'en_verification': 'En vérification',
  'fonde': 'Fondé',
  'infonde': 'Infondé',
  'traite': 'Traité',
  'cloture': 'Clôturé',
  'expire': 'Expiré',
};

const reasonLabels = <String, String>{
  'dotation_demo': 'Dotation de démonstration',
  'signalement_corrobore': 'Signalement corroboré',
  'signalement_confirme': 'Signalement confirmé',
  'bonus_qualite': 'Bonus qualité',
  'bonus_premier_signaleur': 'Bonus premier signaleur',
  'signalement_malveillant': 'Signalement malveillant',
  'retrait_demande': 'Retrait demandé',
  'retrait_rejete_remboursement': 'Retrait rejeté (remboursé)',
  'expiration_12_mois': 'Expiration (12 mois sans activité)',
};
