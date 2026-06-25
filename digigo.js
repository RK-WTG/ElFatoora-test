'use strict';

/**
 * Signature DigiGO (certificat cloud TunTrust) au profil ElFatoora V3.0.
 *
 * Flux en 2 temps :
 *   prepare(xml)                 -> { authorizeUrl, precomputed }
 *     (l'utilisateur ouvre authorizeUrl, fait PIN+OTP, TunTrust redirige avec un JWT)
 *   complete(xml, jwt, precomp)  -> { signedXml }
 *
 * Le signeur XAdES est aligne BYTE-POUR-BYTE sur le golden V3.0 (verifie RSA contre
 * l'exemple officiel) : IDs fixes SigFrs/r-id-frs/xades-SigFrs, Reference Type="",
 * CertDigest SHA-1, politique urn:2.16.788.1.2.1.3 / OIDAsURN / ZKLu5..., ClaimedRole Fournisseur.
 * Les appels TunTrust (credentials/info, oauth2/token, signHash) et l'ASN.1 IssuerSerialV2
 * proviennent du POC valide. Doit tourner depuis l'IP whitelistee (Hetzner).
 */
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { DOMParser } = require('@xmldom/xmldom');
const { ExclusiveCanonicalization } = require('xml-crypto/lib/exclusive-canonicalization');

const TUNTRUST_BASE_URL = process.env.TUNTRUST_BASE_URL || 'https://193.95.63.230/tunsign-proxy-webapp';
const { TUNTRUST_CLIENT_ID, TUNTRUST_CLIENT_SECRET, TUNTRUST_CREDENTIAL_ID, TUNTRUST_REDIRECT_URI } = process.env;

// Politique de signature ElFatoora V3.0 (obligatoire prod 30/06/2026).
const POLICY = {
  identifier: 'urn:2.16.788.1.2.1.3',
  description: 'Politique de Signature Electronique de Tunisie TradeNet',
  digestValue: 'ZKLu5TojntPu+bUfZyjaEDvkYsAh7eyyV+Hf8nUSQEE=',
  spuri: 'https://www.tradenet.com.tn/Politique_Signature_Electronique_Tunisie_TradeNet.pdf',
};
// IDs fixes (une seule signature fournisseur) — conformes au golden / spec V3.0.
const ID = { signature: 'SigFrs', reference: 'r-id-frs', signedProps: 'xades-SigFrs', value: 'value-SigFrs' };
const CLAIMED_ROLE = 'Fournisseur';

const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_XADES = 'http://uri.etsi.org/01903/v1.3.2#';
const A = {
  c14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  xpath: 'http://www.w3.org/TR/1999/REC-xpath-19991116',
  signedProps: 'http://uri.etsi.org/01903#SignedProperties',
};

// ---------- canonicalisation / digests ----------
function c14n(xmlFragment) {
  const doc = new DOMParser().parseFromString(xmlFragment, 'text/xml');
  return new ExclusiveCanonicalization().process(doc.documentElement).toString();
}
const sha256b64 = (s) => crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).digest('base64');
const sha1b64 = (buf) => crypto.createHash('sha1').update(buf).digest('base64');

/** Digest document : retire ds:Signature + RefTtnVal puis exc-c14n (no-op a la prepare). */
function documentDigest(xml) {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.substring(1);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const sigs = Array.from(doc.getElementsByTagNameNS(NS_DS, 'Signature'));
  const refs = Array.from(doc.getElementsByTagName('RefTtnVal'));
  for (const n of [...sigs, ...refs]) if (n.parentNode) n.parentNode.removeChild(n);
  return sha256b64(new ExclusiveCanonicalization().process(doc.documentElement).toString());
}

