'use strict';

/**
 * Logique partagée du test saveEfact (utilisée par le CLI et le serveur HTTP).
 * Retourne un journal texte + le résultat/fault, sans jamais throw.
 */

const soap = require('soap');

async function runSaveEfact(opts) {
  const {
    wsdl,
    login = '',
    password = '',
    matricule = '',
    xml = null, // Buffer
    insecure = true,
    argNames = ['arg0', 'arg1', 'arg2', 'arg3'],
    describeOnly = false,
  } = opts;

  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  const sep = (t) => log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));
  let ok = false;

  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  sep('1) ENVIRONNEMENT');
  log('Node        :', process.version);
  log('WSDL        :', wsdl);
  log('INSECURE_TLS:', insecure);
  log('login       :', login ? '(défini)' : '*** MANQUANT ***');
  log('password    :', password ? '(défini)' : '*** MANQUANT ***');
  log('matricule   :', matricule || '*** MANQUANT ***');

  if (!describeOnly && (!login || !password || !matricule || !xml)) {
    log('\nERREUR: login / password / matricule / xml requis.');
    return { ok, log: lines.join('\n') };
  }

  sep("2) WSDL + DESCRIPTION DE L'OPÉRATION");
  let client;
  try {
    client = await soap.createClientAsync(wsdl, { wsdl_options: { rejectUnauthorized: !insecure } });
  } catch (e) {
    log('ECHEC createClient (WSDL injoignable / TLS / IP non whitelistée) : ' + e.message);
    return { ok, log: lines.join('\n') };
  }
  try { log(JSON.stringify(client.describe(), null, 2)); } catch (e) { log('describe() impossible: ' + e.message); }

  if (describeOnly) { log('\nDESCRIBE_ONLY → arrêt avant envoi.'); return { ok: true, log: lines.join('\n') }; }

  sep('3) PRÉPARATION saveEfact');
  const xmlBase64 = xml.toString('base64');
  log('XML  :', xml.length + ' octets → base64 ' + xmlBase64.length + ' car.');
  log('Args :', argNames.join(', '), '(login, password, matricule, documentEfact[base64Binary])');

  const ARGS = {
    [argNames[0]]: login,
    [argNames[1]]: password,
    [argNames[2]]: matricule,
    [argNames[3]]: xmlBase64,
  };

  sep('4) ENVOI');
  try {
    const [result] = await client.saveEfactAsync(ARGS);
    log('--- REQUÊTE SOAP ---\n' + client.lastRequest);
    log('\n--- RÉPONSE (parsée) ---\n' + JSON.stringify(result, null, 2));
    log('\n--- RÉPONSE BRUTE ---\n' + client.lastResponse);
    ok = true;
  } catch (e) {
    log('--- REQUÊTE SOAP ---\n' + (client.lastRequest || '(non capturée)'));
    log('\n--- ERREUR / SOAP FAULT ---\n' + e.message);
    if (e.root) log(JSON.stringify(e.root, null, 2));
    if (client.lastResponse) log('\n--- RÉPONSE BRUTE ---\n' + client.lastResponse);
  }

  return { ok, log: lines.join('\n') };
}

module.exports = { runSaveEfact };
