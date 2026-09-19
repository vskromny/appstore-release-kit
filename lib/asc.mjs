// The one App Store Connect client every command in this kit shares.
//
// Auth is an ES256 JWT signed with an API key — never Xcode's account, so it
// works on a Mac mini nobody is logged into. The key is read lazily: a command
// printing its usage must not fail on a missing .p8.
//
// Configure with environment variables:
//   ASC_KEY_ID     — the key's ID, shown in Users and Access → Integrations
//   ASC_ISSUER_ID  — the issuer ID from the same page
//   ASC_P8_PATH    — where the .p8 is; defaults to where Apple's own tools look:
//                    ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8

import { createHash, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = 'https://api.appstoreconnect.apple.com';

// Apple rejects tokens that live longer than 20 minutes; 15 leaves clock skew room.
const TOKEN_TTL_SECONDS = 15 * 60;

let cached = null;

async function signToken() {
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER_ID;
  if (!keyId || !issuer) {
    throw new Error('ASC_KEY_ID and ASC_ISSUER_ID must be set (Users and Access → Integrations → App Store Connect API).');
  }
  const path = process.env.ASC_P8_PATH
    ?? join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
  const pem = await readFile(path, 'utf8').catch((err) => {
    throw new Error(`Cannot read the API key at ${path}: ${err.message}`);
  });

  const b64url = (input) => Buffer.from(input).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuer, iat: now, exp: now + TOKEN_TTL_SECONDS, aud: 'appstoreconnect-v1' };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // ieee-p1363: Apple wants the raw r||s signature, not the DER that Node emits by default.
  const sig = createSign('SHA256').update(body).end().sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  return { jwt: `${body}.${sig.toString('base64url')}`, expiresAt: (now + TOKEN_TTL_SECONDS) * 1000 };
}

async function token() {
  // wait-for-build can outlive a single token; re-sign a minute before expiry.
  if (!cached || cached.expiresAt - Date.now() < 60_000) cached = await signToken();
  return cached.jwt;
}

export async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Every ASC asset (screenshots, review attachments, previews) is uploaded the
// same way: reserve a record, PUT the bytes where the record says, then PATCH
// it as uploaded with a checksum. The reservation differs per asset type; the
// rest does not, so it lives here.
export async function putChunks(uploadOperations, bytes) {
  for (const op of uploadOperations) {
    const headers = Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value]));
    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: bytes.subarray(op.offset, op.offset + op.length),
    });
    if (!res.ok) throw new Error(`upload chunk: ${res.status} ${await res.text()}`);
  }
}

export async function commitUpload(type, id, bytes) {
  return api('PATCH', `/v1/${type}/${id}`, {
    data: {
      type,
      id,
      attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
    },
  });
}

export function usage(lines, code = 1) {
  console.error(lines.join('\n'));
  process.exit(code);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A failed ASC call is a fact about the account, not a bug in the caller;
// a stack trace only hides the status line Apple sent.
const die = (err) => {
  console.error(`❌ ${err?.message ?? err}`);
  process.exit(1);
};
// A rejected top-level await surfaces as an uncaught exception, not a rejection.
process.on('uncaughtException', die);
process.on('unhandledRejection', die);