// ---------- blocs XAdES (golden V3.0) ----------
function buildSignedProperties({ signingTime, certDigestSha1, issuerSerialV2 }, standalone) {
  const ns = standalone ? ` xmlns:xades="${NS_XADES}" xmlns:ds="${NS_DS}"` : '';
  return `<xades:SignedProperties${ns} Id="${ID.signedProps}">` +
    '<xades:SignedSignatureProperties>' +
      `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
      '<xades:SigningCertificateV2><xades:Cert><xades:CertDigest>' +
        `<ds:DigestMethod Algorithm="${A.sha1}"></ds:DigestMethod>` +
        `<ds:DigestValue>${certDigestSha1}</ds:DigestValue>` +
      '</xades:CertDigest>' +
      `<xades:IssuerSerialV2>${issuerSerialV2}</xades:IssuerSerialV2>` +
      '</xades:Cert></xades:SigningCertificateV2>' +
      '<xades:SignaturePolicyIdentifier><xades:SignaturePolicyId><xades:SigPolicyId>' +
        `<xades:Identifier Qualifier="OIDAsURN">${POLICY.identifier}</xades:Identifier>` +
        `<xades:Description>${POLICY.description}</xades:Description>` +
      '</xades:SigPolicyId>' +
      '<xades:SigPolicyHash>' +
        `<ds:DigestMethod Algorithm="${A.sha256}"></ds:DigestMethod>` +
        `<ds:DigestValue>${POLICY.digestValue}</ds:DigestValue>` +
      '</xades:SigPolicyHash>' +
      '<xades:SigPolicyQualifiers><xades:SigPolicyQualifier>' +
        `<xades:SPURI>${POLICY.spuri}</xades:SPURI>` +
      '</xades:SigPolicyQualifier></xades:SigPolicyQualifiers>' +
      '</xades:SignaturePolicyId></xades:SignaturePolicyIdentifier>' +
      `<xades:SignerRoleV2><xades:ClaimedRoles><xades:ClaimedRole>${CLAIMED_ROLE}</xades:ClaimedRole></xades:ClaimedRoles></xades:SignerRoleV2>` +
    '</xades:SignedSignatureProperties>' +
    '<xades:SignedDataObjectProperties>' +
      `<xades:DataObjectFormat ObjectReference="#${ID.reference}"><xades:MimeType>application/octet-stream</xades:MimeType></xades:DataObjectFormat>` +
    '</xades:SignedDataObjectProperties></xades:SignedProperties>';
}

function buildSignedInfo({ docDigest, signedPropsDigest }, standalone) {
  const ns = standalone ? ` xmlns:ds="${NS_DS}"` : '';
  return `<ds:SignedInfo${ns}>` +
    `<ds:CanonicalizationMethod Algorithm="${A.c14n}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${A.rsaSha256}"></ds:SignatureMethod>` +
    `<ds:Reference Id="${ID.reference}" Type="" URI=""><ds:Transforms>` +
      `<ds:Transform Algorithm="${A.xpath}"><ds:XPath>not(ancestor-or-self::ds:Signature)</ds:XPath></ds:Transform>` +
      `<ds:Transform Algorithm="${A.xpath}"><ds:XPath>not(ancestor-or-self::RefTtnVal)</ds:XPath></ds:Transform>` +
      `<ds:Transform Algorithm="${A.c14n}"></ds:Transform></ds:Transforms>` +
      `<ds:DigestMethod Algorithm="${A.sha256}"></ds:DigestMethod>` +
      `<ds:DigestValue>${docDigest}</ds:DigestValue></ds:Reference>` +
    `<ds:Reference Type="${A.signedProps}" URI="#${ID.signedProps}"><ds:Transforms>` +
      `<ds:Transform Algorithm="${A.c14n}"></ds:Transform></ds:Transforms>` +
      `<ds:DigestMethod Algorithm="${A.sha256}"></ds:DigestMethod>` +
      `<ds:DigestValue>${signedPropsDigest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
}

function buildSignatureBlock({ signedInfo, signedProperties, signatureValue, certificates }) {
  const certsXml = certificates.map((c) => `<ds:X509Certificate>${c}</ds:X509Certificate>`).join('');
  return `<ds:Signature xmlns:ds="${NS_DS}" Id="${ID.signature}">` +
    signedInfo +
    `<ds:SignatureValue Id="${ID.value}">${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data>${certsXml}</ds:X509Data></ds:KeyInfo>` +
    `<ds:Object><xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="#${ID.signature}">` +
      signedProperties +
    '</xades:QualifyingProperties></ds:Object></ds:Signature>';
}

function insertBeforeRootClose(xml, signature) {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.substring(1);
  const m = xml.match(/<\/([A-Za-z0-9_:-]+)\s*>\s*$/);
  if (!m) throw new Error('Balise racine fermante introuvable');
  const pos = xml.lastIndexOf(m[0]);
  return xml.substring(0, pos) + signature + m[0];
}

// ---------- ASN.1 IssuerSerialV2 (repris du POC) ----------
function parseDERTLV(buf, offset) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let hdrLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 2 + i];
    hdrLen = 2 + n;
  }
  return { tag, headerLength: hdrLen, totalLength: hdrLen + len, bytes: buf.slice(offset, offset + hdrLen + len) };
}
function extractIssuerAndSerial(certDER) {
  const certSeq = parseDERTLV(certDER, 0);
  const tbsSeq = parseDERTLV(certDER, certSeq.headerLength);
  let off = certSeq.headerLength + tbsSeq.headerLength;
  let item = parseDERTLV(certDER, off);
  if (item.tag === 0xa0) { off += item.totalLength; item = parseDERTLV(certDER, off); }
  const serialNumber = Buffer.from(item.bytes); off += item.totalLength;
  item = parseDERTLV(certDER, off); off += item.totalLength;       // signatureAlgorithm
  item = parseDERTLV(certDER, off);                                 // issuer
  return { issuer: Buffer.from(item.bytes), serialNumber };
}
function wrapASN1(tag, content) {
  const len = content.length;
  const hdr = len < 128 ? Buffer.from([tag, len])
    : len < 256 ? Buffer.from([tag, 0x81, len])
    : Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([hdr, content]);
}
function buildIssuerSerialV2(issuerDER, serialDER) {
  const directoryName = wrapASN1(0xa4, issuerDER);
  const generalNames = wrapASN1(0x30, directoryName);
  return wrapASN1(0x30, Buffer.concat([generalNames, serialDER])).toString('base64');
}

