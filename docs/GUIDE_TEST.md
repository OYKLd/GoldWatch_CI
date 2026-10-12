# Guide de test — GoldWatch CI

Durée : ~20 min. Tout se passe en local, aucun paiement réel, rien n'est envoyé sur GitHub.

## 0. Préparer et démarrer

```powershell
cd C:\Users\DELL\Documents\GoldWatch_CI\backend
npm install
npm run seed     # recharge les données de démo (efface tout le reste)
npm start        # laisse cette fenêtre ouverte
```

Vérifie : <http://localhost:3000/api/health> doit répondre `{"ok":true,...}`.

Identifiants, mots de passe de démo (dashboard) et portefeuille de démo : ouvre `backend\data\credentials.json`.

| Compte | Rôle | Sert à |
|---|---|---|
| `a_agent1`, `a_agent2` | agent vérificateur | valider Fondé/Infondé |
| `a_analyste` | analyste | lecture seule |
| `a_fonds` | gestionnaire du fonds | retraits, paiements |
| `a_admin` | admin | audit, tout |
| `demoWallet` | portefeuille citoyen | 620 points pour tester le retrait |

Après `npm run seed` tu dois avoir : 18 signalements, 2 dossiers (Hiré « transmis » avec 12 signalements, Divo « fondé »).

## 1. Dashboard autorités

1. Ouvre <http://localhost:3000/dashboard/>, saisis l'identifiant `a_agent1` et son mot de passe (dans `credentials.json`).
2. **Alertes** : Divo (≈70, haute) et Hiré (≈68, haute) en tête, deux zones « en veille » (le classement peut varier de quelques points). Clique « Pourquoi cette priorité ? » : le score est expliqué. Le texte doit ressembler à « Zone de Hiré : 12 signalements… priorité haute ».
3. **Dossiers** → filtre « Transmis » → dossier Hiré :
   - tu vois les positions exactes, l'analyse IA de chaque signalement, l'historique ;
   - clique **Prendre en charge** → statut « En vérification » ;
   - coche « malveillant » sur un signalement, clique **Déclarer FONDÉ**.
