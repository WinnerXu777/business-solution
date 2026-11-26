import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PlatformError,
  type MutationContext,
  type Permission,
  type PlatformAuth,
  type PlatformServices,
} from '../../../packages/core/src/platform/index.ts';
import { permissions } from '../../../packages/core/src/platform/permissions.ts';
import type { LlmPluginOptions, Route } from './llm/index.ts';
import type { VerifiedIdentity } from './governance/identity.ts';
import { bearerToken } from './governance/identity.ts';

type Identify = (request: FastifyRequest) =>
  VerifiedIdentity | undefined | Promise<VerifiedIdentity | undefined>;
const prefix = '/platform/v1';
const llmScopes = ['llm.models', 'llm.chat.completions', 'llm.embeddings'];
const permissionLabel = (id: string) => id.split('.').reverse().join(' ');

export function registerConsoleRoutes(
  app: FastifyInstance,
  services: PlatformServices,
  identify: Identify,
  auth?: PlatformAuth,
) {
  const { directory, connections } = services;
  app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof PlatformError) {
        const status = {
          not_found: 404, idempotency_conflict: 409, unavailable: 503,
          quota_exceeded: 429, invalid_approval: 409, module_disabled: 403, forbidden: 403,
        }[error.code];
        return reply.code(status).send({ code: error.code });
      }
      if ((error as { statusCode?: number })?.statusCode === 400)
        return reply.code(400).send({ code: 'invalid_input' });
      return reply.code(503).send({ code: 'unavailable' });
    });

    async function context(request: FastifyRequest, reply: FastifyReply, permission: Permission,
        stepUp = false): Promise<MutationContext | undefined> {
      reply.header('cache-control', 'no-store');
      const identity = await identify(request);
      if (!identity) {
        await reply.code(401).send({ code: 'unauthenticated' });
        return;
      }
      if (!(await directory.allows(identity, permission))) throw new PlatformError('forbidden');
      if (stepUp && auth?.requireStepUp) {
        const token = bearerToken(request.headers.authorization);
        if (!token || !(await auth.sessions.verify(token))?.steppedUp) {
          await reply.code(403).send({ code: 'step_up_required' });
          return;
        }
      }
      return { ...identity, source: 'rest', traceId: request.id, correlationId: request.id };
    }

    routes.get(prefix + '/permissions', async (request, reply) => {
      if (await context(request, reply, 'roles.read'))
        return permissions.map((id) => ({ id, label: permissionLabel(id) }));
    });

    routes.post<{ Body: { email?: string; roleId?: string } }>(
      prefix + '/members/invitations', async (request, reply) => {
        const actor = await context(request, reply, 'members.manage', true);
        if (!actor) return;
        const { email, roleId } = request.body ?? {};
        if (typeof email !== 'string' || typeof roleId !== 'string')
          return reply.code(400).send({ code: 'invalid_input' });
        const { token, expiresAt } = await directory.createInvite(actor, email, roleId);
        return reply.code(201).send({
          url: prefix + '/invites/' + encodeURIComponent(token) + '/accept', expiresAt,
        });
      },
    );
    routes.patch<{ Params: { id: string }; Body: { roleId?: string } }>(
      prefix + '/members/:id', async (request, reply) => {
        const actor = await context(request, reply, 'members.manage', true);
        if (!actor) return;
        const { roleId } = request.body ?? {};
        if (typeof roleId !== 'string' || !roleId)
          return reply.code(400).send({ code: 'invalid_input' });
        await directory.assignRole(actor, request.params.id, roleId);
        return reply.code(204).send();
      },
    );

    routes.get(prefix + '/onboarding', async (request, reply) => {
      const actor = await context(request, reply, 'platform.read');
      if (!actor) return;
      const [bindings, members] = await Promise.all([
        services.bindings.list(actor.tenantId), directory.members(actor.tenantId),
      ]);
      const completed: string[] = [];
      if (bindings.some(({ version }) => version > 0)) completed.push('choose_providers');
      if (members.filter(({ user }) => user.actor.kind === 'person').length > 1)
        completed.push('invite_team');
      return { completed };
    });

    const keys = prefix + '/llm/keys';
    const hasLlmScopes = ({ kind, scopes }: { kind: string; scopes: string[] }) =>
      kind === 'api_client' && llmScopes.every((scope) => scopes.includes(scope));
    routes.get(keys, async (request, reply) => {
      const actor = await context(request, reply, 'settings.manage');
      if (!actor) return;
      return (await connections.list(actor.tenantId)).filter(hasLlmScopes)
        .map(({ id, name, createdAt }) => ({ id, name, createdAt, prefix: actor.tenantId + '.' + id }));
    });
    routes.post<{ Body: { name?: string } }>(keys, async (request, reply) => {
      const actor = await context(request, reply, 'settings.manage', true);
      if (!actor) return;
      const name = request.body?.name?.trim();
      if (!name || name.length > 100) return reply.code(400).send({ code: 'invalid_input' });
      const key = await connections.create(actor, { kind: 'api_client', name, scopes: llmScopes });
      return reply.code(201).send({ secret: actor.tenantId + '.' + key.id + '.' + key.secret });
    });
    routes.delete<{ Params: { id: string } }>(keys + '/:id', async (request, reply) => {
      const actor = await context(request, reply, 'settings.manage', true);
      if (!actor) return;
      const { id } = request.params;
      if (!(await connections.list(actor.tenantId)).some((item) => item.id === id && hasLlmScopes(item)))
        throw new PlatformError('not_found');
      await connections.delete(actor, id);
      return reply.code(204).send();
    });
  });
}

