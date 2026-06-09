# Test saveEfact — dépôt d'une facture signée sur ElFatoora (test)

But : envoyer une facture **déjà signée** à la plateforme de test ElFatoora via l'opération SOAP `saveEfact`
et observer la réponse → valider (a) connectivité/authentification et (b) si TTN **accepte la signature**.

> ⚠️ La plateforme filtre par IP. L'appel doit sortir par l'**IP whitelistée du serveur Hetzner** (`37.27.65.254`).
> On déploie donc ce test **via Dokploy** (qui tourne sur ce serveur) → l'egress passe par la bonne IP.

## Contenu
- `server.js` — service HTTP (routes `/describe` et `/send`) — **pour Dokploy**
- `test-saveefact.js` — variante CLI (si un jour accès shell direct)
- `lib.js` — logique partagée saveEfact
- `Dockerfile`, `.dockerignore`, `package.json`
- `TEIF_FAC_2024_003_signe.xml` — facture signée embarquée (émetteur matricule `1234567ABC`)

## Déploiement via Dokploy

1. **Source** : créer une *Application* Dokploy pointant sur ce dossier.
   - Soit via un dépôt Git (pousser ce dossier `test-saveefact/`),
   - soit en copiant ces fichiers dans un service Docker (build type **Dockerfile**).
2. **Build** : type **Dockerfile** (présent à la racine du dossier). Port exposé : **3000**.
3. **Variables d'environnement** (onglet Environment de l'app Dokploy) :
   | Variable | Valeur |
   |---|---|
   | `ELFATOORA_LOGIN` | login du compte de test |
   | `ELFATOORA_PASSWORD` | mot de passe |
   | `ELFATOORA_MATRICULE` | `1234567ABC` (= émetteur du XML) |
   | `ELFATOORA_WSDL` | `https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl` *(défaut)* |
   | `INSECURE_TLS` | `1` *(accepte cert auto-signé du test)* |
   | `TRIGGER_TOKEN` | *(optionnel)* un secret pour protéger `/send` |
4. **Déployer**, puis ouvrir l'URL exposée par Dokploy :
   - `GET /describe` → récupère le WSDL et affiche la **signature de l'opération** (confirme les noms de paramètres, **sans envoi**).
   - `GET /send` → **envoie** la facture signée et renvoie le journal complet (requête SOAP + réponse / fault).
     - Si `TRIGGER_TOKEN` est défini : `GET /send?token=VOTRE_TOKEN`.
5. La sortie est aussi visible dans les **logs** du conteneur (Dokploy → Logs).

## Lecture du résultat
- **Réponse `saveEfact`** = une chaîne (message succès/échec).
- En cas d'**erreur de signature**, TTN renvoie un message/acquittement négatif → c'est le point clé
  (rappel : cette signature échouait en validation **DSS locale** avec `HASH_FAILURE` ; on vérifie ici le réel).
- `saveEfact` n'est qu'un accusé : la **réf TTN** (`generatedRef`) et les acquittements viennent ensuite via `consultEfact`.

## Si `/describe` montre des paramètres ≠ `arg0..arg3`
Ajouter la variable d'env `ARG_NAMES`, ex. `ARG_NAMES=login,password,matricule,documentEfact`, puis redéployer.

## Variante CLI (si accès shell)
```bash
npm install
DESCRIBE_ONLY=1 node test-saveefact.js
ELFATOORA_LOGIN=... ELFATOORA_PASSWORD=... ELFATOORA_MATRICULE=1234567ABC \
  node test-saveefact.js ./TEIF_FAC_2024_003_signe.xml
```
