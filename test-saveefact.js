'use strict';

/**
 * Test CLI de dépôt d'une facture signée sur ElFatoora (TTN) — opération SOAP saveEfact.
 * Variante ligne de commande (le serveur HTTP pour Dokploy est dans server.js).
 *
 * Usage :
 *   ELFATOORA_LOGIN=... ELFATOORA_PASSWORD=... ELFATOORA_MATRICULE=1234567ABC \
 *     node test-saveefact.js ./TEIF_FAC_2024_003_signe.xml
 *   DESCRIBE_ONLY=1 node test-saveefact.js     # affiche la signature de l'opération, sans envoi
 */

const fs = require('fs');
const { runSaveEfact } = require('./lib');

const WSDL = process.env.ELFATOORA_WSDL || 'https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl';
const INSECURE = process.env.INSECURE_TLS !== '0';
const DESCRIBE_ONLY = process.env.DESCRIBE_ONLY === '1';
const ARG_NAMES = (process.env.ARG_NAMES || 'arg0,arg1,arg2,arg3').split(',');
const xmlPath = process.argv[2];

(async () => {
  let xml = null;
  if (!DESCRIBE_ONLY) {
    if (!xmlPath) { console.log('ERREUR: chemin du XML signé manquant.'); process.exit(1); }
    if (!fs.existsSync(xmlPath)) { console.log('ERREUR: fichier introuvable: ' + xmlPath); process.exit(1); }
    xml = fs.readFileSync(xmlPath);
  }
  const { ok, log } = await runSaveEfact({
    wsdl: WSDL,
    login: process.env.ELFATOORA_LOGIN || '',
    password: process.env.ELFATOORA_PASSWORD || '',
    matricule: process.env.ELFATOORA_MATRICULE || '',
    xml,
    insecure: INSECURE,
    argNames: ARG_NAMES,
    describeOnly: DESCRIBE_ONLY,
  });
  console.log(log);
  process.exit(ok ? 0 : 3);
})();
