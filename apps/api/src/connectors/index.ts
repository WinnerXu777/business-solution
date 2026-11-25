import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  ConnectorError,
  type BindingRef,
  type ConnectorFailure,
  type ConnectorLifecycle,
  type ConnectorSync,
  type Installation,
  type ShadowMapping,
  type WebhookIngestor,
} from '../../../../packages/adapters/src/connectors/index.ts';

export type ConnectorPermission = 'connectors:read' | 'connectors:manage' | 'connectors:sync';

interface Identity {
  tenantId: string;
  actorId: string;
}

export interface ConnectorPluginOptions {
  lifecycle: ConnectorLifecycle;
  sync: ConnectorSync;
  webhooks: WebhookIngestor;
  /** Resolve verified identity and enforce the requested connector permission. */
  identify(request: FastifyRequest, permission: ConnectorPermission): Promise<Identity>;
}

type ConnectionRoute = { Params: { connectionId: string } };

const text = { type: 'string', minLength: 1, maxLength: 256 } as const;
const secret = { ...text, maxLength: 4096 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const recordKey = object({ recordClass: text, externalId: text });
const statuses: Record<ConnectorFailure, number> = {
  not_found: 404,
  auth_required: 401,
  permission_denied: 403,
  rate_limited: 429,
  conflict: 409,
  validation_failed: 400,
  unsupported: 422,
  provider_unavailable: 502,
  approval_required: 403,
  outcome_unknown: 409,
  write_frozen: 409,
};

/** Register at the platform boundary with a verified identity resolver and tenant-scoped stores. */
export const connectorsPlugin: FastifyPluginAsync<ConnectorPluginOptions> = async (
  app,
  options,
) => {
  const { lifecycle, sync, webhooks } = options;
  const identify = async (request: FastifyRequest, permission: ConnectorPermission) => {
    const identity = await options.identify(request, permission);
    if (!identity?.tenantId || !identity.actorId) throw new ConnectorError('auth_required');
    return identity;
  };
  const ref = async (
    request: FastifyRequest<ConnectionRoute>,
    permission: ConnectorPermission,
  ): Promise<BindingRef> => ({
    tenantId: (await identify(request, permission)).tenantId,
    connectionId: request.params.connectionId,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConnectorError) {
      if (error.retryAfterMs !== undefined)
        reply.header('retry-after', Math.ceil(error.retryAfterMs / 1000));
      return reply.code(statuses[error.code]).send({ error: error.code });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400 || status === 413 || status === 415) {
      return reply.code(status).send({ error: 'validation_failed' });
    }
    return reply.code(502).send({ error: 'provider_unavailable' });
  });

  app.get('/connectors', async (request) => {
    await identify(request, 'connectors:read');
    return { connectors: lifecycle.available() };
  });

  app.post<{ Body: { connectorId: string; accountId: string; mode?: Installation['mode'] } }>(
    '/connectors/install',
    {
      schema: {
        body: object(
          {
            connectorId: text,
            accountId: text,
            mode: { enum: ['primary', 'shadow'] },
          },
          ['connectorId', 'accountId'],
        ),
      },
    },
    async (request, reply) => {
      const { tenantId } = await identify(request, 'connectors:manage');
      const { connectorId, accountId, mode } = request.body;
      return reply.code(201).send(lifecycle.install(tenantId, connectorId, accountId, mode));
    },
  );

  app.post<ConnectionRoute>('/connectors/:connectionId/oauth/start', async (request, reply) => {
    const { tenantId, actorId } = await identify(request, 'connectors:manage');
    reply.header('cache-control', 'no-store');
    return {
      authorizeUrl: await lifecycle.startOAuth({
        tenantId,
        actorId,
        connectionId: request.params.connectionId,
      }),
    };
  });

  app.get<{ Querystring: { state: string; code: string } }>(
    '/connectors/oauth/callback',
    {
      logLevel: 'silent',
      schema: {
        querystring: {
          ...object({ state: text, code: secret }),
          // Providers can attach their own metadata. Account identity comes from the credential.
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const caller = await identify(request, 'connectors:manage');
      const { state, code } = request.query;
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const binding = await lifecycle.completeOAuth(caller, state, code);
      await lifecycle.verifyAccount(binding);
      return lifecycle.activate(binding);
    },
  );

  app.post<ConnectionRoute & { Body: { key: string } }>(
    '/connectors/:connectionId/api-key',
    { logLevel: 'silent', schema: { body: object({ key: secret }) } },
    async (request) => {
      const binding = await ref(request, 'connectors:manage');
      await lifecycle.authorizeApiKey(binding, request.body.key);
      await lifecycle.verifyAccount(binding);
      return lifecycle.activate(binding);
    },
  );

  const managementActions = {
    verify: (binding: BindingRef) => lifecycle.verifyAccount(binding),
    activate: (binding: BindingRef) => lifecycle.activate(binding),
    pause: (binding: BindingRef) => lifecycle.pause(binding),
    refresh: (binding: BindingRef) => lifecycle.refresh(binding),
    revoke: (binding: BindingRef) => lifecycle.revoke(binding),
  };
  for (const [name, action] of Object.entries(managementActions)) {
    app.post<ConnectionRoute>(`/connectors/:connectionId/${name}`, async (request) =>
      action(await ref(request, 'connectors:manage')),
    );
  }

  app.get<ConnectionRoute>('/connectors/:connectionId/status', async (request) => {
    const binding = await ref(request, 'connectors:read');
    return { ...lifecycle.get(binding), sync: sync.status(binding) };
  });

  app.post<ConnectionRoute & { Body: { mode: 'snapshot' | 'poll'; maxPages?: number } }>(
    '/connectors/:connectionId/sync',
    {
      schema: {
        body: object(
          {
            mode: { enum: ['snapshot', 'poll'] },
            maxPages: { type: 'integer', minimum: 1, maximum: 100 },
          },
          ['mode'],
        ),
      },
    },
    async (request) => {
      const binding = await ref(request, 'connectors:sync');
      return request.body.mode === 'snapshot'
        ? sync.importSnapshot(binding)
        : sync.poll(binding, request.body.maxPages);
    },
  );

  app.get<ConnectionRoute>('/connectors/:connectionId/reconciliation', async (request) => ({
    report: sync.report(await ref(request, 'connectors:read')),
  }));

  app.post<ConnectionRoute & { Body: { candidateId: string; mappings: ShadowMapping[] } }>(
    '/connectors/:connectionId/reconciliation/shadow',
    {
      schema: {
        body: object({
          candidateId: text,
          mappings: {
            type: 'array',
            maxItems: 1000,
            items: object({ primary: recordKey, candidate: recordKey }),
          },
        }),
      },
    },
    async (request) => {
      const primary = await ref(request, 'connectors:read');
      const { candidateId, mappings } = request.body;
      return {
        report: sync.compareShadow(
          primary,
          { tenantId: primary.tenantId, connectionId: candidateId },
          mappings,
        ),
      };
    },
  );

  app.get<ConnectionRoute>('/connectors/:connectionId/dead-letters', async (request) => ({
    events: webhooks.listDeadLetters(await ref(request, 'connectors:read')),
  }));

  await app.register(async (signedIngress) => {
    signedIngress.removeAllContentTypeParsers();
    signedIngress.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    signedIngress.post<ConnectionRoute & { Body: Buffer }>(
      '/connectors/:connectionId/webhooks',
      { bodyLimit: 64 * 1024 },
      async (request, reply) => {
        const timestamp = request.headers['x-connector-timestamp'];
        const signature = request.headers['x-connector-signature'];
        if (
          typeof timestamp !== 'string' ||
          typeof signature !== 'string' ||
          !Buffer.isBuffer(request.body)
        ) {
          throw new ConnectorError('auth_required');
        }
        const result = await webhooks.receive(request.params.connectionId, {
          body: request.body,
          timestamp,
          signature,
        });
        return reply.code(202).send(result);
      },
    );
  });
};
