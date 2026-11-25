import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PlatformError,
  type AuditFilters,
  type BindingInput,
  type ConnectionInput,
  type CredentialInput,
  type MutationContext,
  type Permission,
  type PlatformApproval,
  type PlatformAuth,
  type PlatformServices,
  type PlanInput,
  type UsageFilters,
} from '../../../../packages/core/src/platform/index.ts';
import { validates } from '../governance/catalog.ts';
import type { IdentityVerifier } from '../governance/identity.ts';
import { registerAccessRoutes } from './access-routes.ts';
import document from './openapi.json' with { type: 'json' };

export {
  createPlatformFixtureIdentityVerifier,
  createPlatformSessionIdentityVerifier,
} from './identity.ts';

interface PlatformOptions {
  services: PlatformServices;
  verifyIdentity?: IdentityVerifier;
  auth?: PlatformAuth;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    platformPublic?: boolean;
    platformAccess?: boolean;
  }
}

class InvalidRequest extends Error {}

function validate<Input>(
  request: FastifyRequest,
  schema: Record<string, unknown>,
  input: unknown,
): Input {
  if (!validates(request, schema, input)) throw new InvalidRequest();
  return input as Input;
}

function query<Input>(request: FastifyRequest, schema: Record<string, unknown>) {
  return validate<Input>(request, schema, { ...(request.query as object) });
}

const schemas = document.components.schemas;
const credentialCreateSchema = {
  ...schemas.CredentialCreate,
  properties: { ...schemas.CredentialCreate.properties, providerId: schemas.Id },
};
const statusFor = {
  forbidden: 403,
  not_found: 404,
  module_disabled: 403,
  quota_exceeded: 429,
  invalid_approval: 409,
  idempotency_conflict: 409,
  unavailable: 503,
} as const;

