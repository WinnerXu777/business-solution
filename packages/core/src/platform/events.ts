import { createHmac, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { instant, iso } from './compliance-time.ts';
import type { ContactChannel, ContactPurpose } from './contacts.ts';
import type { TenantRepository } from './repository.ts';

interface EventPayloads {
  'record.changed': {
    recordType: string;
    recordId: string;
    change: 'created' | 'updated' | 'deleted';
  };
  'approval.requested': { approvalId: string };
  'approval.decided': { approvalId: string; decision: 'approved' | 'rejected' };
  'workflow.run.settled': { runId: string; status: 'succeeded' | 'failed' | 'cancelled' };
  'invoice.finalized': { invoiceId: string };
  'consent.withdrawn': { consentId: string; channel: ContactChannel; purpose: ContactPurpose };
  'webhook.test': { webhookId: string };
}

export type EventType = keyof EventPayloads;
export const eventTypes = [
  'record.changed',
  'approval.requested',
  'approval.decided',
  'workflow.run.settled',
  'invoice.finalized',
  'consent.withdrawn',
] as const satisfies readonly EventType[];

export type EventInput = {
  [Type in EventType]: { id: string; type: Type; occurredAt: string; data: EventPayloads[Type] };
}[EventType];

export type PlatformEvent = EventInput & { tenantId: string };

export interface WebhookInput {
  url: string;
  events: Exclude<EventType, 'webhook.test'>[];
}

type Webhook = WebhookInput & { id: string; createdAt: string };

interface DeliveryAttempt {
  number: number;
  at: string;
  outcome: 'sending' | 'delivered' | 'retry' | 'dead';
  statusCode?: number;
}

interface Delivery {
  id: string;
  eventId: string;
  webhookId: string;
  status: 'queued' | 'sending' | 'retry' | 'delivered' | 'dead';
  nextAttemptAt?: string;
  replayOf?: string;
  replayId?: string;
  attempts: DeliveryAttempt[];
}

interface EventRow {
  event: PlatformEvent;
  deliveries: Delivery[];
  notifications: { userId: string; readAt?: string }[];
}

export type StoredPlatformEvent = EventRow;
export type StoredWebhook = Webhook;

export interface WebhookDispatch {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export type WebhookTransport = (request: WebhookDispatch) => Promise<{ status: number }>;

const backoff = [30_000, 120_000];
const leaseMs = 30_000;
const timeoutMs = 10_000;
const workerBatch = 50;

export function webhookSignature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: string,
) {
  return (
    'v1=' +
    createHmac('sha256', secret)
      .update(timestamp + '.' + deliveryId + '.' + body)
      .digest('hex')
  );
}

function normalizeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlatformError('forbidden');
  }
  // Fixture targets only. The bus never resolves DNS or performs a network request.
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.example') ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    url.search
  )
    throw new PlatformError('forbidden');
  return url.href;
}

function eventData(input: EventInput): EventPayloads[EventType] {
  switch (input.type) {
    case 'record.changed': {
      const { recordType, recordId, change } = input.data;
      return { recordType, recordId, change };
    }
    case 'approval.requested':
      return { approvalId: input.data.approvalId };
    case 'approval.decided':
      return { approvalId: input.data.approvalId, decision: input.data.decision };
    case 'workflow.run.settled':
      return { runId: input.data.runId, status: input.data.status };
    case 'invoice.finalized':
      return { invoiceId: input.data.invoiceId };
    case 'consent.withdrawn':
      return {
        consentId: input.data.consentId,
        channel: input.data.channel,
        purpose: input.data.purpose,
      };
    case 'webhook.test':
      return { webhookId: input.data.webhookId };
  }
}

function queued(eventId: string, webhookId: string, at: string): Delivery {
  return {
    id: 'delivery-' + randomUUID(),
    eventId,
    webhookId,
    status: 'queued',
    nextAttemptAt: at,
    attempts: [],
  };
}

export class PlatformEventBus {
  private readonly events: TenantRepository<EventRow>;
  private readonly webhooks: TenantRepository<Webhook>;
  private readonly audit: PlatformAudit;
  private readonly now: () => string;
  private readonly signingKey?: Uint8Array;
  private readonly transport?: WebhookTransport;

