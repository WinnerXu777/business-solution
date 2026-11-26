import { randomBytes } from 'node:crypto';
import type { DemoFixtures } from '@bs/contracts';
import type { FastifyInstance } from 'fastify';
import { createNativeBotModel } from '../../../packages/adapters/src/llm/bot.ts';
import {
  Conversations,
  MemoryConversationRepository,
} from '../../../packages/core/src/conversations/index.ts';
import {
  PlatformError,
  type GovernedRecord,
  type PlatformServices,
  type PrivacyOptions,
} from '../../../packages/core/src/platform/index.ts';
import type { ChannelsOptions, TenantChannels } from './channels/index.ts';
import type { IdentityVerifier } from './governance/identity.ts';
import type { LlmPluginOptions } from './llm/index.ts';

export function demoPrivacy(fixtures: DemoFixtures): PrivacyOptions {
  const records: GovernedRecord[] = fixtures.customers.map((customer) => ({
    id: customer.id,
    tenantId: customer.tenantId,
    subjectId: customer.id,
    version: '1',
    recordType: 'contact',
    dataClass: 'personal',
    retainedFrom: fixtures.asOf,
    fields: { id: customer.id, email: customer.email, phone: customer.phone },
  }));
  const deleted = new Map<string, number>();
  const select = (tenantId: string, subjectId?: string) =>
    records.filter(
      (record) =>
        record.tenantId === tenantId && (subjectId === undefined || record.subjectId === subjectId),
    );
  return {
    async verifyIdentity(tenantId, subjectId, _requestId, proofRef) {
      return proofRef === 'fixture-verified' &&
        fixtures.customers.some((row) => row.tenantId === tenantId && row.id === subjectId);
    },
    records: {
      async list(tenantId, subjectId) {
        return structuredClone(select(tenantId, subjectId));
      },
      async delete(tenantId, subjectId, operationId, refs) {
        const key = JSON.stringify([tenantId, subjectId, operationId]);
        const previous = deleted.get(key);
        if (previous !== undefined) return previous;
        const eligible = new Set(select(tenantId, subjectId));
        const targets = new Set(refs.map((ref) => {
          const match = records.find((row) =>
            eligible.has(row) && row.id === ref.id &&
            row.version === ref.version && row.recordType === ref.recordType,
          );
          if (!match) throw new PlatformError('idempotency_conflict');
          return match;
        }));
        for (const target of targets) records.splice(records.indexOf(target), 1);
        deleted.set(key, targets.size);
        return targets.size;
      },
    },
  };
}

export function fixtureChannelBootstrap(env: NodeJS.ProcessEnv, now: () => string) {
  const tenantIds = ['tenant-rivetquay', 'tenant-spoolharbour'];
  const queueId = 'support';
  const tenants = new Map<string, TenantChannels>(tenantIds.map((id, index) => [
    id,
    {
      origins: (env.BS_WIDGET_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','),
      defaultQueue: queueId,
      queues: [{ id: queueId, skills: [], slaMs: 60_000 }],
      email: { recipient: id + '@intake.example', secret: env.BS_FIXTURE_EMAIL_SECRET ?? 'fixture-email-secret' },
      sms: {
        recipient: index === 0 ? '+14165550190' : '+14165550191',
        signatureUrl: (env.BS_INBOUND_ORIGIN ?? 'http://127.0.0.1:3000') + '/channels/inbound/sms/' + id,
        authToken: env.BS_FIXTURE_SMS_TOKEN ?? 'fixture-sms-token',
      },
    },
  ]));
  const keys = new Map(tenantIds.map((id) => [id, randomBytes(32).toString('base64url')]));
  const conversations = new Conversations(new MemoryConversationRepository(), () => Date.parse(now()));

  return {
    key: (tenantId: string) => keys.get(tenantId),
    llm(options: LlmPluginOptions): LlmPluginOptions {
      return {
        ...options,
        verifyApiKey(key, endpoint) {
          if (endpoint === 'chat.completions') {
            for (const [tenantId, secret] of keys) {
              if (key === secret) return { tenantId };
            }
          }
          return options.verifyApiKey(key, endpoint);
        },
      };
    },
    channels(app: FastifyInstance, services: PlatformServices, verify: IdentityVerifier): ChannelsOptions {
      const model = createNativeBotModel(
        async ({ method, path, headers, body, signal }) => {
          signal?.throwIfAborted();
          const response = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
          signal?.throwIfAborted();
          return { status: response.statusCode, json: async () => response.json() };
        },
        (tenantId) => {
          const serviceKey = keys.get(tenantId);
          if (serviceKey) return { serviceKey, modelAlias: 'fixture-chat' };
        },
      );
      return {
        conversations, tenants, model,
        tokenSecret: env.BS_WIDGET_TOKEN_SECRET ?? randomBytes(32).toString('base64url'),
        now: () => Date.parse(now()),
        async verifyStaff(token) {
          const identity = await verify(token);
          if (!identity || !tenants.has(identity.tenantId) ||
            !(await services.directory.allows(identity, 'actions.request'))) return null;
          const { tenantId, actor } = identity;
          conversations.setStaff(tenantId, { id: actor.id, available: true, skills: [] });
          return { tenantId, staffId: actor.id };
        },
        async consent(event) {
          if (event.kind !== 'opt_out') return;
          await services.contacts.suppress({
            tenantId: event.tenantId,
            actor: { id: 'service-channel', kind: 'service' },
            source: 'rest',
            traceId: event.receiptId,
            correlationId: event.receiptId,
          }, { channel: event.channel, destination: event.address, reason: 'opt_out' });
        },
      };
    },
  };
}
