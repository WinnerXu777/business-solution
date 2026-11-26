import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PlatformError,
  redactFields,
  type ConsentInput,
  type ContactInput,
  type MutationContext,
  type Permission,
  type PlatformServices,
  type PrivacyRequestInput,
  type SuppressionInput,
  type VerificationInput,
  type WebhookInput,
} from '../../../../packages/core/src/platform/index.ts';
import document from './openapi.json' with { type: 'json' };

interface ComplianceRoutes {
  base: string;
  services: PlatformServices;
  context: (request: FastifyRequest) => MutationContext;
  adminContext: (request: FastifyRequest) => Promise<MutationContext>;
  requirePermission: (
    request: FastifyRequest,
    permission: Permission,
    sensitive?: boolean,
  ) => Promise<void>;
  requireOperator: (request: FastifyRequest) => void;
  validate: <Input>(
    request: FastifyRequest,
    schema: Record<string, unknown>,
    input: unknown,
  ) => Input;
}

const schemas: Record<string, Record<string, unknown>> = document.components.schemas;

function expand(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(expand);
  if (schema === null || typeof schema !== 'object') return schema;
  if ('$ref' in schema && typeof schema.$ref === 'string') {
    return expand(schemas[schema.$ref.slice('#/components/schemas/'.length)]);
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, expand(value)]));
}

const inputs = Object.fromEntries(
  [
    'ConsentInput',
    'SuppressionInput',
    'ContactInput',
    'UnsubscribeInput',
    'PrivacyRequestInput',
    'PrivacyVerificationInput',
    'RetentionDryRunInput',
    'WebhookInput',
    'SuppressionQuery',
  ].map((name) => [name, expand(schemas[name]) as Record<string, unknown>]),
);

export function reportPlatformError(request: FastifyRequest) {
  request.log.error(
    redactFields('platformLog', { requestId: request.id, operation: 'platform_request' }),
    'Platform request failed',
  );
}

export function registerComplianceRoutes(
  app: FastifyInstance,
  {
    base,
    services: { contacts, privacy, events },
    context,
    adminContext,
    requirePermission,
    requireOperator,
    validate,
  }: ComplianceRoutes,
) {
  function body<Input>(request: FastifyRequest, name: string) {
    return validate<Input>(request, inputs[name], request.body);
  }

  async function suppressionScope(request: FastifyRequest) {
    const { scope } = validate<{ scope?: 'tenant' | 'platform' }>(
      request,
      inputs.SuppressionQuery,
      { ...(request.query as object) },
    );
    if (scope === 'platform') requireOperator(request);
    else await requirePermission(request, 'settings.manage', true);
    return scope === 'platform';
  }

  async function person(request: FastifyRequest) {
    await requirePermission(request, 'platform.read');
    const actor = context(request);
    if (actor.actor.kind !== 'person') throw new PlatformError('forbidden');
    return actor;
  }

  app.get(base + '/consents', async (request) =>
    contacts.listConsents((await adminContext(request)).tenantId),
  );
  app.post(base + '/consents', async (request, reply) => {
    const consent = await contacts.grant(
      await adminContext(request),
      body<ConsentInput>(request, 'ConsentInput'),
    );
    return reply.code(201).send(consent);
  });
  app.post<{ Params: { id: string } }>(base + '/consents/:id/withdraw', async (request) =>
    contacts.withdraw(await adminContext(request), request.params.id),
  );
  app.post(
    base + '/consents/unsubscribe',
    { config: { platformPublic: true } },
    async (request, reply) => {
      const { tenantId, consentId, token } = body<{
        tenantId: string;
        consentId: string;
        token: string;
      }>(request, 'UnsubscribeInput');
      await contacts.unsubscribe(tenantId, consentId, token);
      return reply.code(204).send();
    },
  );

  app.get(base + '/suppressions', { config: { platformAccess: true } }, async (request) => {
    const platform = await suppressionScope(request);
    return contacts.listSuppressions(context(request).tenantId, platform);
  });
  app.post(base + '/suppressions', async (request, reply) => {
    const platform = await suppressionScope(request);
    const suppression = await contacts.suppress(
      context(request),
      body<SuppressionInput>(request, 'SuppressionInput'),
      platform,
    );
    return reply.code(201).send(suppression);
  });
  app.post(base + '/contact-check', async (request) => {
    const { tenantId } = await adminContext(request);
    const { contactId, channel, purpose } = body<ContactInput>(request, 'ContactInput');
    return contacts.canContact(tenantId, contactId, channel, purpose);
  });

  app.get(base + '/privacy-requests', async (request) =>
    privacy.list((await adminContext(request)).tenantId),
  );
  app.post(base + '/privacy-requests', async (request, reply) => {
    const result = await privacy.create(
      await adminContext(request),
      body<PrivacyRequestInput>(request, 'PrivacyRequestInput'),
    );
    return reply.code(201).send(result);
  });
  app.post<{ Params: { id: string } }>(base + '/privacy-requests/:id/verify', async (request) =>
    privacy.verify(
      await adminContext(request),
      request.params.id,
      body<VerificationInput>(request, 'PrivacyVerificationInput'),
    ),
  );
  app.post<{ Params: { id: string } }>(base + '/privacy-requests/:id/complete', async (request) =>
    privacy.complete(await adminContext(request), request.params.id),
  );

  app.get(base + '/retention/policies', async (request) => {
    const { tenantId } = await adminContext(request);
    return privacy.policies(tenantId);
  });
  app.post(base + '/retention/dry-run', async (request) => {
    const { tenantId } = await adminContext(request);
    const { asOf } = validate<{ asOf?: string }>(
      request,
      inputs.RetentionDryRunInput,
      request.body === undefined ? {} : request.body,
    );
    return privacy.dryRun(tenantId, asOf);
  });

  app.get(base + '/webhooks', async (request) =>
    events.listWebhooks((await adminContext(request)).tenantId),
  );
  app.post(base + '/webhooks', async (request, reply) => {
    const hook = await events.createWebhook(
      await adminContext(request),
      body<WebhookInput>(request, 'WebhookInput'),
    );
    return reply.code(201).send(hook);
  });
  app.post<{ Params: { id: string } }>(base + '/webhooks/:id/test', async (request, reply) => {
    const event = await events.testWebhook(await adminContext(request), request.params.id);
    return reply.code(202).send(event);
  });
  app.get<{ Params: { id: string } }>(base + '/webhooks/:id/deliveries', async (request) =>
    events.deliveries((await adminContext(request)).tenantId, request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    base + '/webhooks/deliveries/:id/replay',
    async (request, reply) => {
      const delivery = await events.replay(await adminContext(request), request.params.id);
      return reply.code(202).send(delivery);
    },
  );
  app.get(base + '/notifications', async (request) => {
    const { tenantId, actor } = await person(request);
    return events.notifications(tenantId, actor.id);
  });
  app.post<{ Params: { id: string } }>(base + '/notifications/:id/read', async (request) =>
    events.markRead(await person(request), request.params.id),
  );
}
