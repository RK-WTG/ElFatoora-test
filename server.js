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
const { runSaveEfact, runConsultEfact } = require('./lib');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WSDL = process.env.ELFATOORA_WSDL || 'https://test.elfatoora.tn/ElfatouraServices/EfactService?wsdl';
const XML_PATH = process.env.XML_PATH || './TEIF_FAC_2024_003_signe.xml';
const INSECURE = process.env.INSECURE_TLS !== '0';
const ARG_NAMES = (process.env.ARG_NAMES || 'arg0,arg1,arg2,arg3').split(',');
const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || '';

// XML embarqués dans l'image — un par voie de signature (cf. Dockerfile COPY)
const XML_DIGIGO = './TEIF_FAC_2024_003_1557686RAM000_v3_DIGIGO_signed.xml';
const XML_USB = './TEIF_FAC_2024_003_1557686RAM000_v3_USB_signed.xml';

async function depose(res, xmlPath) {
  let xml;
  try { xml = fs.readFileSync(xmlPath); }
  catch (e) { return text(res, 500, 'XML introuvable: ' + xmlPath + ' — ' + e.message); }
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

function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/' || path === '/health') {
    return text(res, 200,
      'Test saveEfact ElFatoora\n\n' +
      'GET /describe  → affiche la signature de l\'opération (sans envoi)\n' +
      'GET /send      → envoie ' + XML_PATH + ' à ' + WSDL +
      (TRIGGER_TOKEN ? '  (requiert ?token=...)' : '') + '\n' +
      'POST /send     → envoie le XML signé du body (raw XML, ou JSON {xml}/{xmlBase64})\n' +
      'GET /send-digigo → dépose la facture signée DigiGO (cert 7B410D39…)\n' +
      'GET /send-usb    → dépose la facture signée clé USB (cert 0BB3F842…)\n' +
      'GET /consult   → consultEfact ; ?idSaveEfact=... ou ?documentNumber=...\n');
  }

  if (path === '/send-digigo') return depose(res, XML_DIGIGO);
  if (path === '/send-usb') return depose(res, XML_USB);

  if (path === '/describe') {
    const { log } = await runSaveEfact({ wsdl: WSDL, insecure: INSECURE, describeOnly: true });
    return text(res, 200, log);
  }

  if (path === '/send') {
    if (TRIGGER_TOKEN && url.searchParams.get('token') !== TRIGGER_TOKEN) {
      return text(res, 403, 'Token invalide. Ajoutez ?token=... (voir TRIGGER_TOKEN).');
    }
    let xml;
    if (req.method === 'POST') {
      // XML signé fourni dans le body (raw XML, ou JSON {xml} / {xmlBase64})
      try {
        const raw = await readBody(req);
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          const j = JSON.parse(raw.toString('utf8'));
          xml = j.xmlBase64 ? Buffer.from(j.xmlBase64, 'base64') : Buffer.from(j.xml, 'utf8');
        } else {
          xml = raw; // raw XML bytes
        }
        if (!xml || !xml.length) return text(res, 400, 'Body vide : fournissez le XML signé.');
      } catch (e) { return text(res, 400, 'Body illisible : ' + e.message); }
    } else {
      try { xml = fs.readFileSync(XML_PATH); }
      catch (e) { return text(res, 500, 'XML introuvable: ' + XML_PATH + ' — ' + e.message); }
    }

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

  if (path === '/consult') {
    const idSaveEfact = url.searchParams.get('idSaveEfact');
    const documentNumber = url.searchParams.get('documentNumber');
    const criteria = {};
    if (idSaveEfact) criteria.idSaveEfact = parseInt(idSaveEfact, 10);
    if (documentNumber) criteria.documentNumber = documentNumber;
    if (!idSaveEfact && !documentNumber) {
      return text(res, 400, 'Précisez ?idSaveEfact=... ou ?documentNumber=...');
    }
    const { ok, log } = await runConsultEfact({
      wsdl: WSDL,
      login: process.env.ELFATOORA_LOGIN || '',
      password: process.env.ELFATOORA_PASSWORD || '',
      matricule: process.env.ELFATOORA_MATRICULE || '',
      criteria,
      insecure: INSECURE,
    });
    return text(res, ok ? 200 : 502, log);
  }

  return text(res, 404, 'Not found. Routes: /describe, /send, /consult');
});

const HOST = process.env.HOSTNAME || '0.0.0.0';
server.listen(PORT, HOST, () => console.log('test-saveefact en écoute sur ' + HOST + ':' + PORT + ' (WSDL ' + WSDL + ')'));