/** Expose the selected route after the native API has primed the actual provider stream. */
export function consoleLlm(app: FastifyInstance, llm: LlmPluginOptions): LlmPluginOptions {
  const scope = new AsyncLocalStorage<FastifyReply>();
  app.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions.url === '/llm/v1/chat/completions') scope.run(reply, done);
    else done();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    const version = reply.getHeader('x-llm-binding-version');
    if (typeof version === 'string') reply.header('x-binding-version', version);
    return payload;
  });
  function wrap(route: Route): Route {
    const reply = scope.getStore();
    if (!reply) return route;
    return {
      ...route,
      adapter: {
        ...route.adapter,
        async *stream(input, signal) {
          for await (const event of route.adapter.stream(input, signal)) {
            if (!reply.sent) reply.header('x-provider-route', route.routeId);
            yield event;
          }
        },
      },
    };
  }
  return {
    ...llm,
    async resolveBinding(tenantId, capability) {
      const binding = await llm.resolveBinding(tenantId, capability);
      if (!binding) return null;
      return {
        ...binding,
        primary: wrap(binding.primary),
        inferenceFallback: binding.inferenceFallback && wrap(binding.inferenceFallback),
      };
    },
  };
}

/** Browser sessions and API clients share the native endpoint and its metering. */
export function browserLlm(
  app: FastifyInstance, services: PlatformServices, llm: LlmPluginOptions, identify: Identify,
): LlmPluginOptions {
  const tickets = new Map<string, string>();
  app.addHook('onRequest', async (request) => {
    if (!request.routeOptions.url?.startsWith('/llm/v1/')) return;
    const identity = await identify(request);
    if (!identity || !(await services.directory.allows(identity, 'platform.read'))) return;
    const ticket = 'console-' + randomUUID();
    tickets.set(ticket, identity.tenantId);
    request.headers.authorization = 'Bearer ' + ticket;
  });
  app.addHook('onResponse', async (request) => {
    const ticket = bearerToken(request.headers.authorization);
    if (ticket) tickets.delete(ticket);
  });
  return {
    ...llm,
    verifyApiKey(key, endpoint) {
      const tenantId = tickets.get(key);
      if (tenantId) {
        tickets.delete(key);
        return { tenantId };
      }
      return llm.verifyApiKey(key, endpoint);
    },
  };
}
