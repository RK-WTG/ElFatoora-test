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
const digigo = require('./digigo');

// TEIF non signe (unpretty) servi par le flux DigiGO ; on substitue un numero unique.
const TEIF_UNSIGNED = process.env.TEIF_UNSIGNED_PATH || './TEIF_FAC_2024_003_1557686RAM000_v3_unsigned_unpretty.xml';

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

  // ============ Voie DigiGO ============
  if (path === '/tuntrust/prepare' && req.method === 'POST') {
    try {
      let xml = fs.readFileSync(TEIF_UNSIGNED, 'utf8');
      const docId = 'FAC-DIGIGO-' + Date.now();
      xml = xml.replace(/<DocumentIdentifier>[^<]*<\/DocumentIdentifier>/, `<DocumentIdentifier>${docId}</DocumentIdentifier>`);
      const { authorizeUrl, precomputed } = await digigo.prepare(xml);
      return json(res, 200, { ok: true, docId, authorizeUrl, xml, precomputed });
    } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (path === '/tuntrust/digigo/callback') {
    let jwtToken = url.searchParams.get('code') || url.searchParams.get('token') || url.searchParams.get('access_token') || '';
    if (!jwtToken) { const m = req.url.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/); if (m) jwtToken = m[0]; }
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>TunTrust</title></head><body style="font-family:sans-serif">' +
      '<p>' + (jwtToken ? 'Authentification reussie, finalisation en cours...' : 'Erreur : JWT introuvable dans la reponse TunTrust.') + '</p>' +
      '<script>var jwt=' + JSON.stringify(jwtToken) + ';if(jwt&&window.opener){window.opener.postMessage({type:"tuntrust-jwt",jwt:jwt},"*");setTimeout(function(){window.close();},2000);}</script>' +
      '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (path === '/tuntrust/complete' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const signedXml = await digigo.complete(body.xml, body.jwt, body.precomputed);
      return json(res, 200, { ok: true, signedXml });
    } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (path === '/tuntrust/test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TEST_PAGE);
  }

  return text(res, 404, 'Not found. Routes: /describe, /send, /consult, /tuntrust/test');
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const TEST_PAGE = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Test signature DigiGO ElFatoora</title>
<style>body{font-family:Segoe UI,sans-serif;max-width:820px;margin:30px auto;padding:0 16px;color:#1a1a2e}
button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:16px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}#log{white-space:pre-wrap;background:#f1f5f9;border-radius:8px;padding:14px;margin-top:16px;font-family:Consolas,monospace;font-size:13px}
.ok{color:#16a34a}.ko{color:#dc2626}img{margin-top:12px;border:1px solid #e2e8f0}</style></head>
<body><h1>Signature DigiGO &rarr; ElFatoora</h1>
<p>Un clic : prepare &rarr; PIN+OTP (popup) &rarr; signHash &rarr; depot &rarr; QR.</p>
<button id="go" onclick="run()">Signer une facture via DigiGO</button>
<div id="log"></div><div id="qr"></div>
<script>
const L=document.getElementById('log');
function log(m,c){L.innerHTML+=(c?'<span class="'+c+'">'+m+'</span>':m)+"\\n";}
let state={};
async function run(){
  document.getElementById('go').disabled=true;L.innerHTML='';
  try{
    log('1) Preparation (recuperation cert + hash)...');
    let r=await fetch('/tuntrust/prepare',{method:'POST'});let p=await r.json();
    if(!p.ok)throw new Error(p.error);
    state={xml:p.xml,precomputed:p.precomputed,docId:p.docId};
    log('   docId='+p.docId+'  hash='+p.precomputed.signedInfoHash.slice(0,24)+'...','ok');
    log('2) Ouverture du popup TunTrust (faites PIN + OTP)...');
    const w=window.open(p.authorizeUrl,'digigo','width=520,height=720');
    const jwt=await waitJwt();
    log('   JWT recu','ok');
    log('3) signHash + assemblage du XML signe DigiGO...');
    r=await fetch('/tuntrust/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xml:state.xml,jwt:jwt,precomputed:state.precomputed})});
    let c=await r.json();if(!c.ok)throw new Error(c.error);
    log('   XML signe ('+c.signedXml.length+' o)','ok');
    log('4) Depot saveEfact...');
    r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/xml'},body:c.signedXml});
    let dep=await r.text();
    const idm=dep.match(/ID:\\s*(\\d+)/);log('   '+(idm?'ID '+idm[1]:'reponse: '+dep.slice(0,200)),idm?'ok':'ko');
    if(!idm)return;
    log('5) Consultation (ref TTN + QR)...');
    await new Promise(s=>setTimeout(s,9000));
    r=await fetch('/consult?idSaveEfact='+idm[1]);let con=await r.text();
    const ref=con.match(/generatedRef[^:]*:\\s*(\\S+)/)||con.match(/<generatedRef>([^<]+)/);
    log('   '+(ref?'ref TTN = '+ref[1]:'pas encore de ref (validation en cours)'),ref?'ok':'');
    log('TERMINE.','ok');
  }catch(e){log('ERREUR: '+(e.message||e),'ko');}
  document.getElementById('go').disabled=false;
}
function waitJwt(){return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout PIN/OTP (5 min)')),300000);
  window.addEventListener('message',function h(ev){if(ev.data&&ev.data.type==='tuntrust-jwt'){clearTimeout(t);window.removeEventListener('message',h);res(ev.data.jwt);}});});}
</script></body></html>`;

const HOST = process.env.HOSTNAME || '0.0.0.0';
server.listen(PORT, HOST, () => console.log('test-saveefact en écoute sur ' + HOST + ':' + PORT + ' (WSDL ' + WSDL + ')'));
