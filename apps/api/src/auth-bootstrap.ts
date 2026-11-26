import type { ActorGrant } from '@bs/contracts';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  PlatformAuth,
  type OidcHttpClient,
  type PlatformAuthOptions,
  type TenantDirectory,
} from '../../../packages/core/src/platform/index.ts';

const dexUsers = {
  'actor-admin': '00000000-0000-4000-8000-000000000001',
  'actor-operator': '00000000-0000-4000-8000-000000000002',
  'actor-approver': '00000000-0000-4000-8000-000000000003',
  'actor-reader': '00000000-0000-4000-8000-000000000004',
  'actor-isolation': '00000000-0000-4000-8000-000000000005',
};

export interface HostAuth {
  options: PlatformAuthOptions;
  subjects: Readonly<Record<string, string>>;
}

export function configureAuth(app: FastifyInstance, directory: TenantDirectory, grants: ActorGrant[], config: HostAuth) {
  const auth = new PlatformAuth(directory, config.options);
  app.addHook('onReady', async () => {
    for (const [actor, subject] of Object.entries(config.subjects)) {
      const tenantId = actor === 'actor-admin' ? 'tenant-rivetquay' :
        grants.find((row) => row.actor.id === actor)?.tenantId;
      if (!tenantId) throw new Error('Unknown fixture OIDC actor.');
      await directory.linkUser(tenantId, actor, config.options.oidc.issuer, subject);
    }
  });
  return auth;
}

function dexSubject(id: string) {
  // Dex encodes the local connector ID and the configured user ID in the subject.
  return Buffer.concat([
    Buffer.from([10, id.length]),
    Buffer.from(id),
    Buffer.from('\x12\x05local'),
  ]).toString('base64url');
}

export function localDexAuth(env: NodeJS.ProcessEnv): HostAuth | undefined {
  if (env.BS_AUTH_MODE !== 'oidc') return;
  const issuer = env.BS_DEX_ISSUER ?? 'http://localhost:5556/dex';
  const issuerUrl = new URL(issuer);
  if (!['localhost', '127.0.0.1'].includes(issuerUrl.hostname)) {
    throw new Error('The development Dex issuer must use a loopback address.');
  }
  const target = env.BS_DEX_IN_COMPOSE === '1' ? 'http://dex:5556' : issuerUrl.origin;
  const http: OidcHttpClient = async ({ url, method, headers, body }) => {
    const endpoint = new URL(url);
    if (
      endpoint.origin !== issuerUrl.origin ||
      !endpoint.pathname.startsWith(issuerUrl.pathname + '/')
    ) {
      throw new Error('Unexpected development Dex endpoint.');
    }
    const response = await fetch(target + endpoint.pathname + endpoint.search, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Development Dex request failed.');
    return response.json();
  };
  return {
    options: {
      signingKey: randomBytes(32),
      requireStepUp: false,
      oidc: {
        issuer,
        clientId: 'rivetquay-dev',
        clientSecret: 'synthetic-dex-client-secret',
        redirectUri: env.BS_OIDC_REDIRECT_URI ?? 'http://localhost:5173/oidc/callback',
        allowInsecureLoopback: true,
        http,
      },
    },
    subjects: Object.fromEntries(
      Object.entries(dexUsers).map(([actor, id]) => [actor, dexSubject(id)]),
    ),
  };
}