  constructor(
    events: TenantRepository<EventRow>,
    webhooks: TenantRepository<Webhook>,
    audit: PlatformAudit,
    now: () => string,
    signingKey?: Uint8Array,
    transport?: WebhookTransport,
  ) {
    this.events = events;
    this.webhooks = webhooks;
    this.audit = audit;
    this.now = now;
    this.signingKey = signingKey && Buffer.from(signingKey);
    this.transport = transport;
  }

  listWebhooks(tenantId: string) {
    return this.webhooks.list(tenantId);
  }

  private secret(tenantId: string, webhookId: string) {
    if (!this.signingKey) throw new PlatformError('unavailable');
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify(['platform.webhook.v1', tenantId, webhookId]))
      .digest('base64url');
  }

  createWebhook(context: MutationContext, input: WebhookInput) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const events = [...new Set(input.events)];
      if (!events.length || events.some((type) => !eventTypes.includes(type)))
        throw new PlatformError('forbidden');
      const hook = {
        id: 'webhook-' + randomUUID(),
        url: normalizeUrl(input.url),
        events,
        createdAt: this.now(),
      };
      const signingSecret = this.secret(tenantId, hook.id);
      await this.audit.record(context, 'platform.webhook.create', 'ok', hook.id);
      await this.webhooks.put(tenantId, hook.id, hook);
      return { ...hook, signingSecret };
    });
  }

  private async hook(tenantId: string, id: string) {
    const hook = await this.webhooks.get(tenantId, id);
    if (!hook) throw new PlatformError('not_found');
    return hook;
  }

  publish(tenantId: string, input: EventInput, notifyUserIds: readonly string[] = []) {
    return this.audit.transaction(tenantId, () =>
      this.appendInTransaction(tenantId, input, notifyUserIds),
    );
  }

  /** For producers already inside the platform transaction for this tenant. */
  async appendInTransaction(
    tenantId: string,
    input: EventInput,
    notifyUserIds: readonly string[] = [],
  ): Promise<PlatformEvent> {
    const event = {
      id: input.id,
      type: input.type,
      occurredAt: iso(instant(input.occurredAt)),
      data: eventData(input),
      tenantId,
    } as PlatformEvent;
    const userIds = [...new Set(notifyUserIds)].sort();
    const existing = await this.events.get(tenantId, event.id);
    if (existing) {
      if (
        !isDeepStrictEqual(existing.event, event) ||
        !isDeepStrictEqual(
          existing.notifications.map(({ userId }) => userId),
          userIds,
        )
      )
        throw new PlatformError('idempotency_conflict');
      return existing.event;
    }
    const hooks = await this.webhooks.list(tenantId);
    const destinations = hooks.filter((hook) =>
      input.type === 'webhook.test'
        ? hook.id === input.data.webhookId
        : hook.events.includes(input.type),
    );
    const at = this.now();
    const row: EventRow = {
      event,
      deliveries: destinations.map(({ id }) => queued(event.id, id, at)),
      notifications: userIds.map((userId) => ({ userId })),
    };
    await this.events.put(tenantId, event.id, row);
    return event;
  }

  testWebhook(context: MutationContext, id: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      await this.hook(tenantId, id);
      const eventId = 'webhook-test-' + randomUUID();
      await this.audit.record(context, 'platform.webhook.test', 'ok', id);
      return this.appendInTransaction(tenantId, {
        id: eventId,
        type: 'webhook.test',
        occurredAt: this.now(),
        data: { webhookId: id },
      });
    });
  }

  async deliveries(tenantId: string, webhookId: string) {
    await this.hook(tenantId, webhookId);
    return (await this.events.list(tenantId)).flatMap(({ deliveries }) =>
      deliveries.filter((item) => item.webhookId === webhookId),
    );
  }

  replay(context: MutationContext, deliveryId: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const rows = await this.events.list(tenantId);
      const row = rows.find(({ deliveries }) => deliveries.some(({ id }) => id === deliveryId));
      const prior = row?.deliveries.find(({ id }) => id === deliveryId);
      if (!row || !prior) throw new PlatformError('not_found');
      if (prior.status !== 'dead') throw new PlatformError('forbidden');
      const existing = row.deliveries.find(({ id }) => id === prior.replayId);
      if (existing) return existing;
      const delivery = { ...queued(row.event.id, prior.webhookId, this.now()), replayOf: prior.id };
      prior.replayId = delivery.id;
      row.deliveries.push(delivery);
      await this.audit.record(context, 'platform.webhook.replay', 'ok', delivery.id);
      await this.events.put(tenantId, row.event.id, row);
      return delivery;
    });
  }

  async notifications(tenantId: string, userId: string) {
    return (await this.events.list(tenantId)).flatMap(({ event, notifications }) => {
      const notification = notifications.find((entry) => entry.userId === userId);
      return notification ? [{ id: event.id, event, readAt: notification.readAt }] : [];
    });
  }

  markRead(context: MutationContext, eventId: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const row = await this.events.get(tenantId, eventId);
      const notification = row?.notifications.find(({ userId }) => userId === context.actor.id);
      if (!row || !notification) throw new PlatformError('not_found');
      if (!notification.readAt) {
        notification.readAt = this.now();
        await this.events.put(tenantId, eventId, row);
      }
      return { id: eventId, event: row.event, readAt: notification.readAt };
    });
  }

  /** The host ticks each active tenant. A missing transport leaves deliveries queued. */
  async deliverDue(tenantId: string) {
    if (!this.transport) return 0;
    const now = instant(this.now());
    const rows = await this.events.list(tenantId);
    const due = rows
      .flatMap(({ deliveries }) => deliveries)
      .filter(({ nextAttemptAt }) => nextAttemptAt !== undefined && instant(nextAttemptAt) <= now)
      .sort((a, b) => instant(a.nextAttemptAt!) - instant(b.nextAttemptAt!))
      .slice(0, workerBatch);
    for (const delivery of due)
      await this.deliver(tenantId, delivery.eventId, delivery.id, this.transport);
    return due.length;
  }

  private async deliver(
    tenantId: string,
    eventId: string,
    id: string,
    transport: WebhookTransport,
  ) {
    const claim = await this.audit.transaction(tenantId, async () => {
      const row = await this.events.get(tenantId, eventId);
      const delivery = row?.deliveries.find((item) => item.id === id);
      const at = instant(this.now());
      if (!row || !delivery?.nextAttemptAt || instant(delivery.nextAttemptAt) > at) return;
      if (delivery.status === 'sending') {
        this.settle(delivery, at);
        await this.events.put(tenantId, eventId, row);
        return;
      }
      const hook = await this.hook(tenantId, delivery.webhookId);
      const secret = this.secret(tenantId, hook.id);
      const number = delivery.attempts.length + 1;
      delivery.attempts.push({ number, at: iso(at), outcome: 'sending' });
      delivery.status = 'sending';
      delivery.nextAttemptAt = iso(at + leaseMs);
      await this.events.put(tenantId, eventId, row);
      return { event: row.event, number, at, hook, secret };
    });
    if (!claim) return;
    const body = JSON.stringify(claim.event);
    const timestamp = String(Math.floor(claim.at / 1000));
    let status: number | undefined;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      status = await new Promise<number>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        transport({
          url: claim.hook.url,
          body,
          signal,
          headers: {
            'content-type': 'application/json',
            'x-platform-timestamp': timestamp,
            'x-platform-delivery': id,
            'x-platform-signature': webhookSignature(claim.secret, timestamp, id, body),
          },
        }).then(({ status }) => resolve(status), reject);
      });
    } catch {
      // Transport error bodies and messages can contain credentials or recipient data.
    }
    await this.audit.transaction(tenantId, async () => {
      const row = await this.events.get(tenantId, eventId);
      const current = row?.deliveries.find((item) => item.id === id);
      if (
        !row ||
        !current ||
        current.status !== 'sending' ||
        current.attempts.length !== claim.number
      )
        return;
      this.settle(current, instant(this.now()), status);
      await this.events.put(tenantId, eventId, row);
    });
  }

  private settle(delivery: Delivery, at: number, status?: number) {
    const attempt = delivery.attempts.at(-1)!;
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599)
      attempt.statusCode = status;
    const delay = backoff[attempt.number - 1];
    attempt.outcome =
      status !== undefined && status >= 200 && status < 300 && Number.isInteger(status)
        ? 'delivered'
        : delay === undefined
          ? 'dead'
          : 'retry';
    delivery.status = attempt.outcome;
    delivery.nextAttemptAt = attempt.outcome === 'retry' ? iso(at + delay) : undefined;
  }
}