export const platformRoutes: FastifyPluginAsync<PlatformOptions> = async (
  app,
  { services, verifyIdentity, auth },
) => {
  if ((!auth && !verifyIdentity) || (auth && auth.directory !== services.directory))
    throw new Error('Platform routes require a verifier for their identity directory.');
  const base = '/platform/v1';
  const identities = new WeakMap<
    FastifyRequest,
    NonNullable<ReturnType<typeof services.directory.resolve>>
  >();
  const sessions = new WeakMap<
    FastifyRequest,
    NonNullable<ReturnType<PlatformAuth['sessions']['verify']>>
  >();
  const {
    directory,
    gateway,
    entitlements,
    bindings,
    providers,
    connections,
    queries,
    billing,
    vault,
  } = services;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.config.platformPublic) {
      reply.header('Referrer-Policy', 'no-referrer');
      return;
    }
    const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const session = token && auth ? auth.sessions.verify(token) : undefined;
    const identity = auth ? session?.identity : token ? await verifyIdentity?.(token) : undefined;
    const resolved = identity && directory.resolve(identity);
    if (!resolved) {
      return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'forbidden' });
    }
    identities.set(request, resolved);
    if (session) sessions.set(request, session);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PlatformError) {
      return reply.code(statusFor[error.code]).send({ error: error.code });
    }
    const clientError =
      error !== null &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500;
    if (error instanceof InvalidRequest || clientError) {
      return reply.code(400).send({ error: 'forbidden' });
    }
    request.log.error('Platform request failed');
    return reply.code(503).send({ error: 'unavailable' });
  });

  function identityOf(request: FastifyRequest) {
    const identity = identities.get(request);
    if (!identity) throw new Error('Verified platform identity missing.');
    return identity;
  }

  function tenantOf(request: FastifyRequest) {
    return identityOf(request).tenant.id;
  }

  function context(request: FastifyRequest, adminOnly = false): MutationContext {
    const { actor, tenant } = identityOf(request);
    if (adminOnly) requirePermission(request, 'settings.manage', true);
    return {
      tenantId: tenant.id,
      actor: { id: actor.id, kind: actor.kind },
      source: 'rest',
      traceId: request.id,
      correlationId: request.id,
    };
  }

  function requireStepUp(request: FastifyRequest) {
    if (auth?.requireStepUp && !sessions.get(request)?.steppedUp)
      throw new PlatformError('forbidden');
  }

  function requirePermission(request: FastifyRequest, permission: Permission, sensitive = false) {
    const { actor, tenant } = identityOf(request);
    if (!directory.allows({ tenantId: tenant.id, actor }, permission))
      throw new PlatformError('forbidden');
    if (sensitive) requireStepUp(request);
  }

  function requireOperator(request: FastifyRequest) {
    if (!sessions.get(request)?.platformOperator) throw new PlatformError('forbidden');
    requireStepUp(request);
  }

  // Legacy platform reads share one permission, while identity and access routes check their own.
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.config.platformPublic || request.routeOptions.config.platformAccess)
      return;
    if (request.method === 'GET' || request.method === 'HEAD')
      requirePermission(request, 'platform.read');
  });

  registerAccessRoutes(app, {
    base,
    services,
    auth,
    context,
    requirePermission,
    requireOperator,
    validate,
    query,
  });

  app.get(base + '/me', { config: { platformAccess: true } }, async (request) =>
    identityOf(request),
  );
  app.get(base + '/workspaces', async (request) => directory.workspaces(tenantOf(request)));
  app.get<{ Params: { id: string } }>(base + '/workspaces/:id', async (request) => {
    const workspace = directory
      .workspaces(tenantOf(request))
      .find(({ id }) => id === request.params.id);
    if (!workspace) throw new PlatformError('not_found');
    return workspace;
  });

  app.get(base + '/modules', async (request) =>
    entitlements.listing(tenantOf(request), gateway.usage()),
  );
  app.patch<{ Params: { moduleId: string } }>(base + '/modules/:moduleId', async (request) => {
    const actor = context(request, true);
    const { enabled } = validate<{ enabled: boolean }>(request, schemas.ModuleUpdate, request.body);
    return gateway.setModule(actor, request.params.moduleId, enabled);
  });

  app.get(base + '/capabilities', async (request) => bindings.list(tenantOf(request)));
  app.get(base + '/providers', async (request) => {
    const { capability } = query<{ capability?: string }>(request, schemas.ProviderQuery);
    return providers
      .list(capability)
      .map(({ providerId, capability, name, mode, regions, features, notes }) => ({
        providerId,
        capability,
        name,
        mode,
        regions,
        features,
        notes,
      }));
  });
  app.put<{ Params: { capability: string } }>(
    base + '/capabilities/:capability/binding',
    async (request) => {
      const actor = context(request, true);
      const input = validate<BindingInput>(request, schemas.BindingUpdate, request.body);
      return bindings.bind(actor, request.params.capability, input);
    },
  );

  app.get(base + '/audit', async (request) => {
    const { limit, ...filters } = query<Omit<AuditFilters, 'limit'> & { limit?: string }>(
      request,
      schemas.AuditQuery,
    );
    return queries.audit(tenantOf(request), {
      ...filters,
      limit: limit === undefined ? undefined : Number(limit),
    });
  });
  app.get(base + '/usage', async (request) => {
    const filters = query<UsageFilters>(request, schemas.UsageQuery);
    return queries.usage(tenantOf(request), filters);
  });

  app.get(base + '/approvals', async (request) => {
    const { state } = query<{ state?: PlatformApproval['state'] }>(request, schemas.ApprovalQuery);
    return gateway.listApprovals(tenantOf(request), state);
  });
  app.post<{ Params: { id: string } }>(base + '/approvals/:id/sign', async (request) => {
    return gateway.sign(context(request), request.params.id);
  });
  app.post<{ Params: { id: string } }>(base + '/approvals/:id/reject', async (request) => {
    const { reason } = validate<{ reason: string }>(
      request,
      schemas.ApprovalRejection,
      request.body,
    );
    return gateway.reject(context(request), request.params.id, reason);
  });

  app.get(base + '/connections', async (request) => connections.list(tenantOf(request)));
  app.post(base + '/connections', async (request, reply) => {
    const actor = context(request, true);
    const input = validate<ConnectionInput>(request, schemas.ConnectionCreate, request.body);
    const connection = await connections.create(actor, input);
    return reply.code(201).send(connection);
  });
  app.delete<{ Params: { id: string } }>(base + '/connections/:id', async (request, reply) => {
    await connections.delete(context(request, true), request.params.id);
    return reply.code(204).send();
  });

  app.get(base + '/billing/plan', async (request) => billing.plan(tenantOf(request)));
  app.get(base + '/billing/skus', async () => billing.skus());
  app.post(base + '/billing/plan', async (request) => {
    const actor = context(request, true);
    const input = validate<PlanInput>(request, schemas.BillingPlanUpdate, request.body);
    return billing.changePlan(actor, input);
  });
  app.get(base + '/billing/invoices', async (request) => billing.invoices(tenantOf(request)));
  app.get<{ Params: { id: string } }>(base + '/billing/invoices/:id', async (request) =>
    billing.invoice(tenantOf(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>(base + '/billing/invoices/:id/finalize', async (request) =>
    billing.finalize(context(request, true), request.params.id),
  );

  app.get(base + '/credentials', async (request) =>
    (await vault.list(tenantOf(request)))
      .filter(({ status }) => status === 'active')
      .map(({ ref }) => ({ ref })),
  );
  app.post(base + '/credentials', async (request, reply) => {
    const actor = context(request, true);
    const input = validate<CredentialInput>(request, credentialCreateSchema, request.body);
    if (!providers.get(input.capability, input.providerId)) throw new PlatformError('not_found');
    const { ref } = await vault.create(actor, input);
    return reply.code(201).send({ ref });
  });
  app.post<{ Params: { ref: string } }>(base + '/credentials/:ref/rotate', async (request) => {
    const actor = context(request, true);
    const { secret } = validate<{ secret: string }>(
      request,
      schemas.CredentialRotate,
      request.body,
    );
    const { ref } = await vault.rotate(actor, request.params.ref, secret);
    return { ref };
  });
  app.delete<{ Params: { ref: string } }>(base + '/credentials/:ref', async (request, reply) => {
    await vault.revoke(context(request, true), request.params.ref);
    return reply.code(204).send();
  });

  app.get(base + '/registry/bots', async (request) => services.registry(tenantOf(request), 'bots'));
  app.get(base + '/registry/workflows', async (request) =>
    services.registry(tenantOf(request), 'workflows'),
  );
  app.get(base + '/health', async () => ({ status: 'ok', version: 'v1' }));
};
