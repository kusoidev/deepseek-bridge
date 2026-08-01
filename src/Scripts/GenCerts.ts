import { generateKeyPairSync, createSign, constants } from 'crypto';
import { writeFileSync } from 'fs';

/**
 * Encode a length value in DER format.
 *
 * Short form (< 128): single byte with the length.
 * Long form (>= 128): first byte is 0x80 | number_of_length_bytes,
 * followed by the length in big-endian.
 *
 * @param len - The length to encode.
 * @returns DER-encoded length bytes.
 */
function EncodeLen(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let l = len;
  while (l > 0) { bytes.unshift(l & 0xff); l >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Encode an OID dotted string (e.g., '1.2.840.113549.1.1.11') into DER bytes.
 *
 * The first two components are encoded as 40*first + second.
 * Subsequent components use variable-length encoding with the high bit
 * as a continuation marker.
 *
 * @param oid - Dotted OID string.
 * @returns DER-encoded OID bytes.
 *
 * @example
 * EncodeOid('1.2.840.113549.1.1.11')
 * // => Buffer containing the DER OID for sha256WithRSAEncryption
 */
function EncodeOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const out: number[] = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 128) { out.push(v); continue; }
    const stack: number[] = [];
    stack.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return Buffer.from(out);
}

/**
 * Build a DER TLV (Tag-Length-Value) structure.
 *
 * @param tag - The ASN.1 tag byte.
 * @param value - The value content (Buffer or byte array).
 * @returns Complete DER TLV as a Buffer.
 *
 * @example
 * Tlv(0x02, Buffer.from([0x01, 0x00, 0x01]))
 * // => DER INTEGER with value 65537
 */
function Tlv(tag: number, value: Buffer | number[]): Buffer {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), EncodeLen(v.length), v]);
}

/**
 * Build a DER SEQUENCE from child elements.
 *
 * @param items - Array of DER-encoded child elements.
 * @returns DER SEQUENCE containing all children.
 */
function Seq(items: Buffer[]): Buffer {
  return Tlv(0x30, Buffer.concat(items));
}

/**
 * Build a DER BIT STRING with zero unused bits.
 *
 * @param bits - The raw bit data.
 * @returns DER BIT STRING.
 */
function BitString(bits: Buffer): Buffer {
  return Tlv(0x03, Buffer.concat([Buffer.from([0]), bits]));
}

/**
 * Build a DER INTEGER.
 *
 * @param val - A number (will be hex-encoded) or a raw Buffer.
 * @returns DER INTEGER.
 *
 * @example
 * Int(65537)
 * // => DER encoding of the integer 65537
 */
function Int(val: number | Buffer): Buffer {
  if (typeof val === 'number') {
    const hex = val.toString(16);
    return Tlv(0x02, Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex'));
  }
  return Tlv(0x02, val);
}

/**
 * Build a DER OBJECT IDENTIFIER.
 *
 * @param str - Dotted OID string.
 * @returns DER OID.
 */
function Oid(str: string): Buffer {
  return Tlv(0x06, EncodeOid(str));
}

/**
 * Build a DER NULL value.
 *
 * @returns DER NULL (two bytes: 0x05 0x00).
 */
function NullVal(): Buffer {
  return Tlv(0x05, Buffer.alloc(0));
}

/**
 * Build a DER PrintableString.
 *
 * @param str - ASCII string content.
 * @returns DER PrintableString.
 */
function PrintableString(str: string): Buffer {
  return Tlv(0x13, Buffer.from(str, 'ascii'));
}

/**
 * Build a DER UTCTime from a Date object.
 *
 * Format: YYMMDDHHMMSSZ
 *
 * @param d - The date to encode.
 * @returns DER UTCTime.
 */
function UtcTime(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:]/g, '').slice(2, 14) + 'Z';
  return Tlv(0x17, Buffer.from(s, 'ascii'));
}

/**
 * Bounds of a parsed TLV structure within a buffer.
 */
interface TlvRegion {
  /** Start position of the tag byte. */
  pos: number;
  /** Length of the value portion. */
  len: number;
  /** Position where the value data starts. */
  dataStart: number;
  /** Position where the value data ends (exclusive). */
  dataEnd: number;
}

/**
 * Read and validate a DER SEQUENCE TLV header from a buffer.
 *
 * Expects a SEQUENCE tag (0x30) at the given position. Parses the length
 * (supporting both short and long form) and returns the region boundaries.
 *
 * @param buf - The buffer to read from.
 * @param pos - Position to start reading.
 * @returns The TLV region boundaries.
 * @throws Error if the tag byte at pos is not 0x30 (SEQUENCE).
 */
function ReadTlv(buf: Buffer, pos: number): TlvRegion {
  if (buf[pos] !== 0x30) throw new Error(`expected SEQUENCE at ${pos}`);
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

/**
 * Generate a self-signed RSA certificate for localhost and write it to disk.
 *
 * Creates a 2048-bit RSA key pair, builds an X.509 certificate from scratch
 * using raw DER encoding (no OpenSSL dependency), signs it with SHA-256, and
 * writes localhost.key and localhost.crt to the current working directory.
 *
 * This is a standalone script: run with `node dist/Scripts/GenCerts.js`.
 * The generated certificates are not used by the bridge itself (which drives
 * the DOM, not MITM), but they are available if needed for local HTTPS.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const pubBuf = Buffer.from(
  publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, ''),
  'base64',
);

const outer = ReadTlv(pubBuf, 0);
let offset = outer.dataStart;
const algo = ReadTlv(pubBuf, offset);
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
offset++;

const inner = ReadTlv(pubBuf, offset);
offset = inner.dataStart;
const modTlv = ReadTlv(pubBuf, offset);
const modulus = pubBuf.slice(modTlv.dataStart, modTlv.dataEnd);
offset = modTlv.dataEnd;
const expTlv = ReadTlv(pubBuf, offset);
const exponent = pubBuf.slice(expTlv.dataStart, expTlv.dataEnd);

const version = Tlv(0xa0, Tlv(0x02, Buffer.from([2])));
const serial = Int(Date.now());
const sigAlgo = Seq([Oid('1.2.840.113549.1.1.11'), NullVal()]);
const issuer = Seq([Seq([Seq([Oid('2.5.4.3'), PrintableString('DeepSeek Bridge')])])]);
const notBefore = UtcTime(new Date());
const notAfter = UtcTime(new Date(Date.now() + 10 * 365 * 86400 * 1000));
const subject = Seq([Seq([Seq([Oid('2.5.4.3'), PrintableString('localhost')])])]);
const pubKeyInfo = Seq([
  Seq([Oid('1.2.840.113549.1.1.1'), NullVal()]),
  BitString(Seq([Int(modulus), Int(exponent)])),
]);

const tbs = Seq([
  version, serial, sigAlgo, issuer, Seq([notBefore, notAfter]),
  subject, pubKeyInfo,
]);

const sign = createSign('sha256');
sign.update(tbs);
const signature = sign.sign({ key: privateKey, padding: constants.RSA_PKCS1_PADDING });

const certDer = Seq([tbs, sigAlgo, BitString(signature)]);
const certPem =
  '-----BEGIN CERTIFICATE-----\n' +
  certDer.toString('base64').match(/.{1,64}/g)!.join('\n') +
  '\n-----END CERTIFICATE-----\n';

writeFileSync('localhost.key', privateKey, 'utf8');
writeFileSync('localhost.crt', certPem, 'utf8');
console.log('certs generated');