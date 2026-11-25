import type {
  CallEnvelope,
  RunForecastRequest,
  RunProfileRequest,
  ScoreFraudRequest,
} from '@bs/contracts';
import type { ToolGateway } from '@bs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import schemas from '../../../../packages/contracts/v1/contracts.schema.json' with { type: 'json' };

type InsightsRequest = ScoreFraudRequest | RunForecastRequest | RunProfileRequest;
type Identity = Pick<CallEnvelope, 'tenantId' | 'actor'>;

type InsightsOptions = {
  gateway: ToolGateway;
  /** Resolve a verified identity independently of the envelope supplied by the caller. */
  resolveIdentity(request: FastifyRequest): Identity | undefined | Promise<Identity | undefined>;
};

const requests = {
  'fraud.score': 'ScoreFraudRequest',
  'forecast.run': 'RunForecastRequest',
  'profile.run': 'RunProfileRequest',
} as const;

export function registerInsightsRoutes(app: FastifyInstance, options: InsightsOptions): void {
  for (const [tool, schema] of Object.entries(requests)) {
    app.post<{ Body: InsightsRequest }>(
      '/v1/tools/' + tool,
      { schema: { body: { $ref: '#/$defs/' + schema, $defs: schemas.$defs } } },
      async (request, reply) => {
        const identity = await options.resolveIdentity(request);
        if (!identity) {
          return reply.code(401).send({ message: 'Authentication required.' });
        }

        const { envelope } = request.body;
        if (
          envelope.tenantId !== identity.tenantId ||
          envelope.actor.id !== identity.actor.id ||
          envelope.actor.kind !== identity.actor.kind
        ) {
          return { state: 'denied', code: 'forbidden', message: 'forbidden' };
        }

        try {
          return await options.gateway.call({
            ...request.body,
            envelope: {
              ...envelope,
              tenantId: identity.tenantId,
              actor: { id: identity.actor.id, kind: identity.actor.kind },
              source: 'rest',
            },
          });
        } catch {
          return {
            state: 'failed',
            code: 'unavailable',
            message: 'Insights gateway unavailable.',
            retryable: true,
          };
        }
      },
    );
  }
}
