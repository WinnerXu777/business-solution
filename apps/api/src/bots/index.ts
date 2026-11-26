import { randomUUID } from 'node:crypto';
import type { Actor, CallEnvelope } from '@bs/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

export type BotRole = 'reader' | 'operator' | 'approver' | 'admin';
type Identity = { tenantId: string; actor: Actor; role: BotRole };
export type BotCommand = {
  command: string;
  scope: CallEnvelope;
  role: BotRole;
  target?: string;
  body?: unknown;
};
export type BotBackend = {
  invoke(input: BotCommand): Promise<unknown>;
  close?(): void;
};

export class BotRejection extends Error {
  readonly code: keyof typeof status;

  constructor(code: keyof typeof status) {
    super(code);
    this.code = code;
  }
}

const status = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
} as const;
const idPattern = '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$';
const identifier = new RegExp(idPattern);

type Options = {
  backend: BotBackend;
  resolveIdentity(request: FastifyRequest): Identity | undefined | Promise<Identity | undefined>;
};
type Route = [
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  command: string,
  roles?: BotRole[],
  run?: boolean,
];
const routes: Route[] = [
  ['GET', '/definitions', 'definitions'],
  ['GET', '/policies', 'policy', ['admin']],
  ['GET', '/policies/schema', 'policy-schema', ['admin']],
  ['PUT', '/policies', 'policy-update', ['admin']],
  ['GET', '/metrics', 'metrics'],
  ['POST', '/order-entry/requests', 'order-entry', ['operator', 'admin'], true],
  ['POST', '/quotes/rfqs', 'quote', ['operator', 'admin'], true],
  ['GET', '/quotes/reminders', 'quote-reminders'],
  ['POST', '/ap/invoices', 'ap-invoice', ['operator', 'admin'], true],
  ['GET', '/ap/exceptions', 'ap-exceptions', ['operator', 'approver', 'admin']],
  ['POST', '/customer-service/requests', 'customer-service', ['operator', 'admin'], true],
  ['GET', '/customer-service/queue', 'service-queue', ['operator', 'approver', 'admin']],
  ['POST', '/procurement/requests', 'purchase', ['operator', 'admin'], true],
  ['POST', '/procurement/requests/:id/approve', 'approve-draft', ['approver', 'admin']],
  ['GET', '/procurement/exceptions', 'exceptions'],
  ['POST', '/procurement/orders/:id/receipts', 'receipt', ['operator', 'admin']],
  ['GET', '/procurement/orders/:id/matches', 'matches'],
  ['POST', '/procurement/orders/:id/matches', 'match', ['operator', 'admin']],
  ['GET', '/collections/accounts/:id/timeline', 'timeline'],
  ['GET', '/collections/invoices/:id/promise', 'promise'],
  ['GET', '/collections/invoices/:id/payment-plan', 'payment-plan'],
  ['POST', '/collections/dunning', 'dunning', ['operator', 'admin'], true],
  ['POST', '/collections/replies', 'reply', ['operator', 'admin'], true],
  ['POST', '/collections/payment-plans', 'plan', ['operator', 'admin'], true],
  ['POST', '/collections/invoices/:id/payment-plan/approve', 'approve-plan', ['approver', 'admin']],
  ['GET', '/runs/:id', 'run'],
  ['POST', '/runs/:id/resume', 'resume', ['approver', 'admin']],
];

/** Registers an isolated API surface. The host supplies verified identity and a bot backend. */
export const botsPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  app.addHook('onClose', () => options.backend.close?.());
  for (const [method, path, command, roles, run] of routes) {
    app.route({
      method,
      url: '/v1/bots' + path,
      bodyLimit: 32_768,
      schema: {
        ...(method === 'GET' ? {} : { body: { type: 'object' } }),
        ...(path.includes(':id')
          ? {
              params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string', pattern: idPattern } },
              },
            }
          : {}),
      },
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const identity = await options.resolveIdentity(request);
        if (!identity)
          return reply
            .header('WWW-Authenticate', 'Bearer')
            .code(401)
            .send({ code: 'unauthenticated' });
        if (roles && !roles.includes(identity.role))
          return reply.code(403).send({ code: 'forbidden' });
        const key = request.headers['idempotency-key'];
        if (run && (typeof key !== 'string' || !identifier.test(key)))
          return reply.code(400).send({ code: 'invalid_input' });
        const traceId = randomUUID();
        try {
          const response = await options.backend.invoke({
            command,
            role: identity.role,
            scope: {
              version: 'v1',
              tenantId: identity.tenantId,
              actor: identity.actor,
              source: 'rest',
              traceId,
              correlationId: traceId,
              idempotencyKey: run && typeof key === 'string' ? key : traceId,
            },
            target: (request.params as { id?: string } | undefined)?.id,
            body: request.body,
          });
          return reply.code(run ? 202 : 200).send(response);
        } catch (error) {
          const code = error instanceof BotRejection ? error.code : 'unavailable';
          return reply.code(status[code]).send({ code });
        }
      },
    });
  }
};