4. Résultat attendu : dossier « Fondé » ; boutons suivants « Traité » puis « Clôturer » (la machine d'états refuse de sauter une étape).
5. **Statistiques** : confirmés = 2, points distribués en hausse.

Variante infondé : relance `npm run seed` (redémarre le serveur après), refais l'étape 3 avec **INFONDÉ** en cochant un signalement malveillant : ce déclarant perd 50 points et un strike ; au 3e strike il est bloqué.

## 2. Appli mobile (version web)

Ouvre <http://localhost:3000/app/> (si la page est vide, voir §7).

1. **Carte** : centrée sur Hiré, avec les vrais cours d'eau et la forêt classée d'OpenStreetMap (un tracé de rivière passe près des pastilles). Active/désactive les 4 couches (puces en haut). Zoom : les pastilles se regroupent. Pastille dorée = signalements, rouge = confirmé.
2. Touche une pastille ou la carte : fiche avec statut, nb de signalements sur 30 jours, niveau d'alerte IA, et la mention que la position est approximative.
3. **Alertes** : zones haute/moyenne uniquement, triées par score. Les zones « en veille » n'y sont pas (corroboration requise).
4. **Mes points** : solde 0 pour un nouveau portefeuille, barème, code de récupération. L'œil en haut masque les montants (mode discret).
5. **Signaler** : choisis une catégorie, écris une description, envoie. Message attendu : statut « En attente de corroboration » et « aucun point n'est attribué à l'envoi ». Renvoie le même lieu : refus « doublon ».

Chaque navigateur/profil = un portefeuille différent (stocké localement). Utilise une fenêtre privée pour simuler un 2e téléphone.

## 3. Corroboration et points de bout en bout (script)

Crée 3 déclarants distincts au même endroit, dans un lieu vierge (PowerShell, serveur lancé) :

```powershell
$b='http://localhost:3000/api'
1..3 | ForEach-Object {
  $w = Invoke-RestMethod -Method Post "$b/wallets"
  $h = @{ Authorization = "Wallet $($w.walletId):$($w.recoveryCode)" }
  $body = @{ category='orpaillage'; description='Orpailleurs avec motopompe pres de la riviere'; lat=6.200+($_*0.001); lng=-5.000; accuracyM=20 } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post "$b/reports" -Headers $h -ContentType 'application/json' -Body $body
  "$_ -> $($r.statusLabel)"
}
```

Attendu : `1 -> En attente de corroboration`, `2 -> En attente de corroboration`, `3 -> Transmis aux autorités`.
Dans le dashboard : nouveau dossier « transmis » (3 signalements, 3 déclarants). Valide-le Fondé, puis consulte les points d'un de ces portefeuilles :

```powershell
Invoke-RestMethod "$b/wallet" -Headers $h   # le dernier $h
```

Attendu : +5 (corroboration, nouveau déclarant ×0,5), +25 (confirmé), +50 (premier signaleur, pour le tout premier), etc.

## 4. Retrait des points (récompenses)

1. Dans l'appli : **Mes points** → « Récupérer un portefeuille » → saisis `walletId` et `recoveryCode` de `demoWallet`.
2. Solde 620 pts ≈ 6 200 FCFA. Bouton **Retirer** actif (seuil 500).
3. Choisis un mode (ex. crédit de communication), confirme. Attendu : « Retrait de X FCFA planifié ». Le solde baisse.
4. Redemande un retrait : le seuil de 500 n'est plus atteint → refus.
5. Dashboard connecté avec `a_fonds` : onglet **Fonds** → le retrait « planifie » apparaît → **Exécuter les paiements** (simulé) → statut « verse », solde du fonds en baisse.
6. Revue humaine : un retrait > 30 000 FCFA (3 000 points) passe en « revue_humaine » (Approuver/Rejeter). Le cas est couvert par les tests automatiques ; il faut beaucoup de points pour le reproduire à la main.

## 5. Contrôles anti-fraude et vie privée

| Test | Comment | Attendu |
|---|---|---|
| Doublon | même portefeuille, même lieu, < 24 h | 409 « doublon » |
| Hors Côte d'Ivoire | `lat=48.8; lng=2.3` | 422 « hors de la Côte d'Ivoire » |
| Limite quotidienne | 6 signalements en 24 h, même portefeuille | 429 au 6e |
| Photo réutilisée | même image envoyée par 2 portefeuilles | 2e : « photo déjà vue », ni corroborée ni récompensée |
| EXIF supprimé | envoyer une photo avec GPS, regarder `backend\data\uploads\` | métadonnées absentes (le test automatique le vérifie) |
| Orpaillage non publié | 1 seul signalement d'orpaillage | absent de `GET /api/public/reports` tant qu'il n'est pas corroboré |
| Position floutée | `GET /api/public/reports` | coordonnées au centre d'une cellule de ~1 km, jamais l'exacte |
| Accès sans session | `GET /api/authority/alerts` sans en-tête | 401 |
| Mauvais mot de passe | 5 essais ratés sur `a_agent1`, puis le bon | 429 « compte verrouillé » pendant 15 min |
| Mauvais rôle | connecté en `a_analyste` : tenter un verdict | 403 |
| Création en masse | plus de 20 portefeuilles en 1 h depuis la même adresse | 429 |

## 6. Audit (connecté en `a_admin`)

Onglet **Audit** : « Intègre » pour le journal des points, et la liste des accès aux positions exactes (chaque ouverture de dossier est tracée).

Double validation (deux agents) : redémarre avec

```powershell
$env:DOUBLE_VALIDATION='1'; npm start
```

Changer un mot de passe (une fois connecté : récupère le jeton avec `POST /api/authority/login`) :

```powershell
$b='http://localhost:3000/api'
$r = Invoke-RestMethod -Method Post "$b/authority/login" -ContentType 'application/json' -Body (@{id='a_agent1'; password='<mot de passe de credentials.json>'} | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($r.token)" }
Invoke-RestMethod -Method Post "$b/authority/password" -Headers $h -ContentType 'application/json' -Body (@{current='<ancien>'; next='nouveau-mot-de-passe-12'} | ConvertTo-Json)
```

Attendu : « Mot de passe modifié », et l'ancienne session ne marche plus. Un mot de passe de moins de 10 caractères est refusé (422).

Verdict avec `a_agent1` → message « Seconde validation requise » ; même verdict avec `a_agent2` → finalisé. Verdicts contradictoires → « arbitrage requis ».

## 7. Tests automatiques et dépannage

```powershell
cd backend; npm test                      # 12 tests, doivent tous passer
cd ..\mobile; flutter analyze             # « No issues found »
flutter build web --base-href /app/       # reconstruit la page /app/
```

| Problème | Solution |
|---|---|
| `/app/` introuvable | lance la commande `flutter build web` ci-dessus depuis PowerShell (pas Git Bash), puis redémarre le serveur |
| Fond de carte gris « Access blocked » | OpenStreetMap exige un Referer ; ouvre l'appli via `http://localhost:3000/app/`, pas depuis un fichier |
| Port 3000 occupé | `$env:PORT=3001; npm start` et change l'URL via la roue dentée de l'appli |
| Données incohérentes après tests | arrête le serveur, `npm run seed`, relance |
| Appli sur émulateur Android | `flutter run` ; l'API est jointe via `10.0.2.2:3000` (l'APK se compile, jamais lancé sur un appareil) |
| Mot de passe oublié ou `credentials.json` perdu | arrête le serveur, supprime `backend\data\goldwatch.db` et `backend\data\credentials.json`, puis `npm run seed` : de nouveaux comptes et mots de passe sont créés |
| Compte verrouillé (429) | attends 15 minutes, ou arrête le serveur et relance-le après avoir supprimé `goldwatch.db` + `npm run seed` |
