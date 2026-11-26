import { PlatformError } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  EventingClient,
  NotificationEntry,
  PlatformEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from './eventing.ts';
import { findEntry, requireAccess } from './mock-compliance.ts';

export function createMockEventing(me: PlatformIdentity, now: string): EventingClient {
  const tenantId = me.tenant.id;
  const demo = tenantId === 'tenant-rivetquay';
  const hooks: WebhookEndpoint[] = demo
    ? [
        {
          id: 'hook-001',
          url: 'https://receipts.rivetquay.example/events',
          events: ['record.changed'],
          createdAt: now,
        },
      ]
    : [];
  const deliveries: WebhookDelivery[] = demo
    ? [
        {
          id: 'delivery-001',
          eventId: 'event-001',
          webhookId: 'hook-001',
          status: 'dead',
          attempts: [1, 2, 3].map((number) => ({
            number,
            at: now,
            outcome: number === 3 ? 'dead' : 'retry',
            statusCode: 503,
          })),
        },
      ]
    : [];
  const notifications: NotificationEntry[] = demo
    ? [
        {
          id: 'event-001',
          event: {
            id: 'event-001',
            tenantId,
            type: 'record.changed',
            occurredAt: now,
            data: { recordId: 'ord-001', recordType: 'order', change: 'updated' },
          },
        },
      ]
    : [];
  let sequence = 1;
  const manage = () => requireAccess(me.role === 'admin');
  function queue(eventId: string, webhookId: string, replayOf?: string) {
    const row: WebhookDelivery = {
      id: 'delivery-' + ++sequence,
      eventId,
      webhookId,
      status: 'queued',
      nextAttemptAt: now,
      attempts: [],
      ...(replayOf && { replayOf }),
    };
    deliveries.unshift(row);
    return row;
  }
  return {
    async listWebhooks() {
      manage();
      return structuredClone(hooks);
    },
    async createWebhook(input) {
      manage();
      const url = URL.parse(input.url);
      if (
        !url ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.example') ||
        url.username ||
        url.password ||
        !input.events.length
      )
        throw new PlatformError('invalid_input');
      const hook = {
        ...input,
        events: [...new Set(input.events)],
        id: 'hook-' + ++sequence,
        createdAt: now,
      };
      hooks.push(hook);
      return { ...structuredClone(hook), signingSecret: 'fixture-secret-' + hook.id };
    },
    async listDeliveries(id) {
      manage();
      findEntry(hooks, id);
      return structuredClone(deliveries.filter((row) => row.webhookId === id));
    },
    async testWebhook(id) {
      manage();
      findEntry(hooks, id);
      const event: PlatformEvent = {
        id: 'event-' + ++sequence,
        tenantId,
        type: 'webhook.test',
        occurredAt: now,
        data: { webhookId: id },
      };
      queue(event.id, id);
      return event;
    },
    async replayDelivery(id) {
      manage();
      const row = findEntry(deliveries, id);
      requireAccess(row.status === 'dead');
      if (row.replayId) return structuredClone(findEntry(deliveries, row.replayId));
      const replay = queue(row.eventId, row.webhookId, id);
      row.replayId = replay.id;
      return structuredClone(replay);
    },
    async listNotifications() {
      requireAccess(me.actor.kind === 'person');
      return structuredClone(notifications);
    },
    async markRead(id) {
      requireAccess(me.actor.kind === 'person');
      const row = findEntry(notifications, id);
      row.readAt ??= now;
      return structuredClone(row);
    },
  };
}
