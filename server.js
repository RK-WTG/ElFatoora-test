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
// Artefacts du DERNIER parcours DigiGO (memoire), pour fournir le jeu de fichiers a TunTrust.
let lastUnsignedXml = ''; // TEIF non signe envoye (avec docId unique substitue)
let lastSignedXml = '';   // XML signe DigiGO/TunTrust (avant depot)
let lastFinalXml = '';    // XML final signe TTN (+ RefTtnVal/QR), recupere via consultEfact
let lastDocId = '';       // docId de ce parcours (nom des fichiers)

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

  if (path === '/send' || path === '/tuntrust/send') {
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

  if (path === '/consult' || path === '/tuntrust/consult') {
    const idSaveEfact = url.searchParams.get('idSaveEfact');
    const documentNumber = url.searchParams.get('documentNumber');
    const criteria = {};
    if (idSaveEfact) criteria.idSaveEfact = parseInt(idSaveEfact, 10);
    if (documentNumber) criteria.documentNumber = documentNumber;
    if (!idSaveEfact && !documentNumber) {
      return text(res, 400, 'Précisez ?idSaveEfact=... ou ?documentNumber=...');
    }
    const { ok, log, finalXmlB64 } = await runConsultEfact({
      wsdl: WSDL,
      login: process.env.ELFATOORA_LOGIN || '',
      password: process.env.ELFATOORA_PASSWORD || '',
      matricule: process.env.ELFATOORA_MATRICULE || '',
      criteria,
      insecure: INSECURE,
    });
    if (finalXmlB64) { try { lastFinalXml = Buffer.from(finalXmlB64, 'base64').toString('utf8'); } catch (_) {} }
    return text(res, ok ? 200 : 502, log);
  }

  // ===== Telechargement des 3 fichiers du parcours de signature (pour TunTrust) =====
  if (path === '/tuntrust/files/unsigned') return download(res, (lastDocId || 'facture') + '_1_non-signe.xml', lastUnsignedXml, 'application/xml');
  if (path === '/tuntrust/files/signed')   return download(res, (lastDocId || 'facture') + '_2_signe-tuntrust.xml', lastSignedXml, 'application/xml');
  if (path === '/tuntrust/files/final')     return download(res, (lastDocId || 'facture') + '_3_final-ttn-qr.xml', lastFinalXml, 'application/xml');
  if (path === '/tuntrust/files/qr') {
    const m = lastFinalXml.match(/<ReferenceCEV>([A-Za-z0-9+/=]+)<\/ReferenceCEV>/);
    if (!m) return text(res, 404, 'QR indisponible : lancez un parcours /tuntrust/test validé d\'abord.');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="' + (lastDocId || 'facture') + '_qr.png"' });
    return res.end(Buffer.from(m[1], 'base64'));
  }

  // ============ Voie DigiGO ============
  if (path === '/tuntrust/prepare' && req.method === 'POST') {
    try {
      let xml = fs.readFileSync(TEIF_UNSIGNED, 'utf8');
      const docId = 'FAC-DIGIGO-' + Date.now();
      xml = xml.replace(/<DocumentIdentifier>[^<]*<\/DocumentIdentifier>/, `<DocumentIdentifier>${docId}</DocumentIdentifier>`);
      const { authorizeUrl, precomputed } = await digigo.prepare(xml);
      lastUnsignedXml = xml; lastDocId = docId; lastFinalXml = ''; // nouveau parcours
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
      lastSignedXml = signedXml; // conserve pour diagnostic via /tuntrust/lastsigned
      return json(res, 200, { ok: true, signedXml });
    } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (path === '/tuntrust/lastsigned') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(lastSignedXml);
  }

  if (path === '/tuntrust/test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TEST_PAGE);
  }

  return text(res, 404, 'Not found. Routes: /describe, /send, /consult, /tuntrust/test, /tuntrust/files/{unsigned,signed,final,qr}');
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function download(res, filename, body, type) {
  if (!body) return text(res, 404, 'Aucun contenu : lancez d\'abord un parcours /tuntrust/test (et attendez la validation pour le fichier final).');
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + filename + '"' });
  res.end(body);
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
  document.getElementById('go').disabled=true;L.innerHTML='';document.getElementById('qr').innerHTML='';
  const PW=720,PH=860; // taille popup TunTrust (la page DigiGO debordait en 520x760)
  const w=window.open('about:blank','digigo','width='+PW+',height='+PH+',scrollbars=yes,resizable=yes,left='+Math.max(0,((screen.width-PW)/2|0))+',top='+Math.max(0,((screen.height-PH)/2|0))); // ouvert DANS le geste (anti-bloqueur), centre
  try{
    log('1) Preparation (recuperation cert + hash)...');
    let r=await fetch('/tuntrust/prepare',{method:'POST'});let p=await r.json();
    if(!p.ok)throw new Error(p.error);
    state={xml:p.xml,precomputed:p.precomputed,docId:p.docId};
    log('   docId='+p.docId+'  hash='+p.precomputed.signedInfoHash.slice(0,24)+'...','ok');
    log('2) PIN + OTP dans le popup TunTrust (OTP par email)...');
    if(w&&!w.closed){w.location.href=p.authorizeUrl;}
    else{document.getElementById('qr').innerHTML='<p><a href="'+p.authorizeUrl+'" target="digigo" style="font-size:16px">Popup bloque : cliquez ICI pour ouvrir TunTrust</a></p>';log('   popup bloque -> lien manuel affiche ci-dessous','ko');}
    const jwt=await waitJwt();
    log('   JWT recu','ok');
    log('3) signHash + assemblage du XML signe DigiGO...');
    r=await fetch('/tuntrust/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xml:state.xml,jwt:jwt,precomputed:state.precomputed})});
    let c=await r.json();if(!c.ok)throw new Error(c.error);
    log('   XML signe ('+c.signedXml.length+' o)','ok');
    log('4) Depot saveEfact...');
    r=await fetch('/tuntrust/send',{method:'POST',headers:{'Content-Type':'application/xml'},body:c.signedXml});
    let dep=await r.text();
    const idm=dep.match(/enregistree avec ID:\\s*(\\d+)/);
    if(!idm){var fm=dep.match(/SERV\\d+[^"<\\n]*|CONTRL\\d+[^"<\\n]*|faultMessage[^,}<]*|L'objet OID[^"<\\n]*/i);log('   ECHEC depot: '+(fm?fm[0]:dep.slice(-350)),'ko');return;}
    log('   ID '+idm[1],'ok');
    log('5) Consultation (ref TTN + QR)...');
    await new Promise(s=>setTimeout(s,9000));
    r=await fetch('/tuntrust/consult?idSaveEfact='+idm[1]);let con=await r.text();
    const ref=con.match(/<generatedRef>([^<]+)/);
    if(ref&&ref[1]){log('   ref TTN = '+ref[1],'ok');var cev=con.match(/<ReferenceCEV>([A-Za-z0-9+\\/=]+)/);if(cev)document.getElementById('qr').innerHTML='<h3>QR ElFatoora</h3><img src="data:image/png;base64,'+cev[1]+'">';log('FACTURE DIGIGO VALIDEE.','ok');
      document.getElementById('qr').innerHTML+='<h3>Fichiers du parcours de signature</h3><ul>'+
        '<li><a href="/tuntrust/files/unsigned" download>1 - TEIF non signe</a></li>'+
        '<li><a href="/tuntrust/files/signed" download>2 - XML signe TunTrust (DigiGO)</a></li>'+
        '<li><a href="/tuntrust/files/final" download>3 - XML final TTN + QR</a></li>'+
        '<li><a href="/tuntrust/files/qr" download>QR (PNG)</a></li></ul>';}
    else log('   pas encore de ref (validation en cours, reconsulter)','');
  }catch(e){log('ERREUR: '+(e.message||e),'ko');}
  document.getElementById('go').disabled=false;
}
function waitJwt(){return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout PIN/OTP (5 min)')),300000);
  window.addEventListener('message',function h(ev){if(ev.data&&ev.data.type==='tuntrust-jwt'){clearTimeout(t);window.removeEventListener('message',h);res(ev.data.jwt);}});});}
</script></body></html>`;

const HOST = process.env.HOSTNAME || '0.0.0.0';
server.listen(PORT, HOST, () => console.log('test-saveefact en écoute sur ' + HOST + ':' + PORT + ' (WSDL ' + WSDL + ')'));
