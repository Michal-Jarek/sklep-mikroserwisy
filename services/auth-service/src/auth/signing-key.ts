import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { calculateJwkThumbprint, importPKCS8 } from 'jose';

export const SIGNING_ALGORITHM = 'RS256';

// Injection token: @Inject(SIGNING_KEY) key: SigningKey.
export const SIGNING_KEY = Symbol('SIGNING_KEY');

/** Public part of the signing key as published in JWKS (no private members). */
export interface PublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: typeof SIGNING_ALGORITHM;
  use: 'sig';
}

export interface SigningKey {
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  // RFC 7638 thumbprint of the public key; the "kid" header of every token.
  kid: string;
  publicJwk: PublicJwk;
}

/**
 * Reads the RS256 private key (PKCS#8 PEM) from JWT_PRIVATE_KEY_FILE. Called in main.ts before Nest
 * starts, so a missing or invalid file stops the service. The error names the file and has the reason
 * as its cause (the logger prints both); the key itself is never part of the error.
 */
export async function loadSigningKey(path: string): Promise<SigningKey> {
  if (!path) {
    throw new Error('JWT_PRIVATE_KEY_FILE is not set');
  }
  try {
    const pem = await readFile(path, 'utf8');
    const privateKey = await importPKCS8(pem, SIGNING_ALGORITHM);
    const { kty, n, e } = createPublicKey(pem).export({ format: 'jwk' });
    if (kty !== 'RSA' || !n || !e) {
      throw new Error('not an RSA key');
    }
    const kid = await calculateJwkThumbprint({ kty, n, e });
    return { privateKey, kid, publicJwk: { kty, n, e, kid, alg: SIGNING_ALGORITHM, use: 'sig' } };
  } catch (error) {
    throw new Error(`Cannot load the JWT private key from ${path}`, { cause: error });
  }
}
