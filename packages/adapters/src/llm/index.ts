import type { CallEnvelope, CompleteLlmInput, LlmRoute, Turn } from '@bs/contracts';
import type { LlmAdapter } from '../index.ts';

export type ToolProposal =
  | { tool: 'order.read'; input: { orderId: string } }
  | { tool: 'purchase.order.draft'; input: { requestId: string } }
  | { tool: 'message.preview'; input: { invoiceId: string; channel: 'email' | 'voice' | 'sms' } };

function propose(turns: Turn[]): ToolProposal | null {
  const prompt = turns.findLast((turn) => turn.role === 'user')?.content.toLowerCase() ?? '';
  const orderId = prompt.match(/\bord-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0];
  if (orderId) return { tool: 'order.read', input: { orderId } };
  const requestId = prompt.match(/\bpr-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0];
  if (requestId) return { tool: 'purchase.order.draft', input: { requestId } };
  const invoiceId = prompt.match(/\binv-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0];
  if (invoiceId) {
    const channel = /\bsms\b/.test(prompt) ? 'sms' : /\bvoice\b/.test(prompt) ? 'voice' : 'email';
    return { tool: 'message.preview', input: { invoiceId, channel } };
  }
  return null;
}

const providers = { native: 'fixture-native', byo: 'fixture-byo' } as const;

function provider(route: LlmRoute) {
  if (route.fixtureMode !== true || providers[route.kind] !== route.providerId) {
    throw new Error('Unsupported fixture LLM route');
  }
  return providers[route.kind];
}

export function createFixtureRouter(): LlmAdapter & {
  propose(input: Pick<CompleteLlmInput, 'route' | 'turns'>): ToolProposal | null;
} {
  return {
    complete(input) {
      const words = ['Fixture', 'reply', 'via', provider(input.route) + '.'];
      const reply = words.slice(0, input.maxOutputTokens);
      return {
        text: reply.join(' '),
        model: input.model,
        route: { ...input.route },
        inputTokens: input.turns.reduce(
          (total, turn) => total + (turn.content.match(/\S+/g)?.length ?? 0),
          0,
        ),
        outputTokens: reply.length,
      };
    },
    propose(input) {
      provider(input.route);
      return propose(input.turns);
    },
  };
}

type RouteDecision = {
  tenantId: string;
  actorId: string;
  source: CallEnvelope['source'];
  traceId: string;
  correlationId: string;
  previousProviderId: string | null;
  providerId: string;
};

export function createRouteAudit() {
  const current = new Map<string, string>();
  const seen = new Set<string>();
  const entries: RouteDecision[] = [];
  return {
    record(envelope: CallEnvelope, route: LlmRoute) {
      const scope = JSON.stringify([envelope.tenantId, envelope.actor.id, envelope.actor.kind]);
      const key = JSON.stringify([scope, envelope.idempotencyKey]);
      if (seen.has(key)) return;
      seen.add(key);
      const previousProviderId = current.get(scope) ?? null;
      if (previousProviderId === route.providerId) return;
      current.set(scope, route.providerId);
      entries.push({
        tenantId: envelope.tenantId,
        actorId: envelope.actor.id,
        source: envelope.source,
        traceId: envelope.traceId,
        correlationId: envelope.correlationId,
        previousProviderId,
        providerId: route.providerId,
      });
    },
    entries: () => structuredClone(entries),
  };
}
