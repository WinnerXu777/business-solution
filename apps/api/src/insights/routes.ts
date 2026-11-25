import type {
  CallEnvelope,
  RunForecastRequest,
  RunProfileRequest,
  ScoreFraudRequest,
} from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { catalog, validates } from '../governance/catalog.ts';
import { matchesIdentity, verifiedEnvelope } from '../governance/identity.ts';

type InsightsRequest = ScoreFraudRequest | RunForecastRequest | RunProfileRequest;
type Identity = Pick<CallEnvelope, 'tenantId' | 'actor'>;

type InsightsOptions = {
  gateway: ToolGateway;
  /** Resolve a verified identity independently of the envelope supplied by the caller. */
  resolveIdentity(request: FastifyRequest): Identity | undefined | Promise<Identity | undefined>;
};

export const insightTools = ['fraud.score', 'forecast.run', 'profile.run'] as const;

export function registerInsightsRoutes(app: FastifyInstance, options: InsightsOptions): void {
  for (const tool of insightTools) {
    const { path, requestSchema } = catalog.get(tool)!;
    app.post(path, async (request, reply) => {
      const identity = await options.resolveIdentity(request);
      if (!identity) {
        return reply
          .header('WWW-Authenticate', 'Bearer')
          .code(401)
          .send({ message: 'Authentication required.' });
      }
      reply.header('Cache-Control', 'no-store');
      if (!validates(request, requestSchema, request.body))
        return reply.code(400).send({ error: 'invalid_input' });
      const call = request.body as InsightsRequest;
      if (!matchesIdentity(call.envelope, identity)) {
        return { state: 'denied', code: 'forbidden', message: 'forbidden' };
      }

      try {
        return await options.gateway.call({
          ...call,
          envelope: verifiedEnvelope(call.envelope, identity, 'rest'),
        });
      } catch {
        return {
          state: 'failed',
          code: 'unavailable',
          message: 'Insights gateway unavailable.',
          retryable: true,
        };
      }
    });
  }
}
