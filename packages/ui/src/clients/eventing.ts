import type { RequestJson } from '../platform-client.ts';

const root = '/platform/v1';
export const webhookEvents = [
  'record.changed',
  'approval.requested',
  'approval.decided',
  'workflow.run.settled',
  'invoice.finalized',
  'consent.withdrawn',
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
export interface WebhookInput {
  url: string;
  events: WebhookEvent[];
}
export interface WebhookEndpoint extends WebhookInput {
  id: string;
  createdAt: string;
}
export interface WebhookDelivery {
  id: string;
  eventId: string;
  webhookId: string;
  status: 'queued' | 'sending' | 'retry' | 'delivered' | 'dead';
  nextAttemptAt?: string;
  replayOf?: string;
  replayId?: string;
  attempts: {
    number: number;
    at: string;
    outcome: 'sending' | 'delivered' | 'retry' | 'dead';
    statusCode?: number;
  }[];
}
export interface PlatformEvent {
  id: string;
  tenantId: string;
  type: WebhookEvent | 'webhook.test';
  occurredAt: string;
  data: Record<string, string>;
}
export interface NotificationEntry {
  id: string;
  event: PlatformEvent;
  readAt?: string;
}
export interface EventingClient {
  listWebhooks(): Promise<WebhookEndpoint[]>;
  createWebhook(input: WebhookInput): Promise<WebhookEndpoint & { signingSecret: string }>;
  testWebhook(id: string): Promise<PlatformEvent>;
  listDeliveries(id: string): Promise<WebhookDelivery[]>;
  replayDelivery(id: string): Promise<WebhookDelivery>;
  listNotifications(): Promise<NotificationEntry[]>;
  markRead(id: string): Promise<NotificationEntry>;
}
export class HttpEventingClient implements EventingClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  listWebhooks() {
    return this.request<WebhookEndpoint[]>(root + '/webhooks');
  }
  createWebhook(input: WebhookInput) {
    return this.request<WebhookEndpoint & { signingSecret: string }>(
      root + '/webhooks',
      'POST',
      input,
    );
  }
  testWebhook(id: string) {
    return this.request<PlatformEvent>(
      root + '/webhooks/' + encodeURIComponent(id) + '/test',
      'POST',
    );
  }
  listDeliveries(id: string) {
    return this.request<WebhookDelivery[]>(
      root + '/webhooks/' + encodeURIComponent(id) + '/deliveries',
    );
  }
  replayDelivery(id: string) {
    return this.request<WebhookDelivery>(
      root + '/webhooks/deliveries/' + encodeURIComponent(id) + '/replay',
      'POST',
    );
  }
  listNotifications() {
    return this.request<NotificationEntry[]>(root + '/notifications');
  }
  markRead(id: string) {
    return this.request<NotificationEntry>(
      root + '/notifications/' + encodeURIComponent(id) + '/read',
      'POST',
    );
  }
}
