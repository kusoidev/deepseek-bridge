const { generateKeyPairSync, createSign } = require('crypto');
const { writeFileSync } = require('fs');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Simple X.509 builder
function encodeLen(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let l = len;
  while (l > 0) { bytes.unshift(l & 0xff); l >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function encodeOID(oid) {
  const parts = oid.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 128) { out.push(v); continue; }
    const stack = [];
    stack.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return Buffer.from(out);
}
function TLV(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLen(v.length), v]);
}
function seq(items) {
  return TLV(0x30, Buffer.concat(items));
}
function bitString(bits) {
  return TLV(0x03, Buffer.concat([Buffer.from([0]), bits]));
}
function int(val) {
  if (typeof val === 'number') {
    const hex = val.toString(16);
    return TLV(0x02, Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex'));
  }
  return TLV(0x02, val);
}
function oid(str) { return TLV(0x06, encodeOID(str)); }
function nullVal() { return TLV(0x05, Buffer.alloc(0)); }
function printableString(str) { return TLV(0x13, Buffer.from(str, 'ascii')); }
function utcTime(d) {
  const s = d.toISOString().replace(/[-:]/g, '').slice(2, 14) + 'Z';
  return TLV(0x17, Buffer.from(s, 'ascii'));
}

// Parse SPKI to extract RSA modulus + exponent
const pubBuf = Buffer.from(publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, ''), 'base64');
function readTLV(buf, pos) {
  if (buf[pos] !== 0x30) throw new Error('expected SEQUENCE at ' + pos);
  pos++;
  let len = buf[pos];
  pos++;
  if (len & 0x80) {
    const numBytes = len & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) { len = (len << 8) | buf[pos + i]; }
    pos += numBytes;
  }
  return { pos, len, dataStart: pos, dataEnd: pos + len };
}

const outer = readTLV(pubBuf, 0);
let offset = outer.dataStart;
const algo = readTLV(pubBuf, offset);
offset = algo.dataEnd;

if (pubBuf[offset] !== 0x03) throw new Error('expected BIT STRING');
offset++;
let bsLen = pubBuf[offset];
offset++;
if (bsLen & 0x80) {
  const n = bsLen & 0x7f;
  bsLen = 0;
  for (let i = 0; i < n; i++) { bsLen = (bsLen << 8) | pubBuf[offset + i]; }
  offset += n;
}
offset++; // unused bits

const inner = readTLV(pubBuf, offset);
offset = inner.dataStart;
const modTLV = readTLV(pubBuf, offset);
const modulus = pubBuf.slice(modTLV.dataStart, modTLV.dataEnd);
offset = modTLV.dataEnd;
const expTLV = readTLV(pubBuf, offset);
const exponent = pubBuf.slice(expTLV.dataStart, expTLV.dataEnd);

// Build tbsCertificate
const version = TLV(0xa0, TLV(0x02, Buffer.from([2])));
const serial = int(Date.now());
const sigAlgo = seq([oid('1.2.840.113549.1.1.11'), nullVal()]);
const issuer = seq([seq([seq([oid('2.5.4.3'), printableString('DeepSeek Bridge')])])]);
const notBefore = utcTime(new Date());
const notAfter = utcTime(new Date(Date.now() + 10 * 365 * 86400 * 1000));
const subject = seq([seq([seq([oid('2.5.4.3'), printableString('localhost')])])]);
const pubKeyInfo = seq([
  seq([oid('1.2.840.113549.1.1.1'), nullVal()]),
  bitString(seq([int(modulus), int(exponent)])),
]);

const tbs = seq([
  version, serial, sigAlgo, issuer, seq([notBefore, notAfter]),
  subject, pubKeyInfo,
]);

const sign = createSign('sha256');
sign.update(tbs);
const signature = sign.sign({ key: privateKey, padding: require('crypto').constants.RSA_PKCS1_PADDING });

const certDER = seq([tbs, sigAlgo, bitString(signature)]);
const certPEM = '-----BEGIN CERTIFICATE-----\n' +
  certDER.toString('base64').match(/.{1,64}/g).join('\n') +
  '\n-----END CERTIFICATE-----\n';

writeFileSync('localhost.key', privateKey, 'utf8');
writeFileSync('localhost.crt', certPEM, 'utf8');
console.log('certs generated');