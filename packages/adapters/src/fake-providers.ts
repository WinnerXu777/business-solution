import type { MessageChannel } from '@bs/contracts';
import type { MessageAdapter, ProviderAdapters } from './index.ts';

function simulatedMessage(channel: MessageChannel): MessageAdapter {
  return {
    send(preview, actionId) {
      return {
        id: 'receipt-' + actionId,
        channel: preview.channel,
        status: 'simulated',
        providerId: 'fixture-' + channel,
      };
    },
  };
}

export function createFakeProviders(): ProviderAdapters {
  return {
    llm: {
      complete(input) {
        const words = ['Fixture', 'reply', 'via', input.route.kind + '.'];
        const reply = words.slice(0, input.maxOutputTokens);
        return {
          text: reply.join(' '),
          model: input.model,
          route: input.route,
          inputTokens: input.turns.reduce(
            (total, turn) => total + turn.content.trim().split(/\s+/).length,
            0,
          ),
          outputTokens: reply.length,
        };
      },
    },
    messages: {
      email: simulatedMessage('email'),
      voice: simulatedMessage('voice'),
      sms: simulatedMessage('sms'),
    },
    scoring: {
      fraud(order) {
        const flagged = order.signals.length > 0;
        return {
          orderId: order.id,
          rule: { score: flagged ? 0.8 : 0.05, reasons: order.signals, version: 'fixture-rule-v1' },
          model: { score: flagged ? 0.87 : 0.09, artifactId: 'fixture-fraud-v1' },
          disposition: flagged ? 'review' : 'pass',
        };
      },
      forecast(input) {
        const isDemand = input.series === 'sku_demand';
        const empty = isDemand && input.skuId !== 'sku-001';
        const points = empty
          ? []
          : Array.from({ length: input.horizonWeeks }, (_, index) => {
              const estimate = isDemand ? 45 + index * 3 : 115000 + index * 1200;
              const week = new Date(Date.UTC(2026, 10, 30 + index * 7));
              const band = isDemand ? 8 : 17000;
              return {
                weekOf: week.toISOString().slice(0, 10),
                estimate,
                lower: estimate - band,
                upper: estimate + band,
              };
            });
        return {
          status: empty ? 'insufficient_history' : 'fixture',
          unit: isDemand ? 'items' : 'cents',
          artifactId: 'fixture-forecast-v1',
          points,
        };
      },
      profile(customer) {
        return {
          customerId: customer.id,
          segment: customer.lastOrderOn < '2026-06-01' ? 'win_back' : 'active',
          evidenceIds: [customer.id],
          artifactId: 'fixture-profile-v1',
          reviewRequired: true,
        };
      },
    },
  };
}
