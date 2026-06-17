# Test saveEfact — dépôt d'une facture signée sur ElFatoora (test)

But : envoyer une facture **déjà signée** à la plateforme de test ElFatoora via l'opération SOAP `saveEfact`
et observer la réponse → valider (a) connectivité/authentification, (b) conformité XSD, et (c) si TTN
**accepte la signature** (selon la voie de signature et l'autorisation du signataire).

> ⚠️ La plateforme filtre par IP. L'appel doit sortir par l'**IP whitelistée du serveur Hetzner** (`37.27.65.254`).
> On déploie donc ce test **via Dokploy** (qui tourne sur ce serveur) → l'egress passe par la bonne IP.

URL déployée (Dokploy) :
**`https://elfatoora-back-cyketi-03c36c-37-27-65-254.traefik.me`**

## Contenu
- `server.js` — service HTTP (routes ci-dessous) — **pour Dokploy**
- `lib.js` — logique partagée `saveEfact` / `consultEfact`
- `test-saveefact.js` — variante CLI (si un jour accès shell direct)
- `Dockerfile`, `.dockerignore`, `package.json`
- XML embarqués dans l'image (émetteur = matricule complet `1557686RAM000`) :
  | Fichier | Voie de signature | Cert (n° série) |
  |---|---|---|
  | `TEIF_FAC_2024_003_1557686RAM000_v3_DIGIGO_signed.xml` | DigiGO (cloud TunTrust) | `7B410D39…` — **accepté** |
  | `TEIF_FAC_2024_003_1557686RAM000_v3_USB_signed.xml` | Clé USB (QSign local) | `0BB3F842…` — `SERV09` tant que non activé côté TTN |
  | `TEIF_FAC_2024_003_1557686RAM000_v3_unsigned.xml` | — (gabarit non signé, accepté par le noyau) | — |

## Routes

| Méthode / Route | Rôle |
|---|---|
| `GET /` ou `/health` | page d'aide + liste des routes |
| `GET /describe` | récupère le WSDL et affiche la **signature de l'opération** (n'envoie rien) |
| `GET /send-digigo` | dépose la facture signée **DigiGO** (`…v3_DIGIGO_signed.xml`) |
| `GET /send-usb` | dépose la facture signée **clé USB** (`…v3_USB_signed.xml`) |
| `GET /send` | dépose le XML par défaut (`XML_PATH`, = DigiGO) ; protégé par `TRIGGER_TOKEN` si défini |
| `POST /send` | dépose le **XML signé fourni dans le body** (raw XML, ou JSON `{xml}` / `{xmlBase64}`) |
| `GET /consult` | `consultEfact` ; `?idSaveEfact=...` ou `?documentNumber=...` → réf TTN, acquittements, XML final |

Chaque appel `/send*` crée un **nouveau dépôt** (TTN attribue un nouvel `idSaveEfact` à chaque fois).

### Lecture du résultat
- **Succès** : `Facture enregistree avec ID: XXXXXXX … conforme a la version 1.8.8 du xsd`.
- **Échec** : bloc `ERREUR / SOAP FAULT` avec le code (ex. `SERV09 — Signataire non autorisé`, `CONTRL05`, `SERV01`…).
- `saveEfact` n'est qu'un accusé : la **réf TTN** (`generatedRef`) et les acquittements viennent ensuite via `GET /consult`.

## Déploiement via Dokploy

1. **Source** : *Application* Dokploy pointant sur ce dossier (dépôt Git `RK-WTG/ElFatoora-test`).
2. **Build** : type **Dockerfile** (à la racine). Port exposé : **3000**. Le push sur `main` redéploie automatiquement.
3. **Variables d'environnement** (onglet Environment) :
   | Variable | Valeur |
   |---|---|
   | `ELFATOORA_LOGIN` | login du compte de test (`WEBTGFE`) |
   | `ELFATOORA_PASSWORD` | mot de passe |
   | `ELFATOORA_MATRICULE` | `1557686RAM000` (= émetteur des XML) |
   | `ELFATOORA_WSDL` | `https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl` *(défaut)* |
   | `INSECURE_TLS` | `1` *(accepte le cert auto-signé du test)* |
   | `XML_PATH` | *(défaut)* `./TEIF_FAC_2024_003_1557686RAM000_v3_DIGIGO_signed.xml` |
   | `TRIGGER_TOKEN` | *(optionnel)* un secret pour protéger `GET /send` |
4. **Déployer**, puis ouvrir les URLs (cf. tableau des routes).

## Si `/describe` montre des paramètres ≠ `arg0..arg3`
Ajouter la variable d'env `ARG_NAMES`, ex. `ARG_NAMES=login,password,matricule,documentEfact`, puis redéployer.

## Variante CLI (si accès shell)
```bash
npm install
DESCRIBE_ONLY=1 node test-saveefact.js
ELFATOORA_LOGIN=... ELFATOORA_PASSWORD=... ELFATOORA_MATRICULE=1557686RAM000 \
  node test-saveefact.js ./TEIF_FAC_2024_003_1557686RAM000_v3_DIGIGO_signed.xml
```

## Exemples curl
```bash
BASE=https://elfatoora-back-cyketi-03c36c-37-27-65-254.traefik.me

curl -sS "$BASE/send-digigo"          # dépose la voie DigiGO
curl -sS "$BASE/send-usb"             # dépose la voie clé USB
curl -sS "$BASE/consult?idSaveEfact=2026232"   # statut / réf TTN d'un dépôt

# dépose un XML signé arbitraire depuis le poste :
curl -sS -X POST -H "Content-Type: application/xml" \
  --data-binary @TEIF_FAC_2024_003_1557686RAM000_v3_USB_signed.xml \
  "$BASE/send"
```
