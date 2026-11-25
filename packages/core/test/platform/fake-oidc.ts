import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { OidcHttpClient } from '../../src/platform/index.ts';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'synthetic-rsa-key';
const keySet = {
  keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
};

export function fakeOidc(now: () => number) {
  const issuer = 'https://dex.example/oidc';
  const clientId = 'rivetquay-fixture';
  const redirectUri = 'https://platform.example/platform/v1/auth/callback';
  const calls: string[] = [];
  const codes = new Map<string, { jwt: string; challenge: string | null }>();

  const http: OidcHttpClient = async ({ method, url, body }) => {
    calls.push(url);
    if (method === 'GET' && url === issuer + '/.well-known/openid-configuration')
      return {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/keys',
        end_session_endpoint: issuer + '/logout',
      };
    if (method === 'GET' && url === issuer + '/keys') return keySet;
    if (method === 'POST' && url === issuer + '/token') {
      const form = new URLSearchParams(body);
      const code = form.get('code') ?? '';
      const record = codes.get(code);
      const verifier = form.get('code_verifier');
      if (
        !record ||
        !verifier ||
        !/^[\w~-]{43,128}$/.test(verifier) ||
        form.get('redirect_uri') !== redirectUri ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== clientId ||
        createHash('sha256').update(verifier).digest('base64url') !== record.challenge
      )
        throw new Error('Synthetic invalid_grant');
      codes.delete(code);
      return { id_token: record.jwt };
    }
    throw new Error('Unexpected fake OIDC HTTP request.');
  };

  function authorize(
    authorizeUrl: string,
    options: { claims?: Record<string, unknown>; badSignature?: boolean } = {},
  ) {
    const { searchParams } = new URL(authorizeUrl);
    const instant = Math.floor(now() / 1000);
    const claims = {
      iss: issuer,
      aud: clientId,
      sub: 'fixture-subject',
      iat: instant,
      exp: instant + 300,
      nonce: searchParams.get('nonce'),
      email: 'fixture@example.test',
      email_verified: true,
      ...options.claims,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signed = header + '.' + payload;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(signed),
      options.badSignature ? wrongKey.privateKey : key.privateKey,
    );
    const code = randomUUID();
    codes.set(code, {
      jwt: signed + '.' + signature.toString('base64url'),
      challenge: searchParams.get('code_challenge'),
    });
    return { code, state: searchParams.get('state')! };
  }

  return {
    config: { issuer, clientId, redirectUri, http, now, mfaAcrValues: ['urn:fixture:mfa'] },
    authorize,
    calls,
  };
}