// ---------- appels TunTrust ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', rejectUnauthorized: false },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }).on('error', reject).end();
  });
}
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, rejectUnauthorized: false },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function getCertificates() {
  const url = `${TUNTRUST_BASE_URL}/services/v1/credentials/info/${TUNTRUST_CLIENT_ID}/${encodeURIComponent(TUNTRUST_CREDENTIAL_ID)}/chain`;
  const res = await httpsGet(url);
  const certs = (JSON.parse(res).certificates || []).map((c) => c.encodedCertificate);
  if (!certs.length) throw new Error('DigiGO: chaine de certificats vide');
  return certs;
}

// ---------- API publique ----------
function isoUtcNoMillis() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/** Calcule tous les digests + le hash a faire signer, a partir du TEIF + de la chaine cert. */
function buildPrecomputed(xml, certificates, signingTime) {
  const certDER = Buffer.from(certificates[0], 'base64');
  const certDigestSha1 = sha1b64(certDER);
  const { issuer, serialNumber } = extractIssuerAndSerial(certDER);
  const issuerSerialV2 = buildIssuerSerialV2(issuer, serialNumber);
  const docDigest = documentDigest(xml);
  const sp = { signingTime, certDigestSha1, issuerSerialV2 };
  const signedPropsDigest = sha256b64(c14n(buildSignedProperties(sp, true)));
  const signedInfoHash = sha256b64(c14n(buildSignedInfo({ docDigest, signedPropsDigest }, true)));
  return { signingTime, certificates, certDigestSha1, issuerSerialV2, docDigest, signedPropsDigest, signedInfoHash };
}

async function prepare(xml) {
  const certificates = await getCertificates();
  const precomputed = buildPrecomputed(xml, certificates, isoUtcNoMillis());
  const authorizeUrl = `${TUNTRUST_BASE_URL}/oauth2/authorize?` +
    `redirectUri=${encodeURIComponent(TUNTRUST_REDIRECT_URI)}` +
    `&responseType=code&scope=credential` +
    `&credentialId=${encodeURIComponent(TUNTRUST_CREDENTIAL_ID)}` +
    `&clientId=${TUNTRUST_CLIENT_ID}&numSignatures=1` +
    `&hash=${encodeURIComponent(precomputed.signedInfoHash)}`;
  return { authorizeUrl, precomputed };
}

async function signHashViaDigigo(jwtToken, signedInfoHash) {
  const decoded = jwt.decode(jwtToken);
  if (!decoded || !decoded.jti) throw new Error('DigiGO: JTI introuvable dans le JWT');
  const tokenUrl = `${TUNTRUST_BASE_URL}/services/v1/oauth2/token/${TUNTRUST_CLIENT_ID}/authorization_code/${TUNTRUST_CLIENT_SECRET}/${decoded.jti}`;
  const tokenResp = await httpsPost(tokenUrl, TUNTRUST_REDIRECT_URI, { 'Content-Type': 'application/json' });
  let sad;
  try { sad = JSON.parse(tokenResp).sad; } catch (e) { throw new Error('oauth2/token: ' + tokenResp); }
  if (!sad) throw new Error('oauth2/token: SAD absent — ' + tokenResp);
  const signUrl = `${TUNTRUST_BASE_URL}/services/v1/signatures/signHash/${TUNTRUST_CLIENT_ID}/${encodeURIComponent(TUNTRUST_CREDENTIAL_ID)}/${sad}/SHA256/RSA`;
  const signResp = await httpsPost(signUrl, JSON.stringify([signedInfoHash]), { 'Content-Type': 'application/json' });
  let value;
  try { const p = JSON.parse(signResp); value = Array.isArray(p) ? p[0].value : p.value; } catch (e) { throw new Error('signHash: ' + signResp); }
  if (!value) throw new Error('signHash: signatureValue absente — ' + signResp);
  return value;
}

function assemble(xml, precomputed, signatureValue) {
  const sp = { signingTime: precomputed.signingTime, certDigestSha1: precomputed.certDigestSha1, issuerSerialV2: precomputed.issuerSerialV2 };
  const signedProperties = buildSignedProperties(sp, false);
  const signedInfo = buildSignedInfo({ docDigest: precomputed.docDigest, signedPropsDigest: precomputed.signedPropsDigest }, false);
  const signature = buildSignatureBlock({ signedInfo, signedProperties, signatureValue, certificates: precomputed.certificates });
  return insertBeforeRootClose(xml, signature);
}

async function complete(xml, jwtToken, precomputed) {
  const signatureValue = await signHashViaDigigo(jwtToken, precomputed.signedInfoHash);
  return assemble(xml, precomputed, signatureValue);
}

module.exports = {
  prepare, complete, assemble, buildPrecomputed, getCertificates,
  buildSignedProperties, buildSignedInfo, buildIssuerSerialV2, extractIssuerAndSerial, sha1b64, c14n, sha256b64,
};
