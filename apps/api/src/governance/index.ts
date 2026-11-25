import type { Approval, CallEnvelope, Denied, ToolCall } from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { catalog, envelopeSchema, idSchema, validates } from './catalog.ts';
import {
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
  gateway: ToolGateway & {
    signApproval?(envelope: CallEnvelope, approvalId: string): Promise<Approval | Denied>;
  };
  verifyIdentity: IdentityVerifier;
  allowedMcpOrigins?: readonly string[];
}

export const governanceRoutes: FastifyPluginAsync<GovernanceOptions> = async (app, options) => {
  const identities = new WeakMap<FastifyRequest, VerifiedIdentity>();
  const { gateway, verifyIdentity } = options;

  app.addHook('onRequest', async (request, reply) => {
    const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? '')?.[1];
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

  for (const { path, requestSchema } of catalog.values()) {
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
