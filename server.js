'use strict';

/**
 * Service HTTP de test saveEfact — à déployer sur DOKPLOY (serveur Hetzner, IP whitelistée).
 * Déclenche le dépôt d'une facture signée et renvoie le journal complet.
 *
 * Variables d'environnement (à définir dans Dokploy) :
 *   ELFATOORA_LOGIN, ELFATOORA_PASSWORD, ELFATOORA_MATRICULE   (identifiants — secrets Dokploy)
 *   ELFATOORA_WSDL   défaut: https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl
 *   XML_PATH         défaut: ./TEIF_FAC_2024_003_signe.xml (embarqué dans l'image)
 *   INSECURE_TLS     défaut: 1
 *   ARG_NAMES        défaut: arg0,arg1,arg2,arg3
 *   PORT             défaut: 3000
 *   TRIGGER_TOKEN    optionnel : si défini, exige ?token=... pour déclencher l'envoi
 *
 * Routes :
 *   GET /            page d'aide + liens
 *   GET /describe    récupère le WSDL et affiche la signature de l'opération (n'envoie rien)
 *   GET /send        envoie la facture signée (protégé par TRIGGER_TOKEN si défini)
 */

const http = require('http');
const fs = require('fs');
const { runSaveEfact } = require('./lib');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WSDL = process.env.ELFATOORA_WSDL || 'https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl';
const XML_PATH = process.env.XML_PATH || './TEIF_FAC_2024_003_signe.xml';
const INSECURE = process.env.INSECURE_TLS !== '0';
const ARG_NAMES = (process.env.ARG_NAMES || 'arg0,arg1,arg2,arg3').split(',');
const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || '';

function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/' || path === '/health') {
    return text(res, 200,
      'Test saveEfact ElFatoora\n\n' +
      'GET /describe  → affiche la signature de l\'opération (sans envoi)\n' +
      'GET /send      → envoie ' + XML_PATH + ' à ' + WSDL +
      (TRIGGER_TOKEN ? '  (requiert ?token=...)' : '') + '\n');
  }

  if (path === '/describe') {
    const { log } = await runSaveEfact({ wsdl: WSDL, insecure: INSECURE, describeOnly: true });
    return text(res, 200, log);
  }

  if (path === '/send') {
    if (TRIGGER_TOKEN && url.searchParams.get('token') !== TRIGGER_TOKEN) {
      return text(res, 403, 'Token invalide. Ajoutez ?token=... (voir TRIGGER_TOKEN).');
    }
    let xml;
    try { xml = fs.readFileSync(XML_PATH); }
    catch (e) { return text(res, 500, 'XML introuvable: ' + XML_PATH + ' — ' + e.message); }

    const { ok, log } = await runSaveEfact({
      wsdl: WSDL,
      login: process.env.ELFATOORA_LOGIN || '',
      password: process.env.ELFATOORA_PASSWORD || '',
      matricule: process.env.ELFATOORA_MATRICULE || '',
      xml,
      insecure: INSECURE,
      argNames: ARG_NAMES,
    });
    return text(res, ok ? 200 : 502, log);
  }

  return text(res, 404, 'Not found. Routes: /describe, /send');
});

const HOST = process.env.HOSTNAME || '0.0.0.0';
server.listen(PORT, HOST, () => console.log('test-saveefact en écoute sur ' + HOST + ':' + PORT + ' (WSDL ' + WSDL + ')'));
