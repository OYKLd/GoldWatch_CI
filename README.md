# GoldWatch CI

**À quoi ça sert ?** Permettre aux habitants de signaler, en quelques secondes et de façon anonyme, l'orpaillage illégal et les atteintes à l'environnement (eau polluée, forêt coupée, décharge sauvage). Une IA recoupe les signalements pour repérer les zones à risque, les autorités vérifient sur place, et le citoyen gagne des points si son signalement est confirmé.

Projet du Hackathon Défi 3 (biodiversité et lutte contre l'orpaillage illégal) — *« La carte comme point d'entrée. »*

```
Citoyen signale (photo, voix, position)  →  l'IA recoupe les signalements  →  alerte aux autorités
      →  vérification sur le terrain (Fondé / Infondé)  →  points  →  retrait (simulé)
```

## Tester en 5 minutes

Tout se passe sur ton ordinateur, aucun vrai paiement, rien n'est envoyé sur internet. Prérequis : Node.js ≥ 22.13.

**1. Démarrer le serveur** (PowerShell, dans le dossier du projet)

```bash
cd backend
npm install
npm run seed
npm start
```

Laisse la fenêtre ouverte. Tu dois lire « GoldWatch CI API http://localhost:3000 ».

**2. Côté autorités** — ouvre <http://localhost:3000/dashboard/>

- Ouvre `backend/data/credentials.json` : prends l'identifiant `a_agent1` et son `password`, puis saisis-les pour te connecter.
- Onglet **Alertes** : les zones à risque détectées (Hiré, Divo…), avec « Pourquoi cette priorité ? ».
- Onglet **Dossiers** → ouvre le dossier « Transmis » → **Prendre en charge** → **Déclarer FONDÉ**. Les déclarants reçoivent leurs points.

**3. Côté citoyen** — ouvre <http://localhost:3000/app/>

- La carte s'affiche : touche un point pour voir sa fiche, active ou coupe les couches.
- Bouton doré **Signaler** → choisis une catégorie → **Envoyer anonymement**.
- Onglet **Mes points** : ton solde et le barème.

> Si `/app/` est vide (l'appli web n'est pas versionnée), construis-la une fois : `cd mobile`, `flutter pub get`, `flutter build web --base-href /app/`, puis redémarre le serveur.

**4. Récompenses** — dans l'appli, **Mes points** → « Récupérer un portefeuille » → colle `walletId` et `recoveryCode` du bloc `demoWallet` de `credentials.json` → tu as 620 points → **Retirer**.

Scénarios plus complets (corroboration à 3 déclarants, anti-fraude, audit, double validation) : voir **[docs/GUIDE_TEST.md](docs/GUIDE_TEST.md)**.

Problème ? Arrête le serveur (Ctrl+C), refais `npm run seed` puis `npm start` pour repartir de données propres.

---

# Documentation technique

## Contenu

| Dossier | Rôle |
|---|---|
| `backend/` | API Node.js / Express, moteur Citizen AI, machine d'états, points et retraits |
| `dashboard/` | Dashboard autorités (web, Leaflet) servi par le backend sur `/dashboard/` |
| `mobile/` | Appli Flutter (carte `flutter_map`/OSM, signalement, alertes, « Mes points ») |
| `docs/schema.postgis.sql` | Schéma cible PostgreSQL + PostGIS |

## Démarrage

Prérequis : Node.js ≥ 22.13, Flutter (pour l'appli mobile).

```bash
cd backend
npm install
npm run seed      # données de démonstration FICTIVES (scénario « Zone de Hiré ») + comptes de démo
npm start         # http://localhost:3000
```

- Dashboard autorités : <http://localhost:3000/dashboard/> — identifiants et mots de passe dans `backend/data/credentials.json`
  (agents, analyste, gestionnaire du fonds, admin ; générés localement, non versionnés).
- Appli mobile en version web (si `mobile/build/web` existe) : <http://localhost:3000/app/>
- Portefeuille de démonstration (≥ 500 points, pour tester le retrait) : même fichier, bloc `demoWallet`.
- Les mots de passe de démo sont modifiables depuis l'API (`POST /api/authority/password`) ; ils sont conservés d'un `npm run seed` à l'autre.

Appli mobile :

```bash
cd mobile
flutter pub get
flutter run                              # émulateur Android : l'API est jointe via 10.0.2.2:3000
flutter run -d chrome --dart-define=API_URL=http://localhost:3000
flutter build web --base-href /app/      # puis servie par le backend sur /app/
```

L'URL du serveur est aussi modifiable dans l'appli (roue dentée).

Tests : `cd backend && npm test` (12 tests : points, machine d'états, anonymisation, clustering, connexion, verrouillage, limitation de débit).

## Correspondance avec le document « Acteurs, logique métier, récompenses »

| Exigence | Où |
|---|---|
| R1 pseudonymat / portefeuille sans identité, code de récupération | `services/points.js` (`createWallet`) |
| R2 double position : floue publique (cellule ≈ 1 km, erreur ≤ ~700 m) / exacte chiffrée AES-256-GCM, table séparée | `geo.js`, `db.js`, `services/workflow.js` |
| R3 canal sécurisé, pas d'affichage temps réel de l'orpaillage | `routes/public.js` (`/public/reports`), `routes/authority.js` |
| R4 corroboration (N déclarants distincts, 1 km, 42 j — paramétrable) | `workflow.js` (`runCorroboration`), `config.js` |
| R5 classification IA explicable | `ai/classifier.js` |
| R6 clustering géo-temporel + score de priorité expliqué | `ai/zones.js` |
| R7 couches zones protégées / cours d'eau | `layers.js`, `data/layers.osm.geojson` (réel) ou `data/layers.geojson` (démo), `scripts/fetch-osm-layers.js` |
| R8 alertes triées, onglet Alertes, dashboard | `mobile/lib/screens/alerts_screen.dart`, `dashboard/` |
| Machine d'états (Reçu → … → Clôturé / Expiré) | `workflow.js` (`TRANSITIONS`) |
| Points : 0 à l'envoi, +10 corroboré, +50 confirmé, +100 premier signaleur, +20 qualité, sanction si malveillant | `config.js`, `workflow.js` (`finalizeVerdict`) |
| Seuil 500 pts, 1 pt = 10 FCFA, plafond 50 000 FCFA/mois, délai 3–10 j, expiration 12 mois, revue humaine | `services/points.js` |
| Cloisonnement du paiement (le prestataire ne reçoit que « portefeuille, montant ») | table `payments`, aucun lien vers `reports` |
| Anti-fraude : 1 compte/appareil, plafonds, confiance progressive, photos réutilisées, journal inaltérable, double validation | `workflow.js`, `points.js` (`verifyLedger`), `DOUBLE_VALIDATION=1` |
| Journalisation des accès aux positions exactes | table `access_log`, onglet Audit du dashboard |
| Connexion autorités (mot de passe scrypt, sessions, verrouillage) et limitation de débit | `services/authorities.js`, `ratelimit.js` |
| Écrans « Mes points », mode discret, retrait simulé, validation Fondé/Infondé | `points_screen.dart`, `dashboard/` |

## Choix d'implémentation et écarts avec le dossier

- **SQLite embarqué au lieu de PostgreSQL/PostGIS** : exécutable sans serveur (`node:sqlite`). Le schéma cible est dans `docs/schema.postgis.sql`.
- **OpenStreetMap (`flutter_map`) au lieu de Mapbox** : pas de jeton nécessaire.
- **Couches OpenStreetMap réelles** pour la zone de Divo/Hiré (`data/layers.osm.geojson`, cours d'eau et forêt classée de Go-Bodienou, © contributeurs OpenStreetMap, ODbL). Si ce fichier est absent, le serveur utilise `data/layers.geojson`, fictif. Pour une autre zone : `npm run layers:osm -- sud,ouest,nord,est`. Le tagging OSM des forêts classées est incomplet : une zone protégée absente d'OSM n'est pas détectée.
- **IA à règles** (lexique pondéré + score d'indices) : il n'existe pas de jeu de données labellisé de photos d'orpaillage (le document le signale). L'interface `classify()` est prévue pour accueillir un modèle.
- **Paiements simulés** : aucun appel à un opérateur de mobile money ; le numéro de paiement n'est jamais collecté ni stocké.
- **Vérification satellite Sentinel-2** : hors MVP (feuille de route).
- **Délai de publication publique** : `PUBLISH_DELAY_MIN/MAX` (minutes). À 0 par défaut pour la démo ; à régler en production pour décorréler publication et signalement.

## Limites connues

- Anonymat : le serveur ne journalise pas les IP, mais un déploiement réel doit aussi le garantir au niveau proxy/hébergeur. La voix reste reconnaissable dans les notes vocales (jamais publiques). En zone peu peuplée, le flou ne protège pas un déclarant isolé : d'où l'absence d'affichage public de l'orpaillage avant corroboration.
- Les valeurs de points, seuils et plafonds sont les hypothèses de l'annexe du document : à calibrer avec bailleurs et opérateur.
- Authentification autorités : identifiant + mot de passe (scrypt), sessions de 8 h, verrouillage 15 min après 5 échecs, changement de mot de passe, limitation de débit. Un déploiement réel doit ajouter SSO/MFA, HTTPS et un cloisonnement réseau.
- Android : l'APK de débogage se compile (`flutter build apk --debug`) mais n'a pas été lancé sur un téléphone ou un émulateur. Les licences du SDK Android ne sont pas toutes acceptées sur cette machine (`flutter doctor --android-licenses`).
