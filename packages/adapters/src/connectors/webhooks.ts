import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorLifecycle } from './lifecycle.ts';
import {
  ConnectorError,
  keyOf,
  type BindingRef,
  type Clock,
  type ConnectorFailure,
  type RecordKey,
} from './sdk.ts';
import { isInstant } from './sync.ts';

export interface WebhookSecretStore {
  get(binding: BindingRef): Promise<string | undefined>;
}

export interface WebhookEvent extends RecordKey {
  schemaVersion: 1;
  eventId: string;
  accountId: string;
  sequence: number;
  occurredAt: string;
}

export interface DeadLetter extends BindingRef, RecordKey {
  eventId: string;
  receivedAt: string;
  reason: ConnectorFailure;
}

export interface WebhookDelivery {
  body: Buffer;
  timestamp: string;
  signature: string;
}

export function signWebhook(secret: string, timestamp: string, body: Buffer) {
  return createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
}

type WebhookState = {
  seen: string[];
  highWater: [string, number][];
  deadLetters: DeadLetter[];
};

export class WebhookIngestor {
  private readonly lifecycle: ConnectorLifecycle;
  private readonly secrets: WebhookSecretStore;
  private readonly apply: (ref: BindingRef, event: WebhookEvent) => Promise<void>;
  private readonly clock: Clock;
  private readonly toleranceMs: number;

  constructor(
    lifecycle: ConnectorLifecycle,
    secrets: WebhookSecretStore,
    apply: (ref: BindingRef, event: WebhookEvent) => Promise<void>,
    clock: Clock = Date.now,
    toleranceMs = 5 * 60 * 1000,
  ) {
    this.lifecycle = lifecycle;
    this.secrets = secrets;
    this.apply = apply;
    this.clock = clock;
    this.toleranceMs = toleranceMs;
  }

  async receive(
    connectionId: string,
    delivery: WebhookDelivery,
  ): Promise<{
    status: 'accepted' | 'duplicate' | 'out_of_order' | 'dead_lettered';
  }> {
    const ref = this.lifecycle.resolveConnection(connectionId);
    const receivedAt = this.clock();
    const secret = await this.secrets.get(ref);
    this.verify(delivery, secret, receivedAt);
    const repository = this.lifecycle.repository;
    return repository.lease(ref.tenantId, keyOf('webhook', ref.connectionId), async () => {
      const binding = this.lifecycle.get(ref);
      const manifest = this.lifecycle.manifest(ref);
      if (!manifest.webhook) throw new ConnectorError('unsupported');
      const event = parseEvent(delivery.body);
      if (binding.accountId !== event.accountId) throw new ConnectorError('permission_denied');
      if (!manifest.webhook.recordClasses.includes(event.recordClass)) {
        throw new ConnectorError('unsupported');
      }
      if (binding.status !== 'active') throw new ConnectorError('auth_required');
      const state = this.state(ref);
      if (state.seen.includes(event.eventId)) return { status: 'duplicate' };
      state.seen.push(event.eventId);
      const entity = keyOf(event.recordClass, event.externalId);
      const highWater = new Map(state.highWater);
      const previous = highWater.get(entity);
      let status: 'accepted' | 'out_of_order' | 'dead_lettered' = 'out_of_order';
      if (previous === undefined || event.sequence > previous) {
        try {
          await this.apply(ref, event);
          highWater.set(entity, event.sequence);
          state.highWater = [...highWater];
          status = 'accepted';
        } catch (error) {
          state.deadLetters.push({
            ...ref,
            eventId: event.eventId,
            recordClass: event.recordClass,
            externalId: event.externalId,
            receivedAt: new Date(receivedAt).toISOString(),
            reason: error instanceof ConnectorError ? error.code : 'provider_unavailable',
          });
          status = 'dead_lettered';
        }
      }
      repository.put(ref.tenantId, 'webhook', ref.connectionId, state);
      return { status };
    });
  }

  listDeadLetters(ref: BindingRef): DeadLetter[] {
    this.lifecycle.get(ref);
    return this.state(ref).deadLetters;
  }

  private state(ref: BindingRef): WebhookState {
    return (
      this.lifecycle.repository.get<WebhookState>(ref.tenantId, 'webhook', ref.connectionId) ?? {
        seen: [],
        highWater: [],
        deadLetters: [],
      }
    );
  }

  private verify(delivery: WebhookDelivery, secret: string | undefined, now: number) {
    const { timestamp, signature, body } = delivery;
    const milliseconds = Number(timestamp) * 1000;
    if (
      !secret ||
      !/^\d{1,12}$/.test(timestamp) ||
      !/^[a-f\d]{64}$/i.test(signature) ||
      Math.abs(now - milliseconds) > this.toleranceMs ||
      !timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(signWebhook(secret, timestamp, body), 'hex'),
      )
    )
      throw new ConnectorError('auth_required');
  }
}

function parseEvent(body: Buffer): WebhookEvent {
  let event: Partial<WebhookEvent> | null;
  try {
    event = JSON.parse(body.toString('utf8')) as Partial<WebhookEvent> | null;
  } catch {
    throw new ConnectorError('validation_failed');
  }
  if (
    !event ||
    event.schemaVersion !== 1 ||
    ![event.eventId, event.accountId, event.recordClass, event.externalId].every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 256,
    ) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence! < 0 ||
    !isInstant(event.occurredAt)
  )
    throw new ConnectorError('validation_failed');
  return event as WebhookEvent;
}
