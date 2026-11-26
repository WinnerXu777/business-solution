import type { Approval, CallEnvelope, Denied, ToolCall, ToolName } from '@bs/contracts';
import type { GovernedGateway, ToolGateway } from '@bs/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { catalog, envelopeSchema, idSchema, validates } from './catalog.ts';
import {
  bearerToken,
  matchesIdentity,
  verifiedEnvelope,
  type IdentityVerifier,
  type VerifiedIdentity,
} from './identity.ts';
import { registerMcp } from './mcp.ts';

export {
  createFixtureIdentityVerifier,
  type IdentityVerifier,
  type VerifiedIdentity,
} from './identity.ts';

interface GovernanceOptions {
  gateway: ToolGateway &
    Partial<Pick<GovernedGateway, 'exportAudit' | 'listUsage' | 'listDeadLetters'>> & {
      signApproval?(envelope: CallEnvelope, approvalId: string): Promise<Approval | Denied>;
    };
  verifyIdentity: IdentityVerifier;
  allowedMcpOrigins?: readonly string[];
  restToolsHandledElsewhere?: readonly ToolName[];
  canReview?: (identity: VerifiedIdentity) => boolean | Promise<boolean>;
}

export const governanceRoutes: FastifyPluginAsync<GovernanceOptions> = async (app, options) => {
  const identities = new WeakMap<FastifyRequest, VerifiedIdentity>();
  const { gateway, verifyIdentity } = options;

  app.addHook('onRequest', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const identity = token && (await verifyIdentity(token));
    if (!identity) {
      return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ error: 'unauthorized' });
    }
    identities.set(request, { tenantId: identity.tenantId, actor: { ...identity.actor } });
    reply.header('Cache-Control', 'no-store');
  });

  function identityOf(request: FastifyRequest) {
    const identity = identities.get(request);
    if (!identity) throw new Error('Verified identity missing.');
    return identity;
  }

  for (const [tool, { path, requestSchema }] of catalog) {
    if (options.restToolsHandledElsewhere?.includes(tool)) continue;
    app.post(path, async (request, reply) => {
      if (!validates(request, requestSchema, request.body)) {
        return reply.code(400).send({ error: 'invalid_input' });
      }
      const call = request.body as ToolCall;
      const identity = identityOf(request);
      if (!matchesIdentity(call.envelope, identity)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return gateway.call({ ...call, envelope: verifiedEnvelope(call.envelope, identity, 'rest') });
    });
  }

  const { exportAudit, listUsage, listDeadLetters } = gateway;
  if (options.canReview && exportAudit && listUsage && listDeadLetters) {
    async function preHandler(request: FastifyRequest, reply: FastifyReply) {
      if (!(await options.canReview?.(identityOf(request)))) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    app.get('/v1/governance/audit', { preHandler }, async (request, reply) =>
      reply
        .type('application/x-ndjson')
        .send(await exportAudit.call(gateway, identityOf(request).tenantId)),
    );
    app.get('/v1/governance/usage', { preHandler }, (request) =>
      listUsage.call(gateway, identityOf(request).tenantId),
    );
    app.get('/v1/governance/dead-letters', { preHandler }, (request) =>
      listDeadLetters.call(gateway, identityOf(request).tenantId),
    );
  }

  if (gateway.signApproval) {
    app.post<{ Params: { approvalId: string } }>(
      '/v1/approvals/:approvalId/sign',
      async (request, reply) => {
        if (
          !validates(request, envelopeSchema, request.body) ||
          !validates(request, idSchema, request.params.approvalId)
        ) {
          return reply.code(400).send({ error: 'invalid_input' });
        }
        const envelope = request.body as CallEnvelope;
        const identity = identityOf(request);
        if (!matchesIdentity(envelope, identity)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        return gateway.signApproval?.(
          verifiedEnvelope(envelope, identity, 'rest'),
          request.params.approvalId,
        );
      },
    );
  }

  registerMcp(app, gateway, identityOf, options.allowedMcpOrigins ?? []);
};
